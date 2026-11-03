/**
 * 轴对齐求解（扩展自己的几何规则）。
 *
 * 只在浏览器内使用，不跨前后端，因此不进 `@woohaa3/contracts`：宿主只约定"策略"与"参考线"
 * 的形状（见 `CanvasRuntimeService.setAlignmentSnapPolicy`），怎么算由扩展决定。
 *
 * 规则：两轴独立；拖动框的边与中线去比候选对象的边与中线，取阈值内位移最小的一条；
 * 吸附后再把所有"已经重合"的线合并成参考线，让使用者看见自己贴到了谁身上。
 */
import type { AlignmentGuide, AlignmentRect, AlignmentSnapResult } from "@woohaa3/frontend/extension-api";

/** 参考线两端相对参与矩形的外扩（世界单位）。 */
const PADDING = 6;
/** 判定两条线重合的容差，只用来吸收浮点误差。 */
const EPSILON = 1e-3;
/** 每个轴最多画几条线：再多就变成噪声。 */
const MAX_GUIDES_PER_AXIS = 3;

type Axis = AlignmentGuide["axis"];
type Edge = { position: number; kind: AlignmentGuide["kind"] };

/** 矩形在某轴上的三条线：起点边、中线、结束边。 */
function edges(rect: AlignmentRect, axis: Axis): Edge[] {
  const start = axis === "x" ? rect.x : rect.y;
  const size = axis === "x" ? rect.width : rect.height;
  return [
    { position: start, kind: "start" },
    { position: start + size / 2, kind: "center" },
    { position: start + size, kind: "end" }
  ];
}

/** 矩形在另一轴上的跨度（参考线要覆盖它）。 */
function span(rect: AlignmentRect, axis: Axis): [number, number] {
  return axis === "x" ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width];
}

/** 多个矩形的并集；调用方保证非空。 */
function union(rects: readonly AlignmentRect[]): AlignmentRect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 单轴求解：先找最小位移，再收集吸附后与拖动框重合的线。 */
function snapAxis(
  moving: AlignmentRect,
  candidates: readonly AlignmentRect[],
  axis: Axis,
  threshold: number
): { delta: number; guides: AlignmentGuide[] } {
  const movingEdges = edges(moving, axis);
  let delta = 0;
  let best = Infinity;
  for (const candidate of candidates) {
    for (const target of edges(candidate, axis)) {
      for (const source of movingEdges) {
        const distance = Math.abs(target.position - source.position);
        if (distance <= threshold && distance < best) {
          best = distance;
          delta = target.position - source.position;
        }
      }
    }
  }
  if (best === Infinity) return { delta: 0, guides: [] };

  const snapped = movingEdges.map(edge => edge.position + delta);
  const movingSpan = span(moving, axis);
  const merged = new Map<number, { kind: AlignmentGuide["kind"]; start: number; end: number }>();
  for (const candidate of candidates) {
    for (const target of edges(candidate, axis)) {
      if (!snapped.some(position => Math.abs(target.position - position) <= EPSILON)) continue;
      const [start, end] = span(candidate, axis);
      const current = merged.get(target.position);
      if (current) {
        current.start = Math.min(current.start, start);
        current.end = Math.max(current.end, end);
      } else {
        merged.set(target.position, { kind: target.kind, start, end });
      }
    }
  }
  const guides = [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_GUIDES_PER_AXIS)
    .map(([position, entry]) => ({
      axis,
      position,
      start: Math.min(entry.start, movingSpan[0]) - PADDING,
      end: Math.max(entry.end, movingSpan[1]) + PADDING,
      kind: entry.kind
    }));
  return { delta, guides };
}

/**
 * 求一次拖动吸附。
 *
 * `moving` 是本次被拖动的矩形（多选时按并集处理），`candidates` 是可吸附的其它对象，
 * `threshold` 是宿主按缩放换算后的世界阈值。
 */
export function resolveAlignmentSnap(input: {
  moving: readonly AlignmentRect[];
  candidates: readonly AlignmentRect[];
  threshold: number;
}): AlignmentSnapResult {
  if (input.moving.length === 0) return { dx: 0, dy: 0, guides: [] };
  const box = union(input.moving);
  const horizontal = snapAxis(box, input.candidates, "x", input.threshold);
  const vertical = snapAxis(box, input.candidates, "y", input.threshold);
  return {
    dx: horizontal.delta,
    dy: vertical.delta,
    guides: [...horizontal.guides, ...vertical.guides]
  };
}
