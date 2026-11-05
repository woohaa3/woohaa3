/**
 * 统一生成运行状态契约：类型与常量
 * （change: 2026-10-12-unify-generation-history-strip，design D1）。
 *
 * 所有实际生成操作（文本/图片/视频/音频任务、批量运行、3D 模型、片场、镜头、对象/动作生成、
 * 模型/当前帧截图、片场视频导出）共享同一稳定操作身份与生命周期读模型。本模块是纯类型/常量
 * 叶子：不依赖 DOM、Node、Yjs，也不携带完整历史正文或媒体 bytes。
 *
 * 关键约束：
 * - 运行状态是**可丢弃的读模型**，MUST NOT 写入 Canvas Y.Doc / `ServerCanvas`；
 * - 身份是 `(canvasId, nodeId, operationId)`，服务端 owner 复用 runId，本地 owner 用稳定
 *   `local-<id>`；
 * - 服务端 owner 仍以既有 `taskStatus` 为权威；本读模型不伪造 canonical 状态。
 */

/** 运行状态契约版本；结构变化必须升版本。 */
export const CANVAS_RUN_STATE_VERSION = "woohaa-canvas-run-state-v1" as const;
export type CanvasRunStateVersion = typeof CANVAS_RUN_STATE_VERSION;

/**
 * 生成操作种类。
 *
 * 覆盖普通内容生成、3D/片场/镜头/对象/动作生成、截图与视频导出。批量运行不新增种类，
 * 而是按其成员各自的种类分别登记。
 */
export const CANVAS_OPERATION_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "model",
  "camera",
  "object",
  "motion",
  "screenshot",
  "frame-capture",
  "video-export"
] as const;
export type CanvasOperationKind = (typeof CANVAS_OPERATION_KINDS)[number];

export function isCanvasOperationKind(value: unknown): value is CanvasOperationKind {
  return typeof value === "string" && (CANVAS_OPERATION_KINDS as readonly string[]).includes(value);
}

/**
 * 操作生命周期状态。
 *
 * - `queued`/`running`：非终态；
 * - `succeeded`/`failed`/`cancelled`：权威终态；
 * - `interrupted`：断线/服务重启/未结算的派生状态（客户端恢复时标记）；
 * - `partial`：批量等有部分成员成功、部分失败/跳过的终态。
 */
export const CANVAS_OPERATION_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "partial"
] as const;
export type CanvasOperationState = (typeof CANVAS_OPERATION_STATES)[number];

export const CANVAS_ACTIVE_OPERATION_STATES = ["queued", "running", "interrupted"] as const;
export const CANVAS_TERMINAL_OPERATION_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "partial"
] as const;

export function isCanvasOperationState(value: unknown): value is CanvasOperationState {
  return typeof value === "string" && (CANVAS_OPERATION_STATES as readonly string[]).includes(value);
}

export function isActiveOperationState(state: CanvasOperationState): boolean {
  return (CANVAS_ACTIVE_OPERATION_STATES as readonly string[]).includes(state);
}

export function isTerminalOperationState(state: CanvasOperationState): boolean {
  return (CANVAS_TERMINAL_OPERATION_STATES as readonly string[]).includes(state);
}

/**
 * 生命周期 owner。
 *
 * - `server`：经 Task Service / Canvas Service 执行（含 3D/镜头服务端生成）；
 * - `local`：浏览器本地编码/截图/导出（不强行走 Task Service）。
 */
export type RunLifecycleOwner = "server" | "local";

/** 稳定操作身份。 */
export type CanvasOperationId = {
  canvasId: string;
  nodeId: string;
  /**
   * 稳定操作 id：服务端 owner 复用 runId；本地 owner 使用 `local-<uuid>`。
   * 同一操作在提交、执行、结算与恢复期间保持不变。
   */
  operationId: string;
};

/** 统一运行状态记录（有界摘要，不含完整内容/媒体 bytes）。 */
export type CanvasOperationRecord = {
  operationId: string;
  canvasId: string;
  nodeId: string;
  kind: CanvasOperationKind;
  state: CanvasOperationState;
  owner: RunLifecycleOwner;
  /** 0..100；仅非终态有意义。 */
  progress?: number;
  /** 安全错误摘要（不含堆栈/凭据/本机路径）。 */
  error?: string;
  /** 本地提交被拒（网关拒绝等）；不伪造 canonical 状态。 */
  localFailure?: boolean;
  /** 是否属于批量运行成员（不参与活动数量聚合，仅用于分组/展示）。 */
  batch?: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * 单节点运行摘要（底部历史条、聚合遮罩与面板门禁的有界读模型）。
 *
 * 这是投影给渲染层的形状：有界、不含完整历史列表或媒体 bytes。
 */
export type CanvasNodeRunSummary = {
  canvasId: string;
  nodeId: string;
  /** 该节点当前非终态操作（若有）；同一普通节点可有多个，但仅首个用于门禁。 */
  active: CanvasOperationRecord | null;
  /** 该节点是否为聚合节点。 */
  isAggregate: boolean;
  /** 聚合节点是否存在运行中操作（驱动整体遮罩）。 */
  aggregateRunning: boolean;
};

/** 判定聚合节点的最小信息。 */
export type AggregateRunNodeInput = { type: string };

/** 稳定错误码（跨进程按字符串判定）。 */
export const RUN_STATE_ERROR_CODES = ["OPERATION_IN_PROGRESS"] as const;
export type RunStateErrorCode = (typeof RUN_STATE_ERROR_CODES)[number];
