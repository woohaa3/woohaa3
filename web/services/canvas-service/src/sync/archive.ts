/**
 * Yjs 归档扩展（任务 8.5 / design D12）。
 *
 * 前置 change 的 `woohaa3-canvas-archive-v1` 是 metadata-only 的**结构化画布**归档。
 * Yjs 模式还有一份必须能备份/恢复的状态：checkpoint、format、roomEpoch 与命令幂等记录。
 *
 * 本模块定义**扩展段**（而不是替换前置格式）：归档里新增可选 `yjs` 段，旧工具忽略它即可，
 * 新工具能校验与恢复。依然遵守「禁止媒体 bytes / 签名 URL」的红线 —— Yjs update 是结构
 * 字节而非媒体 bytes，但**签名 URL 与 base64 仍被拒绝**。
 */
import { computeUpdateSha256,
  type YjsDocumentRepository,
  type YjsLoadedState } from "./yjs-repository.js";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";

export const YJS_ARCHIVE_SECTION = "woohaa3-ycanvas-archive-v1" as const;

/** 单画布的 Yjs 归档记录。 */
export type YjsArchiveRecord = {
  canvasId: string;
  formatVersion: string;
  roomEpoch: string | null;
  /** 完整 checkpoint（base64；这是 Yjs 结构字节，不是媒体 bytes）。 */
  checkpointBase64: string;
  checkpointSha256: string;
  checkpointSeq: number;
  /**
   * checkpoint 之后的有序 update。
   *
   * **每条 update 携带其来源命令**：仓储契约保证「一次 `commitYjsCommand` 恰好追加一条
   * update 行」，因此 seq 与命令一一对应。恢复时用同一个 commandId 提交，既能还原
   * update 又能还原幂等记录，**不会**额外增加 storageSeq。
   */
  updates: Array<{
    seq: number;
    updateBase64: string;
    sha256: string;
    command: {
      commandId: string;
      payloadHash: string;
      revision: number;
      changed: boolean;
      actorId: string;
      createdAt: string;
    } | null;
  }>;
  storageSeq: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type YjsArchiveSection = {
  section: typeof YJS_ARCHIVE_SECTION;
  formatVersion: string;
  records: YjsArchiveRecord[];
  createdAt: string;
};

/**
 * 导出某画布的 Yjs 段。
 *
 * `listCommands` 返回该画布的**全部**命令记录；导出时按 `seq` 与命令的提交顺序配对。
 * 由于仓储保证「一次提交恰好一条 update」，两者的顺序完全一致。
 */
export async function exportYjsArchive(
  repository: YjsDocumentRepository,
  canvasIds: readonly string[],
  options: { now: string; listCommands?: (canvasId: string) => Promise<ArchiveCommandRecord[]> }
): Promise<YjsArchiveSection> {
  const records: YjsArchiveRecord[] = [];
  for (const canvasId of canvasIds) {
    const state = await repository.loadYjsState(canvasId);
    if (!state) continue;
    records.push(await toArchiveRecord(state, options.listCommands));
  }
  return {
    section: YJS_ARCHIVE_SECTION,
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    records,
    createdAt: options.now
  };
}

/** 命令幂等记录（归档用）。 */
export type ArchiveCommandRecord = {
  commandId: string;
  payloadHash: string;
  revision: number;
  changed: boolean;
  actorId: string;
  createdAt: string;
};

async function toArchiveRecord(
  state: YjsLoadedState,
  listCommands?: (canvasId: string) => Promise<ArchiveCommandRecord[]>
): Promise<YjsArchiveRecord> {
  const commands = listCommands ? await listCommands(state.canvasId) : [];
  return {
    canvasId: state.canvasId,
    formatVersion: state.formatVersion,
    roomEpoch: state.roomEpoch,
    checkpointBase64: toBase64(state.checkpoint),
    checkpointSha256: await computeUpdateSha256(state.checkpoint),
    checkpointSeq: state.checkpointSeq,
    // seq 与命令一一对应；命令数不足时 command 为 null（仍可恢复 update）。
    updates: await Promise.all(
      state.updates.map(async (entry, index) => ({
        seq: entry.seq,
        updateBase64: toBase64(entry.update),
        sha256: await computeUpdateSha256(entry.update),
        command: commands[index] ?? null
      }))
    ),
    storageSeq: state.storageSeq,
    revision: state.projection?.revision ?? 0,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

export type YjsArchiveVerifyResult =
  | { ok: true; recordCount: number; updateCount: number }
  | { ok: false; code: YjsArchiveErrorCode; detail: string };

export type YjsArchiveErrorCode =
  | "invalid-shape"
  | "unsupported-format"
  | "checksum-mismatch"
  | "forbidden-content";

/** 校验 Yjs 段：shape、格式版本、checksum 与「无禁止内容」。 */
export async function verifyYjsArchive(input: unknown): Promise<YjsArchiveVerifyResult> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, code: "invalid-shape", detail: "Yjs 段必须是对象" };
  }
  const section = input as Partial<YjsArchiveSection>;
  if (section.section !== YJS_ARCHIVE_SECTION) {
    return { ok: false, code: "invalid-shape", detail: `不是 ${YJS_ARCHIVE_SECTION} 段` };
  }
  if (section.formatVersion !== YJS_CANVAS_FORMAT_VERSION) {
    return {
      ok: false,
      code: "unsupported-format",
      detail: `不支持的格式版本：${String(section.formatVersion)}`
    };
  }
  if (!Array.isArray(section.records)) {
    return { ok: false, code: "invalid-shape", detail: "records 必须是数组" };
  }

  // 禁止内容检查：签名 URL / blob / data URL 不得出现在归档文本里。
  const serialized = JSON.stringify(section);
  for (const needle of ["X-Amz-Signature", "q-sign-algorithm", "blob:", "data:"]) {
    if (serialized.includes(needle)) {
      return { ok: false, code: "forbidden-content", detail: `归档包含禁止内容：${needle}` };
    }
  }

  let updateCount = 0;
  for (const record of section.records) {
    if (record.formatVersion !== YJS_CANVAS_FORMAT_VERSION) {
      return { ok: false, code: "unsupported-format", detail: `画布 ${record.canvasId} 格式版本不匹配` };
    }
    const checkpoint = fromBase64(record.checkpointBase64);
    const checkpointHash = await computeUpdateSha256(checkpoint);
    if (checkpointHash !== record.checkpointSha256) {
      return { ok: false, code: "checksum-mismatch", detail: `画布 ${record.canvasId} checkpoint checksum 不一致` };
    }
    for (const entry of record.updates) {
      const update = fromBase64(entry.updateBase64);
      const hash = await computeUpdateSha256(update);
      if (hash !== entry.sha256) {
        return { ok: false, code: "checksum-mismatch", detail: `画布 ${record.canvasId} update seq=${entry.seq} checksum 不一致` };
      }
      updateCount += 1;
    }
  }

  return { ok: true, recordCount: section.records.length, updateCount };
}

/** 恢复（导入）Yjs 段：先校验，再逐画布创建文档并追加 update。 */
export async function restoreYjsArchive(
  repository: YjsDocumentRepository,
  input: unknown
): Promise<{ ok: true; restored: string[] } | { ok: false; code: YjsArchiveErrorCode; detail: string }> {
  const verified = await verifyYjsArchive(input);
  if (!verified.ok) return verified;
  const section = input as YjsArchiveSection;

  const restored: string[] = [];
  for (const record of section.records) {
    // 已存在则先删除，保证恢复收敛到归档状态（显式 replace 语义）。
    await repository.deleteYjsDocument(record.canvasId);
    await repository.createYjsDocument({
      canvasId: record.canvasId,
      formatVersion: record.formatVersion,
      roomEpoch: record.roomEpoch ?? "",
      checkpoint: fromBase64(record.checkpointBase64),
      // projection 由调用方在恢复后从 Y.Doc 重建；这里先给空聚合占位。
      projection: emptyProjection(record),
      revision: record.revision,
      createdAt: record.createdAt
    });

    // 逐条按 seq 应用。**携带原命令**时用同一个 commandId 提交，从而同时还原
    // update 与幂等记录，且不会额外增加 storageSeq（一次提交恰好一条 update）。
    for (const entry of record.updates) {
      const update = fromBase64(entry.updateBase64);
      const command = entry.command ?? {
        commandId: `restore:${record.canvasId}:${entry.seq}`,
        payloadHash: entry.sha256,
        revision: record.revision,
        changed: true,
        actorId: "archive-restore",
        createdAt: record.updatedAt
      };
      const result = await repository.commitYjsCommand({
        canvasId: record.canvasId,
        expectedStorageSeq: entry.seq - 1,
        update,
        revision: command.revision,
        updatedAt: record.updatedAt,
        projection: emptyProjection(record),
        command
      });
      if (!result.ok) {
        return { ok: false, code: "invalid-shape", detail: `画布 ${record.canvasId} 恢复 seq=${entry.seq} 失败` };
      }
    }

    restored.push(record.canvasId);
  }
  return { ok: true, restored };
}

/** 占位聚合：恢复流程只关心 Yjs 状态；调用方随后从 Y.Doc 重建 projection。 */
function emptyProjection(record: YjsArchiveRecord) {
  return {
    id: record.canvasId,
    title: "",
    revision: record.revision,
    document: {
      schemaVersion: "asset-canvas-v1" as const,
      nodes: [],
      edges: [],
      updatedAt: record.updatedAt
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: record.updatedAt
  };
}

// ---------------------------------------------------------------------------
// base64（Yjs 结构字节；与媒体 base64 无关）
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
