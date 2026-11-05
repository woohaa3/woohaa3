/**
 * 2D 组创作目标的可信工具白名单（group scope）。
 *
 * 2D 组作用域只决定 Agent **能看见和能改哪些卡片**：根组本身与 `memberNodeIds` 成员。它不授
 * 予任何共享世界写资格——模型/镜头必须继续走导演区的世界助手权威（`assistant.world-authoring`）。
 *
 * 旧版本（普通组容器）的工具白名单随 `f510576d` 删除；这里按当前真实注册的工具名重建，
 * 由 `localAgentToolsForMode("world" + workflow-group-2d)` 与宿主 grant 共同约束。
 */
export const CANVAS_GROUP_TOOLS = [
  // 读取与能力发现
  "list_canvases", "get_canvas_capabilities", "get_canvas_graph", "get_canvas_changes",
  // 结构编辑（脚本与语义计划两条路，均经组作用域编译与提交校验）
  "get_canvas_script_api", "validate_canvas_script", "submit_canvas_script",
  "validate_canvas_plan", "apply_canvas_plan", "create_canvas_node", "connect_canvas_nodes",
  "resize_canvas_node", "resize_canvas_group", "delete_canvas_entities",
  // 节点执行与结果
  "run_canvas_node", "get_canvas_run", "cancel_canvas_run", "get_node_output",
  // Codex 内建生图导入当前 2D 组（宿主按组作用域校验，工具参数不能自报范围）
  "import_generated_image",
  // 组内模型的读取与脚本编辑（作用域由组投影限定）
  "get_model_api", "get_model_node", "get_model_statistics", "submit_model_script", "submit_model_scripts"
] as const;

export type CanvasGroupToolName = (typeof CANVAS_GROUP_TOOLS)[number];
