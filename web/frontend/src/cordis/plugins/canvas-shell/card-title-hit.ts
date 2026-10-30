/**
 * 卡片上方名称行的命中判定（双击改名用）。
 *
 * 名称与尺寸画在卡片**外侧上方**（仅选中/悬停时显示），几何与 Bevy
 * `canvas_query/layout.rs` 的 `card_meta_top` 保持一致：文字高度 `CARD_TITLE_FONT`，
 * 与卡片顶边之间留 `CARD_META_GAP`。
 *
 * 只有富内容卡（文字/图片/视频/音频，且宽度不触发紧凑布局）才有这一行。
 */
export const CARD_TITLE_FONT = 12;
export const CARD_META_GAP = 6;
/** 名称行占用的竖直高度（含与卡片的间隙）。 */
export const CARD_META_HEIGHT = CARD_META_GAP + CARD_TITLE_FONT;

/** 宽度低于 196 时 Bevy 切到紧凑卡片，名称不在卡片上方。 */
const COMPACT_CARD_WIDTH = 196;

const TITLE_CARD_TYPES: ReadonlySet<string> = new Set(["text", "image", "video", "audio"]);

export function hasCardMetaRow(node: { type: string }, rect: { width: number; height: number }): boolean {
  return TITLE_CARD_TYPES.has(node.type) && rect.width >= COMPACT_CARD_WIDTH;
}

/** 点是否落在卡片上方的名称/尺寸行里。 */
export function hitsCardTitleRow(
  world: { x: number; y: number },
  node: { type: string },
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  if (!hasCardMetaRow(node, rect)) return false;
  return world.x >= rect.x
    && world.x <= rect.x + rect.width
    && world.y >= rect.y - CARD_META_HEIGHT
    && world.y <= rect.y;
}
