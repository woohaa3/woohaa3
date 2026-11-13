/**
 * standard-agent-roles 后端入口（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 只贡献角色实现：不依赖本机 / SDK / OAuth 执行扩展，不启动模型、不签发授权、不写画布。
 * 角色归属由宿主按本次 activation 的扩展身份记账，重复 ID 会让激活失败并回滚。
 */
import type { ApplicationBackendExtensionDefinition } from "@woohaa3/contracts";
import { STANDARD_AGENT_ROLES } from "./roles/index.js";

export const STANDARD_AGENT_ROLES_PLUGIN_ID = "standard-agent-roles" as const;

export type StandardAgentRolesExtensionOptions = Record<string, never>;

export function createStandardAgentRolesExtension(
  _options: StandardAgentRolesExtensionOptions = {}
): ApplicationBackendExtensionDefinition {
  return {
    extensionId: STANDARD_AGENT_ROLES_PLUGIN_ID,
    activate(host) {
      if (!host.registerAgentRole) {
        // 最小装配/旧宿主没有角色注册面：明确不可用，不伪造内存注册表。
        host.logger({ event: "standard-agent-roles-disabled", reason: "宿主未提供 registerAgentRole" });
        return;
      }
      for (const implementation of STANDARD_AGENT_ROLES) host.registerAgentRole(implementation);
      host.logger({ event: "standard-agent-roles-activated", roles: STANDARD_AGENT_ROLES.length });
    }
  };
}

export { STANDARD_AGENT_ROLES } from "./roles/index.js";
export * from "./roles/index.js";
export { targetLine } from "./prompts.js";
