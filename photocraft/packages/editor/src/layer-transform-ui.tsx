import {useStickyModifiers,withStickyModifiers} from "./modifier-keys.js";
import {isEditorMac} from "./photo-editor-shortcuts.js";
import {ArithmeticInput} from "./arithmetic-input.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "./ui/Button.js";
import { IDENTITY_MATRIX, IDENTITY_TRANSFORM, dragTransformMatrix, frameCenter, inverseTransformPoint, transformMatrix, transformValues, updateTransformValue, type LayerTransform, type TransformFrame, type TransformDragHandle, type TransformPoint } from "./transform-layer.js";

export type TransformGesturePort = { cancelGesture: () => boolean; hasGesture: () => boolean; previewAt: (point: TransformPoint, shift: boolean, alt: boolean) => void };

export function TransformOptions({ resolutionDpi=72, frame, matrix, readonly, onPreview, onConfirm, onCancel, onValidChange, linked = true, onLinkedChange, reference, onReferenceChange }: {
  resolutionDpi?:number;
  linked?: boolean; onLinkedChange?: (linked: boolean) => void; reference?: TransformPoint; onReferenceChange?: (point: TransformPoint) => void;
  frame: TransformFrame | null; matrix: readonly number[]; readonly: boolean; onPreview: (matrix: number[]) => void;
  onConfirm: () => void; onCancel: () => void; onValidChange: (valid: boolean) => void;
}) {
  const [value, setValue] = useState<LayerTransform>({ ...IDENTITY_TRANSFORM });
  const [draftValid, setDraftValid] = useState(true);
  useEffect(() => { if (frame) { setValue(transformValues(frame, matrix)); setDraftValid(true); onValidChange(true); } }, [frame, matrix, onValidChange]);
  const valid = draftValid && !!frame && !!transformMatrix(frame, value);
  return <div className="photo-editor__options-group">
    {([ ["dx", "水平位移", "px"], ["dy", "垂直位移", "px"], ["scaleX", "宽度", "%"], ["scaleY", "高度", "%"], ["rotate", "旋转", "°"] ] as const).map(([key, label, unit]) =>
      <label key={key}>{label}<ArithmeticInput invalidate units={key.startsWith("scale")?{unit:"%"}:key==="rotate"?{unit:"°"}:{unit:"px",dpi:resolutionDpi}}  value={Number.isFinite(value[key]) ? value[key] : ""} disabled={readonly || !frame}
        min={key.startsWith("scale") ? 1 : undefined} max={key.startsWith("scale") ? 1600 : undefined}
        onChange={(event) => {
          const next = { ...value, [key]: (event.currentTarget.value.trim()===""?NaN:Number(event.currentTarget.value)) };
          setValue(next);
          const updated = frame && Object.values(next).every(Number.isFinite) && updateTransformValue(frame, matrix, key, next[key], reference ?? frameCenter(frame), linked);
          setDraftValid(!!updated);
          onValidChange(!!updated);
          if (updated) onPreview(updated);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (valid) onConfirm(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
        }} />{unit}</label>)}
    <label><input type="checkbox" checked={linked} disabled={readonly} onChange={(event) => onLinkedChange?.(event.currentTarget.checked)} />锁定比例</label>
    <Button size="sm" tone="ghost" disabled={readonly || !frame} onClick={() => { if (frame) onReferenceChange?.(frameCenter(frame)); }}>参考点居中</Button>
    <Button size="sm" disabled={readonly || !valid} onClick={onConfirm}>确认变换</Button>
    <Button size="sm" tone="ghost" disabled={readonly} onClick={onCancel}>取消</Button>
    <span className="photo-editor__option-hint">Enter 确认，Esc 取消。Shift 切换比例约束，Alt/Option 围绕参考点缩放。</span>
  </div>;
}

/** 单次拖动产生累计矩阵；变换会话由 App 确认，移动工具在松手时确认。 */
export const LayerTransformOverlay = forwardRef<TransformGesturePort, {
  frame: TransformFrame; origin: { x: number; y: number }; zoom: number;
  matrix?: readonly number[]; passive?: boolean; moveOnly?: boolean; linked?: boolean; reference?: TransformPoint; onReferenceChange?: (point: TransformPoint) => void; onBegin?: () => boolean;
  onPreview?: (matrix: number[]) => void; onCancel?: () => void;
  onPointerPosition?: (event: {clientX:number;clientY:number;shiftKey:boolean;altKey:boolean}) => void;
  onApply: (matrix: number[]) => void; onGestureChange: (active: boolean) => void;
}>(function LayerTransformOverlay({ frame, origin, zoom, matrix = IDENTITY_MATRIX, moveOnly = false, passive = false, linked = true, reference = frameCenter(frame), onReferenceChange, onBegin, onPreview, onCancel, onApply, onGestureChange, onPointerPosition }, ref) {
  const gesture = useRef<{ pointer: number; handle: TransformDragHandle | "reference"; reference: TransformPoint; start: { x: number; y: number }; matrix: readonly number[]; element: HTMLElement } | null>(null);
  const [preview, setPreview] = useState<readonly number[]>(matrix);
  useEffect(() => { if (!gesture.current) setPreview(matrix); }, [matrix]);
  const cancelGesture = () => {
    const active = gesture.current;
    if (!active) return false;
    gesture.current = null;
    onGestureChange(false);
    setPreview(active.matrix);
    if (active.handle === "reference") onReferenceChange?.(active.reference);
    else { onPreview?.([...active.matrix]); onCancel?.(); }
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    return true;
  };
  useEffect(() => () => {
    const active = gesture.current;
    gesture.current = null;
    if (active?.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    onGestureChange(false);
  }, [onGestureChange]);
  useImperativeHandle(ref, () => ({ cancelGesture, hasGesture: () => gesture.current !== null, previewAt }));
  function previewAt(position: TransformPoint, shift: boolean, alt: boolean) {
    const active = gesture.current;
    if (!active) return;
    if (active.handle === "reference") {
      const start = inverseTransformPoint(active.matrix,active.start), end = inverseTransformPoint(active.matrix,position);
      onReferenceChange?.({x:active.reference.x+end.x-start.x,y:active.reference.y+end.y-start.y});
      return;
    }
    const next = dragTransformMatrix(frame,active.matrix,active.handle,active.start,position,{linked,shift,centered:alt,reference:active.reference});
    setPreview(next); onPreview?.(next);
  }
  const point = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left - origin.x) / zoom, y: (event.clientY - bounds.top - origin.y) / zoom };
  };
  const sticky=useStickyModifiers();
  const calculate = (event: { clientX: number; clientY: number; currentTarget: HTMLElement; shiftKey: boolean; altKey: boolean }) => {
    const active = gesture.current!;
    return dragTransformMatrix(frame, active.matrix, active.handle as TransformDragHandle, active.start, point(event),
      { linked, shift: event.shiftKey, centered: event.altKey, reference: active.reference });
  };
  const moveReference = (event: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const active = gesture.current!;
    const start = inverseTransformPoint(active.matrix, active.start), end = inverseTransformPoint(active.matrix, point(event));
    onReferenceChange?.({ x: active.reference.x+end.x-start.x, y: active.reference.y+end.y-start.y });
  };
  const [x0, y0, x1, y1] = frame;
  const [a,b,c,d,e,f] = gesture.current ? preview : matrix;
  return <div className="photo-editor-transform" data-canvas-viewport-blocked={gesture.current ? "true" : undefined}
    style={{ pointerEvents: passive ? "none" : undefined, left: origin.x + x0 * zoom, top: origin.y + y0 * zoom, width: (x1 - x0) * zoom, height: (y1 - y0) * zoom,
      transformOrigin: "0 0", transform: `matrix(${a},${b},${c},${d},${(a*x0+c*y0+e-x0)*zoom},${(b*x0+d*y0+f-y0)*zoom})` }}
    onPointerDown={(rawEvent) => {
      const event=withStickyModifiers(rawEvent,sticky,isEditorMac());
      if (event.button !== 0 || gesture.current) return;
      event.stopPropagation();
      const handle = (event.target as HTMLElement).dataset.transformHandle as TransformDragHandle | "reference" | undefined;
      if (handle !== "reference" && onBegin && !onBegin()) return;
      gesture.current = { pointer: event.pointerId, handle: moveOnly ? "move" : handle ?? "move", reference, start: point(event), matrix, element: event.currentTarget };
      event.currentTarget.setPointerCapture(event.pointerId);
      onGestureChange(true);
      onPointerPosition?.(event);
    }}
    onPointerMove={(rawEvent) => {
      const event=withStickyModifiers(rawEvent,sticky,isEditorMac());
      if (!gesture.current || gesture.current.pointer !== event.pointerId) return;
      event.stopPropagation();
      onPointerPosition?.(event);
      if (gesture.current.handle === "reference") { moveReference(event); return; }
      const next = calculate(event);
      setPreview(next);
      onPreview?.(next);
    }}
    onPointerUp={(rawEvent) => {
      const event=withStickyModifiers(rawEvent,sticky,isEditorMac());
      const active = gesture.current;
      if (!active || active.pointer !== event.pointerId) return;
      event.stopPropagation();
      if (active.handle === "reference") {
        moveReference(event); gesture.current = null; onGestureChange(false);
        if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
        return;
      }
      const next = calculate(event);
      gesture.current = null;
      onGestureChange(false);
      setPreview(next);
      onPreview?.(next);
      if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
      onApply(next);
    }}
    onPointerCancel={(event) => { event.stopPropagation(); cancelGesture(); }} onLostPointerCapture={cancelGesture}>
    {!moveOnly ? (["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"] as const).map((handle) => <span key={handle} className={`photo-editor-transform__handle photo-editor-transform__handle--${handle}`} data-transform-handle={handle} />) : null}
    {!moveOnly ? <span className="photo-editor-transform__handle photo-editor-transform__handle--reference" data-transform-handle="reference" title="拖动参考点"
      style={{ left: (reference.x-x0)*zoom-5, top: (reference.y-y0)*zoom-5 }} /> : null}
  </div>;
});
