/**
 * 组 3D 徽标的屏幕矩形（执行面板锚点用）。
 *
 * 徽标就是组模型本体：Rust 把模型绘制在以组结构底边中点向下 40 画布单位为锚点的位置，
 * 尺寸取模型投影包围盒。而 group 的渲染矩形是成员包围后的布局尺寸
 * （`getGroupLayoutSizes`），比节点自身尺寸常常高出一大截；若用节点自身矩形推导锚点，
 * 徽标会被算高一整段，面板随之压回场景上。
 *
 * 这里只做纯几何：调用方给出节点矩形、布局尺寸、模型投影与当前视口倍率。
 */
import { groupBadgeScreenRect, type GroupBadgeProjection } from "@woohaa3/contracts";

export type ScreenRect = { left: number; top: number; width: number; height: number };

export function groupBadgePresentationScreenRect(input: {
  /** 节点自身的屏幕矩形（含拖动/改尺寸预览）。 */
  card: ScreenRect;
  /** 当前视口倍率（CSS px / 画布单位）。 */
  zoom: number;
  node: { type: string; width?: number; height?: number };
  /** 成员包围后的布局尺寸；缺省退回节点自身尺寸。 */
  layout: { width: number; height: number } | null;
  collapsed: boolean;
  /** 组模型的投影包围盒；缺失（资源未就绪）时没有徽标范围。 */
  projection: GroupBadgeProjection | null;
}): ScreenRect | null {
  const { card, zoom } = input;
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  const local = {
    x: 0,
    y: 0,
    width: input.layout?.width ?? input.node.width ?? 0,
    height: input.layout?.height ?? input.node.height ?? 0
  };
  // 收起只移除背板，徽标始终相对完整布局矩形定位。
  const width = local.width * zoom;
  const height = local.height * zoom;
  const presentation = {
    left: card.left + local.x * zoom,
    top: card.top + local.y * zoom,
    width: width > 0 ? width : card.width,
    height: height > 0 ? height : card.height
  };
  return groupBadgeScreenRect(presentation, zoom, input.projection);
}
