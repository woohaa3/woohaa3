/**
 * 画布裁剪框叠加层（U50）：拖动、八向缩放、拉直手柄、三分/网格线与遮罩。
 *
 * 几何全部来自 `crop-frame.ts` 的纯函数，本组件只负责把指针事件换算成文档坐标并回报。
 * 它**不**持有裁剪参数、不提交命令：`onFrameChange`/`onStraightenChange` 给实时预览，
 * `onApply` 在松手时由面板决定是否提交草稿。
 *
 * 挂载点属共享画布（`photo-editor-app.tsx` 的 `renderOverlay` 槽位），集成负责人接上后
 * 与其他叠加层共用同一 `origin`/`zoom` 投影。
 */

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  CROP_HANDLES,
  cropFrameCenter,
  cropGridLines,
  cropHandlePoint,
  dragCropFrame,
  isValidCropFrame,
  straightenAngle,
  type CropFrameRect,
  type CropHandle
} from "./crop-frame.js";

/** 手柄的鼠标指针形状（内联样式，避免依赖共享样式表）。 */
const CSS_CURSORS: Record<string, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize"
};

export type CropOverlayProps = {
  frame: CropFrameRect;
  /** 文档尺寸；遮罩只压暗画布外与裁剪框外的区域。 */
  document: { width: number; height: number };
  /** 画布原点与缩放（与既有叠加层同一投影）。 */
  origin: { x: number; y: number };
  zoom: number;
  /** 宽高比约束（宽 / 高）；`null` 表示自由。 */
  ratio?: number | null;
  grid?: "none" | "thirds" | "grid";
  /** 拉直角度（度），显示在旋转手柄旁。 */
  angle?: number;
  /** 是否允许把裁剪框拖出画布（扩展画布）。 */
  allowOutside?: boolean;
  readonly?: boolean;
  /** 拖动中的实时裁剪框（未提交）。 */
  onFrameChange?: (frame: CropFrameRect) => void;
  /** 拖动旋转手柄时的实时角度。 */
  onStraightenChange?: (angle: number) => void;
  /** 松手：`frame` 是最终框，`angle` 是最终角度。 */
  onApply?: (frame: CropFrameRect, angle: number) => void;
  /** 指针是否落在框内（供画布决定是否让出默认手势）。 */
  onGestureChange?: (active: boolean) => void;
};

type Gesture = {
  pointer: number;
  handle: CropHandle;
  start: { x: number; y: number };
  frame: CropFrameRect;
  angle: number;
  /** 手势内的最新值：指针事件可能在同一批次里到达，不能只读渲染时的 state。 */
  latest: CropFrameRect;
  latestAngle: number;
  element: HTMLElement;
};

export function CropOverlay({
  frame,
  document,
  origin,
  zoom,
  ratio = null,
  grid = "thirds",
  angle = 0,
  allowOutside = true,
  readonly = false,
  onFrameChange,
  onStraightenChange,
  onApply,
  onGestureChange
}: CropOverlayProps) {
  const gesture = useRef<Gesture | null>(null);
  // 拖动中的预览框；松手后让回上层状态（上层可能夹取或重新取整）。
  const [draft, setDraft] = useState<CropFrameRect | null>(null);
  const [draftAngle, setDraftAngle] = useState<number | null>(null);
  const current = draft ?? frame;
  const angleNow = draftAngle ?? angle;

  const project = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left - origin.x) / zoom, y: (event.clientY - bounds.top - origin.y) / zoom };
  };

  const begin = (event: React.PointerEvent<HTMLElement>) => {
    if (readonly || event.button !== 0 || gesture.current) return;
    const handle = (event.target as HTMLElement).dataset.cropHandle as CropHandle | undefined;
    // 手柄优先；框内拖动算移动。框外（画布空白处）不该悄悄搬走裁剪框。
    const point = project(event);
    const inside = point.x >= frame.x && point.x <= frame.x + frame.width
      && point.y >= frame.y && point.y <= frame.y + frame.height;
    if (!handle && !inside) return;
    const start: Gesture = {
      pointer: event.pointerId,
      handle: handle ?? "move",
      start: point,
      frame,
      angle,
      latest: frame,
      latestAngle: angle,
      element: event.currentTarget
    };
    event.stopPropagation();
    gesture.current = start;
    event.currentTarget.setPointerCapture(event.pointerId);
    onGestureChange?.(true);
  };

  const update = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    const point = project(event);
    if (active.handle === "rotate") {
      // 旋转手柄按「从框中心指向指针」的方向给出角度，围绕框中心而不是指针起点。
      const next = straightenAngle(cropFrameCenter(active.frame), point);
      active.latestAngle = next;
      setDraftAngle(next);
      onStraightenChange?.(next);
      return;
    }
    const next = dragCropFrame(active.frame, active.handle, { x: point.x - active.start.x, y: point.y - active.start.y }, {
      document,
      ratio,
      allowOutside
    });
    active.latest = next;
    setDraft(next);
    onFrameChange?.(next);
  };

  const finish = (event: React.PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    onGestureChange?.(false);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    const appliedFrame = active.latest;
    const appliedAngle = active.latestAngle;
    setDraft(null);
    setDraftAngle(null);
    // 非法框（0 宽高等）不提交，避免把内核必定拒绝的参数送上去。
    if (isValidCropFrame(appliedFrame)) onApply?.(appliedFrame, appliedAngle);
  };

  const cancel = () => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    onGestureChange?.(false);
    setDraft(null);
    setDraftAngle(null);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
  };

  // 遮罩：整幅画布压暗，再把裁剪框掏空（even-odd 填充规则）。
  const maskPath = `M${origin.x} ${origin.y}H${origin.x + document.width * zoom}V${origin.y + document.height * zoom}H${origin.x}Z`
    + `M${origin.x + current.x * zoom} ${origin.y + current.y * zoom}`
    + `H${origin.x + (current.x + current.width) * zoom}V${origin.y + (current.y + current.height) * zoom}`
    + `H${origin.x + current.x * zoom}Z`;
  const lines = cropGridLines(current, grid, Math.max(8, 16 / Math.max(0.05, zoom)));

  const handles: ReactNode[] = CROP_HANDLES.map((handle) => {
    const point = cropHandlePoint(current, handle);
    // 旋转手柄画在框上方 24 屏幕像素处，与变换工具的习惯一致。
    const offset = handle === "rotate" ? 24 / zoom : 0;
    return (
      <span
        key={handle}
        className={`photo-editor-crop__handle photo-editor-crop__handle--${handle}`}
        data-crop-handle={handle}
        data-testid={`crop-handle-${handle}`}
        style={{
          position: "absolute",
          width: 9,
          height: 9,
          marginLeft: -5,
          marginTop: -5,
          boxSizing: "border-box",
          background: "var(--app-web-panel, #fff)",
          border: "1px solid var(--app-interaction-accent, #2f80ed)",
          borderRadius: handle === "rotate" ? "50%" : 1,
          cursor: handle === "rotate" ? "grab" : `${CSS_CURSORS[handle] ?? "crosshair"}`,
          left: origin.x + point.x * zoom,
          top: origin.y + point.y * zoom - offset
        }}
      />
    );
  });

  return (
    <div
      className="photo-editor-crop"
      data-crop-overlay="true"
      data-crop-frame={`${current.x},${current.y},${current.width},${current.height}`}
      style={{ position: "absolute", inset: 0, touchAction: "none", pointerEvents: readonly ? "none" : undefined }}
      onPointerDown={begin}
      onPointerMove={update}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
    >
      {/* 颜色与线宽写在内联样式里：叠加层不依赖 `photo-editor.css`（共享文件，单写）。 */}
      <svg className="photo-editor-crop__svg" width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <path className="photo-editor-crop__mask" d={maskPath} fillRule="evenodd"
          fill="rgba(0,0,0,.55)" style={{ fill: "rgba(0,0,0,.55)" }} />
        <g className="photo-editor-crop__grid" stroke="rgba(255,255,255,.65)" strokeWidth={1}>
          {lines.x.map((x, index) => (
            <line key={`x${index}`} x1={origin.x + x * zoom} x2={origin.x + x * zoom}
              y1={origin.y + current.y * zoom} y2={origin.y + (current.y + current.height) * zoom} />
          ))}
          {lines.y.map((y, index) => (
            <line key={`y${index}`} y1={origin.y + y * zoom} y2={origin.y + y * zoom}
              x1={origin.x + current.x * zoom} x2={origin.x + (current.x + current.width) * zoom} />
          ))}
        </g>
        <rect
          className="photo-editor-crop__frame"
          x={origin.x + current.x * zoom}
          y={origin.y + current.y * zoom}
          width={current.width * zoom}
          height={current.height * zoom}
          fill="none"
          stroke="var(--app-interaction-accent, #2f80ed)"
          strokeWidth={1}
        />
        <line
          className="photo-editor-crop__stem"
          x1={origin.x + (current.x + current.width / 2) * zoom}
          x2={origin.x + (current.x + current.width / 2) * zoom}
          y1={origin.y + current.y * zoom}
          y2={origin.y + current.y * zoom - 24}
          stroke="var(--app-interaction-accent, #2f80ed)"
          strokeWidth={1}
        />
      </svg>
      {handles}
      {draftAngle !== null ? (
        <span className="photo-editor-crop__angle" data-crop-angle="true"
          style={{ position: "absolute", left: origin.x + (current.x + current.width / 2) * zoom + 14, top: origin.y + current.y * zoom - 40,
            padding: "1px 4px", borderRadius: 3, fontSize: 11, background: "rgba(0,0,0,.7)", color: "#fff" }}>
          {angleNow.toFixed(1)}°
        </span>
      ) : null}
    </div>
  );
}
