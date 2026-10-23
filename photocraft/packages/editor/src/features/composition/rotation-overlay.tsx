/**
 * 任意角度整图旋转的画布预览叠加层（U52）。
 *
 * 旋转本身由已在白名单的 `image.rotation.arbitrary` 执行；这个叠加层只画**预览**：新画布
 * 的外框、旧画布旋转后的四条边，以及可拖的旋转手柄。几何全部来自 `rotation-frame.ts`
 * （与内核 `mode_cmds::rotate_arbitrary` 同一套中心+扩张式），组件不自己算尺寸。
 *
 * 挂载点与裁剪框/变形网格相同：共享画布的 `renderOverlay` 槽位，由集成负责人接一次。
 * 未挂载时不参与渲染，也不改变任何文档状态。
 */

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  isValidRotationAngle,
  pointerAngle,
  rotationAngleFromPointer,
  rotationFootprint,
  type RotationPoint
} from "./rotation-frame.js";

export type RotationOverlayProps = {
  /** 当前画布尺寸（旋转前）。 */
  document: { width: number; height: number };
  origin: { x: number; y: number };
  zoom: number;
  /** 预览角度（度，顺时针为正）。 */
  angle: number;
  readonly?: boolean;
  /** 拖动中的角度；松手后由上层夹取或吸附。 */
  onAngleChange?: (angle: number) => void;
  /** 松手：给出最终角度，界面据此决定是否提交。 */
  onApply?: (angle: number) => void;
  onGestureChange?: (active: boolean) => void;
  /** 拖动时按该角度吸附（度）；未给则不吸附。 */
  snap?: number;
};

type Gesture = {
  pointer: number;
  center: RotationPoint;
  startAngle: number;
  startPointerAngle: number;
  latest: number;
  element: HTMLElement;
};

const toScreen = (point: RotationPoint, origin: { x: number; y: number }, zoom: number): RotationPoint => ({
  x: origin.x + point.x * zoom,
  y: origin.y + point.y * zoom
});

export function RotationOverlay({
  document,
  origin,
  zoom,
  angle,
  readonly = false,
  onAngleChange,
  onApply,
  onGestureChange,
  snap
}: RotationOverlayProps) {
  const gesture = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const current = draft ?? angle;
  const footprint = rotationFootprint(document, current);
  // 新画布比旧画布大，预览时整体向外偏，让两框都落在可见区域里。
  const pad = footprint.offset;
  const view = { x: origin.x - pad.x * zoom, y: origin.y - pad.y * zoom };
  const project = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left - view.x) / zoom, y: (event.clientY - bounds.top - view.y) / zoom };
  };
  const center = { x: footprint.size.width / 2, y: footprint.size.height / 2 };

  const begin = (event: React.PointerEvent<HTMLElement>) => {
    if (readonly || event.button !== 0 || gesture.current) return;
    const point = project(event);
    // 手柄与框内都可起拖：旋转是整图操作，没有「框外拖动」的含义。
    event.stopPropagation();
    gesture.current = {
      pointer: event.pointerId,
      center,
      startAngle: current,
      startPointerAngle: pointerAngle(center, point),
      latest: current,
      element: event.currentTarget
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onGestureChange?.(true);
  };

  const update = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    // 增量角度：从按下时的指针方向算起，越过 ±180 也连续。
    const next = rotationAngleFromPointer(active.center, project(event), {
      startAngle: active.startAngle,
      startPointerAngle: active.startPointerAngle,
      snap
    });
    active.latest = next;
    setDraft(next);
    onAngleChange?.(next);
  };

  const finish = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    onGestureChange?.(false);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    const applied = active.latest;
    setDraft(null);
    // 内核只接受 |angle| < 360；非法值不提交，避免无谓的拒绝。
    if (isValidRotationAngle(applied)) onApply?.(applied);
  };

  const cancel = () => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    onGestureChange?.(false);
    setDraft(null);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
  };

  const screen = footprint.corners.map((corner) => toScreen(corner, view, zoom));
  const quad = screen.map((point) => `${point.x},${point.y}`).join(" ");
  const outline = toScreen({ x: 0, y: 0 }, view, zoom);
  const handle = screen[0];
  const stemTop = { x: handle.x, y: handle.y - 24 };

  const handles: ReactNode[] = footprint.corners.map((corner, index) => {
    const point = toScreen(corner, view, zoom);
    return (
      <span
        key={`corner-${index}`}
        className="photo-editor-rotation__corner"
        data-rotation-corner={index}
        style={{
          position: "absolute",
          width: 7,
          height: 7,
          marginLeft: -4,
          marginTop: -4,
          boxSizing: "border-box",
          background: "var(--app-web-panel, #fff)",
          border: "1px solid var(--app-interaction-accent, #2f80ed)",
          borderRadius: 1,
          left: point.x,
          top: point.y
        }}
      />
    );
  });

  return (
    <div
      className="photo-editor-rotation"
      data-rotation-overlay="true"
      data-rotation-angle={current.toFixed(3)}
      data-rotation-canvas={`${footprint.size.width},${footprint.size.height}`}
      style={{ position: "absolute", inset: 0, touchAction: "none", pointerEvents: readonly ? "none" : undefined }}
      onPointerDown={begin}
      onPointerMove={update}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    >
      {/* 颜色与线宽内联：叠加层不依赖共享样式表（`photo-editor.css` 单写）。 */}
      <svg className="photo-editor-rotation__svg" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <rect
          className="photo-editor-rotation__canvas"
          x={outline.x}
          y={outline.y}
          width={footprint.size.width * zoom}
          height={footprint.size.height * zoom}
          fill="rgba(47,128,237,.06)"
          stroke="var(--app-interaction-accent, #2f80ed)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <polygon
          className="photo-editor-rotation__content"
          points={quad}
          fill="none"
          stroke="rgba(255,255,255,.9)"
          strokeWidth={1}
        />
        <line
          className="photo-editor-rotation__stem"
          x1={handle.x}
          y1={handle.y}
          x2={stemTop.x}
          y2={stemTop.y}
          stroke="var(--app-interaction-accent, #2f80ed)"
          strokeWidth={1}
        />
      </svg>
      {handles}
      <span
        className="photo-editor-rotation__handle"
        data-rotation-handle="true"
        style={{
          position: "absolute",
          width: 9,
          height: 9,
          marginLeft: -5,
          marginTop: -5,
          boxSizing: "border-box",
          background: "var(--app-web-panel, #fff)",
          border: "1px solid var(--app-interaction-accent, #2f80ed)",
          borderRadius: "50%",
          cursor: "grab",
          left: stemTop.x,
          top: stemTop.y
        }}
      />
      {draft !== null ? (
        <span
          className="photo-editor-rotation__angle"
          data-rotation-label="true"
          style={{
            position: "absolute",
            left: stemTop.x + 12,
            top: stemTop.y - 16,
            padding: "1px 4px",
            borderRadius: 3,
            fontSize: 11,
            background: "rgba(0,0,0,.7)",
            color: "#fff"
          }}
        >
          {current.toFixed(1)}°
        </span>
      ) : null}
    </div>
  );
}
