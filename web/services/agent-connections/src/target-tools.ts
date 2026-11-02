/**
 * 本机 Agent 的目标工具面
 * （change: 2026-10-17-add-agent-appserver-and-sdk-connections）。
 *
 * 工具名必须与受控 MCP 服务端实际注册名一致；不能用抽象的 `read_node`/`write_node`，
 * 否则宿主逐次授权会拒绝真实工具，MCP 写工具也会因 grant 不含该名称而失败。
 * 读取面同样按目标收窄：只给当前目标所需的节点/镜头读取工具，不授予整画布列表、
 * 请求历史或预览渲染等非必要能力。
 */
import type { AgentTargetMode, AssistantWorldScopeSelection } from "@woohaa3/contracts";
import { assistantWorldToolsForScope } from "@woohaa3/contracts";

/** 3D 模型脚本的只读 API 与权威节点。 */
const MODEL_READ_TOOLS = ["get_model_api", "get_model_node", "get_model_statistics"] as const;

/** 写入 3D 模型脚本。 */
const MODEL_WRITE_TOOLS = ["submit_model_script", "submit_model_scripts"] as const;

/** Absent mode retains the legacy model target; unknown and retired modes fail closed. */
export function localAgentToolsForMode(
  mode: AgentTargetMode | undefined,
  worldScope?: AssistantWorldScopeSelection
): readonly string[] {
  switch (mode) {
    case "camera":
      // camera 目标已从可用模式撤下；协议枚举仅用于解码旧会话，不再发放任何工具。
      return [];
    case "world":
      // A world target without a host-selected scope is not actionable.
      return worldScope ? [...assistantWorldToolsForScope(worldScope)] : [];
    case "model3d":
    case undefined:
      return [...MODEL_READ_TOOLS, ...MODEL_WRITE_TOOLS];
    default:
      return [];
  }
}
