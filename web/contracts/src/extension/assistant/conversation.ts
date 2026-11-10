/**
 * 宿主拥有的 Agent 会话/回合/事件公开契约（纯类型 + 无副作用 decoder）
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.1 / design D1/D2/D3/D7）。
 *
 * 这里是**宿主**与 provider 扩展、通用面板之间的稳定边界：
 * - 宿主定义 entry intent、adapter 能力、conversation/turn/message/event/receipt 与领域运行关联；
 * - provider 扩展注册 adapter（授权/目录/讨论/目标执行），不把私有 service 暴露给通用面板；
 * - 通用面板只消费本模块的 DTO，不 import 任何具体扩展实现。
 *
 * 本模块是浏览器安全的纯类型：不含 SQLite、SDK、HTTP handler 或秘密。宿主 API 落在
 * `/api/agent-conversations/*`（同源、owner+canvas 隔离），实现见 application-service。
 *
 * 关键约束（design D2/D7）：
 * - owner 只来自宿主可信 principal，绝不来自请求 body；
 * - requestId 绑定 owner+canvas+conversation+规范输入 hash，重放返回原回合，不重复推理；
 * - succeeded/partial/failed/cancelled 来自宿主 ledger 与领域回执，不从助手正文推断；
 * - 同一节点旧任务与较新会话各自保留关联，打开/关闭/查询都不创建新执行。
 */
import { isBoolean, isBoundedId, isJsonObject, isStringArray } from "../../validation.js";
import type { AssistantWorldScopeSelection } from "../../canvas/assistant-world-authority.js";
import type { AgentRoleRef, PreparedAgentRoleTurn } from "./agent-role.js";
import { isAgentNativeCapability } from "./agent-role.js";

/** Agent 会话 API 的固定同源前缀（宿主拥有）。 */
export const AGENT_CONVERSATION_BASE_PATH = "/api/agent-conversations" as const;

/**
 * 权威回合状态。
 *
 * 无法证明结果不再有独立状态：先按原身份查询回执，能证明按事实结算，否则结算 `failed` 并
 * 保留机器错误码（`result-unconfirmed` / `write-unconfirmed` / `outcome-unknown`）。
 * 旧数据里的 `unknown` 由 `normalizeConversationTurnStatus` 归一为 `failed`。
 */
export const CONVERSATION_TURN_STATUSES = [
  "queued",
  "running",
  "committing",
  "succeeded",
  "partial",
  "failed",
  "cancelled"
] as const;
export type ConversationTurnStatus = (typeof CONVERSATION_TURN_STATUSES)[number];

export function isConversationTurnStatus(value: unknown): value is ConversationTurnStatus {
  return typeof value === "string" && (CONVERSATION_TURN_STATUSES as readonly string[]).includes(value);
}

/**
 * 读取期归一（旧数据 / 旧事件 / 旧 API payload）。
 *
 * `unknown` 按 `failed` 返回，避免旧值继续下传成一个用户可见状态；其余无法识别的值返回
 * `null`，由调用方决定拒绝或兜底。调用方在缺少错误码时补 `result-unconfirmed`。
 */
export function normalizeConversationTurnStatus(value: unknown): ConversationTurnStatus | null {
  if (value === "unknown") return "failed";
  return isConversationTurnStatus(value) ? value : null;
}

/** 活动回合（尚未终态）的判定：驱动单会话串行与“查看执行与对话”入口。 */
export const ACTIVE_TURN_STATUSES: readonly ConversationTurnStatus[] = ["queued", "running", "committing"];

export function isActiveTurnStatus(value: ConversationTurnStatus): boolean {
  return ACTIVE_TURN_STATUSES.includes(value);
}

/** 会话整体状态：由最近回合派生（宿主投影，不是第二事实源）。 */
export const CONVERSATION_STATUSES = ["idle", "active", "succeeded", "partial", "failed", "cancelled"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export function isConversationStatus(value: unknown): value is ConversationStatus {
  return typeof value === "string" && (CONVERSATION_STATUSES as readonly string[]).includes(value);
}

/** 读取期归一：旧 `unknown` 会话状态按 `failed` 呈现。 */
export function normalizeConversationStatus(value: unknown): ConversationStatus | null {
  if (value === "unknown") return "failed";
  return isConversationStatus(value) ? value : null;
}

/** 无法证明结果的稳定机器错误码（跨进程按字符串判定，不对应独立用户状态）。 */
export const UNCONFIRMED_RESULT_ERROR_CODE = "result-unconfirmed" as const;
/** 缺少交付回执的稳定机器错误码（回合/组创作/文本保存）。 */
export const UNCONFIRMED_WRITE_ERROR_CODE = "write-unconfirmed" as const;
/** 外部工作日志无法确认的稳定机器错误码（保留原码，提示不得自动重试）。 */
export const UNCONFIRMED_OUTCOME_ERROR_CODE = "outcome-unknown" as const;

/** 结算为失败时统一附带的「可能已部分写入」说明。 */
export const UNCONFIRMED_RESULT_MESSAGE =
  "无法确认执行结果，可能已部分写入；重试前请核对原请求，系统不会自动重试。";
export const UNCONFIRMED_WRITE_MESSAGE =
  "回复完成，但作品更新未确认，可能已部分写入；重试前请核对原请求。";

/**
 * entry intent 的动作：`discuss` 仅讨论（无写许可），`generate`/`modify` 声明本次明确目标动作。
 *
 * 服务端在接受回合时冻结目标与范围；前端 toggle、模型 prompt 或工具 annotation 都不能代替授权。
 */
export const AGENT_ENTRY_ACTIONS = ["discuss", "generate", "modify"] as const;
export type AgentEntryAction = (typeof AGENT_ENTRY_ACTIONS)[number];

export function isAgentEntryAction(value: unknown): value is AgentEntryAction {
  return typeof value === "string" && (AGENT_ENTRY_ACTIONS as readonly string[]).includes(value);
}

/**
 * 目标创作模式。
 *
 * 片场（`film-set`）已下线；`canvas-group` 重新启用，表示 2D 组（`workflow-group-2d`）作用域：
 * 只授权组内卡片组织与节点执行，不授予共享世界写资格。
 * `camera` 指模型自身的镜头预设，仍属 model3d 节点的子资源。
 */
export const AGENT_TARGET_MODES = ["model3d", "camera", "text", "world", "canvas-group"] as const;
export type AgentTargetMode = (typeof AGENT_TARGET_MODES)[number];

export function isAgentTargetMode(value: unknown): value is AgentTargetMode {
  return typeof value === "string" && (AGENT_TARGET_MODES as readonly string[]).includes(value);
}

/** 引用输入：稳定 storageKey 或上游节点身份；不携带 URL/凭据。 */
export type AgentEntryReference = {
  kind: "asset" | "node";
  /** kind=asset：稳定 storageKey。 */
  storageKey?: string;
  /** kind=node：上游节点 id。 */
  nodeId?: string;
  role?: string;
};

/**
 * 一次回合冻结的连接身份（change: 2026-10-16-add-agent-appserver-and-sdk-connections，
 * 任务 2.2/2.3 / design D7）。
 *
 * 与目标、模型一起纳入请求幂等指纹：同一 requestId 换连接/配置/凭据版本 MUST 拒绝，
 * 不切换凭据、不重新推理。原生会话 id 是执行索引，不能跨连接或 owner 复用。
 *
 * 没有连接身份的历史行不会自动绑定或发起新执行。
 */
export type AgentConnectionBinding = {
  connectionId: string;
  /** 解析该连接的 adapter 稳定 id（与 `ConversationSummary.adapterId` 一致）。 */
  adapterId: string;
  /** 冻结时的非秘密配置 revision。 */
  configRevision: number;
  /** 冻结时的凭据 epoch（替换/清除密钥使旧运行失效）。 */
  credentialEpoch: number;
};

/** 仅开放运行时或模型目录明确支持的思考强度；省略时沿用模型默认。 */
export const AGENT_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];
export function isAgentReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return typeof value === "string" && (AGENT_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** 一次回合的显式目标快照（camera/clip/item 使用稳定 id，不用索引）。 */
export type AgentTargetSnapshot = {
  /** Trusted structured runner identity; ordinary dispatch must never execute this turn. */
  structuredInputHash?: string;
  /** Trusted host delivery association; never accepted from a browser entry intent. */
  delivery?: { purpose: "text-generation" | "image-director-scene"; domainRequestId: string; attemptId: string; nodeId?: string };
  canvasId: string;
  nodeId?: string;
  mode?: AgentTargetMode;
  cameraId?: string;
  clipId?: string;
  itemId?: string;
  /**
   * Trusted world scope selection for `mode: "world"`. The host resolves the
   * canonical scope/version and leases; the assistant never supplies them.
   */
  worldScope?: AssistantWorldScopeSelection;
  /**
   * 冻结的账户模型 id（来自真实目录）。
   *
   * 选择失效时 MUST 要求用户处理，不自动换模型（design D5）；adapter 不得用别的模型冒充。
   */
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  /** 冻结的显式来源连接 id。 */
  connectionId?: string;
  /** 领域并发 precondition（模型内容哈希 / 片场 snapshotHash，按模式）。 */
  expectedContentHash?: string;
  /**
   * 受理时冻结的角色身份（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 旧回合缺省即 legacy：不补造角色指纹，查询/取消/回执恢复仍按原身份。
   */
  role?: AgentRoleRef;
  /** 受理时冻结的准备内容摘要（与角色修订、真实工具集合共同用于原生上下文隔离）。 */
  rolePreparedHash?: string;
};

/** 生成面板/详情提交的 entry intent（首轮与详情后续消息共用）。 */
export type AgentEntryIntent = {
  /** Optional public version assertion; the host still resolves ownership and credentials. */
  connection?: AgentConnectionBinding;
  action: AgentEntryAction;
  canvasId: string;
  /** 目标节点；纯讨论可为空。 */
  nodeId?: string;
  mode?: AgentTargetMode;
  cameraId?: string;
  clipId?: string;
  itemId?: string;
  /** Trusted world scope selection for `mode: "world"` (see AgentTargetSnapshot). */
  worldScope?: AssistantWorldScopeSelection;
  /** 冻结的账户模型 id（来自真实目录）；缺失时由 adapter 按当前目录处理或拒绝。 */
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  /** 显式选定的来源连接；新请求缺失时拒绝。 */
  connectionId?: string;
  /**
   * 显式选定的完整角色 id（`<extensionId>/<roleId>`）。
   *
   * 业务入口必须提交明确角色；核心不按 mode 猜角色，也不接受把连接 id 当角色。
   */
  roleId?: string;
  expectedContentHash?: string;
  prompt: string;
  /** 显式引用（不从节点版本伪造历史）。 */
  references?: readonly AgentEntryReference[];
};

/**
 * adapter 声明的能力：通用面板据此决定可用动作与文案，不静默替换聊天模型。
 * - `discussion`：支持多轮讨论；
 * - `targets`：支持的目标创作模式；
 * - `tools`：支持内置 MCP 工具（写范围须服务端门禁）；
 * - `models`：目录来源（`remote` 表示真实账户目录）。
 */
export type AssistantTextCapabilities = { imageInput: boolean; maxImages: number };

export type AgentAdapterCapabilities = {
  /** Candidate generation uses the same connection/runtime, without canvas tools. */
  textDelivery?: AssistantTextCapabilities;
  candidateGeneration?: { imageInput: boolean; maxImages: number };
  discussion: boolean;
  targets: readonly AgentTargetMode[];
  tools: boolean;
  models: "remote" | "none";
  /**
   * 通道真实支持的内建执行能力（change: 2026-11-07-add-pluggable-agent-roles）。
   * 角色声明与本集合求交；缺省表示不支持任何内建能力（不从旧回合继承）。
   */
  nativeCapabilities?: readonly import("./agent-role.js").AgentNativeCapability[];
};

/** adapter 授权状态（复用 provider 自身边界；绝不携带 token）。 */
export const AGENT_ADAPTER_AUTH_STATES = [
  "unavailable",
  "disconnected",
  "authorizing",
  "ready",
  "reauthorization-required"
] as const;
export type AgentAdapterAuthState = (typeof AGENT_ADAPTER_AUTH_STATES)[number];

export function isAgentAdapterAuthState(value: unknown): value is AgentAdapterAuthState {
  return typeof value === "string" && (AGENT_ADAPTER_AUTH_STATES as readonly string[]).includes(value);
}

/** 账户模型目录项（使用账户实际返回的 slug/displayName）。 */
export type AgentModelView = { id: string; label: string; reasoningEfforts?: readonly AgentReasoningEffort[] };

export type AgentCatalogSnapshot = { models: AgentModelView[]; error?: string };

/** 目录/授权/能力查询响应（`GET /catalog`）。 */
export type AgentCatalogResponse = {
  models: AgentModelView[];
  error?: string;
  authState: AgentAdapterAuthState;
  capabilities: AgentAdapterCapabilities;
};

/** 会话摘要（列表用；不含消息正文）。 */
/** Separates new whole-set conversations from historical local authoring context. */
export type ConversationSummary = {
  contextKey?: string;
  conversationId: string;
  canvasId: string;
  adapterId: string;
  /** 当前会话冻结的来源连接 id；不自动绑定默认连接。 */
  connectionId?: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  /** 最近一个回合的 requestId（用于打开确切运行；无回合时缺省）。 */
  latestRequestId?: string;
  /** 关联的生成目标节点（一个节点复用一条会话；design D8；未绑定/已归档时缺省）。 */
  nodeId?: string;
  turnCount: number;
};

/** 一条消息（宿主持久化；`sequence` 单调）。 */
export type ConversationMessage = {
  messageId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 内容被预算截断时为 true（不静默丢显式引用）。 */
  truncated: boolean;
  sequence: number;
  createdAt: string;
};

/** 有界、脱敏的工具过程投影（不展示完整隐式推理或凭据）。 */
export type ConversationToolActivity = {
  tool: string;
  status: "started" | "completed" | "failed";
  summary?: string;
  /** 工具记录产生前的事件 cursor；用于事件窗口不完整时恢复相对顺序。 */
  afterSequence?: number;
  createdAt?: string;
};

/** 一个回合的权威投影。 */
export type ConversationTurn = {
  turnId: string;
  conversationId: string;
  requestId: string;
  action: AgentEntryAction;
  status: ConversationTurnStatus;
  stage: string;
  target: AgentTargetSnapshot;
  /** 助手文本（来自真实 adapter 输出；不是权威终态）。 */
  assistantText?: string;
  /** 工具过程（按 sequence 有界记录）。 */
  tools: readonly ConversationToolActivity[];
  /** 领域运行关联（显式记录，不从节点 active run 反推）。 */
  runId?: string;
  taskId?: string;
  /** 权威回执（provider 领域回执，按 discriminant 呈现）。 */
  receipt?: unknown;
  /** 该回合冻结的连接身份（旧数据缺省；用于「修改连接后用原 requestId 重试」拒绝）。 */
  connection?: AgentConnectionBinding;
  /** 该回合冻结的角色身份；旧回合缺省即 legacy，不补造。 */
  role?: AgentRoleRef;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
};

/**
 * 事件类型：accepted/stage/message-delta/message-completed/tool-started/tool-completed/
 * task-linked/receipt/error。
 *
 * `message-delta` 标记一条消息**开始**并有内容更新（payload 只带 `messageId`/`role`；正文从快照
 * 读取，避免按 token 膨胀事件窗口）；`message-completed` 标记该消息结束。同一条消息只有这两个
 * 事件，分片不得各自落成消息。
 */
export const CONVERSATION_EVENT_TYPES = [
  "accepted",
  "stage",
  "message-delta",
  "message-completed",
  "tool-started",
  "tool-completed",
  "task-linked",
  "receipt",
  "error",
  "skill-step-updated"
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export function isConversationEventType(value: unknown): value is ConversationEventType {
  return typeof value === "string" && (CONVERSATION_EVENT_TYPES as readonly string[]).includes(value);
}

/** 单调 sequence 事件；订阅重连按 cursor 重放，缺窗口返回权威 snapshot。 */
export type ConversationEvent = {
  sequence: number;
  conversationId: string;
  turnId: string;
  requestId: string;
  type: ConversationEventType;
  payload: unknown;
  createdAt: string;
};

/**
 * 会话快照：消息、回合与事件的权威读模型。
 *
 * `cursor` 是当前最大事件 sequence；`resyncRequired` 表示客户端 cursor 早于保留窗口，
 * 调用方必须丢弃本地事件缓存并以本快照为准。
 *
 * `nextMessageCursor`／`nextTurnCursor` 表示还有更早的合法历史可继续读取（change:
 * 2026-10-22-remove-agent-execution-limits，任务 4.1）：分页只是单次传输片段，不是总量截断，
 * 完整历史始终可以通过游标继续读取。
 */
export type ConversationSnapshot = {
  conversation: ConversationSummary;
  turns: readonly ConversationTurn[];
  messages: readonly ConversationMessage[];
  events: readonly ConversationEvent[];
  cursor: number;
  resyncRequired: boolean;
  /** 继续读取更早消息的游标（消息 sequence）；缺省表示已到起点。 */
  nextMessageCursor?: number;
  /** 继续读取更早回合的游标（偏移）；缺省表示已到起点。 */
  nextTurnCursor?: number;
};

/**
 * provider adapter 的可执行 port 形状（宿主在进程内按能力解析；不穿过浏览器边界）。
 *
 * 通用面板只经宿主的 conversation service 间接使用；扩展注册时由宿主校验形状，
 * 缺少讨论/执行任一能力的 adapter 仍然可用（未声明的动作不可用，不静默替换）。
 */
export type AgentConversationAdapterEvent =
  | { type: "stage"; stage: string; detail?: string; /** 上游公开的可读思考摘要；不得填入原始推理。 */ summary?: string }
  | {
      type: "message";
      role: "assistant" | "system";
      content: string;
      /**
       * 文本投递语义（缺省 `append`）：
       * - `append`：content 是当前消息的**新增**分片（token/片段增量）；
       * - `replace`：content 是当前消息的**完整**文本（原生协议给的是累计快照）。
       *
       * 宿主据此把分片合并成一条可原地更新的消息，而不是每条分片各存一条。
       */
      delivery?: "append" | "replace";
      /**
       * 逻辑消息身份：同一逻辑消息的分片共用；出现新值即视为下一条消息。
       *
       * 缺省时沿用当前打开的助手消息。无身份且需要多条消息的 adapter 必须显式给值
       * （例如 ChatGPT 每个完整回复各用一个新的 `streamId`）。
       */
      streamId?: string;
    }
  | { type: "tool-started"; tool: string; callId?: string; summary?: string }
  | { type: "tool-completed"; tool: string; callId?: string; ok: boolean; summary?: string };

export type AgentAdapterRunOutcome = {
  /** 无法确认的路径已按 `failed` 结算；机器错误码说明原因。 */
  status: "succeeded" | "partial" | "failed" | "cancelled";
  assistantText?: string;
  runId?: string;
  taskId?: string;
  receipt?: unknown;
  error?: { code: string; message: string };
};

export type AgentAdapterRunInput = {
  /** Trusted host-only input; never decoded from a browser entry intent. */
  candidate?: { images: readonly AgentImageInput[]; outputSchema: Record<string, unknown> };
  /**
   * 宿主准备好的角色回合（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 通道只消费它：不得再按业务 mode 构造角色提示词或选择业务工具。缺失表示旧回合/旧路径，
   * 新目标回合不会以空 prepared 执行（宿主在受理时已拒绝）。
   */
  prepared?: PreparedAgentRoleTurn;
  owner: string;
  canvasId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  intent: AgentEntryIntent;
  /**
   * 本回合冻结的来源连接身份（change: 2026-10-16-...，任务 2.2）。
   *
   * adapter 据此解析自身连接配置与凭据 epoch；不同连接不得复用原生会话。旧数据缺省时不注入。
   */
  connection?: AgentConnectionBinding;
  /** 合法已完成历史（仅内容；不继承旧工具权限）。 */
  history: readonly ConversationMessage[];
  /** Host-resolved media bytes. Internal adapter input only; never accept filesystem paths from a request. */
  images?: readonly { bytes: Uint8Array; contentType: string }[];
  signal: AbortSignal;
  emit: (event: AgentConversationAdapterEvent) => void;
};

export type AgentImageInput = { bytes: Uint8Array; contentType: string };

export type AgentConversationAdapter = {
  /** adapter 稳定 id（registry key）。 */
  id: string;
  /** 声明后只能经该 daemon executor 执行；宿主不提供进程内执行回退。 */
  runtimeExecutor?: string;
  capabilities(): AgentAdapterCapabilities;
  /** 授权状态（真实 provider 状态；不携带 token）。 */
  authorization(input: { owner: string }): Promise<AgentAdapterAuthState>;
  /** 账户模型目录；失败保留原选择，不自动换模型。 */
  models(input: { owner: string }): Promise<AgentCatalogSnapshot>;
  /** 讨论或目标执行；未声明能力时调用方 MUST 拒绝并说明原因。 */
  run(input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome>;
  /** 重启后核对领域回执（不自动重推理）。 */
  query?(input: { owner: string; requestId: string }): Promise<AgentAdapterRunOutcome | null>;
  /** 取消在途回合（不撤销已提交领域动作）。 */
  cancel?(input: { owner: string; requestId: string; candidateContext?: { canvasId: string; conversationId: string; connection: AgentConnectionBinding; intent: AgentEntryIntent } }): Promise<void>;
  dispose?(): void | Promise<void>;
};

/**
 * 宿主 Agent 会话的显式本地身份端口 capability id
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.3 / design D2）。
 *
 * provider 扩展（当前为 ChatGPT）注册 `{ resolveLocalSession(req) }`，把**自身已有**的
 * 可信浏览器 HttpOnly 会话解析为宿主可用的 owner；宿主会话 API 优先复用该身份，MUST NOT
 * 另造浏览器 ID。配置了可信认证适配器时该端口返回 null（生产不回退到本地会话）。
 */
export const AGENT_CONVERSATION_IDENTITY_CAPABILITY_ID = "agent-conversation-identity" as const;

/** 本地会话身份解析结果（宿主 owner + 会话绑定；仅新建会话时下发 Set-Cookie）。 */
export type AgentConversationSessionIdentity = {
  /** 宿主会话 owner（provider 扩展的凭据 owner 命名空间；不来自请求自报）。 */
  subject: string;
  /** 会话绑定 id（审计/分派用）。 */
  sessionId: string;
  /** 需要下发的 Set-Cookie（仅新建本地会话时）。 */
  setCookie?: string;
};

/**
 * 显式宿主 identity port：provider 扩展把自身可信的浏览器会话身份暴露给宿主会话 API。
 *
 * `req` 为宿主注入的原始请求（纯类型下声明为 `unknown`，实现方按自身驱动收窄）；解析不出
 * 可信身份时返回 null，宿主不伪造身份。
 */
export type AgentConversationIdentityPort = {
  resolveLocalSession: (req: unknown) => AgentConversationSessionIdentity | null;
};

/** 形状校验：拒绝半成品 identity port 注册。 */
export function isAgentConversationIdentityPort(value: unknown): value is AgentConversationIdentityPort {
  return isJsonObject(value) && typeof value.resolveLocalSession === "function";
}

const AGENT_ADAPTER_CAPABILITY_PREFIX = "agent-conversation-adapter:";

export function agentConversationAdapterCapabilityId(adapterId: string): string {
  return `${AGENT_ADAPTER_CAPABILITY_PREFIX}${adapterId}`;
}

export function isAgentConversationAdapterCapabilityId(value: string): boolean {
  return value.startsWith(AGENT_ADAPTER_CAPABILITY_PREFIX) && value.length > AGENT_ADAPTER_CAPABILITY_PREFIX.length;
}

export function agentConversationAdapterIdFromCapabilityId(value: string): string {
  return value.slice(AGENT_ADAPTER_CAPABILITY_PREFIX.length);
}

/** 形状校验：拒绝半成品 adapter 注册（宿主在 activation 前校验）。 */
export function isAgentConversationAdapterShape(value: unknown): value is AgentConversationAdapter {
  if (!isJsonObject(value)) return false;
  if (!isBoundedId(value.id)) return false;
  if (typeof value.capabilities !== "function") return false;
  if (typeof value.authorization !== "function") return false;
  if (typeof value.models !== "function") return false;
  if (typeof value.run !== "function") return false;
  return true;
}

/** 校验 adapter 能力声明形状。 */
export function isAgentAdapterCapabilities(value: unknown): value is AgentAdapterCapabilities {
  if (!isJsonObject(value)) return false;
  if (!isBoolean(value.discussion)) return false;
  if (!isBoolean(value.tools)) return false;
  if (value.models !== "remote" && value.models !== "none") return false;
  if (!Array.isArray(value.targets)) return false;
  if (value.textDelivery !== undefined && (!isJsonObject(value.textDelivery) || !isBoolean(value.textDelivery.imageInput) || !Number.isSafeInteger(value.textDelivery.maxImages) || (value.textDelivery.maxImages as number) < 0)) return false;
  if (value.candidateGeneration !== undefined) {
    const candidate = value.candidateGeneration;
    if (!isJsonObject(candidate) || !isBoolean(candidate.imageInput) || !Number.isSafeInteger(candidate.maxImages) || (candidate.maxImages as number) < 1) return false;
  }
  if (value.nativeCapabilities !== undefined && (!Array.isArray(value.nativeCapabilities) || !value.nativeCapabilities.every(isAgentNativeCapability))) return false;
  return value.targets.every(isAgentTargetMode);
}

/** 解码结果：成功携带值；失败携带稳定错误码与可读原因。 */
export type AgentConversationDecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * 稳定会话错误码（跨进程按字符串判定）。
 *
 * `conversation-busy` 与 `budget-exceeded` 是**历史契约码**（change:
 * 2026-10-22-remove-agent-execution-limits，任务 3.1）：受理与执行已不再产生它们，保留只为
 * 旧历史记录与跨版本解码继续可读，不得作为新增拒绝路径。
 */
export const AGENT_CONVERSATION_ERROR_CODES = [
  "malformed-request",
  "unauthorized",
  "not-found",
  "request-id-reused",
  "conversation-busy",
  "adapter-unavailable",
  "connection-unavailable",
  "capability-unsupported",
  "budget-exceeded",
  "storage-failed",
  // 角色（change: 2026-11-07-add-pluggable-agent-roles）
  "role-not-found",
  "role-unavailable",
  "role-version-conflict",
  "role-input-invalid",
  "role-context-invalid",
  "role-requirement-unsatisfied",
  "role-prepare-failed"
] as const;
export type AgentConversationErrorCode = (typeof AGENT_CONVERSATION_ERROR_CODES)[number];

export function isAgentConversationErrorCode(value: unknown): value is AgentConversationErrorCode {
  return typeof value === "string" && (AGENT_CONVERSATION_ERROR_CODES as readonly string[]).includes(value);
}

/** 供测试/诊断：依赖的字符串能力集合（非空校验）。 */
export function assertStringArray(value: unknown, key: string): string[] {
  if (!isStringArray(value)) throw new Error(`${key} 必须是字符串数组`);
  return value;
}
