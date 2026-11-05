export type Rect = { left: number; top: number; width: number; height: number };

export type AnchoredPanel = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "below" | "above" | "edge";
};

/** 贴着锚点的固定留白。 */
const EDGE_MARGIN = 12;

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

export function layoutNodePanel(node: Rect, area: Rect, panel: { width: number; height: number }, previous?: AnchoredPanel["placement"], policy: "auto" | "below" = "auto"): AnchoredPanel | null {
  const right = node.left + node.width;
  const bottom = node.top + node.height;
  const areaRight = area.left + area.width;
  const areaBottom = area.top + area.height;
  if (area.width <= 0 || area.height <= 0) return null;
  // 锚点完全离开视口时不留下贴边浮层：选中对象已经不可见，面板也没有可依附的位置。
  // 部分可见（例如徽标下缘探出视口底边）仍算可见，继续按策略给出落点。
  const visible = right > area.left && node.left < areaRight && bottom > area.top && node.top < areaBottom;
  if (!visible) return null;
  const width = Math.max(0, Math.min(760, area.width - 32, panel.width));
  const left = Math.max(area.left + 16, Math.min(node.left + node.width / 2 - width / 2, areaRight - 16 - width));
  const below = areaBottom - bottom - EDGE_MARGIN;
  if (policy === "below") {
    const room = Math.max(0, below);
    // 只落在锚点下方：面板高度收回可用空间并内部滚动，绝不为了「放得下」改贴左右两侧或
    // 视口边缘。锚点下缘已经越过视口底边时没有可依附的「下方」，直接隐藏。
    if (room <= 0) return null;
    return { left, top: bottom + EDGE_MARGIN, width, maxHeight: room, placement: "below" };
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
