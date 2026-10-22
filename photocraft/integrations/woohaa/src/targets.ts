/**
 * 聚焦目标类型判定
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 3.1）。
 *
 * 由节点类型派生聚焦 `kind`：图片 → image；model3d/composite-asset → model；其它不聚焦。
 */
import type { CanvasFocusKind } from "@woohaa3/frontend/plugin-api";

export function modelFocusKindForNode(type: string): CanvasFocusKind | null {
  if (type === "image") return "image";
  if (type === "video") return "video";
  if (type === "model3d" || type === "composite-asset") return "model";
  return null;
}
