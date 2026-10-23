/**
 * 从拍摄镜头预览拉线时的菜单项
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.2 / design D9）。
 *
 * 单独成模块：`canvas-menu/plugin.ts` 已接近规模门禁上限，新增职责不再堆进宿主插件；
 * 这里只放纯函数，便于非渲染回归测试。
 */
import { CANVAS_MENU_SECTION } from "@woohaa3/contracts";
import type { CanvasNodeTemplate } from "../../domain/node-catalog.js";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";

/** 镜头参考只能连到的视频生成节点类型（canonical type）。 */
export const SHOT_REFERENCE_TARGET_NODE_TYPE = "video";

/** 非视频目标被禁用时展示的原因（与连接规则的拒绝原因一致）。 */
export const SHOT_REFERENCE_TARGET_REASON = "镜头参考只能连到视频生成节点";

/**
 * 拉线创建菜单项：从拍摄镜头预览拉线时只把视频模板设为可选，其余模板保留但显式禁用并附原因，
 * 避免用户点击后静默失败。只读时全部禁用。
 */
export function shotReferenceTemplateItems(
  templates: readonly CanvasNodeTemplate[],
  writable: boolean,
  connectFrom: { nodeId: string; nodeType: string },
  kind: "static" | "dynamic" | null = "dynamic"
): CanvasContextMenuItem[] {
  void connectFrom;
  return templates.map((template) => {
    const isVideo = kind !== null && (template.nodeType === SHOT_REFERENCE_TARGET_NODE_TYPE || (kind === "static" && template.nodeType === "image"));
    return {
      id: `insert:${template.id}`,
      label: template.label,
      section: CANVAS_MENU_SECTION.basicMaterial,
      disabled: !writable || !isVideo,
      ...(isVideo || !writable ? {} : { reason: kind === "static" ? "静态镜头图片参考只能连到图片或视频生成节点" : SHOT_REFERENCE_TARGET_REASON })
    };
  });
}
