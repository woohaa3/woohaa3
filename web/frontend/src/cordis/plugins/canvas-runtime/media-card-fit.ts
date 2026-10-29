/**
 * 图片卡片按图片比例定尺寸。
 *
 * 卡片默认是固定的 248×232，图片在内容区里 contain，横图/竖图都会留出灰边。图片解码完成后，
 * 若卡片仍是默认尺寸（没被手动拉过），就把卡片改成「内容区与图片同比例、面积与默认内容区相近」
 * 的尺寸。已经被调过的卡片不动，所以只会适配一次。
 *
 * 卡片几何与 Bevy `canvas_query/layout.rs` 保持一致：上、左、右各 `CARD_CONTENT_PAD`，
 * 底部留标题行 `CARD_TITLE_ROW_HEIGHT`（无历史圆点时）。
 */
import { bevyNodeSize, DEFAULT_NODE_DIMS, type CanvasCommand, type ServerCanvas } from "@woohaa3/contracts";

const RICH_CONTENT_NODE_SIZE = bevyNodeSize("image");

const CARD_CONTENT_PAD = 6;
const CARD_TITLE_ROW_HEIGHT = 28;
/** 宽度低于 196 时 Bevy 会切到紧凑卡片布局，因此下限取它而不是节点最小宽度 180。 */
const MIN_CARD_WIDTH = 196;
const MAX_CARD_WIDTH = 360;
const MAX_CARD_HEIGHT = 400;

/** 视为「没被手动调过」的尺寸：富内容卡默认值与 reducer 的兜底默认值。 */
const DEFAULT_SIZES = [RICH_CONTENT_NODE_SIZE, DEFAULT_NODE_DIMS];

function contentWidthOf(cardWidth: number): number {
  return cardWidth - CARD_CONTENT_PAD * 2;
}

function cardHeightFor(contentHeight: number): number {
  return contentHeight + CARD_CONTENT_PAD + CARD_TITLE_ROW_HEIGHT;
}

/** 默认卡片内容区面积：适配后的卡片保持大致相同的视觉分量。 */
const TARGET_CONTENT_AREA =
  contentWidthOf(RICH_CONTENT_NODE_SIZE.width) * (RICH_CONTENT_NODE_SIZE.height - CARD_CONTENT_PAD - CARD_TITLE_ROW_HEIGHT);

/** 按图片宽高比算卡片尺寸；图片尺寸非法时返回 null。 */
export function fitImageCardSize(media: { width: number; height: number }): { width: number; height: number } | null {
  if (!(media.width > 0) || !(media.height > 0)) return null;
  const ratio = media.width / media.height;
  let contentWidth = Math.sqrt(TARGET_CONTENT_AREA * ratio);
  contentWidth = Math.min(Math.max(contentWidth, contentWidthOf(MIN_CARD_WIDTH)), contentWidthOf(MAX_CARD_WIDTH));
  let contentHeight = contentWidth / ratio;
  const maxContentHeight = MAX_CARD_HEIGHT - CARD_CONTENT_PAD - CARD_TITLE_ROW_HEIGHT;
  if (contentHeight > maxContentHeight) contentHeight = maxContentHeight;
  return {
    width: Math.round(contentWidth + CARD_CONTENT_PAD * 2),
    height: Math.round(cardHeightFor(contentHeight))
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
