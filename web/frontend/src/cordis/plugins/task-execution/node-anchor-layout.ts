export type Rect = { left: number; top: number; width: number; height: number };

export type AnchoredPanel = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "below" | "above" | "edge" | "right" | "left";
};

/** 贴着锚点/退到边缘时的固定留白。 */
const EDGE_MARGIN = 12;
/** 面板可用宽度的下限；再窄就退回「贴边」而不是把内容挤成一条。 */
const MIN_SIDE_PANEL_WIDTH = 320;
/** 下方可用高度低于此值即视为「放不下」，改贴徽标左右两侧。 */
const MIN_USABLE_HEIGHT = 120;

export function usableCanvasArea(area: Rect, occlusions: readonly Rect[]): Rect {
  let usable = area;
  for (const occlusion of occlusions) {
    const occlusionRight = occlusion.left + occlusion.width;
    const occlusionBottom = occlusion.top + occlusion.height;
    const right = usable.left + usable.width;
    const bottom = usable.top + usable.height;
    if (occlusionRight <= usable.left || occlusion.left >= right || occlusionBottom <= usable.top || occlusion.top >= bottom) continue;
    const candidates = [
      { left: usable.left, top: usable.top, width: Math.max(0, occlusion.left - usable.left), height: usable.height },
      { left: Math.min(right, occlusionRight), top: usable.top, width: Math.max(0, right - occlusionRight), height: usable.height },
      { left: usable.left, top: usable.top, width: usable.width, height: Math.max(0, occlusion.top - usable.top) },
      { left: usable.left, top: Math.min(bottom, occlusionBottom), width: usable.width, height: Math.max(0, bottom - occlusionBottom) }
    ];
    usable = candidates.reduce((largest, candidate) => candidate.width * candidate.height > largest.width * largest.height ? candidate : largest);
  }
  return usable;
}

/**
 * 组面板贴徽标**左右两侧**：下方放不下时的落点。
 *
 * 片场徽标会被放大到接近或超过视口高度，此时「徽标下缘」已在视口之外。继续把面板钉在视口
 * 底边就会压回模型上（正是被报告的问题），所以退到徽标侧面——仍然贴着模型，但不遮挡。
 */
function beside(node: Rect, area: Rect, panel: { width: number, height: number }, width: number): AnchoredPanel | null {
  const areaRight = area.left + area.width;
  const areaBottom = area.top + area.height;
  const height = Math.min(panel.height, Math.max(0, area.height - EDGE_MARGIN * 2));
  if (height <= 0) return null;
  const top = Math.max(area.top + 16, Math.min(node.top + (node.height - height) / 2, areaBottom - 16 - height));
  const nodeRight = node.left + node.width;
  const rightSpace = areaRight - (nodeRight + EDGE_MARGIN);
  if (rightSpace >= Math.min(width, MIN_SIDE_PANEL_WIDTH)) {
    return { left: nodeRight + EDGE_MARGIN, top, width: Math.min(width, rightSpace), maxHeight: height, placement: "right" };
  }
  const leftSpace = node.left - EDGE_MARGIN - (area.left + 16);
  if (leftSpace >= Math.min(width, MIN_SIDE_PANEL_WIDTH)) {
    return { left: node.left - EDGE_MARGIN - Math.min(width, leftSpace), top, width: Math.min(width, leftSpace), maxHeight: height, placement: "left" };
  }
  return null;
}

export function layoutNodePanel(node: Rect, area: Rect, panel: { width: number; height: number }, previous?: AnchoredPanel["placement"], policy: "auto" | "below" = "auto"): AnchoredPanel | null {
  const right = node.left + node.width;
  const bottom = node.top + node.height;
  const areaRight = area.left + area.width;
  const areaBottom = area.top + area.height;
  if (area.width <= 0 || area.height <= 0) return null;
  const visible = right > area.left && node.left < areaRight && bottom > area.top && node.top < areaBottom;
  // `below` 策略由调用方显式要求「贴着组徽标下方」，即使徽标已经探出视口底边也要给出可见落点。
  if (!visible && policy !== "below") return null;
  const width = Math.max(0, Math.min(760, area.width - 32, panel.width));
  const left = Math.max(area.left + 16, Math.min(node.left + node.width / 2 - width / 2, areaRight - 16 - width));
  const below = areaBottom - bottom - EDGE_MARGIN;
  if (policy === "below") {
    const room = Math.max(0, below);
    // 下方还有可用高度：面板整块落在徽标之外，永远不会盖住场景。
    if (Math.min(panel.height, room) >= MIN_USABLE_HEIGHT || room >= panel.height) {
      return { left, top: bottom + EDGE_MARGIN, width, maxHeight: room, placement: "below" };
    }
    // 徽标探到视口底边：改贴徽标左右两侧，避免把面板压回模型上。
    const side = beside(node, area, panel, width);
    if (side) return side;
    // 两侧也放不下（模型几乎占满视口）：退到视口底边，保证面板仍可见而不是消失。
    const maxHeight = Math.max(0, Math.max(below, node.top - area.top - EDGE_MARGIN));
    return { left, top: areaBottom - Math.min(panel.height, maxHeight), width, maxHeight, placement: "edge" };
  }
  const above = node.top - area.top - EDGE_MARGIN;
  const fitsBelow = below >= panel.height;
  const fitsAbove = above >= panel.height;
  let placement: AnchoredPanel["placement"] = fitsBelow ? "below" : fitsAbove ? "above" : below >= above ? "edge" : "edge";
  if (previous === "below" && below >= panel.height - 24) placement = "below";
  if (previous === "above" && above >= panel.height - 24 && !fitsBelow) placement = "above";
  const maxHeight = placement === "below" ? Math.max(0, below) : placement === "above" ? Math.max(0, above) : Math.max(0, Math.max(below, above));
  const top = placement === "below" ? bottom + EDGE_MARGIN : placement === "above" ? node.top - EDGE_MARGIN - Math.min(panel.height, maxHeight) : below >= above ? areaBottom - Math.min(panel.height, maxHeight) : area.top;
  return { left, top, width, maxHeight, placement };
}

/**
 * 底部停靠：面板固定在画布底部中间，不跟随节点。
 *
 * 节点只在打开面板时决定「这一份面板属于谁」（内容跟随节点），位置与卡片无关：
 * 拖动、缩放、平移画布都不再移动面板。高度取面板自身高度，但不超过
 * `area` 的上半部的上限，避免高面板盖住整个画布。
 */
export function layoutDockedPanel(area: Rect, panel: { width: number; height: number }): AnchoredPanel | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const width = Math.max(0, Math.min(DOCK_MAX_WIDTH, area.width - DOCK_SIDE_MARGIN * 2, panel.width));
  const maxHeight = Math.max(0, Math.min(panel.height, area.height * DOCK_MAX_HEIGHT_RATIO));
  const left = area.left + (area.width - width) / 2;
  const top = area.top + area.height - maxHeight - DOCK_BOTTOM_MARGIN;
  return { left, top, width, maxHeight, placement: "edge" };
}

/** 底部停靠面板的最大宽度（与锚定面板一致，避免左右过宽）。 */
export const DOCK_MAX_WIDTH = 760;
/** 底部停靠面板占画布高度的上限：剩余部分留给画布本身。 */
export const DOCK_MAX_HEIGHT_RATIO = 0.55;
export const DOCK_SIDE_MARGIN = 16;
export const DOCK_BOTTOM_MARGIN = 16;
