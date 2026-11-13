/**
 * Yjs 持久化契约（任务 3.1 / design D7）。
 *
 * 在前置 change 的 `CanvasRepository` **旁边**增加一组能力，而不是把 Yjs bytes 塞进
 * `canvas_json`：两者的写入频率、体积与恢复语义完全不同（checkpoint/update log 会持续
 * 增长，JSON 是投影）。
 *
 * 契约只有 5 个方法（design D7），刻意保持最小：room runtime 需要什么，这里就提供什么。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { ModelScriptBatchMeta, CanvasScriptSubmissionMeta } from "@woohaa3/contracts";
import type { LeaseConflict } from "../world-authoring/spatial-leases.js";

/** 一次命令提交要原子写入的全部内容（design D6/D7）。 */
export type YjsCommandCommit = {
  spatialContext?: import("../world-authoring/spatial-leases.js").SpatialWriteContext;
  signal?: AbortSignal;
  canvasId: string;
  /** 期望的存储 sequence；不匹配即拒绝（防止与其它 writer 交错）。 */
  expectedStorageSeq: number;
  /** 候选 transaction 产生的 Yjs update（已持久化前的候选）。 */
  update: Uint8Array;
  /** 提交后的业务 revision（有净变化才递增）。 */
  revision: number;
  updatedAt: string;
  /** 同事务写入的派生 JSON 投影（复用前置 REST/list/export）。 */
  projection: ServerCanvas;
  /** 命令幂等结果（同事务写入；checkpoint 压缩不得删除）。 */
  command: YjsCommandRecord;
};

/** 命令幂等记录（design D6 / spec「响应丢失后重试」）。 */
export type YjsCommandRecord = {
  commandId: string;
  /** 命令加载荷的稳定哈希；相同 ID 不同哈希必须拒绝。 */
  payloadHash: string;
  revision: number;
  /** 是否为 no-op（有效命令但无净变化）。 */
  changed: boolean;
  actorId: string;
  createdAt: string;
  /**
   * Canvas script 首次提交元数据（change: 2026-10-13-add-canvas-script-authoring，任务 3.2/3.7）。
   *
   * 与命令记录**同事务**写入，只含 digest/版本/refs/首次摘要，**绝不含源码**。JSON
   * 可序列化；旧记录没有该字段。重试返回冻结值，不从当前画布重建。
   */
  script?: CanvasScriptSubmissionMeta;
  modelBatch?: ModelScriptBatchMeta;
  /** Immutable scene-area authority receipt (T06); written in the same transaction. */
  worldAuthoring?: import("@woohaa3/contracts").WorldAuthoringCommandReceipt;
  resourceEdit?: import("@woohaa3/contracts").WorldResourceReceipt;
};

/** 从存储恢复出的完整 Yjs 状态。 */
export type YjsLoadedState = {
  canvasId: string;
  formatVersion: string;
  roomEpoch: string | null;
  /** 完整 checkpoint（可能为空文档的 update）。 */
  checkpoint: Uint8Array;
  /** checkpoint 覆盖到的 sequence。 */
  checkpointSeq: number;
  /** checkpoint 之后的有序 updates（按 seq 升序）。 */
  updates: Array<{ seq: number; update: Uint8Array; sha256: string }>;
  /** 存储中的当前 sequence（用于 CAS）。 */
  storageSeq: number;
  /** 派生 JSON 投影（若存在）。 */
  projection: ServerCanvas | null;
  createdAt: string;
  updatedAt: string;
};

export type YjsCommitResult =
  | { ok: true; storageSeq: number; revision: number; duplicate: boolean }
  | { ok: false; code: "lease-conflict"; conflict?: LeaseConflict }
  | { ok: false; code: "spatial-rejected"; reason: string; conflict?: LeaseConflict }
  | { ok: false; code: "storage-seq-conflict"; currentSeq: number }
  | { ok: false; code: "command-id-reused"; existingHash: string };

export type YjsRepositoryHealth = {
  ok: boolean;
  backend: string;
  reason?: string;
};

/**
 * Yjs 文档仓储契约。
 *
 * 实现必须保证：`commitYjsCommand` 把 update、sequence、派生 JSON 与 command result
 * 写在**同一个数据库事务**里（design D6 步骤 3），任一失败全回滚。
 */
export interface YjsDocumentRepository {
  /** 加载 checkpoint + 后续 updates + projection。不存在返回 null。 */
  loadYjsState(canvasId: string): Promise<YjsLoadedState | null>;

  /** 原子提交一个命令：追加 update、推进 seq、更新 projection、写 command 记录。 */
  commitYjsCommand(commit: YjsCommandCommit): Promise<YjsCommitResult>;

  /** 查询命令幂等结果。 */
  getCommandRecord(canvasId: string, commandId: string): Promise<YjsCommandRecord | null>;

  /**
   * Latest scene-area authority command for one operation (T06).
   *
   * Undo/redo walk this chain: forward → undo → redo. Implementations without
   * receipts may omit it; the authority service then fails closed.
   */
  findLatestWorldAuthoringCommand?(canvasId: string, operationId: string): Promise<YjsCommandRecord | null>;

  /**
   * 在 cutoffSeq 原子替换 checkpoint：写入新 checkpoint/snapshotSeq，删除
   * `seq <= cutoffSeq` 的 updates。cutoff 之后的 updates 必须保留（design D8）。
   */
  replaceCheckpoint(input: {
    canvasId: string;
    cutoffSeq: number;
    checkpoint: Uint8Array;
    updatedAt: string;
  }): Promise<void>;

  /**
   * 确保结构化目录里存在这张画布（本机首次从远端拉下来时用）。
   *
   * 结构化目录（`canvases` 表）与 Yjs 文档是**两张独立的表**：远端画布被 seed 下来之后
   * 只有 Yjs 文档、没有目录行，它就不会出现在"我的画布"里，命令提交也会因为找不到
   * 画布行而失败。实现必须幂等：已存在时只更新标题/时间，不覆盖 revision 与内容。
   *
   * 可选：纯 Yjs 仓储（测试替身）可以不实现，此时该画布只在本机 Yjs 层存在。
   */
  ensureCanvasRow?(canvas: ServerCanvas): Promise<void>;

  /** 写入初始 checkpoint（为画布建立首个 Y.Doc）。 */
  createYjsDocument(input: {
    canvasId: string;
    formatVersion: string;
    roomEpoch: string;
    checkpoint: Uint8Array;
    projection: ServerCanvas;
    revision: number;
    createdAt: string;
  }): Promise<void>;

  /** 删除整个 Yjs 文档（含 updates 与 command 记录）。 */
  deleteYjsDocument(canvasId: string): Promise<void>;

  health(): Promise<YjsRepositoryHealth>;
}

/** update 的 SHA-256（内容寻址校验；恢复时验证完整性）。 */
export async function computeUpdateSha256(update: Uint8Array): Promise<string> {
  // 复制为**独立**缓冲再求摘要：`Buffer#slice`/子视图的 `.buffer` 可能指向更大的底层
  // pool（甚至包含未使用字节），直接对 `.buffer` 求 SHA-256 会算错。
  const bytes = new Uint8Array(update);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
