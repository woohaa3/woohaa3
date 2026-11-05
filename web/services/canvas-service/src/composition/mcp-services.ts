/**
 * Canvas Service composition：MCP 能力面投影
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R07）。
 *
 * 只装配既有 service 端口为进程内能力面；不新增跨域实现依赖，不改变拓扑。
 */
import type { ModelMcpService } from "../model-mcp/index.js";
import type { AgentCanvasInternalService } from "../agent-authoring/index.js";

/** `CanvasService.mcpServices` 的返回形状（与 composition types 对齐）。 */
export type McpServicesProjection = {
  modelMcp: ModelMcpService | null;
  agent: AgentCanvasInternalService | null;
};

/**
 * 由既有 service 构造 `mcpServices` 投影。
 *
 * `internalModelMcp` 为内部协议面 actor 的 ModelMcpService；`agent` 为 Agent 内部服务。
 */
export function buildMcpServicesProjection(input: {
  internalModelMcp: ModelMcpService | null;
  agent: AgentCanvasInternalService | null;
}): McpServicesProjection {
  return {
    modelMcp: input.internalModelMcp,
    agent: input.agent
  };
}
