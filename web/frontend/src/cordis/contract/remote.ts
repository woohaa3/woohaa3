/**
 * 三大远端 adapter 契约（Canvas / Task / Media Remote）。
 * 从 `contracts.ts` façade 拆分（change: 2026-09-28-split-frontend-god-plugins，task 1.5）。
 */
import type {
  CanvasGenerationHistoryListPage,
  CanvasTaskActivity,
  CanvasTaskActivityEventBatch,
  CanvasTaskActivitySnapshot,
  CanvasTaskCatalog,
  CreatePromptSnippetInput,
  CreatePromptSnippetTagInput,
  EditSessionBeginRequest,
  ImageProjectReferencesRequest,
  ImageProjectReferencesResult,
  EditSessionBeginResponse,
  EditSessionCompleteRequest,
  EditSessionCompletionReceipt,
  EditSessionStatusRequest,
  MergeNodeHistoryReceipt,
  NodeGenerationHistoryDetail,
  NodeGenerationHistoryListPage,
  PromptSnippet,
  PromptSnippetErrorCode,
  PromptSnippetListQuery,
  PromptSnippetListResult,
  PromptSnippetTag,
  RenamePromptSnippetTagInput,
  UpdatePromptSnippetInput
} from "@woohaa3/contracts";
import type { SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import type { ApplicationRemote } from "../services/application-remote.js";
// Task History 只读查询契约的权威定义在 shared/task-history；Cordis 契约只聚合、不重复定义
// （change: 2026-10-10-extract-task-history-page，design D3）。
import type { TaskHistoryReader } from "../../shared/task-history/client.js";

/** 画布活动有限增量查询（`GET /changes`）。 */
export type CanvasActivityChangesQuery = { canvasId: string; after: number; limit?: number };

export type CanvasRunRequest = {
  nodeId: string;
  runId: string;
  jobId: string;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  /** T10 exact capture binding frozen at click time. */
  worldCapture?: import("@woohaa3/contracts").WorldCaptureGenerationBinding;
};

export type CanvasRunResult =
  | { ok: true; runId: string; jobId: string }
  | { ok: false; error: string; code?: string };

export type CanvasCaptureFreezeResult =
  | { ok: true; binding: import("@woohaa3/contracts").WorldCaptureGenerationBinding }
  | {
      ok: false;
      code: string;
      error: string;
      requestedKey?: import("@woohaa3/contracts").WorldCaptureVersionKey;
      currentKey?: import("@woohaa3/contracts").WorldCaptureVersionKey;
    };

/** 页面驱动取景：宿主登记的待渲染镜头项。 */
export type PageCapturePendingEntry = {
  attemptId?: string;
  canvasId: string;
  cameraId: string;
  key: import("@woohaa3/contracts").WorldCaptureVersionKey;
  width: number;
  height: number;
  kind?: "static" | "dynamic";
  dynamicKey?: import("@woohaa3/contracts").WorldCaptureDynamicVersionKey;
  fps?: number;
  timeRange?: import("@woohaa3/contracts").WorldCaptureTimeRange;
  animationNodeId?: string;
};

export type PageCapturePendingResult =
  | { ok: true; captures: PageCapturePendingEntry[] }
  | { ok: false; code: string; error: string };

/** 镜头卡片状态列表（静态图片 / 动态视频共用）。 */
export type WorldCaptureStatusResult =
  | { ok: true; statuses: import("@woohaa3/contracts").WorldCaptureFramingStatus[] }
  | { ok: false; code: string; error: string };
export type CanvasCancelResult = { ok: true } | { ok: false; error: string };

export type ModelScriptReport = {
  canvasId: string;
  nodeId: string;
  status: "ok" | "failed";
  message?: string;
};

/**
 * Canvas Remote：Canvas Yjs transport、语义命令 wire、run/cancel、Model MCP report、
 * 提示词片段目录的唯一浏览器出口。所有最终进入 Canvas Service 的协议都在这里。
 */
export type WorldRemoteOutcome<T> = T & { transportCode?: string };

export interface CanvasRemoteService {
  issueWorldToolContext(input: import("@woohaa3/contracts").WorldToolContextRequest, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldToolContextOutcome>>;
  revokeWorldToolContext(input: import("@woohaa3/contracts").WorldToolContextRevokeInput, signal?: AbortSignal): Promise<WorldRemoteOutcome<{ ok: true } | import("@woohaa3/contracts").WorldAuthoringFailure>>;
  saveWorldCamera(input: import("@woohaa3/contracts").WorldCameraSettingsSaveInput, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldCameraSettingsSaveOutcome>>;
  restoreWorldCamera(input: import("@woohaa3/contracts").WorldCameraRestoreInput, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldCameraRestoreOutcome>>;
  listWorldCameraHistory(input: import("@woohaa3/contracts").WorldCameraHistoryListInput, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldCameraHistoryListOutcome>>;
  prepareSceneArea(input: { canvasId: string; areaId: string }, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldAuthoringPrepareOutcome>>;
  executeSceneArea(input: import("@woohaa3/contracts").WorldAuthoringExecuteInput, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldAuthoringExecuteOutcome>>;
  historySceneArea(direction: "undo" | "redo", input: import("@woohaa3/contracts").WorldAuthoringHistoryInput, signal?: AbortSignal): Promise<WorldRemoteOutcome<import("@woohaa3/contracts").WorldAuthoringHistoryOutcome>>;
  prepareWorldConversion(input: import("@woohaa3/contracts").WorldConversionPrepareInput, signal?: AbortSignal): Promise<import("@woohaa3/contracts").WorldConversionPrepareOutcome>;
  commitWorldConversion(input: import("@woohaa3/contracts").WorldConversionCommitInput, signal?: AbortSignal): Promise<import("@woohaa3/contracts").WorldConversionCommitOutcome>;
  /**
   * 打开当前 Canvas page 的 `canvas-yjs` 逻辑通道
   * （change: unify-canvas-session-websocket，design D2）。
   *
   * 物理 WebSocket 由 page-owned Canvas Session transport 唯一创建；这里只返回逻辑通道
   * transport，Yjs provider 不再自行创建 socket。
   */
  openCanvasSession(canvasId: string, roomEpoch: string | null): SyncSocket;
  /**
   * 关闭并释放 page-owned Canvas Session 物理连接（切换画布/离开页面/dispose scope）。
   * 幂等；释放后 `openCanvasSession` 会重新建立一条连接。
   */
  closeCanvasSession(): void;
  /**
   * 显式重建 page-owned Canvas Session 物理连接（不 dispose 通道订阅者）。
   *
   * 断线只读时由 CanvasSession 的重连入口调用：立即发起一次连接（取消退避等待），
   * 各逻辑通道在 open 后自行重新握手（Yjs state vector / task activity cursor）。
   * 未创建过物理连接时为空操作，调用方应改用完整 attach。
   */
  reconnectCanvasSession(): void;
  /** 发起节点任务（最终由 Canvas Service 校验并提交 Task）。 */
  run(request: CanvasRunRequest): Promise<CanvasRunResult>;
  /**
   * T10: wait for the exact current framing and return a trusted frozen binding. A
   * superseded/cancelled/old-version wait returns an explicit error, never another
   * framing. Missing service/route fails closed.
   */
  freezeWorldCapture(input: {
    cameraId: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<CanvasCaptureFreezeResult>;
  /** 页面驱动取景：宿主登记的待渲染镜头清单（无则空数组）。 */
  listPendingPageCaptures(signal?: AbortSignal): Promise<PageCapturePendingResult>;
  reportPageCaptureProgress(input: import("@woohaa3/contracts").WorldCapturePageProgress, signal?: AbortSignal): Promise<boolean>;
  retryPageCapture(cameraId: string, signal?: AbortSignal): Promise<boolean>;
  /** 镜头卡片状态：当前画布已观察镜头的 preview/ready/stale/failed。 */
  listWorldCaptureStatuses(signal?: AbortSignal): Promise<WorldCaptureStatusResult>;
  /** 页面录制的动态镜头视频提交（浏览器 WebCodecs 编码后的 MP4）。 */
  commitPageVideoCapture(input: {
    attemptId?: string;
    signal?: AbortSignal;
    cameraId: string;
    key: import("@woohaa3/contracts").WorldCaptureDynamicVersionKey;
    mp4: Uint8Array;
    width: number;
    height: number;
  }): Promise<CanvasCaptureFreezeResult>;
  /** 页面驱动取景：提交页面渲染的 PNG；版本已变返回 superseded。 */
  commitPageCapture(input: {
    attemptId?: string;
    signal?: AbortSignal;
    cameraId: string;
    key: import("@woohaa3/contracts").WorldCaptureVersionKey;
    png: Uint8Array;
    width: number;
    height: number;
  }): Promise<CanvasCaptureFreezeResult>;
  cancel(input: { nodeId: string; runId: string }): Promise<CanvasCancelResult>;
  /** 上报浏览器 model script 执行结果。 */
  reportModelScript(report: ModelScriptReport): Promise<void>;

  // --- 节点生成历史（change: add-canvas-node-generation-history） --------------
  /** 列出某节点的历史版本（画布授权；cursor 分页）。 */
  listNodeHistory(input: { canvasId: string; nodeId: string; cursor?: string; limit?: number }): Promise<NodeHistoryResult<NodeGenerationHistoryListPage>>;
  /**
   * 列出整张画布全部节点的历史版本
   * （change: add-canvas-generation-history-dialog；画布授权、cursor 分页、可按种类筛选）。
   */
  listCanvasHistory(input: { canvasId: string; summary?: boolean; summaryNodeId?: string; cursor?: string; limit?: number; kind?: string }): Promise<NodeHistoryResult<CanvasGenerationHistoryListPage>>;
  /** 读取某历史条目的完整内容（按需）。 */
  getNodeHistoryDetail(input: { canvasId: string; nodeId: string; entryId: string }): Promise<NodeHistoryResult<NodeGenerationHistoryDetail>>;
  /** 恢复历史版本（原子；调用方负责仅在可写会话调用）。
   * `expectedCurrentIdentity` 为可选并发保护（change: 图片聚焦编辑，design D8）。 */
  applyNodeHistory(input: { canvasId: string; nodeId: string; entryId: string; expectedCurrentIdentity?: string }): Promise<NodeHistoryResult<{ entryId: string; revision: number; alreadyCurrent: boolean }>>;
  /**
   * 清空某节点的全部历史版本（显式写操作）。
   *
   * 只删历史索引，不动画布内容、当前输出资产与 Media 对象；服务端在进行中生成或
   * 未结算编辑会话时以 `conflict` 拒绝。
   */
  clearNodeHistory(input: { canvasId: string; nodeId: string }): Promise<NodeHistoryResult<{ removed: number }>>;
  /**
   * 同类型节点合并到目标节点（不可撤销的原子写操作）
   * （change: 2026-10-27-merge-same-type-node-history，任务 2.5 / design D4、D7）。
   *
   * `operationId` 由调用方在打开确认框时生成，确认与重试复用同一个；服务端据此幂等，
   * 响应丢失后重试返回首次回执（`alreadyMerged: true`）。
   */
  mergeNodeHistory(input: {
    canvasId: string;
    targetNodeId: string;
    sourceNodeId: string;
    operationId: string;
    expectedSourceCurrentIdentity?: string;
    expectedTargetCurrentIdentity?: string;
  }): Promise<NodeHistoryResult<MergeNodeHistoryReceipt>>;
  /** 受控预览 URL（模型缩略图 / 媒体预览 / 视频海报）；只返回同源受控地址。 */
  nodeHistoryPreviewUrl(input: { canvasId: string; nodeId: string; entryId: string; variant: "preview" | "poster" }): string;
  /**
   * 编辑完成面（change: 图片聚焦编辑，design D6）。
   * `begin` 捕获会话基线；`complete` 提交最终编辑版本；`status` 查询受保护回执；
   * `abandon` 放弃尚未提交内容的 prepared 草稿。
   */
  verifyImageProjectReferences(input: ImageProjectReferencesRequest): Promise<NodeHistoryResult<ImageProjectReferencesResult>>;
  editBegin(input: EditSessionBeginRequest): Promise<NodeHistoryResult<EditSessionBeginResponse>>;
  editComplete(input: EditSessionCompleteRequest): Promise<EditCompleteResult>;
  editStatus(input: EditSessionStatusRequest): Promise<NodeHistoryResult<EditSessionCompletionReceipt>>;
  editAbandon(input: EditSessionStatusRequest): Promise<NodeHistoryResult<{ status: "abandoned" }>>;

  // --- 画布任务活动（change: 2026-09-29-add-canvas-task-activity-feed） --------------
  /**
   * 读取当前画布的安全任务活动快照（active + recent）。**必须**走画布授权面，
   * 不得使用全局 operator/admin `taskRemote.createHistory()`。
   */
  taskActivitySnapshot(input: { canvasId: string; cursor?: string; limit?: number }): Promise<NodeHistoryResult<CanvasTaskActivitySnapshot>>;
  /**
   * 有限 JSON 活动增量（断线补偿/冷启动；不持有长连接）
   * （change: unify-canvas-session-websocket，design D5）。
   */
  taskActivityChanges(input: CanvasActivityChangesQuery): Promise<NodeHistoryResult<CanvasTaskActivityEventBatch>>;
  /**
   * 订阅当前画布任务活动的 `task-activity` 逻辑通道（共享 Canvas Session）。
   *
   * 返回取消订阅函数；连接重建由 page-owned session 统一负责（无独立 retry timer）。
   */
  subscribeTaskActivity(input: {
    canvasId: string;
    cursor: number;
    onRecord: (record: CanvasTaskActivity, cursor: number) => void;
    onError?: (error: unknown) => void;
  }): () => void;

  // --- 提示词片段目录（change: add-prompt-snippet-library） -----------------
  listSnippets(query?: PromptSnippetListQuery): Promise<SnippetResult<PromptSnippetListResult>>;
  getSnippet(snippetId: string): Promise<SnippetResult<PromptSnippet>>;
  createSnippet(input: CreatePromptSnippetInput): Promise<SnippetResult<PromptSnippet>>;
  updateSnippet(input: UpdatePromptSnippetInput): Promise<SnippetResult<PromptSnippet>>;
  deleteSnippet(snippetId: string): Promise<SnippetResult<null>>;
  listSnippetTags(): Promise<SnippetResult<SnippetTagWithCount[]>>;
  createSnippetTag(input: CreatePromptSnippetTagInput): Promise<SnippetResult<PromptSnippetTag>>;
  renameSnippetTag(input: RenamePromptSnippetTagInput): Promise<SnippetResult<PromptSnippetTag>>;
  deleteSnippetTag(tagId: string): Promise<SnippetResult<null>>;
  /** 目录素材 resolver：确认稳定 storageKey 可解析（不返回任何 URL）。 */
  resolveSnippetMaterial(storageKey: string): Promise<SnippetResult<{ storageKey: string; resolvable: boolean }>>;

}

/** 片段目录协议结果；失败携带稳定错误码（跨进程按字符串判定）。 */
export type SnippetResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PromptSnippetErrorCode | "unauthorized" | "unavailable"; error: string };

/**
 * 节点生成历史协议结果
 * （change: add-canvas-node-generation-history）。
 *
 * 失败携带稳定错误码：not-found / conflict / unrecoverable / unauthorized / unavailable。
 */
export type NodeHistoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string; body?: unknown };

/** 编辑完成结果：成功携带回执；失败携带稳定错误码与可选回执（change: 图片聚焦编辑）。 */
export type EditCompleteResult =
  | { ok: true; receipt: EditSessionCompletionReceipt }
  | { ok: false; code: string; error: string; receipt?: EditSessionCompletionReceipt };

export type SnippetTagWithCount = PromptSnippetTag & { snippetCount: number };

export type TaskCatalogReader = {
  fetchCatalog(): Promise<CanvasTaskCatalog>;
};

/** Task Remote：浏览器允许的只读 catalog/history 协议。 */
export interface TaskRemoteService {
  fetchCatalog(): Promise<CanvasTaskCatalog>;
  createHistory(): TaskHistoryReader;
}

/**
 * Application Remote：站点插件状态/增量/管理写入与 Application 健康读取
 * （change: 2026-10-05-extract-application-plugin-host，任务 5.3）。
 *
 * 站点管理不再经 Task Remote；浏览器不持有服务间令牌。
 */
export type ApplicationRemoteService = ApplicationRemote;

/**
 * 通用插件 JSON/流式传输类型
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.1）。
 *
 * 属于 **frontend 平台契约**（浏览器传输），不进入 `@woohaa3/contracts` 跨端纯类型。
 * 插件业务 adapter（如 ChatGPT remote）复用该传输，不自建针对服务的 fetch/EventSource。
 */
export type ApplicationTransportErrorCode =
  | "unauthorized"
  | "not-found"
  | "conflict"
  | "invalid"
  | "unavailable"
  | "aborted";

export type ApplicationTransportJsonResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: ApplicationTransportErrorCode; error: string; status?: number; body?: unknown };

export type ApplicationTransportStreamEvent = { type: string; data: string };

export type ApplicationTransportStreamCallbacks = {
  onEvent: (event: ApplicationTransportStreamEvent) => void;
  onError: (error: string, code: ApplicationTransportErrorCode) => void;
  onClose?: () => void;
};

export type ApplicationRemoteTransport = {
  request: (input: {
    path: string;
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    signal?: AbortSignal;
  }) => Promise<ApplicationTransportJsonResult>;
  stream: (input: {
    path: string;
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    callbacks: ApplicationTransportStreamCallbacks;
  }) => { cancel: () => void };
};

export type UploadedMedia = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  url: string;
  deduplicated: boolean;
};

export type UploadMediaResult = { ok: true; media: UploadedMedia } | { ok: false; error: string };

/** Media Remote：上传、稳定同源 URL 构造与受控媒体读取资格；不持有 COS 凭据。 */
export interface MediaRemoteService {
  /**
   * 上传一个文件；`onProgress` 上报 0..100（可用时）。
   *
   * `canvasId` 只在已知画布上下文传入，作为上传目标的 `?canvas=` 提示
   * （`POST /api/media?canvas=<id>`），让宿主把字节写入该画布对应的存储后端。
   */
  upload(input: { file: File; canvasId?: string; onProgress?: (percent: number) => void; signal?: AbortSignal }): Promise<UploadMediaResult>;
  /** 由稳定 storageKey 构造同源读取地址；`canvasId` 可选（只在画布上下文附加提示）。 */
  urlFor(storageKey: string, canvasId?: string): string;
  /** 校验一个 canonical 资产 URL 是否为受控稳定同源引用。 */
  isAllowedUrl(url: string): boolean;
  /** 从 canonical asset 解析受控 URL；不合法返回 null。`canvasId` 同上，仅作渲染提示。 */
  resolveCanonicalUrl(asset: unknown, canvasId?: string): string | null;
}
