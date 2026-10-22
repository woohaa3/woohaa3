/**
 * 本机 Agent 的目标工具面
 * （change: 2026-10-17-add-agent-appserver-and-sdk-connections）。
 *
 * 工具名必须与受控 MCP 服务端实际注册名一致；不能用抽象的 `read_node`/`write_node`，
 * 否则宿主逐次授权会拒绝真实工具，MCP 写工具也会因 grant 不含该名称而失败。
 * 读取面同样按目标收窄：只给当前目标所需的节点/镜头/片段读取工具，不授予整画布列表、
 * 请求历史或预览渲染等非必要能力。
 */
import { CANVAS_GROUP_TOOLS, type AgentTargetMode } from "@woohaa3/contracts";

/** 3D 模型脚本的只读 API 与权威节点。 */
const MODEL_READ_TOOLS = ["get_model_api", "get_model_node", "get_model_statistics"] as const;

/** 镜头目标的读取面。 */
const CAMERA_READ_TOOLS = ["get_model_node", "get_model_cameras"] as const;

/** 片场目标的读取面。 */
const FILM_SET_READ_TOOLS = ["get_model_api", "get_model_node", "get_film_set_clips", "get_film_set_export"] as const;

/** 写入 3D 模型脚本。 */
const MODEL_WRITE_TOOLS = ["submit_model_script", "submit_model_scripts"] as const;

/** 镜头增删改。 */
const CAMERA_WRITE_TOOLS = [
  "set_model_camera",
  "create_model_camera",
  "update_model_camera",
  "delete_model_camera",
  "rename_model_camera",
  "reset_model_camera"
] as const;

/** 片场模型/运动/片段写入。 */
const FILM_SET_WRITE_TOOLS = [
  "submit_film_set",
  "mutate_film_set_item",
  "mutate_film_set_clip",
  "add_film_set_media",
  "export_film_set_clip",
  "create_film_set_node",
  "import_model_snapshot"
] as const;

/** Absent mode retains the legacy model target; unknown modes fail closed. */
export function localAgentToolsForMode(mode: AgentTargetMode | undefined): readonly string[] {
  switch (mode) {
    case "canvas-group":
      return CANVAS_GROUP_TOOLS;
    case "camera":
      return [...CAMERA_READ_TOOLS, ...CAMERA_WRITE_TOOLS];
    case "film-set":
      return [...FILM_SET_READ_TOOLS, ...FILM_SET_WRITE_TOOLS];
    case "model3d":
    case undefined:
      return [...MODEL_READ_TOOLS, ...MODEL_WRITE_TOOLS];
    default:
      return [];
  }
}
