/**
 * 卡片底部标题行命中判定（双击改名用）。
 *
 * 几何与 Bevy `canvas_query/layout.rs` 保持一致：富内容卡底部是一条高 `CARD_TITLE_ROW_HEIGHT`
 * 的标题行。点在这条带内、且左右在卡片内，就算命中标题。
 * 只有富内容卡（文字/图片/视频/音频，且宽度不触发紧凑布局）才有标题行。
 */
export const CARD_TITLE_ROW_HEIGHT = 28;

/** 宽度低于 196 时 Bevy 切到紧凑卡片，标题不在底部。 */
const COMPACT_CARD_WIDTH = 196;

const TITLE_CARD_TYPES: ReadonlySet<string> = new Set(["text", "image", "video", "audio"]);

export function hasCardTitleRow(node: { type: string }, rect: { width: number; height: number }): boolean {
  return TITLE_CARD_TYPES.has(node.type)
    && rect.width >= COMPACT_CARD_WIDTH
    && rect.height > CARD_TITLE_ROW_HEIGHT * 2;
}

export function hitsCardTitleRow(
  world: { x: number; y: number },
  node: { type: string },
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  if (!hasCardTitleRow(node, rect)) return false;
  const bottom = rect.y + rect.height;
  return world.x >= rect.x
    && world.x <= rect.x + rect.width
    && world.y >= bottom - CARD_TITLE_ROW_HEIGHT
    && world.y <= bottom;
}
