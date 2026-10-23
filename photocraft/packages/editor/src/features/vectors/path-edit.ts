/**
 * 路径选择 / 直接选择（U12，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D5）。
 *
 * 纯命中与参数编译：屏幕阈值按取景换算成源像素，然后在**内核几何**上找最近的锚点或方向手柄。
 * 命中结果直接编译成 `path.moveAnchors` / `path.moveHandle` / `path.convertPoint` 的参数，
 * 因此节点编号只有一套；拖动预览复用同一份位移，松手一次命令 = 一步历史。
 */

import { hitTolerance } from "./shape-tools.js";

export type PathPoint = readonly [number, number];

export type PathKnot = {
  anchor: PathPoint;
  in?: PathPoint;
  out?: PathPoint;
  smooth?: boolean;
};

export type PathSubpath = { closed?: boolean; knots: readonly PathKnot[] };

/** 内核 `path.info` / `vectorSnapshot` 里的路径子集（只读）。 */
export type EditablePath = { subpaths: readonly PathSubpath[] };

export type PathHitKind = "anchor" | "in" | "out";

export type PathHit = {
  subpath: number;
  knot: number;
  kind: PathHitKind;
  /** 源像素距离。 */
  distance: number;
};

export type SelectMode = "replace" | "add" | "subtract";

function pointOf(knot: PathKnot, key: "in" | "out"): PathPoint | null {
  const handle = knot[key];
  if (!handle) return null;
  // 收回的手柄与锚点重合：既不可见也不该抢走锚点拖动。
  return Math.abs(handle[0] - knot.anchor[0]) > 1e-9 || Math.abs(handle[1] - knot.anchor[1]) > 1e-9 ? handle : null;
}

function distance(to: PathPoint, point: PathPoint): number {
  return Math.hypot(to[0] - point[0], to[1] - point[1]);
}

/**
 * 在源坐标里找最近的锚点或方向手柄。
 *
 * 优先级：锚点 > 手柄（同距离时锚点胜出），因为锚点拖动是默认手势。
 */
export function hitTest(path: EditablePath, point: PathPoint, screenPx = 6, zoom = 1): PathHit | null {
  const tolerance = hitTolerance(screenPx, zoom);
  let best: PathHit | null = null;
  const consider = (hit: PathHit) => {
    if (!Number.isFinite(hit.distance) || hit.distance > tolerance) return;
    if (!best) { best = hit; return; }
    const anchorWins = hit.kind === "anchor" && best.kind !== "anchor";
    const handleLoses = hit.kind !== "anchor" && best.kind === "anchor";
    if (anchorWins) best = hit;
    else if (!handleLoses && hit.distance < best.distance) best = hit;
  };
  path.subpaths.forEach((subpath, subpathIndex) => {
    subpath.knots.forEach((knot, knotIndex) => {
      consider({ subpath: subpathIndex, knot: knotIndex, kind: "anchor", distance: distance(knot.anchor, point) });
      const incoming = pointOf(knot, "in");
      if (incoming) consider({ subpath: subpathIndex, knot: knotIndex, kind: "in", distance: distance(incoming, point) });
      const outgoing = pointOf(knot, "out");
      if (outgoing) consider({ subpath: subpathIndex, knot: knotIndex, kind: "out", distance: distance(outgoing, point) });
    });
  });
  return best;
}

/** 拖动一个锚点/手柄时的位移（源像素）。 */
export type PathDrag = { hit: PathHit; from: PathPoint; to: PathPoint };

export function dragOffset(drag: PathDrag): [number, number] {
  return [drag.to[0] - drag.from[0], drag.to[1] - drag.from[1]];
}

/**
 * 命中 → 提交参数。
 *
 * - 锚点：`path.moveAnchors`（可批量，多选锚点时一次命令）。
 * - 手柄：`path.moveHandle`，`handle` 为 `in`/`out`，`to` 是绝对坐标。
 */
/** 命中结果 → `path.moveHandle` 的参数（锚点拖动由 `path.moveAnchors` 处理）。 */
export function commandForDrag(
  drag: PathDrag,
  target: { name: string; layer?: number | null },
  selection: readonly PathHit[] = [],
  options: { anchors?: readonly (readonly [number, number])[] } = {},
): { id: string; params: Record<string, unknown> } {
  const [dx, dy] = dragOffset(drag);
  const base = { name: target.name, ...(target.layer == null ? {} : { layer: target.layer }) };
  if (drag.hit.kind === "anchor") {
    // 路径选择工具（`path-select`）拖锚点移动整条子路径：参数仍是 `path.moveAnchors`，
    // 只是把该子路径的全部锚点列进 `anchors`，因此一次拖动一步历史、内核只收到一条命令。
    const listed = options.anchors ?? (selection.length ? selection : [drag.hit])
      .filter(hit => hit.kind === "anchor")
      .map(hit => [hit.subpath, hit.knot] as readonly [number, number]);
    const anchors = listed.length ? listed : [[drag.hit.subpath, drag.hit.knot] as readonly [number, number]];
    return { id: "path.moveAnchors", params: { ...base, anchors: anchors.map(pair => [pair[0], pair[1]]), move: [dx, dy] } };
  }
  return {
    id: "path.moveHandle",
    params: { ...base, subpath: drag.hit.subpath, knot: drag.hit.knot, handle: drag.hit.kind, to: [drag.to[0], drag.to[1]] },
  };
}

/** 线段命中：`path.bendSegment` 需要「第几段 + 段内参数 t」。 */
export type SegmentHit = { subpath: number; knot: number; t: number; distance: number };

/** 三次贝塞尔在 `t` 处的点（与内核 `Subpath::segments` 同一组四个控制点）。 */
function bezier(a: PathPoint, out: PathPoint, next: PathPoint, incoming: PathPoint, t: number): [number, number] {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return [
    w0 * a[0] + w1 * out[0] + w2 * incoming[0] + w3 * next[0],
    w0 * a[1] + w1 * out[1] + w2 * incoming[1] + w3 * next[1],
  ];
}

/**
 * 找最近的**线段**（拖动弯折 / 双击插锚）。
 *
 * 与 `hitTest` 分开：锚点与手柄优先，线段只在两者都没命中时参与，避免「想拖锚点却弯了线」。
 * 采 24 段足够在 6 px 屏幕阈值内定位；返回的 `t` 会直接进 `path.bendSegment` / `path.addAnchor`。
 */
export function hitTestSegment(path: EditablePath, point: PathPoint, screenPx = 6, zoom = 1): SegmentHit | null {
  const tolerance = hitTolerance(screenPx, zoom);
  const steps = 24;
  let best: SegmentHit | null = null;
  path.subpaths.forEach((subpath, subpathIndex) => {
    const knots = subpath.knots;
    const count = subpath.closed ? knots.length : knots.length - 1;
    for (let index = 0; index < count; index += 1) {
      const from = knots[index]!;
      const to = knots[(index + 1) % knots.length]!;
      const out = from.out ?? from.anchor;
      const incoming = to.in ?? to.anchor;
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        const [x, y] = bezier(from.anchor, out, to.anchor, incoming, t);
        const d = Math.hypot(x - point[0], y - point[1]);
        if (!Number.isFinite(d) || d > tolerance) continue;
        // 端点附近的命中交给锚点：这里再收紧一点，避免线段抢走锚点拖动。
        if (d < 1e-9 && (step === 0 || step === steps)) continue;
        if (!best || d < best.distance) best = { subpath: subpathIndex, knot: index, t, distance: d };
      }
    }
  });
  return best;
}

/** 多选锚点：Shift 加选/减选，普通点击替换。 */
export function applySelection(selection: readonly PathHit[], hit: PathHit | null, mode: SelectMode = "replace"): PathHit[] {
  const anchors = selection.filter(entry => entry.kind === "anchor");
  if (!hit || hit.kind !== "anchor") return mode === "replace" ? [] : [...selection];
  const same = (entry: PathHit) => entry.subpath === hit.subpath && entry.knot === hit.knot;
  if (mode === "replace") return [hit];
  if (mode === "add") return anchors.some(same) ? [...selection] : [...selection, hit];
  return selection.filter(entry => !same(entry));
}

/**
 * 平滑 ↔ 尖角转换参数。
 *
 * 上游三种用法（`vendor/…/vector/src/edit.rs` 的 `convert_point` / `toggle_curvature_point`）：
 * - `curvature: true`：按锚点**当前**状态翻转（平滑↔尖角），界面双击走这条；
 * - 带 `out`：转平滑点，入向柄镜像为 `2·anchor − out`；
 * - 不带 `out`：转尖角并收回手柄。
 *
 * 因此「双向转换」不能用「不带 out」实现 —— 它永远是尖角。`options.curvature` 默认 `false`
 * 只因为这是底层构造器；交互路径（`vector-tools.ts` 双击）显式传 `true`。
 */
export function convertPointParams(
  target: { name: string; layer?: number | null },
  hit: PathHit,
  out?: PathPoint,
  options: { curvature?: boolean } = {},
): { id: string; params: Record<string, unknown> } {
  const base = {
    name: target.name,
    ...(target.layer == null ? {} : { layer: target.layer }),
    subpath: hit.subpath,
    knot: hit.knot,
    ...(options.curvature ? { curvature: true } : {}),
  };
  return { id: "path.convertPoint", params: out ? { ...base, out: [out[0], out[1]] } : base };
}

/** 在锚点后的线段中点插入锚点；`t` 严格在 0–1 之间。 */
export function addAnchorParams(
  target: { name: string; layer?: number | null },
  hit: PathHit | SegmentHit,
  t = 0.5,
): { id: string; params: Record<string, unknown> } {
  const at = "t" in hit ? hit.t : t;
  // 双击插锚：`hitTestSegment` 返回真实 `t`；`hitTest` 的锚点命中则默认段中点。
  if (!(at > 0 && at < 1)) throw new Error("插入位置必须严格在 0 与 1 之间");
  return {
    id: "path.addAnchor",
    params: { name: target.name, ...(target.layer == null ? {} : { layer: target.layer }), subpath: hit.subpath, knot: hit.knot, t: at },
  };
}

/** 删除锚点；单点子路径的最后锚点会被内核移除。 */
export function deleteAnchorParams(
  target: { name: string; layer?: number | null },
  hit: PathHit,
): { id: string; params: Record<string, unknown> } {
  return {
    id: "path.deleteAnchor",
    params: { name: target.name, ...(target.layer == null ? {} : { layer: target.layer }), subpath: hit.subpath, knot: hit.knot },
  };
}

/** 拖动线段：在 `t` 处弯折，`move` 是位移。 */
export function bendSegmentParams(
  target: { name: string; layer?: number | null },
  hit: PathHit | SegmentHit,
  move: readonly [number, number],
  t = 0.5,
): { id: string; params: Record<string, unknown> } {
  return {
    id: "path.bendSegment",
    params: { name: target.name, ...(target.layer == null ? {} : { layer: target.layer }), subpath: hit.subpath, knot: hit.knot, t: "t" in hit ? hit.t : t, move: [move[0], move[1]] },
  };
}

/** 当前路径的定位信息：`layer` 表示形状层/矢量蒙版路径，其余是文档路径名。 */
export type PathTarget = { name: "work" | "layer" | string; layer?: number | null };

/** 路径是否可作为蒙版/形状几何来源（至少一个有 2 个以上锚点的子路径）。 */
export function usablePath(path: EditablePath): boolean {
  return path.subpaths.some(subpath => subpath.knots.length >= 2);
}
