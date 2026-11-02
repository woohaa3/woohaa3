/**
 * 服务端 canvas room：命令验证、事务与持久化管线
 * （自 `room.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R27）。
 *
 * 只接受受控 `RoomExecutionHost`：文档与 revision/storageSeq 的唯一 owner 仍是 `CanvasRoom`，
 * 本模块不持有第二份 doc/revision。durable 成功后的 published 前进、observer 顺序与广播由
 * owner 的 `finalizeAccepted` 完成，保持「持久化先于确认和广播」的结构性不变式。
 */
import * as Y from "yjs";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { MediaStorage } from "@woohaa3/contracts";
import type { ModelScriptBatchMeta, CanvasScriptSubmissionMeta } from "@woohaa3/contracts";
import type { YjsCommandRecord, YjsDocumentRepository } from "./yjs-repository.js";
import { applyCommandTransaction } from "./command-transaction.js";
import { computeCommandPayloadHash, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoomState, RoomCommandResult, RoomSubmitOptions } from "./room-types.js";

/** room 命令管线所需的最小受控上下文；由 `CanvasRoom` 提供（唯一 doc/revision owner）。 */
export type RoomExecutionHost = {
  content?: import("@woohaa3/contracts").ContentContributionResolver;
  lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver;
  readonly canvasId: string;
  readonly state: CanvasRoomState;
  readonly quarantineReason: string | null;
  readonly repository: YjsDocumentRepository;
  readonly mediaStorage: MediaStorage | undefined;
  readonly verifyAssets: boolean;
  readonly storageSeq: number;
  readonly publishedDoc: Y.Doc;
  nowIso(): string;
  exportCanvas(): { ok: true; canvas: ServerCanvas } | { ok: false; code?: string; message: string };
  /** durable 成功后由 owner 推进 published/revision、按序调用 observer 并广播。 */
  finalizeAccepted(input: {
    storageSeq: number;
    update: Uint8Array | null;
    revision: number;
    canvas: ServerCanvas;
    commands: readonly unknown[];
  }): void;
};

/**
 * 串行「读改写」提交（change: add-model-camera-mcp-crud）。
 *
 * 在 room 串行队列内：先按 `commandId` 查询 durable 回执（命中即返回 duplicate，保证
 * 传输层重试幂等，不重复应用变更），否则导出当前 published 聚合、交给调用方按**最新
 * 状态**派生命令批次，再走既有 `executeCommand`。派生与提交之间没有其它同 room 命令交错，
 * 因此两个并发单条写入不会互相覆盖。
 *
 * `derive` 只在无回执时调用；返回 `ok:false` 时直接返回领域拒绝，不占用 revision。
 *
 * change: 2026-10-13-add-canvas-script-authoring —— 扩展为可选的脚本提交身份复核与元数据：
 * - `expectedPayloadHash`：脚本请求 hash；命中同 commandId 但 hash 不同时返回 `request-id-reused`；
 *   相同则返回**冻结的首次回执**（不重新执行、不重新布局、不推进 revision）；
 * - derive 可返回 `script`：源码无关的提交元数据，与 update 同事务写入（noop 也写）。
 */
export async function executeDerived(
  host: RoomExecutionHost,
  input: {
    commandId: string;
    /** 脚本请求 hash；提供时用于区分「重试已成功请求」与「复用身份改内容」。 */
    expectedPayloadHash?: string;
    expectedModelBatchHash?: string;
    /** T06: same operationId must carry the same frozen scene-area intent. */
    expectedWorldAuthoringHash?: string;
    derive: (canvas: ServerCanvas) =>
      | { ok: true; batch: CanvasCommandBatch; script?: CanvasScriptSubmissionMeta; modelBatch?: ModelScriptBatchMeta; worldAuthoring?: import("@woohaa3/contracts").WorldAuthoringCommandReceipt }
      | { ok: false; code: string; message: string }
      | Promise<
          | { ok: true; batch: CanvasCommandBatch; script?: CanvasScriptSubmissionMeta; modelBatch?: ModelScriptBatchMeta; worldAuthoring?: import("@woohaa3/contracts").WorldAuthoringCommandReceipt }
          | { ok: false; code: string; message: string }
        >;
  },
  options?: RoomSubmitOptions
): Promise<RoomCommandResult> {
  if (host.state === "quarantined") {
    return { ok: false, status: "failed", commandId: input.commandId, code: "room-quarantined", message: host.quarantineReason ?? "room 已隔离", retryable: false };
  }
  if (options?.authorize && !await options.authorize().catch(() => false)) return {
    ok: false, status: "rejected", commandId: input.commandId, code: "write-forbidden", message: "无权写入该画布"
  };
  // 幂等预检在派生之前：命中同 commandId 的回执直接返回首次结果，不重新读取/应用变更。
  const existing = input.commandId.trim() === "" ? null : await host.repository.getCommandRecord(host.canvasId, input.commandId);
  if (existing) {
    if (input.expectedWorldAuthoringHash !== undefined && existing.worldAuthoring?.intentHash !== input.expectedWorldAuthoringHash) return {
      ok: false, status: "rejected", commandId: input.commandId, code: "request-id-reused", message: "相同 operationId 使用了不同场景意图"
    };
    if (input.expectedModelBatchHash !== undefined && existing.modelBatch?.submissionHash !== input.expectedModelBatchHash) return {
      ok: false, status: "rejected", commandId: input.commandId, code: "request-id-reused", message: "相同 requestId 使用了不同模型批次"
    };
    // 脚本提交：同身份不同 hash 必须拒绝（不静默返回旧回执）。
    if (input.expectedPayloadHash !== undefined && existing.payloadHash !== input.expectedPayloadHash) {
      return {
        ok: false,
        status: "rejected",
        commandId: input.commandId,
        code: "request-id-reused",
        message: "相同 requestId 使用了不同脚本或 expectedRevision"
      };
    }
    return {
      ok: true,
      status: "duplicate",
      commandId: input.commandId,
      revision: existing.revision,
      noop: !existing.changed,
      update: null,
      ...(existing.script ? { script: existing.script } : {}),
      ...(existing.modelBatch ? { modelBatch: existing.modelBatch } : {}),
      ...(existing.worldAuthoring ? { worldAuthoring: existing.worldAuthoring } : {}),
      duplicate: true
    };
  }
  const exported = host.exportCanvas();
  if (!exported.ok) {
    return { ok: false, status: "failed", commandId: input.commandId, code: "canvas-unavailable", message: exported.message, retryable: true };
  }
  const derived = await input.derive(exported.canvas);
  if (!derived.ok) {
    return { ok: false, status: "rejected", commandId: input.commandId, code: derived.code, message: derived.message };
  }
  return executeCommand(host, derived.batch, { ...options, ...(derived.script ? { script: derived.script } : {}), ...(derived.modelBatch ? { modelBatch: derived.modelBatch } : {}), ...(derived.worldAuthoring ? { worldAuthoring: derived.worldAuthoring } : {}) });
}

export async function executeCommand(
  host: RoomExecutionHost,
  batch: CanvasCommandBatch,
  options?: RoomSubmitOptions
): Promise<RoomCommandResult> {
  const rejected = precheck(host, batch);
  if (rejected) return rejected;

  // 每画布访问屏障（change: 2026-10-13-...，任务 4.5/6.2/6.3）：write 复核在 room 串行队列**内**、
  // 应用与持久 commit **之前**执行。这样 ACL 撤 write 与 command commit 通过同一队列排序：
  // 屏障前完成的 commit 允许成功，撤权生效后的 commit 必须拒绝；检查与持久之间无无保护窗口。
  // 复核失败即拒绝且不形成新 revision/不广播（返回 `write-forbidden`）。
  if (options?.authorize) {
    let allowed = false;
    try {
      allowed = await options.authorize();
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return {
        ok: false,
        status: "rejected",
        commandId: batch.commandId,
        code: "write-forbidden",
        message: "无权写入该画布"
      };
    }
  }

  // 幂等查询（在应用之前）。
  const payloadHash = await computeCommandPayloadHash({
    canvasId: batch.canvasId,
    commands: batch.commands
  });
  const existing = await host.repository.getCommandRecord(host.canvasId, batch.commandId);
  if (existing) {
    const duplicate = duplicateResult(existing, payloadHash, batch.commandId);
    if (duplicate) return duplicate;
  }

  // 每个命令从 published 重建 authoring：保证「下一命令基于最后 durable 状态」
  // （design D6：提交失败时从 published 重建 authoring）。
  // 每个命令从 published 重建 authoring：保证「下一命令基于最后 durable 状态」，
  // 也保证提交失败时不需要回滚 published。
  const authoring = cloneDoc(host.publishedDoc);
  const outcome = await applyCommandTransaction({
    doc: authoring,
    batch,
    mediaStorage: host.mediaStorage,
    now: host.nowIso(),
    verifyAssets: host.verifyAssets,
    content: host.content,
    lifecycle: host.lifecycle
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: "rejected",
      commandId: batch.commandId,
      code: outcome.code,
      message: outcome.message
    };
  }

  const record: YjsCommandRecord = {
    commandId: batch.commandId,
    payloadHash,
    revision: outcome.revision,
    changed: outcome.changed,
    actorId: batch.actorId,
    createdAt: host.nowIso(),
    // noop 也保存首次回执（spec）；元数据在首次提交时冻结。
    ...(options?.script ? { script: options.script } : {}),
    ...(options?.modelBatch ? { modelBatch: options.modelBatch } : {}),
    ...(options?.worldAuthoring ? { worldAuthoring: options.worldAuthoring } : {})
  };

  // 无净变化：仍持久化幂等记录，但 update 为空、revision 不变（design D5）。
  const updateForStorage = outcome.update ?? new Uint8Array(0);
  if (options?.signal?.aborted) return { ok: false, status: "rejected", commandId: batch.commandId, code: "cancelled", message: "提交已取消" };
  const commit = await host.repository.commitYjsCommand({
    spatialContext: options?.spatialContext,
    signal: options?.signal,
    canvasId: host.canvasId,
    expectedStorageSeq: host.storageSeq,
    update: updateForStorage,
    revision: outcome.revision,
    updatedAt: outcome.updatedAt,
    projection: outcome.canvas,
    command: record
  }).catch((error: unknown) => {
    if (options?.signal?.aborted && error instanceof Error && error.name === "AbortError") {
      return { ok: false as const, code: "cancelled" as const };
    }
    // 暂时存储失败：不广播、不确认成功（design D6 步骤 5）。
    return { ok: false as const, code: "storage-failed" as const, message: message(error) };
  });

  if (!commit.ok) {
    return commitFailure(commit, batch.commandId);
  }

  // durable 成功 → 前进 published → 广播 → 才返回 accepted（design D6 步骤 4）。
  const acceptedUpdate = outcome.changed ? outcome.update : null;
  host.finalizeAccepted({
    storageSeq: commit.storageSeq,
    update: acceptedUpdate,
    revision: outcome.revision,
    canvas: outcome.canvas,
    commands: batch.commands
  });

  return {
    ok: true,
    status: "accepted",
    commandId: batch.commandId,
    revision: outcome.revision,
    noop: !outcome.changed,
    update: acceptedUpdate,
    ...(options?.script ? { script: options.script } : {}),
    ...(options?.modelBatch ? { modelBatch: options.modelBatch } : {}),
    ...(options?.worldAuthoring ? { worldAuthoring: options.worldAuthoring } : {})
  };
}

/** room 状态与批次身份的前置检查；命中即返回拒绝/失败结果。 */
function precheck(host: RoomExecutionHost, batch: CanvasCommandBatch): RoomCommandResult | null {
  if (host.state === "quarantined") {
    return {
      ok: false,
      status: "failed",
      commandId: batch.commandId,
      code: "room-quarantined",
      message: host.quarantineReason ?? "room 已隔离"
    };
  }
  if (host.state !== "ready") {
    return {
      ok: false,
      status: "failed",
      commandId: batch.commandId,
      code: "room-not-ready",
      message: "room 尚未加载完成"
    };
  }
  // canvasId 必须匹配本 room，否则是路由错误。
  if (batch.canvasId !== host.canvasId) {
    return {
      ok: false,
      status: "rejected",
      commandId: batch.commandId,
      code: "canvas-mismatch",
      message: `批次 canvasId ${batch.canvasId} 与本 room ${host.canvasId} 不一致`
    };
  }
  return null;
}

/** payload 不同 → request-id-reused；相同 → duplicate 回执（带冻结的首次脚本元数据）。 */
function duplicateResult(
  existing: YjsCommandRecord,
  payloadHash: string,
  commandId: string
): RoomCommandResult | null {
  if (existing.payloadHash !== payloadHash) {
    return {
      ok: false,
      status: "rejected",
      commandId,
      code: "command-id-reused",
      message: "相同 commandId 使用了不同 payload"
    };
  }
  return {
    ok: true,
    status: "duplicate",
    commandId,
    revision: existing.revision,
    noop: !existing.changed,
    update: null,
    ...(existing.script ? { script: existing.script } : {}),
      ...(existing.modelBatch ? { modelBatch: existing.modelBatch } : {}),
      ...(existing.worldAuthoring ? { worldAuthoring: existing.worldAuthoring } : {}),
    duplicate: true
  };
}

/** 持久化失败 → 稳定错误码映射。 */
function commitFailure(
  commit: { ok: false; code: string; message?: string; reason?: string; conflict?: import("../world-authoring/spatial-leases.js").LeaseConflict },
  commandId: string
): RoomCommandResult {
  if (commit.code === "cancelled") return { ok: false, status: "rejected", commandId, code: "cancelled", message: "提交已取消" };
  if (commit.code === "lease-conflict") return { ok: false, status: "rejected", commandId, code: "lease-conflict", message: "对象正在被其他运行占用", conflict: commit.conflict };
  if (commit.code === "spatial-rejected") return { ok: false, status: "rejected", commandId, code: "spatial-rejected", message: "空间写入资格无效", spatialReason: commit.reason, conflict: commit.conflict };
  if (commit.code === "storage-seq-conflict") {
    // room 已在本层之上自动重载并重试（见 `CanvasRoom.withStorageSeqRecovery`）；走到这里
    // 说明重试上限用尽（仍在与别的 writer 竞争），因此这里的失败确实可以再试一次。
    return {
      ok: false,
      status: "failed",
      commandId,
      code: "storage-seq-conflict",
      message: "存储 sequence 已变化，请重试",
      retryable: true
    };
  }
  if (commit.code === "command-id-reused") {
    return {
      ok: false,
      status: "rejected",
      commandId,
      code: "command-id-reused",
      message: "相同 commandId 使用了不同 payload"
    };
  }
  return {
    ok: false,
    status: "failed",
    commandId,
    code: "storage-failed",
    message: "message" in commit && commit.message ? commit.message : "存储提交失败"
  };
}

/** 用二进制快照克隆一个 Y.Doc（保持 update 语义，见 mapping 注释）。 */
function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
