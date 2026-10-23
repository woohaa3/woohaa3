/**
 * 钢笔与路径草稿（U11，change: 2026-10-22-add-photocraft-vector-canvas-tools，design D2/D3）。
 *
 * 规范几何只有一份：**子路径 + 锚点 + 入/出控制柄 + closed**，源像素坐标。本模块负责把指针
 * 交互翻译成这份结构，并在结束时交给 `path.set` / `shape.create`。三条规则：
 *
 * 1. 单击落角点；按下后拖动拉出对称控制柄（平滑点），按住 Alt 只动出向柄（尖角带柄）。
 * 2. 结束规则显式且互斥：双击/Enter → **开放**路径；点回首个锚点 → 闭合；Escape 丢弃草稿。
 *    不再一律 `closed: true`。
 * 3. 续接 = 在已有开放路径末尾继续追加锚点（`continueFrom`），自由钢笔与曲率钢笔都归约到
 *    同一份锚点列表，不产生第二套路径表示。
 */

/** 一个锚点：源像素坐标与两个控制柄（控制柄等于锚点表示收回）。 */
export type PenKnot = {
  anchor: [number, number];
  in: [number, number];
  out: [number, number];
  smooth: boolean;
};

/** 一条子路径。 */
export type PenSubpath = { closed: boolean; knots: PenKnot[] };

/** 提交给内核的路径 JSON（与 `path.set` / `shape.create` 的 `path` 参数同形）。 */
export type PenPath = { subpaths: PenSubpath[]; fillRule?: "nonzero" | "evenodd" };

/** 钢笔变体：普通、自由（连续采样）与曲率（自动平滑）。 */
export type PenKind = "pen" | "freeform" | "curvature";

/** 一次指针落点在钢笔里的语义。 */
export type PenPointInput = {
  point: [number, number];
  /** 拖动出的控制柄终点；未拖动则为 `null`（尖角）。 */
  handle?: [number, number] | null;
  /** 按住 Alt：只影响出向柄，形成带柄尖角。 */
  breakHandle?: boolean;
  /** 是否吸附加点：点在首个锚点的命中半径内表示闭合。 */
  closeHit?: boolean;
};

export type PenDraft = {
  subpaths: PenSubpath[];
  /** 当前正在编辑的子路径下标（续接时可能不是 0）。 */
  active: number;
  kind: PenKind;
};

export function emptyDraft(kind: PenKind = "pen"): PenDraft {
  return { subpaths: [{ closed: false, knots: [] }], active: 0, kind };
}

/** 角点：控制柄全收回。 */
export function cornerKnot(point: readonly [number, number]): PenKnot {
  return { anchor: [point[0], point[1]], in: [point[0], point[1]], out: [point[0], point[1]], smooth: false };
}

/**
 * 平滑点：入向柄与出向柄关于锚点对称（出向柄指向 `handle`）。
 *
 * `breakHandle` 为真时只保留出向柄（尖角带柄），入向柄收回——这与上游 `path.convertPoint`
 * 的「只给 out」语义一致。
 */
export function smoothKnot(point: readonly [number, number], handle: readonly [number, number], breakHandle = false): PenKnot {
  const anchor: [number, number] = [point[0], point[1]];
  const out: [number, number] = [handle[0], handle[1]];
  const incoming: [number, number] = breakHandle ? anchor : [anchor[0] * 2 - out[0], anchor[1] * 2 - out[1]];
  return { anchor, in: incoming, out, smooth: !breakHandle };
}

/** 追加一个锚点；返回新的草稿（不修改入参，便于撤销与预览）。 */
export function addKnot(draft: PenDraft, input: PenPointInput): PenDraft {
  const knot = input.handle ? smoothKnot(input.point, input.handle, input.breakHandle) : cornerKnot(input.point);
  const subpaths = draft.subpaths.map((subpath, index) => index === draft.active ? { ...subpath, knots: [...subpath.knots, knot] } : subpath);
  return { ...draft, subpaths };
}

/** 删除最后一个锚点（Backspace）。 */
export function removeKnot(draft: PenDraft): PenDraft {
  return {
    ...draft,
    subpaths: draft.subpaths.map((subpath, index) =>
      index === draft.active ? { ...subpath, knots: subpath.knots.slice(0, -1) } : subpath),
  };
}

/** 闭合当前子路径（点回首个锚点）。少于 3 个锚点时不闭合——那不构成面。 */
export function closeDraft(draft: PenDraft): PenDraft {
  const current = draft.subpaths[draft.active];
  if (!current || current.knots.length < 3) return draft;
  return {
    ...draft,
    subpaths: draft.subpaths.map((subpath, index) => index === draft.active ? { ...subpath, closed: true } : subpath),
  };
}

/** 完成草稿：`closed` 决定闭合，返回可提交的路径；锚点不足 2 个返回 `null`。 */
export function finishDraft(draft: PenDraft, closed = false): PenPath | null {
  const source = closed ? closeDraft(draft) : draft;
  const subpaths = source.subpaths.filter(subpath => subpath.knots.length >= 2);
  if (subpaths.length === 0) return null;
  return { subpaths: subpaths.map(subpath => ({ closed: subpath.closed, knots: subpath.knots })) };
}

/**
 * 续接已有路径：把草稿的工作子路径设为该开放子路径的副本，从末尾继续追加。
 *
 * 闭合路径不能续接（上游语义：闭合子路径没有可延长的末端），返回 `null`。
 */
export function continueFrom(path: PenPath, index = path.subpaths.length - 1, kind: PenKind = "pen"): PenDraft | null {
  const subpath = path.subpaths[index];
  if (!subpath || subpath.closed || subpath.knots.length === 0) return null;
  return {
    kind,
    active: 0,
    subpaths: [{ closed: false, knots: subpath.knots.map(knot => ({ ...knot, in: [...knot.in] as [number, number], out: [...knot.out] as [number, number], anchor: [...knot.anchor] as [number, number] })) }],
  };
}

/**
 * 自由钢笔：把采样点串成平滑折线（相邻中点作为控制柄），只保留一个子路径。
 *
 * `tolerance` 是源像素：距离上一点小于它的采样点被丢弃，避免高采样率产生巨量锚点。
 */
export function freehandDraft(points: readonly (readonly [number, number])[], tolerance = 1.5, kind: PenKind = "freeform"): PenDraft {
  const kept: [number, number][] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= tolerance) kept.push([point[0], point[1]]);
  }
  if (kept.length < 2) return emptyDraft(kind);
  const knots = kept.map((point, index) => {
    const previous = kept[Math.max(0, index - 1)];
    const next = kept[Math.min(kept.length - 1, index + 1)];
    const anchor: [number, number] = [point[0], point[1]];
    // Catmull-Rom 风格：控制柄取相邻点差值的三分之一，平滑但不是插值曲线。
    const inHandle: [number, number] = [anchor[0] - (next[0] - previous[0]) / 6, anchor[1] - (next[1] - previous[1]) / 6];
    const outHandle: [number, number] = [anchor[0] + (next[0] - previous[0]) / 6, anchor[1] + (next[1] - previous[1]) / 6];
    return { anchor, in: inHandle, out: outHandle, smooth: true };
  });
  return { kind, active: 0, subpaths: [{ closed: false, knots }] };
}

/**
 * 曲率钢笔：拖出一个锚点后，让相邻的平滑锚点重新贴合曲线。
 *
 * 上游的等价命令是 `path.moveAnchors` 带 `curvature: true`；本函数只计算**命令参数**，
 * 真正的曲线重整由内核完成（不在前端重算贝塞尔）。
 */
export function curvatureParams(subpath: number, knots: readonly number[], move: readonly [number, number]): Record<string, unknown> {
  return { anchors: knots.map(knot => [subpath, knot]), move: [move[0], move[1]], curvature: true };
}

/** 导出为 `path.set` 的参数（保存/续接前把草稿落成规范路径）。 */
export function pathSetParams(name: string, path: PenPath): Record<string, unknown> {
  return { name, path };
}

/** 草稿锚点数（界面禁用状态与提示用）。 */
export function knotCount(draft: PenDraft): number {
  return draft.subpaths.reduce((total, subpath) => total + subpath.knots.length, 0);
}

/** 是否可提交：至少两个锚点，或已有一个闭合子路径。 */
export function canFinish(draft: PenDraft): boolean {
  return draft.subpaths.some(subpath => subpath.knots.length >= 2 || (subpath.closed && subpath.knots.length >= 3));
}
