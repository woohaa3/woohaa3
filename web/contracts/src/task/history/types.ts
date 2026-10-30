/**
 * Task execution history DTO：类型与常量
 * （自 `history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R20）。
 *
 * 纯类型/常量叶子。全局历史页与 Canvas 补偿都只读这一套 read model；它只暴露安全字段。
 */

/** 对外稳定执行状态（覆盖 scheduling 与 execution 两相）。 */
export const TASK_EXECUTION_STATES = [
  "queued",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled"
] as const;

export type TaskExecutionState = (typeof TASK_EXECUTION_STATES)[number];

/** 模型类型（与 catalog modelType 对齐）。 */
export type TaskModelType = "language" | "image" | "video" | "audio";

/** 进行中状态（历史页「进行中」tab）。 */
export const ACTIVE_TASK_STATES: readonly TaskExecutionState[] = ["queued", "pending", "running"];

/** 列表/详情共用的安全结果摘要。 */
/**
 * 产物字节的当前位置：哪个后端、什么键、能否给出 locator。
 *
 * **读取时现算，不落库**：产物采纳后按内容寻址写进 `media` 命名空间，位置会随画布归属
 * （本地 / 托管）与主存储切换变化；持久化一个 locator 只会得到陈旧答案。
 */
export type TaskResultLocation = {
  /** 此刻承载字节的后端 id（`local` / `cos` / `server` …）。 */
  backendId: string;
  /** 后端实际使用的键（已含 namespace）。 */
  key: string;
  /**
   * 定位符 `media://<backendId>/<key>`：展示与粘贴回存储层都用它。
   *
   * 后端实现 `locatorOf` 时用后端给的值；没实现时由宿主按同一形状派生。派生值对
   * 「展示与排障」是准确的（如实表达了后端与键），但只有实现了 `readLocator` 的后端
   * 才能反过来解析它。
   */
  locator: string;
};

export type TaskResultSummary = {
  mediaKind: "text" | "image" | "video" | "audio";
  /**
   * 字节当前位置（宿主在读取详情时补全）。
   *
   * 与 `storageKey` 的区别：`storageKey` 是使用方给的稳定逻辑键，位置是「现在真的落在哪」——
   * 排障时判断「为什么签不出地址 / 为什么读不到」看的正是后者。
   */
  location?: TaskResultLocation;
  /** 文本结果的安全摘要（绝不包含完整 provider 响应）。 */
  text?: string;
  /** 文本摘要是否被截断（缺失表示未截断或未知）。 */
  textTruncated?: boolean;
  /** 二进制结果的稳定 metadata（绝不含 bytes 或签名 URL）。 */
  storageKey?: string;
  contentType?: string;
  size?: number;
  checksum?: string;
  /** 音视频时长（可得时）。 */
  durationSeconds?: number;
  /** 可选视频海报/封面的稳定 metadata。 */
  poster?: {
    storageKey: string;
    contentType?: string;
    size?: number;
    checksum?: string;
  };
};

/** 安全错误摘要：只有名称与消息与结构化状态码，绝不含 stack / 上游响应头。 */
export type TaskErrorSummary = {
  name?: string;
  message: string;
  /**
   * 上游 HTTP 状态码（change: l0-generation-provenance）。
   * 只保留数字本身；上游响应体、响应头仍不进历史。
   */
  status?: number;
  /** 上游业务错误码（如 `InvalidParameter`）；只保留稳定字符串标识。 */
  code?: string;
};

/**
 * 参考输入安全摘要：只含稳定引用身份，不含执行期签出的 URL。
 *
 * 这是「这张图用了哪张素材」的溯源落点（change: l0-generation-provenance）：
 * 执行期的签名地址会过期，稳定引用不会。
 */
export type TaskRequestInput = {
  role: string;
  mediaKind?: string;
  mediaType: string;
  assetId?: string;
  storageKey?: string;
};

/**
 * 请求参数安全摘要（**仅出现在 operator/admin 详情**，不在列表与事件流）。
 */
export type TaskRequestSummary = {
  prompt: string;
  /** prompt 达到服务端上限被截断。 */
  promptTruncated?: boolean;
  parameters: Record<string, unknown>;
  /** parameters 达到预算被裁剪（键被剔除或深度/数量/字节受限）。 */
  parametersTruncated?: boolean;
  /** 稳定参考输入（顺序与提交一致）。 */
  inputs?: TaskRequestInput[];
};

/** 有界事件时间线项。 */
export type TaskExecutionEvent = {
  sequence: number;
  occurredAt: string;
  kind: "scheduling" | "execution";
  stage: string;
  /** 已脱敏的细节；调用方不得假设其结构。 */
  detail?: Record<string, unknown>;
};

/**
 * 任务来源（change: improve-task-history-experience，阶段二 D1）。
 *
 * - `canvas`：由 Canvas 节点 run 受理；
 * - `plugin`：由受信任 Application 插件受理的非画布任务；
 * - `unknown`：旧记录或缺少可信受理依据。
 */
export const TASK_EXECUTION_SOURCES = ["canvas", "extension", "unknown"] as const;

export type TaskExecutionSource = (typeof TASK_EXECUTION_SOURCES)[number];

/**
 * 受理时版本审计（change: improve-task-history-experience，阶段二 D1）。
 */
export type TaskAdmissionVersions = {
  catalogRevision?: number;
  schemaRevision?: number;
  configVersion?: number;
  extensionConfigVersion?: number;
};

/** 列表项：足以渲染表格与筛选，不含事件时间线。 */
export type TaskExecutionSummary = {
  taskKey: string;
  state: TaskExecutionState;
  providerId: string;
  providerName?: string;
  modelType?: TaskModelType;
  modelKey?: string;
  modelTitle?: string;
  canvasId?: string;
  canvasTitle?: string;
  nodeId?: string;
  nodeTitle?: string;
  runId?: string;
  /**
   * 上游 Provider 的任务号（如 RunningHub taskId / Ark task id）。
   *
   * 有它才能拿着历史去上游控制台对账（change: l0-generation-provenance）。
   */
  upstreamTaskId?: string;
  progress?: number;
  attempt?: number;
  result?: TaskResultSummary;
  error?: TaskErrorSummary;
  source?: TaskExecutionSource;
  extensionId?: string;
  admission?: TaskAdmissionVersions;
  /**
   * 可信受理 actor（change: 2026-10-13-...，任务 7.1/7.2 / design D9）。
   * 只来自冻结 delegation；旧记录缺失即 `{unknown:true}`，不反填为查看者。
   */
  actor?: TaskExecutionActor;
  /**
   * 生命周期时间与耗时（change: 2026-10-13-...，任务 7.1/7.3 / design D9）。
   * 旧记录缺失字段即不猜测；`observedAt` 为同一次快照时刻。
   */
  timing?: TaskExecutionTiming;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs: number;
  recordRevision: number;
};

/**
 * 可信受理 actor（change: 2026-10-13-...，任务 7.1/7.2 / design D9）。
 *
 * `unknown` 表示旧记录或缺少可信受理依据；viewer 自身身份不得反填为 actor。
 */
export type TaskExecutionActor = {
  subject?: string;
  displayName?: string;
  /** 旧记录无来源。 */
  unknown?: boolean;
};

/**
 * 生命周期时间与耗时（change: 2026-10-13-...，任务 7.1/7.3 / design D9）。
 *
 * 定义固定：total=受理至终态/observedAt；queue=首次执行开始前等待；execution=首次执行开始至
 * 终态/observedAt（含重试等待）；state=当前状态驻留（终态后不增长）。缺失可靠时间即 `undefined`。
 */
export type TaskExecutionTiming = {
  /** 受理时间（旧记录可能缺失）。 */
  admittedAt?: string;
  /** 首次执行开始时间。 */
  firstStartedAt?: string;
  /** 状态最近变化时间。 */
  stateChangedAt?: string;
  /** 受理至终态/observedAt（毫秒；负值钳 0）。 */
  totalMs?: number;
  /** 首次执行开始前等待。 */
  queueMs?: number;
  /** 首次执行开始至终态/observedAt（含重试等待）。 */
  executionMs?: number;
  /** 当前状态驻留。 */
  stateMs?: number;
  /** 观测时刻（与服务端同一快照）。 */
  observedAt: string;
};

/** 详情：列表项 + 有界事件时间线 + 请求参数摘要（operator/admin 视图）。 */
export type TaskExecutionDetail = TaskExecutionSummary & {
  events: TaskExecutionEvent[];
  /** 事件时间线因上限被裁剪（缺失表示未裁剪或未知）。 */
  eventsTruncated?: boolean;
  /** 提交时的 prompt 与 parameters；仅详情返回，列表与事件流不含。 */
  request?: TaskRequestSummary;
};

/** 历史查询筛选（服务端做上限与校验）。 */
export type TaskHistoryQuery = {
  cursor?: string;
  limit?: number;
  /** 旧单一状态查询（与 `states` 互斥）。 */
  state?: TaskExecutionState;
  /** 有界多状态集合（进行中=queued/pending/running）。 */
  states?: TaskExecutionState[];
  providerId?: string;
  modelType?: TaskModelType;
  modelKey?: string;
  canvasId?: string;
  nodeId?: string;
  /** 精确 taskKey 查找。 */
  taskKey?: string;
  /** 执行来源筛选（change: 阶段二 D1）。 */
  source?: TaskExecutionSource;
  /** 受信任插件身份筛选（仅 plugin 来源有意义）。 */
  extensionId?: string;
  /** ISO 时间；含边界。 */
  from?: string;
  to?: string;
};

/** 分页结果：`nextCursor` 缺失表示已到末尾。 */
export type TaskHistoryPage = {
  items: TaskExecutionSummary[];
  nextCursor?: string;
  /** 快照时刻的原子事件高水位；客户端据此启动可恢复订阅。 */
  watermark: number;
};

/** task history event stream 的消息（cursor 单调、只对应已持久化事实）。 */
export type TaskHistoryEventMessage = {
  /** 本次通知对应的记录快照（已脱敏）。 */
  record: TaskExecutionSummary;
  /** 逐条可确认的 cursor（成功交付后才可确认）。 */
  cursor: number;
};

/** 有界增量批次（断线补偿与事件流共用）。 */
export type TaskHistoryIncrementalBatch = {
  messages: TaskHistoryEventMessage[];
  /** 已交付的最后 cursor（无消息时为输入 cursor）。 */
  cursor: number;
  /** 是否还有未交付的补偿数据。 */
  hasMore: boolean;
  /** 无法续读请求水位，客户端必须重读快照后再订阅。 */
  resync?: boolean;
};

/** 服务端 page size 上限。 */
export const TASK_HISTORY_MAX_PAGE_SIZE = 200;
export const TASK_HISTORY_DEFAULT_PAGE_SIZE = 50;
/** 一次性增量补偿批次上限。 */
export const TASK_HISTORY_MAX_EVENT_BATCH = 200;

/** 历史查询解析错误码（稳定、跨进程按字符串判定）。 */
export const TASK_HISTORY_QUERY_ERROR_CODES = [
  "state-conflict",
  "invalid-state",
  "invalid-model-type",
  "invalid-time-range",
  "invalid-cursor",
  "cursor-mismatch",
  "invalid-source"
] as const;

export type TaskHistoryQueryErrorCode = (typeof TASK_HISTORY_QUERY_ERROR_CODES)[number];

export type TaskHistoryQueryParse =
  | { ok: true; query: TaskHistoryQuery; fingerprint: string }
  | { ok: false; code: TaskHistoryQueryErrorCode; message: string };

/** 历史筛选候选：Provider 与模型（含保留期内已下线模型），不含 request 内容。 */
export type TaskHistoryCandidateProvider = {
  providerId: string;
  providerName?: string;
};

export type TaskHistoryCandidateModel = {
  providerId: string;
  modelType: TaskModelType;
  modelKey: string;
  modelTitle?: string;
  providerName?: string;
};

/** 插件来源候选（从历史受理事实投影；只含 extensionId，不含配置正文）。 */
export type TaskHistoryCandidateExtension = {
  extensionId: string;
};

export type TaskHistoryCandidates = {
  providers: TaskHistoryCandidateProvider[];
  models: TaskHistoryCandidateModel[];
  /** plugin 来源的 extensionId（可能为空）。 */
  plugins: TaskHistoryCandidateExtension[];
};

/** 候选查询（服务端做上限与校验）。 */
export type TaskHistoryCandidateQuery = {
  providerId?: string;
  modelType?: TaskModelType;
  limit?: number;
};
