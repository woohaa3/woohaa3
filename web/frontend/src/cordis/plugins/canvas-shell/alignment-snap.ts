/**
 * 拖动辅助对齐线 / 吸附的宿主侧接线
 * （内置插件 `alignment-guides`；几何求解在 contracts `alignment-guides` 里，这里只做接线）。
 *
 * 职责：
 * 1. 把 working 画布几何整理成"被拖动矩形 + 候选矩形"两组世界坐标；
 * 2. 按当前缩放把屏幕像素阈值换算成世界阈值；
 * 3. 调用插件提供的策略（没有策略时完全不吸附，行为与未安装插件一致）。
 *
 * 本模块不写规范状态、不提交命令；返回的 `dx`/`dy` 由拖动预览自行叠加。
 */
import type {
  AlignmentGuide,
  AlignmentRect,
  AlignmentSnapPolicy
} from "../../contract/alignment-snap.js";
import type { CanvasNodeIndex } from "./canvas-node-index.js";

/**
 * 策略契约经本模块转出：canvas-shell 内部（controller / runtime 宿主）只从交互层取类型，
 * 不必各自 import `cordis/contract`。类型来源仍只有一份（`contract/alignment-snap.ts`）。
 */
export type { AlignmentSnapPolicy } from "../../contract/alignment-snap.js";

/**
 * 吸附命中阈值（屏幕 CSS 像素）。
 *
 * 手感区间取值：太小几乎贴不上，太大会把相邻卡片"拽走"。6px 与常见设计工具一致。
 */
export const ALIGNMENT_SNAP_THRESHOLD_PX = 6;

/** 一次拖动预览的吸附结果；无吸附时为空值。 */
export type DragAlignmentSnap = { dx: number; dy: number; guides: readonly AlignmentGuide[] };

export const NO_DRAG_ALIGNMENT_SNAP: DragAlignmentSnap = { dx: 0, dy: 0, guides: [] };

/** 被拖动根节点及其全部后代：它们随拖动一起位移，不能作为吸附候选。 */
export function movingNodeIds(
  index: CanvasNodeIndex,
  roots: ReadonlyMap<string, unknown>
): Set<string> {
  const ids = new Set<string>();
  const stack = [...roots.keys()];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const childId of index.children.get(id) ?? []) stack.push(childId);
  }
  return ids;
}

/** 可见候选矩形（排除折叠隐藏的被拖动集合）。 */
export function collectAlignmentCandidates(
  index: CanvasNodeIndex,
  excluded: ReadonlySet<string>
): AlignmentRect[] {
  const rects: AlignmentRect[] = [];
  for (const bounds of index.workingBounds) {
    if (excluded.has(bounds.id)) continue;
    rects.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }
  return rects;
}

/**
 * 被拖动矩形：取 workingBounds 的呈现矩形（含组展开布局与折叠徽标），再叠加本次预览位移。
 *
 * 用呈现矩形而不是节点自身宽高，才能与画布上真正画出来的卡片边缘对齐。
 */
export function movingAlignmentRects(
  index: CanvasNodeIndex,
  roots: ReadonlyMap<string, unknown>,
  dx: number,
  dy: number
): AlignmentRect[] {
  const bounds = new Map(index.workingBounds.map(entry => [entry.id, entry] as const));
  const rects: AlignmentRect[] = [];
  for (const id of roots.keys()) {
    const entry = bounds.get(id);
    if (!entry) continue;
    rects.push({ x: entry.x + dx, y: entry.y + dy, width: entry.width, height: entry.height });
  }
  return rects;
}

/**
 * 求一次拖动吸附。
 *
 * `zoom` 用于把像素阈值换算成世界单位；非正缩放按 1 处理，避免除零放大阈值。
 */
export function resolveDragAlignmentSnap(input: {
  policy: AlignmentSnapPolicy | null | undefined;
  index: CanvasNodeIndex | null;
  roots: ReadonlyMap<string, unknown>;
  dx: number;
  dy: number;
  zoom: number;
  thresholdPx?: number;
}): DragAlignmentSnap {
  const { policy, index, roots } = input;
  if (!policy || !index || roots.size === 0) return NO_DRAG_ALIGNMENT_SNAP;
  const zoom = input.zoom > 0 ? input.zoom : 1;
  const threshold = (input.thresholdPx ?? ALIGNMENT_SNAP_THRESHOLD_PX) / zoom;
  // 吸附只在指针真的"拖动"之后才参与：位移还没超过阈值时保持完全跟手。
  //
  // 否则会退化成"移一点点又弹回原位"——拖动开始处的极短位移每次都落回同一根对齐线，
  // 用户以为没拖动（change: 2026-11-03 反馈：加对齐线后节点移不出去）。
  if (Math.hypot(input.dx, input.dy) <= threshold) return NO_DRAG_ALIGNMENT_SNAP;
  const moving = movingAlignmentRects(index, roots, input.dx, input.dy);
  if (moving.length === 0) return NO_DRAG_ALIGNMENT_SNAP;
  const candidates = collectAlignmentCandidates(index, movingNodeIds(index, roots));
  if (candidates.length === 0) return NO_DRAG_ALIGNMENT_SNAP;
  const result = policy.resolve({ moving, candidates, threshold });
  if (!result) return NO_DRAG_ALIGNMENT_SNAP;
  // 防御：策略返回值先过一遍边界校验，异常值按不吸附处理，绝不让它污染拖动坐标。
  const dx = Number.isFinite(result.dx) ? result.dx : 0;
  const dy = Number.isFinite(result.dy) ? result.dy : 0;
  const guides = Array.isArray(result.guides)
    ? result.guides.filter(guide =>
      Number.isFinite(guide.position) && Number.isFinite(guide.start) && Number.isFinite(guide.end))
    : [];
  return { dx, dy, guides };
}

/**
 * 把参考线写回拖动预览状态：只在内容真的变化时递增版本号。
 *
 * 内容不变就不递增的原因：覆盖层按版本号决定是否重绘，而 pointermove 每次都会求值一次；
 * 没有这条比较，拖动期间每帧都会触发一次无意义的 React 重渲染。
 */
export function setAlignmentGuides(
  state: { alignmentGuides: AlignmentGuide[]; alignmentGuidesVersion: number },
  guides: readonly AlignmentGuide[]
): void {
  if (sameGuides(state.alignmentGuides, guides)) return;
  state.alignmentGuides = guides.map(guide => ({ ...guide }));
  state.alignmentGuidesVersion += 1;
}

function sameGuides(a: readonly AlignmentGuide[], b: readonly AlignmentGuide[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.axis !== right.axis || left.kind !== right.kind) return false;
    if (Math.abs(left.position - right.position) > 1e-3) return false;
    if (Math.abs(left.start - right.start) > 1e-3) return false;
    if (Math.abs(left.end - right.end) > 1e-3) return false;
  }
  return true;
}

/**
 * 拖动预览的统一入口：求吸附、写参考线状态、返回调整后的位移。
 *
 * 调用方（pointermove 与 release 前的最后一次预览）共用它，保证"拖到哪里提交哪里"一致；
 * 没有策略、没有索引或没有根源时原样返回位移，并把参考线清空。
 */
export function applyDragAlignment(input: {
  state: { alignmentGuides: AlignmentGuide[]; alignmentGuidesVersion: number };
  policy: AlignmentSnapPolicy | null | undefined;
  index: CanvasNodeIndex | null;
  roots: ReadonlyMap<string, unknown>;
  dx: number;
  dy: number;
  zoom: number;
  thresholdPx?: number;
}): { dx: number; dy: number } {
  const snap = resolveDragAlignmentSnap({
    policy: input.policy,
    index: input.index,
    roots: input.roots,
    dx: input.dx,
    dy: input.dy,
    zoom: input.zoom,
    ...(input.thresholdPx === undefined ? {} : { thresholdPx: input.thresholdPx })
  });
  setAlignmentGuides(input.state, snap.guides);
  return { dx: input.dx + snap.dx, dy: input.dy + snap.dy };
}

