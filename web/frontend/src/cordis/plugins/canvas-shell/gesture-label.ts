/**
 * 手势动作名（编辑历史标签）——从 interaction-controller 抽出以保持文件体积守卫。
 * change: 2026-10-09-improve-canvas-workflow。
 */
import type { Gesture } from "./interaction-types.js";

/** 由手势种类派生可读的中文动作名。 */
export function gestureLabel(kind: Gesture["kind"]): string {
  switch (kind) {
    case "group-badge-resize": return "缩放组徽标";
    case "group-badge-press": return "选择并拖动组";
    case "drag": return "移动作品";
    case "resize": return "调整尺寸";
    case "connect": return "连线";
    case "aggregate-connect": return "聚合连线";
    default: return "画布操作";
  }
}
