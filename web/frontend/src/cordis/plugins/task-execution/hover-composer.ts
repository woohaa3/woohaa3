/**
 * 卡片悬停胶囊「添加到对话框」的纯判定与几何
 * （参考稿：悬停图片时在卡片底部浮出的大胶囊，而不是选中后才出现在顶部横条里）。
 *
 * 与 React/DOM 解耦，供组件与单测共用：只回答「现在浮不浮」「浮在卡片哪一处」，
 * 不测量 DOM、不写画布、不提交命令。
 *
 * 为什么不再走 `canvas.node-action`：那条横条由 Bevy 绘制、Rust 命中，只在**单选**时出现。
 * 悬停态是瞬时呈现，不属于选中语义，放进横条会让「悬停即出现」退化成「先点一下才有」。
 */
import type { ScreenRect } from "@woohaa3/contracts";
import { panelKindForNodeType } from "./node-panel-registry.js";

/** 胶囊高度（CSS px）。 */
export const HOVER_COMPOSER_HEIGHT = 44;
/**
 * 胶囊在卡片外侧与卡片留的间距（CSS px）。
 *
 * 胶囊**浮在卡片外**，不压卡片本体：卡片底部的历史圆点条（`history_strip_rect`）与右下角
 * resize 抓手都是画布上的命中区，DOM 浮层一旦盖上去就会把它们接走 —— 悬停时点历史圆点会
 * 变成选中节点，拖右下角也拖不动（review 发现的回归）。
 */
export const HOVER_COMPOSER_GAP = 8;
/** 胶囊与视口左右边缘的最小留白（CSS px）。 */
export const HOVER_COMPOSER_MARGIN = 8;
/** 卡片小于该尺寸时不浮出，避免胶囊比卡片本身还宽。 */
export const HOVER_COMPOSER_MIN_CARD_WIDTH = 180;
export const HOVER_COMPOSER_MIN_CARD_HEIGHT = 120;

export type HoverComposerBox = { left: number; top: number; width: number; height: number };

/**
 * 解析当前该给哪个节点浮出胶囊（纯函数）。
 *
 * - 聚焦工作区里不浮（画布卡片由聚焦界面接管）；
 * - 指针下的节点优先；指针移进胶囊本身时画布会补发 `pointerleave` 清掉悬停，此时用
 *   `pinnedNodeId` 兜住，胶囊才不会在指针落到它上面的一瞬间消失；
 * - 只有**带生成面板**的节点类型浮出（图片/视频/音频/文本）；分组、模型卡片没有该面板。
 *
 * 只读画布仍浮出（与本动作原先在横条里的呈现一致：保留呈现、置灰不可用），由调用方禁用按钮。
 */
export function resolveHoverComposerTarget(input: {
  hoveredNodeId: string | null;
  pinnedNodeId: string | null;
  focusActive: boolean;
  nodes: readonly { id: string; type: string }[];
}): { nodeId: string; nodeType: string } | null {
  if (input.focusActive) return null;
  const nodeId = input.hoveredNodeId ?? input.pinnedNodeId;
  if (!nodeId) return null;
  const node = input.nodes.find((entry) => entry.id === nodeId);
  if (!node || panelKindForNodeType(node.type) === null) return null;
  return { nodeId, nodeType: node.type };
}

/**
 * 胶囊在屏幕上的矩形：浮在卡片**下方**外侧，左右与卡片对齐。
 *
 * 不压卡片本体（见 `HOVER_COMPOSER_GAP` 的说明），因此不会抢走历史条与 resize 抓手的点击。
 *
 * 三个回退，都是为了「卡片在可视区边缘时仍然点得到」：
 * - 下方放不下（卡片下缘贴近视口底部）→ 翻到卡片上方；
 * - 上下都放不下（卡片比视口还高）→ 钳制进视口，贴着下缘那一侧；
 * - 左右越界 → 水平钳制，并保证至少 `HOVER_COMPOSER_MARGIN` 的边距。
 *
 * `viewport` 缺省（测试或不测量视口时）不做回退，保持「始终放在下方」的纯几何行为。
 * 卡片太小或尚未测量出尺寸时返回 null —— 宁可不浮。
 */
export function hoverComposerBox(
  rect: ScreenRect | null,
  viewport?: { width: number; height: number }
): HoverComposerBox | null {
  if (!rect) return null;
  if (rect.width < HOVER_COMPOSER_MIN_CARD_WIDTH || rect.height < HOVER_COMPOSER_MIN_CARD_HEIGHT) return null;
  const width = Math.max(0, rect.width);
  if (width <= 0) return null;

  const below = rect.top + rect.height + HOVER_COMPOSER_GAP;
  let top = below;
  if (viewport) {
    const margin = HOVER_COMPOSER_MARGIN;
    const fitsBelow = below + HOVER_COMPOSER_HEIGHT <= viewport.height - margin;
    if (!fitsBelow) {
      const above = rect.top - HOVER_COMPOSER_GAP - HOVER_COMPOSER_HEIGHT;
      // 上方也放不下就钳制：贴着视口底部（卡片比视口高时，下方那侧更可能仍是卡片可见区）。
      top = above >= margin ? above : viewport.height - margin - HOVER_COMPOSER_HEIGHT;
      top = Math.max(margin, top);
    }
  }

  let left = rect.left;
  if (viewport) {
    left = Math.max(HOVER_COMPOSER_MARGIN, Math.min(left, viewport.width - HOVER_COMPOSER_MARGIN - width));
  }
  return { left, top, width, height: HOVER_COMPOSER_HEIGHT };
}
