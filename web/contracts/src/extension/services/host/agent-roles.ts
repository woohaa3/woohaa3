/**
 * Agent 角色宿主面（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * `HostAgentRoleService` 是扩展可见的**注册面**：注册按实际装载 owner 记账，停用/回滚时由宿主
 * 自动注销；插件不能自报别的扩展身份。`ApplicationExtensionAgentRoleFacade` 是受信后端扩展
 * （业务入口）使用的**准备面**：只做解析、校验、匹配与确定性 prepare，不推理、不写作品。
 */
import type {
  AgentRoleDescriptor,
  AgentRoleFailure,
  AgentRoleImplementation,
  AgentRoleTargetRef,
  AgentRoleChannelCapabilities,
  PreparedAgentRoleTurn
} from "../../assistant/agent-role.js";

export type HostAgentRoleService = {
  /** 注册本插件实现的角色；返回幂等注销。重复完整身份由宿主拒绝并回滚激活。 */
  register(implementation: AgentRoleImplementation): () => void;
  /** 本插件已注册角色（只读、无准备副作用）。 */
  list(): readonly AgentRoleDescriptor[];
  /** 读取某角色的可用性（缺失工具/通道能力时给出真实原因）。 */
  availability(namespacedId: string): { available: boolean; reason?: string };
};

export type ApplicationExtensionAgentRolePrepareRequest = {
  /** 完整命名空间角色 id（`<extensionId>/<roleId>`）。 */
  roleId: string;
  input: unknown;
  /** 领域入口准备好的权威上下文；调用方必须是受信后端扩展。 */
  context: unknown;
  target: AgentRoleTargetRef;
  /** 本回合稳定 requestId（业务入口自己的幂等身份）。 */
  requestId: string;
  /** 领域冻结的内容前置条件（若有）。 */
  expectedContentHash?: string;
  /** 所选执行通道/模型的真实能力。 */
  channel: AgentRoleChannelCapabilities;
  /** 业务入口显式收窄（只能是角色声明的子集）。 */
  requestedTools?: readonly string[];
  /** 附件身份摘要（字节沿原附件通道传递，不进入角色定义）。 */
  attachments?: readonly unknown[];
};

export type ApplicationExtensionAgentRolePrepareResult =
  | { ok: true; turn: PreparedAgentRoleTurn }
  | AgentRoleFailure;

/** 受信后端扩展可用的角色准备面（不穿过浏览器边界）。 */
export type ApplicationExtensionAgentRoleFacade = {
  prepare(input: ApplicationExtensionAgentRolePrepareRequest): ApplicationExtensionAgentRolePrepareResult;
  list(): readonly AgentRoleDescriptor[];
  availability(namespacedId: string): { available: boolean; reason?: string };
};
