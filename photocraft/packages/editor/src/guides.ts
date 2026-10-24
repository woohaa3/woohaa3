/**
 * 标尺、参考线与网格（I096）。
 *
 * 参考线与标尺原点是**文档视图状态**：由原生 `view.newGuide|moveGuide|editGuide|deleteGuide|
 * clearGuides|setRulerOrigin|resetRulerOrigin` 持有，写入会进入工程但**不进入内容指纹**
 * （`document_content.rs` 不投影它们），因此拖动参考线不改变内容身份或保存基线判定。
 *
 * 本模块只做命中、吸附与网格几何；不复制文档模型，也不自己做排版。
 */

export type Guide = { orientation: "horizontal" | "vertical"; position: number; index: number; color?: [number, number, number] };
export type GuideState = { horizontal: number[]; vertical: number[] };

/** 从文档投影里读取参考线；非法条目直接丢弃，不猜测位置。 */
export function decodeGuides(value: unknown): GuideState {
  if (!value || typeof value !== "object") return { horizontal: [], vertical: [] };
  const raw = value as Record<string, unknown>;
  const axis = (list: unknown) => Array.isArray(list)
    ? list.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
  return { horizontal: axis(raw.horizontal), vertical: axis(raw.vertical) };
}

/** 扁平化成可命中的列表（索引对应原生数组下标）。 */
export function guideList(state: GuideState, colors?: unknown): Guide[] {
  const list: Guide[] = [
    ...state.horizontal.map((position, index) => ({ orientation: "horizontal" as const, position, index })),
    ...state.vertical.map((position, index) => ({ orientation: "vertical" as const, position, index }))
  ];
  if (Array.isArray(colors)) for (const entry of colors) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const vertical = raw.vertical === true;
    const position = typeof raw.position === "number" ? raw.position : null;
    const rgb = Array.isArray(raw.rgb) && raw.rgb.length === 3 && raw.rgb.every(channel => typeof channel === "number") ? raw.rgb as [number, number, number] : null;
    if (position === null || !rgb) continue;
    const target = list.find(guide => guide.orientation === (vertical ? "vertical" : "horizontal") && guide.position === position);
    if (target) target.color = rgb;
  }
  return list;
}

/** 参考线附近的命中（屏幕像素容差换算到文档像素）。 */
export function guideAt(list: readonly Guide[], point: { x: number; y: number }, zoom: number, tolerance = 4): Guide | null {
  const limit = tolerance / Math.max(zoom, 0.01);
  let found: Guide | null = null, best = Infinity;
  for (const guide of list) {
    const distance = guide.orientation === "horizontal" ? Math.abs(guide.position - point.y) : Math.abs(guide.position - point.x);
    if (distance <= limit && distance < best) { best = distance; found = guide; }
  }
  return found;
}

/** 从标尺拖出参考线：水平标尺拖出纵向参考线，反之亦然。 */
export function draggedGuide(orientation: "horizontal" | "vertical", point: { x: number; y: number }): { orientation: "horizontal" | "vertical"; position: number } {
  return orientation === "horizontal" ? { orientation: "vertical", position: Math.round(point.x) } : { orientation: "horizontal", position: Math.round(point.y) };
}

/** 吸附目标：参考线 + 网格 + 画布边缘；返回吸附后的点与命中的轴向。 */
export type SnapTarget = { x?: number; y?: number };
export function snapPoint(point: { x: number; y: number }, options: {
  guides?: readonly Guide[];
  grid?: number | null;
  canvas?: { width: number; height: number } | null;
  threshold: number;
  snapToGuides?: boolean;
  snapToGrid?: boolean;
  snapToCanvas?: boolean;
}): { point: { x: number; y: number }; snappedX: boolean; snappedY: boolean } {
  const threshold = Math.max(0, options.threshold);
  let bestX: number | null = null, bestY: number | null = null;
  const considerX = (candidate: number) => {
    const distance = Math.abs(candidate - point.x);
    if (distance <= threshold && (bestX === null || distance < Math.abs(bestX - point.x))) bestX = candidate;
  };
  const considerY = (candidate: number) => {
    const distance = Math.abs(candidate - point.y);
    if (distance <= threshold && (bestY === null || distance < Math.abs(bestY - point.y))) bestY = candidate;
  };
  if (options.snapToGuides ?? true) for (const guide of options.guides ?? []) {
    if (guide.orientation === "vertical") considerX(guide.position); else considerY(guide.position);
  }
  if (options.snapToCanvas && options.canvas) { considerX(0); considerX(options.canvas.width); considerY(0); considerY(options.canvas.height); }
  if (options.snapToGrid && options.grid && options.grid > 0) {
    considerX(Math.round(point.x / options.grid) * options.grid);
    considerY(Math.round(point.y / options.grid) * options.grid);
  }
  return { point: { x: bestX ?? point.x, y: bestY ?? point.y }, snappedX: bestX !== null, snappedY: bestY !== null };
}

/**
 * 网格线位置：只覆盖可见区域，避免为超大画布生成整幅网格。
 * `step` 是文档像素，返回范围内每条线的文档坐标。
 */
export function gridLines(from: number, to: number, step: number, limit = 4096): number[] {
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const first = Math.ceil(from / step) * step;
  const lines: number[] = [];
  for (let value = first; value <= to && lines.length < limit; value += step) lines.push(Math.round(value * 1000) / 1000);
  return lines;
}

/** 标尺刻度：按缩放挑一个「好看」的步长，避免每像素都标数。 */
export function rulerTicks(extent: number, zoom: number, minSpacingPx = 60): { step: number; ticks: number[] } {
  if (!Number.isFinite(extent) || extent <= 0) return { step: 1, ticks: [] };
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  const minimum = minSpacingPx / Math.max(zoom, 1e-6);
  const step = candidates.find(candidate => candidate >= minimum) ?? candidates[candidates.length - 1]!;
  const ticks: number[] = [];
  for (let value = 0; value <= extent + 1e-9; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return { step, ticks };
}

/** 网格与参考线的显示偏好分组（本机存储）。 */
export type GuidePreferences = {
  showRulers: boolean;
  showGuides: boolean;
  showGrid: boolean;
  snapToGuides: boolean;
  snapToGrid: boolean;
  snapToCanvas: boolean;
  gridSize: number;
};
export const DEFAULT_GUIDE_PREFERENCES: GuidePreferences = {
  showRulers: false, showGuides: true, showGrid: false,
  snapToGuides: true, snapToGrid: false, snapToCanvas: true, gridSize: 100
};
export function normalizeGuidePreferences(value: unknown): GuidePreferences {
  if (!value || typeof value !== "object") return DEFAULT_GUIDE_PREFERENCES;
  const raw = value as Record<string, unknown>;
  const flag = (key: keyof GuidePreferences) => typeof raw[key] === "boolean" ? raw[key] as boolean : DEFAULT_GUIDE_PREFERENCES[key] as boolean;
  const size = typeof raw.gridSize === "number" && Number.isFinite(raw.gridSize) && raw.gridSize >= 2 && raw.gridSize <= 4096
    ? Math.round(raw.gridSize) : DEFAULT_GUIDE_PREFERENCES.gridSize;
  return { showRulers: flag("showRulers"), showGuides: flag("showGuides"), showGrid: flag("showGrid"),
    snapToGuides: flag("snapToGuides"), snapToGrid: flag("snapToGrid"), snapToCanvas: flag("snapToCanvas"), gridSize: size };
}
