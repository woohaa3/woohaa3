/**
 * Agent 连接身份、授权方式、状态证据与模型能力公开契约（纯类型）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.1 / design D3/D4）。
 *
 * 连接是本 change 的**第一等身份**：它把一个可信 owner 与一个提供方接入方式绑定，
 * 供生成入口按用户选择解析 adapter、模型与工具范围。本模块只声明纯类型与无副作用形状校验：
 * - 稳定 `connectionId` 不从显示名 / base URL / 裸 token 推导；
 * - `authMode` 显式声明，授权入口取决于提供方实际支持的方式（OAuth 或 API Key）；
 * - 状态证据分开记录 transport / credential / modelAccess / tools，`ready` 只在当前动作所需
 *   能力满足时成立；
 * - 模型能力来源区分上游目录、用户手填与本地内置，不能把手填模型冒充账号已授权；
 * - **不含秘密**：API Key 只以「是否已配置」投影，任何 token 都不进入本契约。
 *
 * 连接元数据/凭据由贡献方扩展按扩展、owner、connectionId 隔离保存；宿主只认识连接引用与能力。
 */

import { isAgentReasoningEffort, isAgentTargetMode, type AgentTargetMode } from "./conversation.js";

/** 固定 API 引擎映射；历史 adapter ID 不作为引擎选择项。 */
export const AGENT_API_ENGINES = {
  openai: "codex-agent-sdk",
  anthropic: "claude-agent-sdk",
  "chat-completions": "dsh-agent-sdk",
  gemini: "gemini-agent-adk"
} as const;
export type AgentApiType = keyof typeof AGENT_API_ENGINES;
export type AgentEngineId = (typeof AGENT_API_ENGINES)[AgentApiType];
export const AGENT_RUNTIME_SCHEMA_VERSION = 1;

/** 无秘密的运行时证据；缺少依赖不得用 HTTP 推理降级。 */
export type AgentConnectionRuntime = {
  schemaVersion: 1;
  apiType: AgentApiType;
  engine: AgentEngineId;
  engineVersion: string;
  dependency: AgentConnectionStatusEvidence;
  tasks: Record<"discussion" | "imageInput" | "targetExecution", AgentConnectionStatusEvidence>;
};

export function isAgentConnectionRuntime(value: unknown): value is AgentConnectionRuntime {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== AGENT_RUNTIME_SCHEMA_VERSION) return false;
  if (typeof candidate.apiType !== "string" || !Object.hasOwn(AGENT_API_ENGINES, candidate.apiType)) return false;
  if (candidate.engine !== AGENT_API_ENGINES[candidate.apiType as AgentApiType]) return false;
  if (typeof candidate.engineVersion !== "string" || candidate.engineVersion.trim() === "") return false;
  if (!isStatusEvidence(candidate.dependency)) return false;
  if (typeof candidate.tasks !== "object" || candidate.tasks === null) return false;
  const tasks = candidate.tasks as Record<string, unknown>;
  return ["discussion", "imageInput", "targetExecution"].every((task) => isStatusEvidence(tasks[task]));
}

/** 连接运行类别：决定是否需要本机进程，以及授权入口的默认姿态。 */
export const AGENT_CONNECTION_RUN_CATEGORIES = ["local-appserver", "http-sdk", "agent-sdk"] as const;
export type AgentConnectionRunCategory = (typeof AGENT_CONNECTION_RUN_CATEGORIES)[number];

export function isAgentConnectionRunCategory(value: unknown): value is AgentConnectionRunCategory {
  return typeof value === "string" && (AGENT_CONNECTION_RUN_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 显式授权方式。
 *
 * - `oauth`：提供方官方 OAuth（仅 adapter 实际声明且验证过时展示）；
 * - `api-key`：个人 API Key 填写/测试/替换/清除；
 * - `local-login`：由本机工具官方登录流程准备好的账号，本应用只读取连接结果、不复制认证文件；
 * - `none`：无需账号（如回环服务的连接口令由服务自己签发仍属 `local-login`）。
 */
export const AGENT_CONNECTION_AUTH_MODES = ["oauth", "api-key", "local-login", "none"] as const;
export type AgentConnectionAuthMode = (typeof AGENT_CONNECTION_AUTH_MODES)[number];

export function isAgentConnectionAuthMode(value: unknown): value is AgentConnectionAuthMode {
  return typeof value === "string" && (AGENT_CONNECTION_AUTH_MODES as readonly string[]).includes(value);
}

/**
 * 状态证据种类。分开记录，避免「保存了 Key」被当成「模型可调用」。
 *
 * - `transport`：服务/进程可连接（真实协议响应，不把 HTML 200 当健康）；
 * - `credential`：凭据已保存且未失效；
 * - `modelAccess`：账号/模型访问已验证；
 * - `tools`：本轮工具范围可注入。
 */
export const AGENT_CONNECTION_STATUS_KINDS = ["transport", "credential", "modelAccess", "tools"] as const;
export type AgentConnectionStatusKind = (typeof AGENT_CONNECTION_STATUS_KINDS)[number];

/** 单类证据状态；`checkedAt` 是采集时间（无检查时为 null）。 */
export const AGENT_CONNECTION_STATUS_STATES = ["unknown", "ready", "pending", "unavailable", "failed"] as const;
export type AgentConnectionStatusState = (typeof AGENT_CONNECTION_STATUS_STATES)[number];

export function isAgentConnectionStatusState(value: unknown): value is AgentConnectionStatusState {
  return typeof value === "string" && (AGENT_CONNECTION_STATUS_STATES as readonly string[]).includes(value);
}

export type AgentConnectionStatusEvidence = {
  state: AgentConnectionStatusState;
  /** 采集时间（ISO）；未检查时为 null。 */
  checkedAt?: string | null;
  /** 可读原因（失败/待处理）；不携带凭据。 */
  reason?: string;
};

/** 四类证据的完整快照。 */
export type AgentConnectionStatus = Record<AgentConnectionStatusKind, AgentConnectionStatusEvidence>;

/** 模型能力来源：区分上游目录、用户手填与本地内置。 */
export const AGENT_MODEL_CAPABILITY_SOURCES = ["remote-catalog", "user-provided", "builtin"] as const;
export type AgentModelCapabilitySource = (typeof AGENT_MODEL_CAPABILITY_SOURCES)[number];

export function isAgentModelCapabilitySource(value: unknown): value is AgentModelCapabilitySource {
  return typeof value === "string" && (AGENT_MODEL_CAPABILITY_SOURCES as readonly string[]).includes(value);
}

/**
 * 连接声明的能力。
 *
 * 与既有 `AgentAdapterCapabilities` 分开：后者描述 adapter 的通用能力，本类型额外覆盖图片输入、
 * 结构化结果、取消与恢复，供生成入口在发送前做目标/输入预检（design D3/D8）。
 */
export type AgentConnectionCapabilities = {
  textDelivery?: import("./conversation.js").AssistantTextCapabilities;
  discussion: boolean;
  imageInput: boolean;
  tools: boolean;
  structuredResult: boolean;
  cancel: boolean;
  resume: boolean;
  /** 通道支持的显式目标模式；缺省表示未声明（调用方不得据此猜测）。 */
  targets?: readonly AgentTargetMode[];
};

/** 连接可见模型：能力、来源与账号授权分离。 */
export type AgentConnectionModel = {
  reasoningEfforts?: readonly import("./conversation.js").AgentReasoningEffort[];
  id: string;
  label: string;
  source: AgentModelCapabilitySource;
  /**
   * 该模型是否属于**账号已授权**能力。
   *
   * `user-provided` / `builtin` 目标准入前不得标 true（避免手填模型冒充已授权）。
   */
  accountAuthorized: boolean;
  /** 模型级能力覆盖（缺省继承连接能力）。 */
  capabilities?: Partial<Pick<AgentConnectionCapabilities, "imageInput" | "tools" | "structuredResult" | "textDelivery">>;
};

/**
 * 公开连接视图：**不含任何秘密**。
 *
 * 客户端自报 owner、显示名、模型名或服务地址都不是凭据归属依据；本视图由后端按可信 owner
 * 投影，`credentialConfigured` 只表示「已保存」，不回读明文 Key。
 */
export type AgentConnectionView = {
  /** 稳定连接身份（不从显示名/地址/token 推导）。 */
  connectionId: string;
  /** 来自服务连接来源的连接投影到该来源身份；本地 Agent 与旧连接可能缺省。 */
  serviceConnectionId?: string;
  /** 旧记录缺省；仅投影已由贡献方核验的引擎证据。 */
  runtime?: AgentConnectionRuntime;
  /** 解析 adapter 的稳定 id。 */
  adapterId: string;
  /** 贡献该连接的扩展 id。 */
  extensionId: string;
  name: string;
  runCategory: AgentConnectionRunCategory;
  authMode: AgentConnectionAuthMode;
  /** 非秘密配置 revision（修改接入方式/配置递增）。 */
  configRevision: number;
  /** 凭据 epoch（替换/清除密钥递增；同一 epoch 才可复用原生会话）。 */
  credentialEpoch: number;
  status: AgentConnectionStatus;
  /** 当前动作所需能力是否满足；仅当所需证据为 ready 时成立。 */
  ready: boolean;
  capabilities: AgentConnectionCapabilities;
  models: readonly AgentConnectionModel[];
  /** 目录读取失败原因（保留原选择，不自动换模型）。 */
  modelsError?: string;
  /** 是否已保存凭据（不返回明文）。 */
  credentialConfigured: boolean;
  /**
   * 自定义 base URL 是否通过部署允许策略。
   *
   * 缺省 undefined 表示无自定义 endpoint。
   */
  endpointAllowed?: boolean;
  /** 不可就绪原因（展示用）。 */
  reason?: string;
};

/** 形状校验：拒绝半成品连接视图注册。 */
export function isAgentConnectionCapabilities(value: unknown): value is AgentConnectionCapabilities {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.textDelivery === undefined || isTextDelivery(candidate.textDelivery)) &&
    typeof candidate.discussion === "boolean" &&
    typeof candidate.imageInput === "boolean" &&
    typeof candidate.tools === "boolean" &&
    typeof candidate.structuredResult === "boolean" &&
    typeof candidate.cancel === "boolean" &&
    typeof candidate.resume === "boolean" &&
    (candidate.targets === undefined || (Array.isArray(candidate.targets) && candidate.targets.every(isAgentTargetMode)))
  );
}

function isStatusEvidence(value: unknown): value is AgentConnectionStatusEvidence {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isAgentConnectionStatusState(candidate.state);
}

export function isAgentConnectionStatus(value: unknown): value is AgentConnectionStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return AGENT_CONNECTION_STATUS_KINDS.every((kind) => isStatusEvidence(candidate[kind]));
}

export function isAgentConnectionModel(value: unknown): value is AgentConnectionModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.capabilities === undefined || (typeof candidate.capabilities === "object" && candidate.capabilities !== null && ((candidate.capabilities as Record<string, unknown>).textDelivery === undefined || isTextDelivery((candidate.capabilities as Record<string, unknown>).textDelivery)))) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.label === "string" &&
    isAgentModelCapabilitySource(candidate.source) &&
    typeof candidate.accountAuthorized === "boolean" &&
    (candidate.reasoningEfforts === undefined || (Array.isArray(candidate.reasoningEfforts) && candidate.reasoningEfforts.every(isAgentReasoningEffort)))
  );
}

export function isAgentConnectionView(value: unknown): value is AgentConnectionView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.connectionId !== "string" || candidate.connectionId.length === 0) return false;
  if (typeof candidate.adapterId !== "string" || candidate.adapterId.length === 0) return false;
  if (typeof candidate.extensionId !== "string" || candidate.extensionId.length === 0) return false;
  if (typeof candidate.name !== "string") return false;
  if (!isAgentConnectionRunCategory(candidate.runCategory)) return false;
  if (!isAgentConnectionAuthMode(candidate.authMode)) return false;
  if (typeof candidate.configRevision !== "number") return false;
  if (typeof candidate.credentialEpoch !== "number") return false;
  if (!isAgentConnectionStatus(candidate.status)) return false;
  if (candidate.runtime !== undefined && !isAgentConnectionRuntime(candidate.runtime)) return false;
  if (typeof candidate.ready !== "boolean") return false;
  if (!isAgentConnectionCapabilities(candidate.capabilities)) return false;
  if (!Array.isArray(candidate.models) || !candidate.models.every(isAgentConnectionModel)) return false;
  if (typeof candidate.credentialConfigured !== "boolean") return false;
  return true;
}

/**
 * 连接发现端口 capability id 前缀。
 *
 * 贡献方扩展注册 `{ listConnections, getConnection? }`，宿主按可信 owner 解析可见连接；
 * 核心不 import 任何厂商实现（design D3 / 任务 2.1）。
 */
const AGENT_CONNECTION_PROVIDER_CAPABILITY_PREFIX = "agent-connection-provider:";

export function agentConnectionProviderCapabilityId(providerId: string): string {
  return `${AGENT_CONNECTION_PROVIDER_CAPABILITY_PREFIX}${providerId}`;
}

export function isAgentConnectionProviderCapabilityId(value: string): boolean {
  return value.startsWith(AGENT_CONNECTION_PROVIDER_CAPABILITY_PREFIX) && value.length > AGENT_CONNECTION_PROVIDER_CAPABILITY_PREFIX.length;
}

export function agentConnectionProviderIdFromCapabilityId(value: string): string {
  return value.slice(AGENT_CONNECTION_PROVIDER_CAPABILITY_PREFIX.length);
}

/**
 * 连接发现端口形状（进程内；不穿过浏览器边界）。
 *
 * 只返回 owner-scoped 公开视图；凭据与原生会话映射留在扩展私有存储。未激活/无权限的扩展不注册
 * 该 capability，因此「未安装/停用」的连接自然不可见（fail closed）。
 */
export type AgentConnectionProvider = {
  /** 提供方稳定 id（= capability 后缀）。 */
  id: string;
  /** 列出该 owner 可见连接（不含秘密）。 */
  listConnections(input: { owner: string }): Promise<readonly AgentConnectionView[]>;
  /** Explicit execution preparation only; never called by read-only discovery. */
  migrateConnection?(input: { owner: string; connectionId: string; beforeMigration: () => boolean }): Promise<{ changed: boolean }>;
  /** 读取单条连接；不存在或非本 owner 返回 null。 */
  getConnection?(input: { owner: string; connectionId: string }): Promise<AgentConnectionView | null>;
};

export function isAgentConnectionProviderShape(value: unknown): value is AgentConnectionProvider {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
  if (typeof candidate.listConnections !== "function") return false;
  if (candidate.getConnection !== undefined && typeof candidate.getConnection !== "function") return false;
  return true;
}

/**
 * 凭据用途。请求严格区分三类用途，禁止跨提供方/连接复用（design D4）。
 */
export const AGENT_CREDENTIAL_PURPOSES = ["model-api-key", "appserver-auth", "mcp-grant"] as const;
export type AgentCredentialPurpose = (typeof AGENT_CREDENTIAL_PURPOSES)[number];

export function isAgentCredentialPurpose(value: unknown): value is AgentCredentialPurpose {
  return typeof value === "string" && (AGENT_CREDENTIAL_PURPOSES as readonly string[]).includes(value);
}

/**
 * 连接检查种类：默认做**无生成**的探测；需要付费的最小推理由显式「测试生成」触发。
 *
 * 保存设置 MUST NOT 自动调用模型或画布工具。
 */
export const AGENT_CONNECTION_CHECK_KINDS = ["probe", "generation"] as const;
export type AgentConnectionCheckKind = (typeof AGENT_CONNECTION_CHECK_KINDS)[number];

export function isAgentConnectionCheckKind(value: unknown): value is AgentConnectionCheckKind {
  return typeof value === "string" && (AGENT_CONNECTION_CHECK_KINDS as readonly string[]).includes(value);
}

/** 解码结果：成功携带值；失败携带稳定错误码与可读原因。 */
export type AgentConnectionDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

/** 稳定连接错误码（跨进程按字符串判定）。 */
export const AGENT_CONNECTION_ERROR_CODES = [
  "malformed-request",
  "unauthorized",
  "not-found",
  "connection-unsupported",
  "credential-missing",
  "endpoint-not-allowed",
  "transport-unavailable",
  "protocol-mismatch",
  "model-access-denied",
  "capability-unsupported",
  "runtime-missing",
  "budget-exceeded",
  "storage-failed"
] as const;
export type AgentConnectionErrorCode = (typeof AGENT_CONNECTION_ERROR_CODES)[number];

export function isAgentConnectionErrorCode(value: unknown): value is AgentConnectionErrorCode {
  return typeof value === "string" && (AGENT_CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

/** 所有证据 `ready` 时连接才算就绪（供贡献方投影 `ready`）。 */
export function connectionReady(
  status: AgentConnectionStatus,
  required: readonly AgentConnectionStatusKind[] = AGENT_CONNECTION_STATUS_KINDS
): boolean {
  return required.every((kind) => status[kind].state === "ready");
}

function isTextDelivery(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const capability = value as Record<string, unknown>;
  return typeof capability.imageInput === "boolean" && Number.isSafeInteger(capability.maxImages) && (capability.maxImages as number) >= 0;
}
