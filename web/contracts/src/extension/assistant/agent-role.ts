/**
 * Agent 角色契约（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 角色回答「做什么、专长、可以用什么、交付什么」，执行通道回答「如何运行」。
 * 本模块只有纯类型与常量：注册表、准备管道、授权与持久化都在宿主实现里。
 *
 * 关键边界：
 * - 角色定义里不得出现模型、账号、连接、凭据、MCP endpoint、owner 或世界租约；
 * - 角色声明只是**边界**，不是权限：真实写入仍由 Canvas/Task/Media 的领域授权决定；
 * - 候选输出不等于已交付，成功终态仍由原领域回执给出。
 */
import type { AgentTargetMode } from "./conversation.js";

/** 可序列化 JSON schema 形状（复用项目既有 `Record<string, unknown>` 约定，不引入验证框架）。 */
export type AgentRoleJsonSchema = Readonly<Record<string, unknown>>;

/** 语义消息角色；执行通道按自身协议转换成消息、指令参数或单个文本 prompt。 */
export const AGENT_PROMPT_MESSAGE_ROLES = ["system", "user", "assistant"] as const;
export type AgentPromptMessageRole = (typeof AGENT_PROMPT_MESSAGE_ROLES)[number];

export type AgentPromptMessage = {
  role: AgentPromptMessageRole;
  content: string;
};

/**
 * 宿主识别并可实际求交的内建执行能力。
 *
 * 初始只有生成图片：它需要通道真实支持产物回收，不能由角色文本自报开启。
 */
export const AGENT_NATIVE_CAPABILITIES = ["generate-image"] as const;
export type AgentNativeCapability = (typeof AGENT_NATIVE_CAPABILITIES)[number];

export function isAgentNativeCapability(value: unknown): value is AgentNativeCapability {
  return typeof value === "string" && (AGENT_NATIVE_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * 输出能力：
 * - `none`：只需要普通文本回复；
 * - `validated-json`：schema 随 prompt 发送，结束后由宿主严格解码；
 * - `schema-enforced`：必须使用通道真实支持的结构化参数，不能静默降级。
 */
export const AGENT_ROLE_STRUCTURED_OUTPUTS = ["none", "validated-json", "schema-enforced"] as const;
export type AgentRoleStructuredOutput = (typeof AGENT_ROLE_STRUCTURED_OUTPUTS)[number];

export function isAgentRoleStructuredOutput(value: unknown): value is AgentRoleStructuredOutput {
  return typeof value === "string" && (AGENT_ROLE_STRUCTURED_OUTPUTS as readonly string[]).includes(value);
}

/** 角色对执行通道的要求；缺失即在发送前明确不可用。 */
export type AgentRoleRequirements = {
  imageInput: boolean;
  toolCalling: boolean;
  structuredOutput: AgentRoleStructuredOutput;
};

/** 角色允许的工具集合；两者都只是「允许」，不是授权。 */
export type AgentRoleToolset = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
};

/** 角色允许的内建能力；缺省关闭。 */
export type AgentRoleNativeCapabilities = {
  readonly required: readonly AgentNativeCapability[];
  readonly optional: readonly AgentNativeCapability[];
};

/** 交付形态；与用户的 `generate/modify/discuss` 动作正交。 */
export type AgentRoleOutput =
  | { readonly kind: "reply" }
  | { readonly kind: "candidate"; readonly schema: AgentRoleJsonSchema }
  | { readonly kind: "tool-receipts" };

export type AgentRoleOutputKind = AgentRoleOutput["kind"];

/** 插件声明的角色定义。`id` 只是插件内名字，完整身份由宿主加扩展命名空间。 */
export type AgentRoleDefinition = {
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly specialty: string;
  /** 基础角色指令；宿主放在规范消息最前面。 */
  readonly instructions: string;
  readonly inputSchema: AgentRoleJsonSchema;
  /** 领域预先授权并准备好的上下文形状。 */
  readonly contextSchema: AgentRoleJsonSchema;
  readonly tools: AgentRoleToolset;
  readonly nativeCapabilities: AgentRoleNativeCapabilities;
  readonly requirements: AgentRoleRequirements;
  readonly output: AgentRoleOutput;
};

/** prepare 只接收已校验的输入、宿主授权的领域上下文与宿主冻结的目标身份。 */
export type AgentRolePrepareInput = {
  readonly input: unknown;
  readonly context: unknown;
  /** 受理时冻结的目标身份（只含稳定 id/范围，不含 owner/租约/grant）。 */
  readonly target: AgentRoleTargetRef;
  /** 本回合稳定 requestId（只用于让角色把同一身份写进指令/工具参数）。 */
  readonly requestId: string;
  /** 领域冻结的内容前置条件（若有）；角色只能转述，不能自行计算。 */
  readonly expectedContentHash?: string;
  /** 宿主/通道实际开启的内建能力（可选能力只在真实支持时出现）。 */
  readonly nativeCapabilities: readonly AgentNativeCapability[];
};

/** prepare 产出的规范消息与可选的工具收窄集合。 */
export type AgentRolePrompt = {
  readonly messages: readonly AgentPromptMessage[];
  /** 只能进一步收窄 definition.tools；越界或未声明即视为非法准备。 */
  readonly tools?: readonly string[];
};

/** 插件注册的角色实现；`prepare` 必须是确定性同步模板构造。 */
export type AgentRoleImplementation = {
  readonly definition: AgentRoleDefinition;
  prepare(input: AgentRolePrepareInput): AgentRolePrompt;
};

/**
 * 宿主确认的完整角色身份。
 *
 * `descriptorDigest` 是定义内容摘要，`artifactId` 是实际装载的实现制品身份；两者分开保存，
 * 不能用函数 `toString` 摘要冒充实现身份。
 */
export type AgentRoleRef = {
  /** `<extensionId>/<roleId>`；业务入口必须显式选择完整身份。 */
  readonly namespacedId: string;
  readonly roleId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly descriptorDigest: string;
  readonly artifactId: string;
  readonly configVersion?: number;
};

/** 只读目录项：不含运行回调、凭据或完整权威上下文。 */
export type AgentRoleDescriptor = {
  readonly ref: AgentRoleRef;
  readonly title: string;
  readonly specialty: string;
  readonly requirements: AgentRoleRequirements;
  /** 宿主内部/受信扩展可见；公开 HTTP 目录会省略工具与内建能力清单。 */
  readonly tools?: AgentRoleToolset;
  readonly nativeCapabilities?: AgentRoleNativeCapabilities;
  readonly outputKind: AgentRoleOutputKind;
  readonly available: boolean;
  /** 不可用原因（缺失工具/通道能力/插件停用）；可用时省略。 */
  readonly reason?: string;
  /** 结构化缺失项（`tool:<name>` / `native:<capability>` / 通道能力名）。 */
  readonly missing?: readonly string[];
};

/** 执行通道对本轮请求的真实能力声明（由通道/模型目录给出，不从角色推导）。 */
export type AgentRoleChannelCapabilities = {
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly structuredOutput: AgentRoleStructuredOutput;
  readonly nativeCapabilities: readonly AgentNativeCapability[];
};

/** 回合冻结的目标身份；只用稳定 id，不携带 owner/租约。 */
export type AgentRoleTargetRef = {
  /** 画布目标（与画布无关的单次任务可省略）。 */
  readonly canvasId?: string;
  readonly nodeId?: string;
  readonly mode?: AgentTargetMode;
  readonly cameraId?: string;
  /** 领域冻结的内容前置条件（模型内容哈希 / 组 epoch 等）。 */
  readonly expectedContentHash?: string;
  readonly allowSceneAreaExpansion?: boolean;
  /** 世界目标的宿主已选范围（只含身份，不含版本/租约）。 */
  readonly worldScope?: {
    readonly kind: "scene-area" | "workflow-group-2d" | "world-camera";
    readonly areaId?: string;
    readonly groupId?: string;
    readonly cameraId?: string;
  };
};

/**
 * 宿主准备完成、可重放的角色回合。
 *
 * 可序列化部分不含秘密：工具授权（grant token）、MCP 地址与凭据仍由执行通道的既有时序签发，
 * 浏览器请求不得构造或改写本对象。
 */
export type PreparedAgentRoleTurn = {
  readonly schemaVersion: 1;
  readonly roleRef: AgentRoleRef;
  /** 已合成的规范消息（definition.instructions 在最前）。 */
  readonly messages: readonly AgentPromptMessage[];
  /** 求交后的工具集合（角色允许 ∩ prepare 收窄 ∩ 授权 ∩ 通道能力 ∩ 实际目录）。 */
  readonly tools: readonly string[];
  readonly nativeCapabilities: readonly AgentNativeCapability[];
  readonly output: AgentRoleOutput;
  readonly inputDigest: string;
  readonly contextDigest: string;
  /** 宿主准备的附件身份摘要；字节沿原附件通道传递。 */
  readonly attachmentDigests: readonly string[];
  readonly target: AgentRoleTargetRef;
  readonly preparedHash: string;
};

/** 稳定角色错误码；不携带原始图片字节、凭据或完整私有上下文。 */
export const AGENT_ROLE_ERROR_CODES = [
  "role-not-found",
  "role-unavailable",
  "role-version-conflict",
  "role-input-invalid",
  "role-context-invalid",
  "role-requirement-unsatisfied",
  "role-prepare-failed",
  "role-duplicate",
  "role-invalid-definition",
  "role-forbidden-field"
] as const;
export type AgentRoleErrorCode = (typeof AGENT_ROLE_ERROR_CODES)[number];

export function isAgentRoleErrorCode(value: unknown): value is AgentRoleErrorCode {
  return typeof value === "string" && (AGENT_ROLE_ERROR_CODES as readonly string[]).includes(value);
}

export type AgentRoleFailure = {
  readonly ok: false;
  readonly code: AgentRoleErrorCode;
  readonly message: string;
  /** 缺失的必要能力/工具/内建能力（requirement-unsatisfied）。 */
  readonly missing?: readonly string[];
};

export function agentRoleFailure(
  code: AgentRoleErrorCode,
  message: string,
  missing?: readonly string[]
): AgentRoleFailure {
  return { ok: false, code, message, ...(missing ? { missing } : {}) };
}

export const AGENT_ROLE_SCHEMA_VERSION = 1 as const;
