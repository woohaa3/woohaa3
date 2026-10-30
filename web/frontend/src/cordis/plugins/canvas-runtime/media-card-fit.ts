/**
 * 图片卡片按图片自身的像素尺寸定尺寸。
 *
 * 卡片默认是固定的 248×232，图片在里面 contain，横图/竖图都会留灰边。图片解码完成后，若卡片
 * 仍是默认尺寸（没被手动拉过），就把它改成**原图像素尺寸、按 `CARD_FIT_MAX_EDGE` 封顶**的卡片，
 * 与参考实现 `fitNodeSize`（infinite-canvas）一致：`scale = min(1, maxEdge / 长边)`。
 *
 * 三点约束：
 * - **不放大到超过原图 1:1**（`scale <= 1`）：小图不会被撑成大卡。
 * - 长边封顶 `CARD_FIT_MAX_EDGE`：4K 图不会铺成 3840 宽，否则画布上一张卡就占满视野。
 * - 宽度不低于 `MIN_CARD_WIDTH`：低于它 Bevy 会切到紧凑卡片布局。
 *
 * 卡片几何与 Bevy `canvas_query/layout.rs` 保持一致：四边等宽窄边 `CARD_CONTENT_PAD`，
 * 名称与尺寸画在卡片上方外侧，不占卡片内部高度。
 */
import { bevyNodeSize, DEFAULT_NODE_DIMS, type CanvasCommand, type ServerCanvas } from "@woohaa3/contracts";

const RICH_CONTENT_NODE_SIZE = bevyNodeSize("image");

const CARD_CONTENT_PAD = 6;
/** 宽度低于 196 时 Bevy 会切到紧凑卡片布局，因此下限取它而不是节点最小宽度 180。 */
const MIN_CARD_WIDTH = 196;
/**
 * 卡片长边上限（世界单位）。
 *
 * 与参考实现 `fitNodeSize` 的 640 一致：再大就不会自动铺开，用户仍可手动拉伸。
 */
export const CARD_FIT_MAX_EDGE = 640;

/** 视为「没被手动调过」的尺寸：富内容卡默认值与 reducer 的兜底默认值。 */
const DEFAULT_SIZES = [RICH_CONTENT_NODE_SIZE, DEFAULT_NODE_DIMS];

/**
 * 按**图片像素尺寸**算卡片尺寸（含四边窄边）；图片尺寸非法时返回 null。
 *
 * `scale = min(1, CARD_FIT_MAX_EDGE / 长边)`：只缩小、不放大。缩到宽度不足
 * `MIN_CARD_WIDTH` 时按宽度下限回推（避免落入紧凑卡片布局）。
 */
export function fitImageCardSize(media: { width: number; height: number }): { width: number; height: number } | null {
  if (!(media.width > 0) || !(media.height > 0)) return null;
  const contentWidth = Math.max(1, media.width);
  const contentHeight = Math.max(1, media.height);
  const longest = Math.max(contentWidth, contentHeight);
  // 只缩小不放大；长边封顶。
  let scale = Math.min(1, CARD_FIT_MAX_EDGE / longest);
  // 缩完宽度不够时，以下限宽度为准（竖直长条图会因此变高，但不会挤进紧凑布局）。
  const minContentWidth = MIN_CARD_WIDTH - CARD_CONTENT_PAD * 2;
  if (contentWidth * scale < minContentWidth) scale = minContentWidth / contentWidth;
  return {
    width: Math.round(contentWidth * scale) + CARD_CONTENT_PAD * 2,
    height: Math.round(contentHeight * scale) + CARD_CONTENT_PAD * 2
  };
}

function isDefaultSize(width: number | undefined, height: number | undefined): boolean {
  return DEFAULT_SIZES.some(size => size.width === (width ?? DEFAULT_NODE_DIMS.width) && size.height === (height ?? DEFAULT_NODE_DIMS.height));
}

/** 需要适配时返回 `node.update` 命令；节点不存在、不是图片、已调过尺寸或比例已吻合时返回 null。 */
export function planImageCardFit(
  canvas: ServerCanvas | null,
  nodeId: string,
  media: { width: number; height: number }
): CanvasCommand | null {
  const node = canvas?.document.nodes.find(entry => entry.id === nodeId);
  if (!node || node.type !== "image") return null;
  if (!isDefaultSize(node.width, node.height)) return null;
  const size = fitImageCardSize(media);
  if (!size) return null;
  if (size.width === (node.width ?? DEFAULT_NODE_DIMS.width) && size.height === (node.height ?? DEFAULT_NODE_DIMS.height)) return null;
  return { type: "node.update", nodeId, width: size.width, height: size.height };
}
