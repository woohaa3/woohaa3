/**
 * 交互持久化覆盖矩阵
 * （change: align-godot-canvas-interactions，任务 1.1 / design D10；
 *  change: replace-godot-canvas-runtime-with-bevy 改为 renderer-neutral）。
 *
 * 每个用户行为都必须明确归类为以下之一：
 * - `transient`：页面瞬时状态，不写 Y.Doc（hover/selection/editing focus/视口预览）。
 * - `preview`：手势中间帧，仅本地可见（拖拽/缩放/旋转/机位拖拽中间态）。
 * - `document`：改变规范结构，走 CanvasCommandBatch（创建/移动/删除/连线/断线/视口）。
 * - `nodeData`：字段级 nodeData.patch（prompt/agent/scene/模型摆放/机位姿态）。
 * - `server-owned`：由服务端任务链路拥有，运行时只读（task/run/result/error）。
 * - `media/local`：媒体二进制或本地文件，本 change 不持久化。
 *
 * 静态审计（`static-coverage.test.ts`）以本矩阵为准；`sourceFile` 指向实现该行为的
 * 浏览器源文件，便于人工核对。首版不做 3D picking/gizmo，`shot.gizmo-preview` 已移除。
 */
export const INTERACTION_BEHAVIORS = [
  { behavior: "node.hover", classification: "transient", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "selection.changed", classification: "transient", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "viewport.wheel-preview", classification: "transient", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "viewport.drag-preview", classification: "transient", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "node.drag-preview", classification: "preview", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "node.resize-preview", classification: "preview", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "model.param-preview", classification: "preview", source: "web/frontend/src/canvas/interaction-controller.ts" },
  { behavior: "node.create", classification: "document", source: "web/frontend/src/canvas/command-planner.ts" },
  { behavior: "node.move", classification: "document", source: "web/frontend/src/canvas/command-planner.ts" },
  { behavior: "node.resize", classification: "document", source: "web/frontend/src/canvas/command-planner.ts" },
  { behavior: "node.delete", classification: "document", source: "web/frontend/src/canvas/command-planner.ts" },
  { behavior: "edge.connect", classification: "document", source: "web/frontend/src/canvas/command-planner.ts" },
  { behavior: "edge.delete", classification: "document", source: "web/frontend/src/canvas/command-planner.ts" },
  { behavior: "media.upload", classification: "media/local", source: "web/frontend/src/canvas/upload-asset.ts" },
  { behavior: "nodeData.patch", classification: "nodeData", source: "web/services/canvas-service/src/model-mcp" },
  { behavior: "task.status", classification: "server-owned", source: "web/services/canvas-service" },
  { behavior: "image.bytes", classification: "media/local", source: "web/services/media-service" },
  { behavior: "js.local-path", classification: "media/local", source: "web/frontend/src/canvas/state" },
  { behavior: "shot.local-file", classification: "media/local", source: "web/services/media-service" }
] as const;

export type InteractionClassification =
  | "transient"
  | "preview"
  | "document"
  | "nodeData"
  | "server-owned"
  | "media/local";

export type InteractionBehavior = (typeof INTERACTION_BEHAVIORS)[number];

/** document/nodeData 分类的行为必须经服务端命令通道提交。 */
export const PERSISTED_CLASSIFICATIONS: readonly InteractionClassification[] = ["document", "nodeData"];

/**
 * 已声明为 document/nodeData 的行为必须映射到服务端 `CanvasCommand.type`，否则静态审计失败
 * （见 proposal「没有持久化契约的本地编辑不得显示为已保存」）。
 */
export const PERSISTED_BEHAVIOR_COMMAND_KIND: Readonly<Record<string, string>> = {
  "node.create": "node.add",
  "node.move": "node.update",
  "node.resize": "node.update",
  "node.delete": "node.remove",
  "edge.connect": "edge.add",
  "edge.delete": "edge.remove",
  "nodeData.patch": "nodeData.patch"
};
