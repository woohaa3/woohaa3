/**
 * Agent 可引用的公开工具名（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 这里只声明**名字**；工具实现、schema、目标授权与回执仍由 MCP 与各领域持有。角色实现引用这些
 * 常量，宿主再与「实际注册目录 + 本轮授权」求交；声明本身不签发任何权限。
 */
export const AGENT_MODEL_READ_TOOLS = ["get_model_api", "get_model_node", "get_model_statistics"] as const;

export const AGENT_MODEL_WRITE_TOOLS = ["submit_model_script", "submit_model_scripts"] as const;

export const AGENT_MODEL_TOOLS = [...AGENT_MODEL_READ_TOOLS, ...AGENT_MODEL_WRITE_TOOLS] as const;

/** Skill 续接工具当前未在任何角色的允许集合内；保留常量只为门禁核对真实目录。 */
export const AGENT_SKILL_CONTINUATION_TOOLS = ["wait_for_skill_step", "get_latest_skill_step_output"] as const;

/** 只读工具判定（通道用于区分“成功写入”与“只读观察”，不构成授权）。 */
export const AGENT_READ_ONLY_TOOLS: readonly string[] = [
  ...AGENT_MODEL_READ_TOOLS,
  "get_canvas_capabilities",
  "get_canvas_graph",
  "get_canvas_changes",
  "get_canvas_script_api",
  "validate_canvas_script",
  "validate_canvas_plan",
  "list_canvases",
  "get_canvas_run",
  "get_node_output",
  "get_world_context",
  ...AGENT_SKILL_CONTINUATION_TOOLS
];
