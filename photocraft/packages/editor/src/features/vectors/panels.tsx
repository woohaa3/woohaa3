import { useCallback, useMemo, useRef, useState } from "react";
import { SHAPE_KINDS, SHAPE_LABELS, shapePreview, type ShapeDrag, type ShapeKind } from "./shape-tools.js";
import { addKnot, canFinish, closeDraft, emptyDraft, knotCount, removeKnot, type PenDraft, type PenKind } from "./pen-tools.js";
import type { EditablePath, PathHit } from "./path-edit.js";

/** 叠加层坐标换算：(源像素 → 容器内 CSS 像素)。 */
type Project = (point: readonly [number, number]) => readonly [number, number];

function projectPath(points: readonly (readonly [number, number])[], closed: boolean, project: Project) {
  const projected = points.map(project);
  const d = projected.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ") + (closed ? " Z" : "");
  return { projected, d };
}

/**
 * 钢笔画布叠加层：只呈现锚点与方向手柄，几何权威在内核。
 *
 * 手柄按上游语义绘制：`in`/`out` 与锚点重合时视为收回，不画手柄线。开放路径不闭合。
 */
export function PathOverlay({ points, closed, zoom, origin, handles }: {
  points: readonly (readonly [number, number])[];
  closed: boolean;
  zoom: number;
  origin: { x: number; y: number };
  /** 每个锚点的入/出控制柄；省略时只画锚点。 */
  handles?: readonly { in?: readonly [number, number]; out?: readonly [number, number] }[];
}) {
  if (points.length === 0) return null;
  const project: Project = ([x, y]) => [origin.x + x * zoom, origin.y + y * zoom];
  const { projected, d } = projectPath(points, closed, project);
  return (
    <svg className="photo-editor__path-overlay" data-path-overlay={closed ? "closed" : "open"}>
      <path d={d} fill={closed ? "rgba(90,140,220,0.18)" : "none"} stroke="var(--app-interaction-accent)" strokeWidth={1.5} />
      {handles ? handles.flatMap((handle, index) => {
        const [x, y] = projected[index] ?? [0, 0];
        return (["in", "out"] as const).flatMap((key) => {
          const control = handle[key];
          if (!control) return [];
          const [hx, hy] = point(control);
          if (Math.abs(hx - points[index][0]) < 1e-9 && Math.abs(hy - points[index][1]) < 1e-9) return [];
          return [<g key={`${index}-${key}`} data-path-handle={key}>
            <line x1={x} y1={y} x2={origin.x + hx * zoom} y2={origin.y + hy * zoom} stroke="var(--app-interaction-accent)" strokeOpacity=".65" strokeWidth={1} />
            <circle cx={origin.x + hx * zoom} cy={origin.y + hy * zoom} r={2.5} fill="var(--app-interaction-accent)" />
          </g>];
        });
      }) : null}
      {projected.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={3} fill="var(--app-interaction-accent)" data-path-anchor={index} />)}
    </svg>
  );
}

function point(value: readonly [number, number]) { return [value[0], value[1]] as const; }

/**
 * 形状拖绘预览（U08/U09）：与提交共用 `shapePreview`，因此预览画的就是松手后得到的几何。
 *
 * 零面积/越界时只显示可读提示，不画形状——避免"看起来创建了、实际被拒绝"。
 */
export function ShapeDragOverlay({ drag, canvas, zoom, origin, label }: {
  drag: ShapeDrag;
  canvas: readonly [number, number];
  zoom: number;
  origin: { x: number; y: number };
  label?: string;
}) {
  const preview = useMemo(() => shapePreview(drag, canvas), [drag, canvas]);
  if (!preview.ok) {
    const [x, y] = [origin.x + drag.end[0] * zoom, origin.y + drag.end[1] * zoom];
    return <svg className="photo-editor__shape-overlay" data-shape-overlay="invalid">
      <text x={x + 12} y={y - 10} fill="var(--app-web-text-muted)" fontSize={11} data-shape-message>{preview.message}</text>
    </svg>;
  }
  const [rx, ry, width, height] = preview.geometry.rect;
  const x = origin.x + rx * zoom;
  const y = origin.y + ry * zoom;
  const w = width * zoom;
  const h = height * zoom;
  const kind = drag.kind;
  const corners = Array.isArray(preview.params.radii) ? Number((preview.params.radii as number[])[0]) * zoom : 0;
  return <svg className="photo-editor__shape-overlay" data-shape-overlay={kind}>
    {kind === "line"
      ? <line x1={origin.x + preview.geometry.from[0] * zoom} y1={origin.y + preview.geometry.from[1] * zoom}
        x2={origin.x + preview.geometry.to[0] * zoom} y2={origin.y + preview.geometry.to[1] * zoom}
        stroke="var(--app-interaction-accent)" strokeWidth={Math.max(1, Number(preview.params.weight ?? 1) * zoom)} />
      : kind === "ellipse"
        ? <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="rgba(90,140,220,0.18)" stroke="var(--app-interaction-accent)" strokeWidth={1.5} />
        : <rect x={x} y={y} width={w} height={h} rx={corners} ry={corners} fill="rgba(90,140,220,0.18)" stroke="var(--app-interaction-accent)" strokeWidth={1.5} />}
    <text x={x + w + 6} y={y - 4} fill="var(--app-interaction-accent)" fontSize={11} data-shape-size>
      {`${Math.round(width)} × ${Math.round(height)}`}
    </text>
    {label ? <text x={x} y={y + h + 14} fill="var(--app-web-text-muted)" fontSize={11}>{label}</text> : null}
  </svg>;
}

/** 已提交路径的锚点/手柄叠加层（直接选择）。命中与否由域内 `hitTest` 决定。 */
export function AnchorOverlay({ path, zoom, origin, selection, hover, tolerance }: {
  path: EditablePath;
  zoom: number;
  origin: { x: number; y: number };
  selection: readonly PathHit[];
  hover?: PathHit | null;
  /** 屏幕阈值，用于画命中圈。 */
  tolerance?: number;
}) {
  const isSelected = (subpath: number, knot: number) => selection.some(hit => hit.kind === "anchor" && hit.subpath === subpath && hit.knot === knot);
  const isHovered = (subpath: number, knot: number) => hover?.subpath === subpath && hover.knot === knot;
  const project: Project = ([x, y]) => [origin.x + x * zoom, origin.y + y * zoom];
  return <svg className="photo-editor__path-overlay" data-anchor-overlay="true">
    {path.subpaths.map((subpath, subpathIndex) => {
      const points = subpath.knots.map(knot => knot.anchor as readonly [number, number]);
      const { d } = projectPath(points, !!subpath.closed, project);
      return <path key={`s${subpathIndex}`} d={d} fill="none" stroke="var(--app-interaction-accent)" strokeOpacity=".55" strokeWidth={1} />;
    })}
    {path.subpaths.map((subpath, subpathIndex) => subpath.knots.map((knot, knotIndex) => {
      const [x, y] = project(knot.anchor as readonly [number, number]);
      const selected = isSelected(subpathIndex, knotIndex);
      const hovered = isHovered(subpathIndex, knotIndex);
      return <g key={`k${subpathIndex}-${knotIndex}`}>
        {(["in", "out"] as const).map(key => {
          const handle = knot[key];
          if (!handle) return null;
          const [hx, hy] = point(handle as readonly [number, number]);
          if (Math.abs(hx - knot.anchor[0]) < 1e-9 && Math.abs(hy - knot.anchor[1]) < 1e-9) return null;
          return <g key={key} data-path-handle={key}>
            <line x1={x} y1={y} x2={origin.x + hx * zoom} y2={origin.y + hy * zoom} stroke="var(--app-interaction-accent)" strokeOpacity=".6" strokeWidth={1} />
            <circle cx={origin.x + hx * zoom} cy={origin.y + hy * zoom} r={2.5} fill="var(--app-interaction-accent)" />
          </g>;
        })}
        <rect x={x - 3.5} y={y - 3.5} width={7} height={7} rx={1}
          fill={selected ? "var(--app-interaction-accent)" : "var(--app-web-surface, #fff)"}
          stroke="var(--app-interaction-accent)" strokeWidth={1.25}
          data-path-anchor={knotIndex} data-selected={selected ? "true" : undefined}
          data-hovered={hovered ? "true" : undefined} />
        {hovered && tolerance ? <circle cx={x} cy={y} r={Math.max(4, tolerance * zoom)} fill="none" stroke="var(--app-interaction-accent)" strokeOpacity=".35" /> : null}
      </g>;
    }))}
  </svg>;
}

/**
 * 钢笔工具状态机（U11）：贝塞尔锚点、开放/闭合、续接与自由/曲率钢笔。
 *
 * 保留旧 API（`points`/`closed`/`add`/`undo`/`close`/`reset`）供现有调用点继续工作，
 * 新增 `addKnotPoint`（带拖柄）、`freehand`（自由钢笔）、`finish`（显式结束规则）。
 */
export function usePathDraft(kind: PenKind = "pen") {
  const [draft, setDraft] = useState<PenDraft>(() => emptyDraft(kind));
  const [closed, setClosed] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const points = useMemo<[number, number][]>(
    () => draft.subpaths.flatMap(subpath => subpath.knots.map(knot => [knot.anchor[0], knot.anchor[1]] as [number, number])),
    [draft],
  );
  const handles = useMemo(
    () => draft.subpaths.flatMap(subpath => subpath.knots.map(knot => ({ in: knot.in, out: knot.out }))),
    [draft],
  );

  const add = useCallback((point: [number, number]) => {
    setClosed(false);
    setDraft(current => addKnot(current, { point: [point[0], point[1]] }));
  }, []);
  /** 带控制柄的锚点（拖出贝塞尔切线）。 */
  const addWithHandle = useCallback((point: [number, number], handle: [number, number], breakHandle = false) => {
    setClosed(false);
    setDraft(current => addKnot(current, { point: [point[0], point[1]], handle: [handle[0], handle[1]], breakHandle }));
  }, []);
  const undo = useCallback(() => setDraft(current => removeKnot(current)), []);
  const close = useCallback(() => setDraft(current => closeDraft(current)), []);
  const reset = useCallback(() => {
    setDraft(emptyDraft(kind));
    setClosed(false);
  }, [kind]);
  /** 显式结束：传 `true` 才是闭合路径，默认开放。 */
  const finish = useCallback((shouldClose = false) => {
    const current = shouldClose ? closeDraft(draftRef.current) : draftRef.current;
    setDraft(current);
    setClosed(shouldClose);
    return canFinish(current);
  }, []);

  return {
    points,
    handles,
    closed,
    draft,
    count: knotCount(draft),
    canFinish: canFinish(draft),
    add,
    addWithHandle,
    undo,
    close,
    finish,
    reset,
  };
}

/** 形状拖绘状态机：指针按下记起点，移动更新终点与修饰键，松手由调用方提交。 */
export function useShapeDrag(kind: ShapeKind = "rect") {
  const [drag, setDrag] = useState<ShapeDrag | null>(null);
  const [shape, setShape] = useState<ShapeKind>(kind);
  const begin = useCallback((point: [number, number], modifiers?: ShapeDrag["modifiers"]) => {
    setDrag({ kind: shape, start: point, end: point, modifiers });
  }, [shape]);
  const update = useCallback((point: [number, number], modifiers?: ShapeDrag["modifiers"]) => {
    setDrag(current => current ? { ...current, end: point, modifiers: modifiers ?? current.modifiers } : current);
  }, []);
  const cancel = useCallback(() => setDrag(null), []);
  return { drag, kind: shape, setKind: setShape, begin, update, cancel, shapes: SHAPE_KINDS, labels: SHAPE_LABELS };
}
