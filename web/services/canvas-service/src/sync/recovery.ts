/**
 * Y.Doc 恢复与校验（任务 3.5 / 3.6 / design D7、D8）。
 *
 * 恢复流程：先应用 checkpoint，再按 seq 应用 updates，最后校验 revision、格式与派生
 * projection 是否自洽。任一校验失败 → **隔离 room**（不可写），绝不创建空文档继续服务
 * （spec「checkpoint 或 update 损坏」）。
 *
 * 本模块只做「加载 + 校验 + 重建」，不涉及网络或命令执行。
 */
import * as Y from "yjs";
import type { ServerCanvas } from "@woohaa3/contracts";
import { computeUpdateSha256,
  type YjsDocumentRepository,
  type YjsLoadedState } from "./yjs-repository.js";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";

export type YjsRecoveryResult =
  | {
      ok: true;
      doc: Y.Doc;
      state: YjsLoadedState;
      /** 恢复出的业务 revision。 */
      revision: number;
      /** 恢复出的规范聚合（用于与存储 metadata 比对）。 */
      canvas: ServerCanvas;
    }
  | {
      ok: false;
      code:
        | "not-found"
        | "unsupported-format"
        | "checksum-mismatch"
        | "revision-mismatch"
        | "corrupt-document"
        | "projection-mismatch";
      message: string;
    };

export type RecoverYjsOptions = {
  repository: YjsDocumentRepository;
  canvasId: string;
  /** 跳过 checksum 校验（导入/运维场景可关；运行时必须开）。 */
  verifyChecksums?: boolean;
  now?: string;
};

/**
 * 从存储恢复一个可用的 Y.Doc。
 *
 * 关键顺序：checkpoint →（按 seq 升序）updates → 校验。顺序不能反：updates 依赖 checkpoint
 * 建立的结构。
 */
export async function recoverYjsDocument(options: RecoverYjsOptions): Promise<YjsRecoveryResult> {
  const state = await options.repository.loadYjsState(options.canvasId);
  if (!state) {
    return { ok: false, code: "not-found", message: `Yjs 文档 ${options.canvasId} 不存在` };
  }

  if (state.formatVersion !== YJS_CANVAS_FORMAT_VERSION) {
    return {
      ok: false,
      code: "unsupported-format",
      message: `不支持的 Y.Doc 格式版本：${state.formatVersion}`
    };
  }

  // 校验 update checksum（内容寻址完整性）。
  if (options.verifyChecksums !== false) {
    for (const entry of state.updates) {
      const actual = await computeUpdateSha256(entry.update);
      if (actual !== entry.sha256) {
        return {
          ok: false,
          code: "checksum-mismatch",
          message: `update seq=${entry.seq} 的 checksum 不一致`
        };
      }
    }
  }

  const doc = new Y.Doc();
  try {
    // 0 字节的 checkpoint/update 编码不了任何 Yjs 状态（no-op 命令会持久化空 update 行）。
    // Yjs 对空字节数组会抛 `Unexpected end of array`，因此按「无变化」跳过。
    if (state.checkpoint.byteLength > 0) {
      Y.applyUpdate(doc, state.checkpoint);
    }
    // 按 seq **严格升序**应用；乱序或重复 seq 视为损坏。
    let expected = state.checkpointSeq;
    for (const entry of state.updates) {
      if (entry.seq <= expected) {
        return {
          ok: false,
          code: "corrupt-document",
          message: `update seq 非单调递增：${entry.seq} <= ${expected}`
        };
      }
      expected = entry.seq;
      if (entry.update.byteLength > 0) {
        Y.applyUpdate(doc, entry.update);
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: "corrupt-document",
      message: `Yjs update 应用失败：${error instanceof Error ? error.message : String(error)}`
    };
  }

  const exported = yDocToServerCanvas(doc, { now: options.now });
  if (!exported.ok) {
    return { ok: false, code: "corrupt-document", message: exported.failure.message };
  }

  // revision 校验：Y.Doc 内的 revision 必须与最新可用 metadata 一致。
  // checkpoint 内的 revision 由快照携带；updates 会覆盖它。这里用导出值作为真值，
  // 并要求它与 projection（若有）的 revision 一致，否则说明应用有漂移。
  if (state.projection && state.projection.revision !== exported.canvas.revision) {
    return {
      ok: false,
      code: "revision-mismatch",
      message: `派生投影 revision ${state.projection.revision} 与 Y.Doc ${exported.canvas.revision} 不一致`
    };
  }

  return {
    ok: true,
    doc,
    state,
    revision: exported.canvas.revision,
    canvas: exported.canvas
  };
}

/**
 * cutoff-safe checkpoint 压缩（任务 3.6 / design D8）。
 *
 * 在 `cutoffSeq = 当前 storageSeq` 时把**完整 published Y.Doc** 编码为新 checkpoint，
 * 然后由 repository 原子替换并删除 `seq <= cutoffSeq` 的 updates。
 *
 * 不变量：
 * - business revision 不变；
 * - 不广播业务 update（压缩不是内容变化）；
 * - 幂等记录不删；
 * - 压缩前后 projection 与 state-vector 收敛等价。
 */
export async function compactYjsCheckpoint(input: {
  repository: YjsDocumentRepository;
  canvasId: string;
  doc: Y.Doc;
  projection: ReturnType<typeof yDocToServerCanvas>;
  now: string;
}): Promise<{ ok: true; cutoffSeq: number } | { ok: false; code: string; message: string }> {
  const state = await input.repository.loadYjsState(input.canvasId);
  if (!state) {
    return { ok: false, code: "not-found", message: `Yjs 文档 ${input.canvasId} 不存在` };
  }

  const cutoffSeq = state.storageSeq;
  const checkpoint = Y.encodeStateAsUpdate(input.doc);
  await input.repository.replaceCheckpoint({
    canvasId: input.canvasId,
    cutoffSeq,
    checkpoint,
    updatedAt: input.now
  });
  return { ok: true, cutoffSeq };
}

/**
 * 判定是否应当压缩（按 update 数量或字节阈值）。
 * 阈值由调用方注入（任务 3.8 会用真实大画布测出默认值）。
 */
export function shouldCompact(
  state: Pick<YjsLoadedState, "updates">,
  thresholds: { maxUpdates: number; maxBytes: number }
): boolean {
  if (state.updates.length >= thresholds.maxUpdates) return true;
  const bytes = state.updates.reduce((sum, entry) => sum + entry.update.byteLength, 0);
  return bytes >= thresholds.maxBytes;
}
