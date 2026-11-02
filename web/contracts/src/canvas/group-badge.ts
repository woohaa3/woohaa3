/**
 * 组 3D 徽标几何（change: 2026-10-30-remove-group-badge-scaling）。
 *
 * 徽标就是组模型本体：不再有固定框、圆角或展示倍率，尺寸完全来自模型在当前呈现下的
 * 投影包围盒（画布单位，1 单位 = 1× 缩放下的 1 CSS px）。普通组与片场组同一口径——徽标倍率
 * 不读组框宽高（change: 2026-10-31-render-film-set-badge-at-model-units）。本模块只做纯几何
 * 派生，与 Rust `canvas_query::group_model` 同源。
 */

/**
 * 组模型锚点：组结构底边中点向下 40 画布单位（即 80 单位底部页脚的中点）。
 *
 * 这是锚点位置，不是徽标尺寸：它不随模型、组宽或手势变化。普通组把模型投影中心对齐该点；
 * 片场组把模型顶边对齐该点并向下展开。两种方式都由模型尺寸单向派生，不参与任何钳制。
 */
export const GROUP_BADGE_ANCHOR_OFFSET = 40;

/** 模型在当前呈现下的投影包围盒尺寸（画布单位，屏幕轴对齐）。 */
export type GroupBadgeProjection = {
  width: number;
  height: number;
  /**
   * 片场组：徽标顶边贴住锚点向下展开，避免大场景侵入组框内成员。
   * 普通组缺省为 false，模型投影中心对齐锚点。
   */
  topAnchored?: boolean;
};

export type GroupBadgeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  center: { x: number; y: number };
};

export type GroupFrameRect = { x: number; y: number; width: number; height: number };

const isFinitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * 徽标范围 = 模型投影包围盒。
 *
 * 普通组以锚点为中心；片场组（`topAnchored`）把模型顶边放在锚点上、只向下展开，
 * 这样大场景不会盖住组框内的成员卡片。
 *
 * 无模型投影（资源未就绪或几何非法）时返回 `null`：不产生徽标范围，也不得用固定框、
 * 历史倍率或上一帧模型尺寸占位。
 */
export function groupBadgeRect(
  rect: GroupFrameRect,
  projection: GroupBadgeProjection | null | undefined,
): GroupBadgeRect | null {
  if (!projection || !isFinitePositive(projection.width) || !isFinitePositive(projection.height)) return null;
  const center = {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height + GROUP_BADGE_ANCHOR_OFFSET + (projection.topAnchored ? projection.height / 2 : 0)
  };
  return {
    x: center.x - projection.width / 2,
    y: center.y - projection.height / 2,
    width: projection.width,
    height: projection.height,
    center,
  };
}

/** 徽标向下超出组结构底边的距离（画布单位）；无模型时为 0。 */
export function groupBadgeOutset(
  rect: GroupFrameRect,
  projection: GroupBadgeProjection | null | undefined,
): number {
  const badge = groupBadgeRect(rect, projection);
  if (!badge) return 0;
  return Math.max(0, badge.y + badge.height - (rect.y + rect.height));
}

/** 组结构矩形与徽标范围的并集（命中/驻留/框选的保守占用范围）。 */
export function groupBadgeBounds(
  rect: GroupFrameRect,
  projection: GroupBadgeProjection | null | undefined,
): GroupFrameRect {
  const badge = groupBadgeRect(rect, projection);
  if (!badge) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const left = Math.min(rect.x, badge.x);
  const top = Math.min(rect.y, badge.y);
  const right = Math.max(rect.x + rect.width, badge.x + badge.width);
  const bottom = Math.max(rect.y + rect.height, badge.y + badge.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 把徽标投影到节点当前的屏幕矩形。
 *
 * 屏幕矩形可能已包含拖动/改尺寸预览，因此相对这个矩形重建徽标，而不是在覆盖层里重算规范世界几何。
 */
export function groupBadgeScreenRect(
  rect: { left: number; top: number; width: number; height: number },
  zoom: number,
  projection: GroupBadgeProjection | null | undefined,
): { left: number; top: number; width: number; height: number } | null {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const badge = groupBadgeRect(
    { x: 0, y: 0, width: rect.width / safeZoom, height: rect.height / safeZoom },
    projection,
  );
  if (!badge) return null;
  return {
    left: rect.left + badge.x * safeZoom,
    top: rect.top + badge.y * safeZoom,
    width: badge.width * safeZoom,
    height: badge.height * safeZoom,
  };
}
