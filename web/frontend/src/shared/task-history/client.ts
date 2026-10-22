/**
 * 任务历史只读查询契约（change: 2026-10-10-extract-task-history-page，design D3）。
 *
 * 独立任务历史页面（`src/pages/task-history`）与 Task Remote（Cordis Service）共用的
 * **权威定义**：只读 reader/client 形状、类型化筛选、连接状态与稳定查询错误。跨端 DTO
 * 由 `@woohaa3/contracts` 拥有；本模块只组合前端消费形状，不复制 DTO，也不依赖页面、
 * Cordis 宿主或具体插件。
 */
import type {
  TaskExecutionDetail,
  TaskExecutionSource,
  TaskExecutionState,
  TaskExecutionSummary,
  TaskHistoryCandidateQuery,
  TaskHistoryCandidates,
  TaskHistoryPage,
  TaskModelType
} from "@woohaa3/contracts";

/** 历史连接状态（页面顶部展示，带最近成功同步时间）。 */
export type TaskHistoryConnectionState = "connecting" | "live" | "reconnecting" | "polling" | "offline";

export type TaskHistoryConnectionStatus = {
  state: TaskHistoryConnectionState;
  /** 最近一次成功交付/同步时间（ISO）。 */
  lastSyncedAt?: string;
  /** 连接或解码失败的最近原因（可诊断，不伪装健康）。 */
  error?: string;
};

/** 历史查询错误：稳定 code + 可读信息（跨进程按字符串判定）。 */
export class TaskHistoryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "TaskHistoryError";
    this.code = code;
    this.status = status;
  }
}

/** 历史筛选：与契约 `TaskHistoryQuery` 对齐（不含 cursor/limit）。 */
export type TaskHistoryFilter = {
  state?: TaskExecutionState;
  states?: TaskExecutionState[];
  providerId?: string;
  modelType?: TaskModelType;
  modelKey?: string;
  canvasId?: string;
  nodeId?: string;
  taskKey?: string;
  source?: TaskExecutionSource;
  extensionId?: string;
  from?: string;
  to?: string;
};

export type TaskHistoryDetailResult = { ok: true; detail: TaskExecutionDetail } | { ok: false; code: string; message: string };

export type TaskHistoryReader = {
  /** 读取某一页；`cursor` 是上一页 `nextCursor`（opaque）。 */
  list(input?: TaskHistoryFilter & { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<TaskHistoryPage>;
  detail(taskKey: string, signal?: AbortSignal): Promise<TaskHistoryDetailResult>;
  /** 有界筛选候选（Provider/模型，含历史下线模型）。 */
  candidates(query?: TaskHistoryCandidateQuery, signal?: AbortSignal): Promise<TaskHistoryCandidates>;
  /**
   * 从快照水位订阅已持久化变更。返回释放函数；释放会中止流请求、reader 与轮询 timer。
   * 断线自动从最后确认 cursor 重连/补偿；无法续读时回调 `onResync` 要求重读快照。
   */
  subscribe(input: {
    cursor: number;
    onRecord: (record: TaskExecutionSummary, cursor: number) => void;
    onStatus?: (status: TaskHistoryConnectionStatus) => void;
    onResync?: () => void;
    onError?: (error: unknown) => void;
  }): () => void;
};

/** History 页面消费的只读客户端（由 Task Remote 提供）。 */
export type TaskHistoryClient = TaskHistoryReader;

/** 页面状态页签 → 服务端多状态查询的稳定枚举。 */
export type TaskHistoryTab = "all" | "active" | "succeeded" | "failed" | "cancelled";
