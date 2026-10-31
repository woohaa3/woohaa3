// 定义处：@woohaa3/contracts —— 前端 Cordis 根的服务契约；web/frontend 只做实现与 re-export。
/**
 * 宿主 Agent 会话前端 capability 契约（type-only）
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.2/5.4/5.6 / design D1/D6a）。
 *
 * 宿主在 Canvas page scope 提供**拥有**会话/回合读模型与提交门禁的唯一 capability；业务生成
 * 扩展（如 ChatGPT）只消费它来提交首轮并获得 `conversationId`/`requestId`，不自行持久化会话，
 * 也不复制宿主 route。本模块是 leaf 契约：只含类型，避免 extension-api 反向依赖业务实现。
 */
import type { AgentConnectionView } from "../../assistant/agent-connection.js";
import type { AgentMcpStatusResponse } from "../../assistant/conversation-mcp.js";
import type {
  AgentCatalogResponse,
  AgentEntryIntent,
  ConversationSnapshot,
  ConversationSummary,
  ConversationTurn
} from "../../assistant/conversation.js";
import type {
  ServiceConnectionDirectory,
  ServiceConnectionManagement,
  ServiceConnectionView
} from "../../host/service-connection.js";
import type { SkillMediaStepView, SkillStepUpdatedEvent } from "../../../canvas/agent-media-continuation.js";

/** 会话操作结果：失败携带稳定错误码与可读原因。 */
export type AgentConversationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

/** 生成面板提交首轮时需要的最小目标身份（与 AuthoringGenerationProps 对齐，不复制路由）。 */
export type AgentConversationSubmitInput = {
  canvasId: string;
  /** adapter id（缺省由宿主选择首个可用 public adapter）。 */
  adapterId?: string;
  /** 已存在的会话（同一生成目标重复提交时复用，避免每次新会话）。 */
  conversationId?: string;
  /** 选定来源连接（缺省由宿主解析兼容默认连接；change: 2026-10-16-...，任务 2.4）。 */
  connectionId?: string;
  /** 目标动作 intent；`discuss` 只读。 */
  entry: AgentEntryIntent;
};

/** 提交结果：建立/复用会话并接受一个回合（异步执行由后端 dispatch）。 */
export type AgentConversationSubmitResult = {
  conversationId: string;
  requestId: string;
  turn: ConversationTurn;
  /** true 表示相同 requestId+输入命中既有回合，未重复推理。 */
  reused: boolean;
};

/**
 * 宿主会话读模型快照（生成面板与详情共用）。
 *
 * `active` 是最后一次提交/查询得到的对话身份，用于状态区摘要与详情定位；`detail` 是详情面板
 * 打开的权威快照（未打开时 null）。前端只持读模型，事实源在后端。
 */
export type AgentConversationActiveTurn = {
  conversationId: string;
  requestId: string;
  turn: ConversationTurn;
};

export type AgentConversationSnapshotView = {
  /** Local requests awaiting acceptance; never operation records or persisted history. */
  pendingSubmissions?: Readonly<Record<string, AgentEntryIntent>>;
  /** Exact request index; active is retained only for legacy consumers. */
  turnsByRequest?: Readonly<Record<string, AgentConversationActiveTurn>>;
  conversations: ConversationSummary[];
  active: AgentConversationActiveTurn | null;
  detail: ConversationSnapshot | null;
  /** 内置 MCP 真实发现 + 外部连接指引（最近一次查询；未查询为 null）。 */
  mcp: AgentMcpStatusResponse | null;
  loading: boolean;
  error: string | null;
  /** 上下文版本：清空上下文成功后自增，供宿主重新解析节点会话（design D8）。 */
  contextRevision: number;
};

/** 只读订阅视图：生成面板据此展示权威状态与详情入口。 */
export type AgentConversationView = {
  getSnapshot: () => AgentConversationSnapshotView;
  subscribe: (listener: () => void) => () => void;
};

/**
 * 宿主会话服务（前端 capability）。
 *
 * 前端只持有草稿/展开/滚动；会话事实源在后端。所有方法只读或显式接受回合，**打开/查询/
 * 关闭**绝不重新 accept 或 dispatch。
 */
export type AgentConversationService = AgentConversationView & {
  serviceConnectionDirectory?: () => Promise<AgentConversationResult<ServiceConnectionDirectory>>;
  manageServiceConnection?: (input: ServiceConnectionManagement) => Promise<AgentConversationResult<ServiceConnectionView>>;
  listServiceConnections?: () => Promise<AgentConversationResult<ServiceConnectionView[]>>;
  getDataScopeId?: () => string | null;
  /** 配置保存后清除连接/模型目录请求缓存；不改变会话事实或草稿。 */
  invalidateDirectory: () => void;
  /** 读取 adapter 授权/能力/账户目录（真实状态，不自动换模型）。 */
  catalog: (adapterId?: string) => Promise<AgentConversationResult<AgentCatalogResponse>>;
  /**
   * 内置 MCP 真实发现 + 外部连接指引（宿主投影）
   * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.6）。
   *
   * `builtin.ready` 只来自后端 executed initialize/tools/list；`external` 只是当前 origin 的
   * Streamable HTTP URL，复制地址不等于外部客户端已连接。
   */
  mcpStatus: () => Promise<AgentConversationResult<AgentMcpStatusResponse>>;
  /** 当前画布的会话列表（有界）。 */
  listConversations: (canvasId: string) => Promise<AgentConversationResult<ConversationSummary[]>>;
  /**
   * 按生成目标节点查找该节点当前会话（一个节点复用一条；design D8）。只读。
   *
   * 无则 `conversation: null`（调用方据此新建）；不改变导航或读模型。
   * `connectionId` 提供时只返回该来源连接下的会话（change: 2026-10-16-...，任务 2.3）。
   */
  findConversationForTarget: (input: { contextKey?: string; canvasId: string; nodeId: string; connectionId?: string }) => Promise<AgentConversationResult<{ conversation: ConversationSummary | null }>>;
  /**
   * 清空节点上下文：解除该节点与当前会话的关联（归档旧会话，**不**删除历史；design D8）。
   *
   * 随后该节点提交将新建会话；同时清理本地读模型中该会话的 active/detail。
   */
  clearContext: (input: { canvasId: string; nodeId: string }) => Promise<AgentConversationResult<{ cleared: number }>>;
  /**
   * 该 owner 可见的来源连接（不含秘密；change: 2026-10-16-...，任务 2.4/2.5）。只读。
   *
   * 宿主据此渲染来源/连接选择；按数据空间缓存成功结果及在途请求，失败保留原选择。
   */
  listConnections: (adapterId?: string) => Promise<AgentConversationResult<AgentConnectionView[]>>;
  /**
   * 显式切换来源连接：解除目标关联、归档旧会话（保留历史），下一次提交建立新来源会话。
   *
   * 活动回合由后端拒绝（change: 2026-10-16-...，任务 2.3）；成功后清理本地读模型并自增
   * `contextRevision`，让宿主重新解析节点会话。
   */
  switchConnection: (input: { canvasId: string; nodeId: string; connectionId: string }) => Promise<AgentConversationResult<{ cleared: number }>>;
  /** 读取会话权威快照（消息/回合/事件），用于详情面板。 */
  readConversation: (conversationId: string, cursor?: number) => Promise<AgentConversationResult<ConversationSnapshot>>;
  /**
   * 从生成面板提交首轮：确保会话存在、接受回合并异步执行。
   *
   * 相同 `requestId`（由调用方提供稳定身份）命中既有回合时返回 `reused: true`，不再推理。
   */
  submitTurn: (
    input: AgentConversationSubmitInput & { requestId: string }
  ) => Promise<AgentConversationResult<AgentConversationSubmitResult>>;
  /** 按确切 requestId 查询回合与快照（断流/unknown 恢复；不重新 dispatch）。 */
  queryTurn: (requestId: string) => Promise<AgentConversationResult<{ conversation: ConversationSummary; turn: ConversationTurn; snapshot: ConversationSnapshot }>>;
  /**
   * 按领域运行关联定位确切回合（活动/历史 Agent 记录 → 确切 request/run）
   * （change: 2026-10-12-add-agent-conversation-panel，任务 5.7 / design D7）。
   *
   * 只匹配宿主已显式关联的 runId，绝不按 nodeId 跳到最近会话；只读，不 accept/dispatch。
   * 无关联返回 `not-found`，调用方据此保留原任务详情（不伪造对话）。
   */
  locateTurnByRun: (runId: string) => Promise<AgentConversationResult<{ conversation: ConversationSummary; turn: ConversationTurn; snapshot: ConversationSnapshot }>>;
  /** 取消在途回合（不撤销已提交领域动作）。 */
  retryTextSave?: (requestId: string) => Promise<AgentConversationResult<{ turn: ConversationTurn }>>;
  cancelTurn: (requestId: string) => Promise<AgentConversationResult<{ ok: true }>>;
  /** 由宿主领域链在 run/task 接受后显式关联（不从节点 active run 反推）。 */
  linkRun: (requestId: string, input: { runId?: string; taskId?: string }) => Promise<AgentConversationResult<{ turn: ConversationTurn }>>;
  /** 按节点读取 Skill 步骤快照（无步骤时 step=null；轮询/刷新复用同一读入口）。 */
  skillStep: (input: { canvasId: string; nodeId: string }) => Promise<AgentConversationResult<{ step: SkillMediaStepView | null }>>;
  /** 画布内最近 Skill 步骤（活动面板投影；有界）。 */
  skillSteps: (input: { canvasId: string; limit?: number }) => Promise<AgentConversationResult<{ steps: SkillMediaStepView[] }>>;
  /** 按步骤身份读取快照 + 事件重放（面板打开/断线恢复）。 */
  skillStepDetail: (input: { canvasId: string; skillRunId: string; stepId: string; after?: number }) => Promise<AgentConversationResult<{
    step: SkillMediaStepView;
    events: Array<SkillStepUpdatedEvent & { sequence: number }>;
    cursor: number;
    resetRequired: boolean;
  }>>;
  /** 用户停止：只请求取消当前尝试，不伪造已取消。 */
  cancelSkillStep: (input: { canvasId: string; skillRunId: string; stepId: string }) => Promise<AgentConversationResult<{ step: SkillMediaStepView; state: "cancel-requested" | "already-terminal" }>>;
  /** 用户改提示词并重新生成：创建递增 attempt，旧尝试保留可核对历史。 */
  regenerateSkillStep: (input: { canvasId: string; skillRunId: string; stepId: string; requestId: string; prompt?: string; modelKey?: string; parameters?: Record<string, unknown> }) => Promise<AgentConversationResult<{ step: SkillMediaStepView; runId: string }>>;
};
