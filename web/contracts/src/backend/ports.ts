/**
 * 统一后端进程的进程内类型化契约（change: 2026-10-06-unify-backend-runtime-with-cordis，任务 1.2 / design D2）。
 *
 * 后端合并为单一进程后，领域模块之间不再通过服务间 HTTP/WS 协议调用，而是注入这些**纯类型**
 * 契约，由各模块提供进程内适配器实现。契约只描述稳定 DTO 与句柄，不暴露数据库、Y.Doc bytes、
 * provider/COS 凭据或服务实现对象。
 *
 * 这些类型刻意与既有 contracts（Task/Media 协议 DTO）对齐，使网络协议与进程内调用共享同一
 * 数据形状；网络协议本身在任务 2.3 被移除。
 */
import type { MediaLocator } from "../media/storage.js";
import type {
  TaskExecutionDetail
} from "../task/history.js";
import type {
  CanvasTaskActivityEventBatch,
  CanvasTaskActivitySnapshot
} from "../task/activity.js";
import type { TaskSubmitRequest, TaskSubmitResponse } from "../task/protocol.js";
import type { MediaMetadata } from "../media/protocol.js";
import type { MediaStorageScope } from "../media/storage.js";

export type BackendWorldConversionPort = {
  prepare(input: import("../canvas/world-conversion.js").WorldConversionPrepareInput, options?: { signal?: AbortSignal }): Promise<import("../canvas/world-conversion.js").WorldConversionPrepareOutcome>;
};

/** Canvas -> Task 进程内契约（替代 CanvasTaskClient 的网络实现）。 */
export type BackendTaskPort = {
  /** 按可信扩展及不可变配置版本裁剪的非画布任务端口。 */
  extensionTasks?: (extensionId: string, configVersion: number) => import("../extension/services/host/facades.js").ApplicationExtensionTaskFacade;
  submit(request: TaskSubmitRequest): Promise<TaskSubmitResponse>;
  cancel(workerTaskKey: string): Promise<void>;
  status(workerTaskKey: string): Promise<TaskExecutionDetail | null>;
  history(query: { after?: number; limit?: number }): Promise<{ items: TaskExecutionDetail[]; cursor: number }>;
  canvasActivity(canvasId: string, query?: { cursor?: string; limit?: number }): Promise<CanvasTaskActivitySnapshot>;
  canvasActivitySince(canvasId: string, after: number, limit?: number): Promise<CanvasTaskActivityEventBatch>;
  canvasActivityChanges(canvasId: string, after: number, limit?: number): Promise<CanvasTaskActivityEventBatch>;
};

/** Canvas/Task -> Media 进程内契约（替代 Media client 的网络实现）。 */
export type BackendMediaPort = {
  /** 有界、内容寻址的进程内资源读写；不暴露存储驱动。 */
  resources?: import("../extension/services/host/facades.js").ApplicationExtensionMediaResourcesFacade;
  /**
   * 核验稳定对象是否存在且 metadata 一致。
   *
   * `scope` 用于把「属于哪张画布」透传给存储层：远端画布的资产可能只在服务端托管存储里，
   * 不带作用域会退化成只查主存储。省略时保持旧行为（只看主存储）。
   */
  verify(
    storageKey: string,
    expected?: Partial<Omit<MediaMetadata, "storageKey">>,
    scope?: MediaStorageScope
  ): Promise<{ exists: boolean; matches: boolean; metadata?: MediaMetadata }>;
  sign(storageKey: string, expiresSeconds?: number, scope?: MediaStorageScope): Promise<string>;
  importFromUrl(input: { url: string; contentType?: string; maxBytes?: number; canvasId?: string }): Promise<MediaMetadata>;
  importBytes(input: { bytesBase64: string; contentType: string; maxBytes?: number; canvasId?: string }): Promise<MediaMetadata>;
  /**
   * 按 locator 导入：字节可能在任何后端（含服务端），由存储层内部取数并落到目标位置。
   *
   * 幂等（内容寻址去重）；失败必须显式失败，**不得**回落成签名地址下载——那会把一个
   * 根因报成两个不相干的错误。
   */
  importFromLocator(input: {
    locator: MediaLocator;
    canvasId?: string;
    contentType?: string;
    maxBytes?: number;
    expected?: { contentType?: string; size?: number; checksum?: string };
  }): Promise<MediaMetadata>;
};

/**
 * MCP -> Canvas 进程内契约（替代 CanvasMcpClient 的网络实现）。
 *
 * 结果类型由 Canvas MCP 面在 contracts 中声明；这里只保留最小方法集，避免把 Canvas 实现
 * 导入 MCP 模块。具体结果类型用 `unknown` 别名在此模块由调用方窄化（调用方知道期望形状）。
 */
export type BackendCanvasMcpPort = {
  listModelNodes(input: { canvasId?: string }): Promise<unknown>;
  getModelNode(input: { canvasId: string; nodeId: string }): Promise<unknown>;
  submitScript(input: { canvasId: string; nodeId: string; source: string; version?: number }): Promise<unknown>;
  renderPreview(input: {
    canvasId: string;
    nodeId: string;
    width?: number;
    height?: number;
    background?: string;
    cameraPreset?: string;
  }): Promise<unknown>;
  applyCommands(input: { canvasId: string; commandId: string; baseRevision: number; commands: readonly unknown[] }): Promise<unknown>;
  mutateCameras(input: { canvasId: string; nodeId: string; requestId: string; mutation: unknown }): Promise<unknown>;
  ready(): Promise<{ ready: boolean; reason?: string }>;
};

/**
 * MCP -> Canvas Agent authoring 进程内契约（替代 AgentCanvasClient 的网络实现）。
 *
 * 方法体为稳定的结构化输入/输出；具体 DTO 由 Canvas agent-authoring 面在 contracts 中声明，
 * 调用方按已知形状窄化。
 */
export type BackendAgentCanvasPort = {
  listCanvases(input: { canvasId?: string; cursor?: string; limit?: number }): Promise<unknown>;
  getGraph(input: {
    canvasId?: string;
    nodeIds?: readonly string[];
    aroundNodeId?: string;
    depth?: number;
    includePrompt?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<unknown>;
  getChanges(input: { canvasId?: string; sinceRevision: number; limit?: number }): Promise<unknown>;
  applyPlan(input: unknown): Promise<unknown>;
  runNode?(input: unknown): Promise<unknown>;
  getRun?(input: { canvasId?: string; nodeId: string; runId: string; waitMs?: number }): Promise<unknown>;
  cancelRun?(input: { canvasId?: string; nodeId: string; runId: string }): Promise<unknown>;
  getOutput?(input: { canvasId?: string; nodeId: string; runId: string }): Promise<unknown>;
};

/** 一个后端模块对统一进程暴露的最小契约（生命周期 + HTTP 面）。 */
export type BackendModule = {
  handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean>;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
};
