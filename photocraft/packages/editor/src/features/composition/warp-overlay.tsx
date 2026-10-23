/**
 * 变形网格叠加层（U53）：拖动控制点、显示网格线、在指针处分割。
 *
 * 几何来自 `warp-mesh.ts`，本组件只做指针换算与预览。拖动只改被拖的控制点；块边界由
 * 「网格分割」命令单独调整，因此叠加层不碰 `us`/`vs`。
 *
 * 挂载点同裁剪框：共享画布的 `renderOverlay` 槽位由集成负责人接入。
 */

import { useRef, useState } from "react";
import { isIdentityWarpMesh, meshLines, meshColumns, moveMeshPoint } from "./warp-mesh.js";
import type { TransformRect, WarpMesh } from "./workflows.js";

export type WarpOverlayProps = {
  /** 变形框 `[x0,y0,x1,y1]`（文档坐标，与上游 `rect` 同义）。 */
  rect: TransformRect;
  mesh: WarpMesh;
  origin: { x: number; y: number };
  zoom: number;
  readonly?: boolean;
  /** 显示网格线与控制点；`false` 时只画变形框（样式预设模式）。 */
  showMesh?: boolean;
  onMeshChange?: (mesh: WarpMesh) => void;
  /** 松手：`changed` 是相对单位网格是否有实际改动，界面据此决定是否提交。 */
  onApply?: (mesh: WarpMesh, changed: boolean) => void;
  /** 双击或「在此分割」时的文档坐标。 */
  onSplit?: (at: [number, number]) => void;
  onGestureChange?: (active: boolean) => void;
};

type Gesture = { pointer: number; index: number; element: HTMLElement; mesh: WarpMesh; latest: WarpMesh };

export function WarpOverlay({
  rect,
  mesh,
  origin,
  zoom,
  readonly = false,
  showMesh = true,
  onMeshChange,
  onApply,
  onSplit,
  onGestureChange
}: WarpOverlayProps) {
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<WarpMesh | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const current = draft ?? mesh;
  const [x0, y0, x1, y1] = rect;

  const project = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - origin.x) / zoom,
      y: (event.clientY - bounds.top - origin.y) / zoom
    };
  };

  const begin = (event: React.PointerEvent<HTMLElement>) => {
    if (readonly || event.button !== 0 || gesture.current) return;
    const raw = (event.target as HTMLElement).dataset.meshPoint;
    if (raw === undefined) return;
    const index = Number(raw);
    if (!Number.isInteger(index)) return;
    event.stopPropagation();
    gesture.current = { pointer: event.pointerId, index, element: event.currentTarget, mesh: current, latest: current };
    event.currentTarget.setPointerCapture(event.pointerId);
    onGestureChange?.(true);
  };

  const update = (event: React.PointerEvent<HTMLElement>) => {
    const point = project(event);
    setHover([point.x, point.y]);
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    const next = moveMeshPoint(active.mesh, active.index, [point.x, point.y]);
    active.latest = next;
    setDraft(next);
    onMeshChange?.(next);
  };

  const finish = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    onGestureChange?.(false);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    const next = active.latest;
    setDraft(null);
    onApply?.(next, !isIdentityWarpMesh(next, rect));
  };

  const cancel = () => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    onGestureChange?.(false);
    setDraft(null);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
  };

  const lines = showMesh ? meshLines(current) : [];
  const columns = meshColumns(current);
  return (
    <div
      className="photo-editor-warp"
      data-warp-overlay="true"
      data-warp-points={current.points.length}
      // 颜色/线宽内联，避免依赖共享样式表；`touch-action: none` 让笔/触摸拖动不会被滚动吞掉。
      style={{
        position: "absolute",
        touchAction: "none",
        border: "1px dashed var(--app-interaction-accent, #2f80ed)",
        boxSizing: "border-box",
        pointerEvents: readonly ? "none" : undefined,
        left: origin.x + x0 * zoom,
        top: origin.y + y0 * zoom,
        width: (x1 - x0) * zoom,
        height: (y1 - y0) * zoom
      }}
      onPointerDown={begin}
      onPointerMove={update}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onDoubleClick={(event) => {
        if (readonly || !onSplit) return;
        event.stopPropagation();
        const point = project(event);
        onSplit([point.x, point.y]);
      }}
    >
      <svg className="photo-editor-warp__svg" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <g data-warp-mesh-lines="true" stroke="var(--app-interaction-accent, #2f80ed)" strokeWidth={1} fill="none">
          {lines.map((line, index) => (
            <line
              key={index}
              x1={(line.from[0] - x0) * zoom}
              y1={(line.from[1] - y0) * zoom}
              x2={(line.to[0] - x0) * zoom}
              y2={(line.to[1] - y0) * zoom}
            />
          ))}
        </g>
      </svg>
      {showMesh ? current.points.map((point, index) => (
        <span
          key={index}
          className={`photo-editor-warp__point${index % columns === 0 ? " photo-editor-warp__point--edge" : ""}`}
          data-mesh-point={index}
          data-testid={`warp-point-${index}`}
          style={{ left: (point[0] - x0) * zoom, top: (point[1] - y0) * zoom }}
        />
      )) : null}
      {hover && onSplit ? (
        <span className="photo-editor-warp__hint" data-warp-hint="true"
          style={{ position: "absolute", left: 6, bottom: 6, padding: "1px 4px", borderRadius: 3, fontSize: 11,
            background: "rgba(0,0,0,.6)", color: "#fff", pointerEvents: "none" }}>
          {Math.round(hover[0])}, {Math.round(hover[1])}
        </span>
      ) : null}
    </div>
  );
}
