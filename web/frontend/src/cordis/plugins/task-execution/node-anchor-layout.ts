export type Rect = { left: number; top: number; width: number; height: number };
export type AnchoredPanel = { left: number; top: number; width: number; maxHeight: number; placement: "below" | "above" | "edge" };

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

export function layoutNodePanel(node: Rect, area: Rect, panel: { width: number; height: number }, previous?: AnchoredPanel["placement"]): AnchoredPanel | null {
  const right = node.left + node.width;
  const bottom = node.top + node.height;
  const areaRight = area.left + area.width;
  const areaBottom = area.top + area.height;
  if (area.width <= 0 || area.height <= 0 || right <= area.left || node.left >= areaRight || bottom <= area.top || node.top >= areaBottom) return null;
  const width = Math.max(0, Math.min(760, area.width - 32, panel.width));
  const left = Math.max(area.left + 16, Math.min(node.left + node.width / 2 - width / 2, areaRight - 16 - width));
  const below = areaBottom - bottom - 12;
  const above = node.top - area.top - 12;
  const fitsBelow = below >= panel.height;
  const fitsAbove = above >= panel.height;
  let placement: AnchoredPanel["placement"] = fitsBelow ? "below" : fitsAbove ? "above" : below >= above ? "edge" : "edge";
  if (previous === "below" && below >= panel.height - 24) placement = "below";
  if (previous === "above" && above >= panel.height - 24 && !fitsBelow) placement = "above";
  const maxHeight = placement === "below" ? Math.max(0, below) : placement === "above" ? Math.max(0, above) : Math.max(0, Math.max(below, above));
  const top = placement === "below" ? bottom + 12 : placement === "above" ? node.top - 12 - Math.min(panel.height, maxHeight) : below >= above ? areaBottom - Math.min(panel.height, maxHeight) : area.top;
  return { left, top, width, maxHeight, placement };
}
