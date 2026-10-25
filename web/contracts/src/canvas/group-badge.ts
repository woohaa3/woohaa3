/** 独立徽标的展示尺寸；不改变组结构或模型资源身份。与 Rust group_model 同步。 */
export const GROUP_BADGE_MIN_SCALE = 0.5;
export const GROUP_BADGE_MAX_SCALE = 2.5;
export const isGroupBadgeScale = (value: unknown): value is number => typeof value === "number"
  && Number.isFinite(value) && value >= GROUP_BADGE_MIN_SCALE && value <= GROUP_BADGE_MAX_SCALE;
export const clampGroupBadgeScale = (value: number): number => Number.isFinite(value)
  ? Math.max(GROUP_BADGE_MIN_SCALE, Math.min(GROUP_BADGE_MAX_SCALE, value)) : 1;

export function groupBadgeRect(rect: {x: number; y: number; width: number; height: number}, requested = 1) {
  const width = Math.max(24, Math.min(88, rect.width - 32));
  const height = Math.max(24, Math.min(64, rect.height - 32 + 6));
  const center = {x: rect.x + rect.width / 2, y: rect.y + rect.height + 6 - height / 2};
  // 不侵入标题或越过左右边框；缩小组框时仅限制有效显示，不改已保存的用户设置。
  const maxScale = Math.max(1, Math.min(GROUP_BADGE_MAX_SCALE, (rect.width - 32) / width,
    2 * (center.y - rect.y - 32) / height));
  const scale = Math.min(clampGroupBadgeScale(requested), maxScale);
  return {x: center.x - width * scale / 2, y: center.y - height * scale / 2,
    width: width * scale, height: height * scale, center, scale, maxScale};
}
