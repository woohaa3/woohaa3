/**
 * 本机 Agent 的目标工具面
 * （change: 2026-10-17-add-agent-appserver-and-sdk-connections；任务 6.3 泛化）。
 *
 * 工具名必须与受控 MCP 服务端实际注册名一致；不能用抽象的 `read_node`/`write_node`，
 * 否则宿主逐次授权会拒绝真实工具，MCP 写工具也会因 grant 不含该名称而失败。
 * 通用模式只暴露内建画布/模型工具；业务目标由激活扩展的 `ContentAgentTarget` 描述符提供。
 */
import { CANVAS_GROUP_TOOLS, type AgentTargetMode, type ContentAgentTarget } from "@woohaa3/contracts";

/** 3D 模型脚本的只读 API 与权威节点。 */
const MODEL_READ_TOOLS = ["get_model_api", "get_model_node", "get_model_statistics"] as const;

/** 写入 3D 模型脚本。 */
const MODEL_WRITE_TOOLS = ["submit_model_script", "submit_model_scripts"] as const;

/** 画布组只读工具；写面从受保护清单里扣除，避免把读工具误记成成功写入。 */
const CANVAS_GROUP_READ_TOOLS = [
  "get_canvas_capabilities",
  "get_canvas_graph",
  "get_canvas_changes",
  "get_canvas_script_api",
  "validate_canvas_script",
  "validate_canvas_plan",
  "get_canvas_run",
  "get_node_output",
  "get_model_api",
  "get_model_node",
  "get_model_statistics",
  "get_film_set_clips"
] as const;
const CANVAS_GROUP_READ_SET = new Set<string>(CANVAS_GROUP_READ_TOOLS);
const CANVAS_GROUP_WRITE_TOOLS = CANVAS_GROUP_TOOLS.filter((tool) => !CANVAS_GROUP_READ_SET.has(tool));

function declaredTarget(mode: AgentTargetMode, targets: readonly ContentAgentTarget[]): ContentAgentTarget | undefined {
  return targets.find((target) => target.mode === mode);
}

/**
 * 目标只读工具面。
 *
 * 未注册的业务 mode 返回空集，不退回模型或片场默认值；`undefined` 仍表示历史 model3d。
 */
export function localAgentReadToolsForMode(
  mode: AgentTargetMode | undefined,
  targets: readonly ContentAgentTarget[] = []
): readonly string[] {
  if (mode === undefined || mode === "model3d") return MODEL_READ_TOOLS;
  if (mode === "canvas-group") return CANVAS_GROUP_READ_TOOLS;
  if (mode === "camera") return [];
  return declaredTarget(mode, targets)?.readTools ?? [];
}

/** 目标可写工具面；与只读面一起构成本轮 grant 的完整工具集合。 */
export function localAgentWriteToolsForMode(
  mode: AgentTargetMode | undefined,
  targets: readonly ContentAgentTarget[] = []
): readonly string[] {
  if (mode === undefined || mode === "model3d") return MODEL_WRITE_TOOLS;
  if (mode === "canvas-group") return CANVAS_GROUP_WRITE_TOOLS;
  if (mode === "camera") return [];
  return declaredTarget(mode, targets)?.writeTools ?? [];
}

/** 本轮目标工具集合；未知/停用的业务 mode 稳定为空，由调用方 fail closed。 */
export function localAgentToolsForMode(
  mode: AgentTargetMode | undefined,
  targets: readonly ContentAgentTarget[] = []
): readonly string[] {
  return [...localAgentReadToolsForMode(mode, targets), ...localAgentWriteToolsForMode(mode, targets)];
}
