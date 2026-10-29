/** 独立徽标的展示尺寸；不改变组结构或模型资源身份。与 Rust group_model 同步。 */
export const GROUP_BADGE_MIN_SCALE = 0.5;
/**
 * 不设上限：片场把 3D 徽标当作场景显示入口，模型组合可能需要远大于承载它的组；
 * 普通 group 用同一规则（只有显式设置才会放大）。仅要求是有限且不小于最小倍率的数。
 */
export const isGroupBadgeScale = (value: unknown): value is number => typeof value === "number"
  && Number.isFinite(value) && value >= GROUP_BADGE_MIN_SCALE;
export const clampGroupBadgeScale = (value: number): number => Number.isFinite(value)
  ? Math.max(GROUP_BADGE_MIN_SCALE, value) : 1;

export function groupBadgeRect(rect: {x: number; y: number; width: number; height: number}, requested = 1) {
  const width = Math.max(24, Math.min(88, rect.width - 32));
  const height = Math.max(24, Math.min(64, rect.height - 32 + 6));
  const top = rect.y + rect.height + 6;
  const centerX = rect.x + rect.width / 2;
  // 徽标固定在气泡主体外侧；缩放只向下增长，不侵入组背板。
  // 不把尺寸限制在 group 矩形内、也不设上限：片场徽标就是场景显示区。
  const maxScale = Number.POSITIVE_INFINITY;
  const scale = clampGroupBadgeScale(requested);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const center = {x: centerX, y: top + scaledHeight / 2};
  return {x: center.x - scaledWidth / 2, y: top,
    width: scaledWidth, height: scaledHeight, center, scale, maxScale};
}

/**
 * Project the external badge from a node's current screen rect.
 *
 * The screen rect may already include a local drag/resize preview, so this keeps the badge
 * relative to that rect instead of rebuilding canonical world geometry in an overlay host.
 */
export function groupBadgeScreenRect(
  rect: {left: number; top: number; width: number; height: number},
  zoom: number,
  requested = 1,
) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const badge = groupBadgeRect(
    {x: 0, y: 0, width: rect.width / safeZoom, height: rect.height / safeZoom},
    requested,
  );
  return {
    left: rect.left + badge.x * safeZoom,
    top: rect.top + badge.y * safeZoom,
    width: badge.width * safeZoom,
    height: badge.height * safeZoom,
  };
}
