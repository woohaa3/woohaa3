/** 透明交互层：图片仍由原节点呈现，取景与聚焦动画共用工作区状态。 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { Button, IconButton } from "./ui/Button.js";
import { ZoomInIcon, ZoomOutIcon } from "./ui/icons.js";
import { shortcutLabel, type EditorViewAction } from "./photo-editor-shortcuts.js";
import { LayerTransformOverlay, type TransformGesturePort } from "./layer-transform-ui.js";
import { projectTransformPoint, type TransformFrame, type TransformPoint } from "./transform-layer.js";
import { SelectionAutoPan, type SelectionPanContext } from "./selection-autopan.js";
import type {StylePositionPort} from "./style-positioning.js";
import { SelectionGesture, selectionModeForKeys } from "./selection-gesture.js";
import type { SelectionSegment } from "./editor-view-model.js";
import type { EditorViewport } from "./viewport.js";
import {
  screenToDocument,
  pointInSelection,
  type CanvasViewport,
  type DocumentPoint,
  type EditorToolId,
  type SelectionMode,
  type PixelRect
} from "./photo-editor-tools.js";

export type PhotoCanvasHandle = {
  view: (action: EditorViewAction) => void;
  cancelGesture: () => boolean;
  hasGesture: () => boolean;
  selectionKey: (key: string, pressed: boolean) => boolean;
};

export type PhotoCanvasView = {
  contentSize?:{width:number;height:number};
  viewport: EditorViewport;
  fitZoom: number;
  transitioning: boolean;
  onChange: (viewport: EditorViewport) => void;
};

export type PhotoCanvasProps = {
  view: PhotoCanvasView;
  positioning?: StylePositionPort;
  /** 预览对应的文档尺寸（画布坐标）。 */
  documentWidth: number;
  documentHeight: number;
  /** 是否接收视图和工具手势（过渡期间自动暂停）。 */
  interactive?: boolean;
  /**
   * 合成预览背景（change: 2026-10-21-extract-photocraft-subproject）。
   *
   * 编辑器画布是透明交互层：Woohaa 让 Bevy 节点在下方呈现像素，独立 dev 宿主则用
   * Canvas 画同一份 RGBA 预览。`origin` 是文档左上角在画布容器内的 CSS 像素，
   * `zoom` 是源像素到 CSS 像素的比例。
   */
  renderBackground?: (origin: { x: number; y: number }, zoom: number) => ReactNode;
  /** 当前手势；none 不接收拖动，pan 仅用于按住空格时临时拖动。 */
  tool?: EditorToolId;
  /** 内核保存的选区边界；不依赖当前工具和上次拖动。 */
  selectionOutline?: SelectionSegment[];
  /** 只隐藏已提交边界；命中、移动和选区内容保持不变。 */
  showSelectionEdges?:boolean;
  ellipse?: boolean;
  selectionMode?: SelectionMode;
  selectionMatrix?: readonly number[];
  onSelectionMoveStart?: (pixels: boolean) => boolean;
  transformFrame?: TransformFrame | null;
  onTransform?: (matrix: number[]) => void;
  transformMatrix?: readonly number[];
  transformLinked?: boolean;
  transformReference?: TransformPoint;
  onTransformReferenceChange?: (point: TransformPoint) => void;
  transformMoveOnly?: boolean;
  onTransformBegin?: () => boolean;
  onTransformPreview?: (matrix: number[]) => void;
  onTransformCancel?: () => void;
  onMoveStart?: (point: DocumentPoint, modifiers: { duplicate: boolean; toggleAuto: boolean }) => boolean;
  onMovePreview?: (matrix: number[]) => void;
  onMoveEnd?: (matrix: number[]) => void;
  onMoveCancel?: () => void;
  /** 选框手势结束（已换算为文档坐标矩形）。 */
  onMarquee?: (rect: PixelRect, mode?: SelectionMode) => void;
  /** 套索手势结束（文档坐标点位）。 */
  onLasso?: (points: DocumentPoint[], mode?: SelectionMode) => void;
  /** 选区工具的单击；与拖动创建选区分开处理。 */
  onSelectionClick?: (point: DocumentPoint, mode?: SelectionMode) => void;
  /** 画笔/橡皮手势结束（文档坐标点位）。 */
  onStroke?: (points: DocumentPoint[]) => void;
  onStrokeStart?: (point: DocumentPoint, modifiers?: {shift:boolean}) => void;
  sampling?: boolean;
  onSampleColor?: (point: DocumentPoint) => void;
  onStrokeMove?: (points: DocumentPoint[]) => void;
  onStrokeCancel?: () => void;
  /** 画笔笔头尺寸（源像素），用于显示光标圈。 */
  brushSize?: number;
  onText?: (placement: {x:number;y:number;box?:[number,number,number,number]}) => void;
  renderOverlay?: (origin:{x:number;y:number},zoom:number) => ReactNode;
};

const MIN_ZOOM = 0.05;

/** 容器内像素矩形。 */
type LocalRect = { x: number; y: number; width: number; height: number };

/** 需要画布手势的工具。 */
function isGestureTool(tool: EditorToolId): boolean {
  return tool === "marquee" || tool === "lasso" || tool === "brush" || tool === "eraser";
}

/**
 * 在原节点图片上叠加工具手势，使用工作区取景。
 *
 * 视图操作只提交取景，不重取编辑预览。
 */
export const PhotoCanvas = forwardRef<PhotoCanvasHandle, PhotoCanvasProps>(function PhotoCanvas({
  view,
  documentWidth,
  documentHeight,
  interactive = true,
  tool = "none",
  selectionOutline = [],
  showSelectionEdges = true,
  ellipse = false,
  selectionMode = "replace",
  selectionMatrix, onSelectionMoveStart,
  transformFrame,
  onTransform,
  transformMatrix,
  transformLinked, transformReference, onTransformReferenceChange,
  transformMoveOnly,
  onTransformBegin,
  onTransformPreview,
  onTransformCancel,
  onMoveStart, onMovePreview, onMoveEnd, onMoveCancel,
  onMarquee,
  onLasso,
  onSelectionClick,
  onStroke,
  onStrokeStart,
  onStrokeMove,
  onStrokeCancel,
  sampling = false, onSampleColor,
  brushSize, onText, renderOverlay, positioning, renderBackground
}, ref) {
  const positionRef=useRef<StylePositionPort|null>(null);
  const [positioningActive,setPositioningActive]=useState(false);
  const autoPointer = useRef<{clientX:number;clientY:number;shiftKey:boolean;altKey:boolean} | null>(null);
  const autoContext = useRef<{read:()=>SelectionPanContext|null;pan:(step:{x:number;y:number})=>void} | null>(null);
  const [autoPan] = useState(() => new SelectionAutoPan(() => autoContext.current?.read() ?? null,(step) => autoContext.current?.pan(step)));
  const transformRef = useRef<TransformGesturePort>(null);
  const selectionMove = useRef<"boundary" | "pixels" | null>(null);
  const [selectionHover, setSelectionHover] = useState<"boundary" | "pixels" | null>(null);
  const moveRef = useRef<DocumentPoint | null>(null);
  const [moving, setMoving] = useState(false);
  const pointerRef = useRef<number | null>(null);
  const clickRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const gestureTool = useRef<EditorToolId>("pan");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { zoom, x: offsetX, y: offsetY } = view.viewport;
  const offset = { x: offsetX, y: offsetY };
  const [pan, setPan] = useState<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const selectionSpace = useRef(false);
  const selectionRef = useRef<SelectionGesture | null>(null);
  const [box, setBox] = useState<PixelRect | null>(null);
  /** 路径手势（套索/画笔）：文档坐标点位。 */
  const textStart = useRef<DocumentPoint | null>(null);
  const pathRef = useRef<DocumentPoint[] | null>(null);
  const samplingRef = useRef(false);
  const [path, setPath] = useState<DocumentPoint[] | null>(null);
  /** 指针在容器内的位置（画笔光标与坐标读数）。 */
  const [cursor, setCursor] = useState<{ local: { x: number; y: number }; doc: DocumentPoint } | null>(null);

  /** 与 Bevy 相机一致：以共享内容矩形中心和源像素缩放计算图片位置。 */
  const viewport = useCallback((): CanvasViewport | null => {
    const element = containerRef.current;
    if (!element || documentWidth <= 0 || documentHeight <= 0) return null;
    const rect = element.getBoundingClientRect();
    const width = documentWidth * zoom;
    const height = documentHeight * zoom;
    return {
      left: rect.left + (element.clientWidth - width) / 2 + offsetX,
      top: rect.top + (element.clientHeight - height) / 2 + offsetY,
      width, height, documentWidth, documentHeight
    };
  }, [documentWidth, documentHeight, zoom, offsetX, offsetY]);

  /** 客户坐标 → 容器内像素（用于绘制选框/光标）。 */
  const toLocal = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const toDocument = useCallback(
    (clientX: number, clientY: number, clamp = true): DocumentPoint | null => {
      const current = viewport();
      return current ? screenToDocument(clientX, clientY, current, clamp && tool !== "brush" && tool !== "eraser" && tool !== "move" && !moveRef.current) : null;
    },
    [viewport, tool]
  );

  const [transforming, setTransforming] = useState(false);
  const changeTransformGesture = useCallback((active: boolean) => {
    setTransforming(active);
    if (!active) { autoPan.stop(); autoPointer.current = null; }
  }, [autoPan]);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setStageSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const actualScale = zoom;
  const canInteract = interactive && !view.transitioning;
  const changeZoom = (factor: number) => view.onChange({ ...view.viewport, zoom: Math.min(32, Math.max(MIN_ZOOM, zoom * factor)) });
  const changeView = (action: EditorViewAction) => {
    if (pointerRef.current !== null || transformRef.current?.hasGesture() || !canInteract) return;
    if (action === "zoomIn") changeZoom(1.2);
    else if (action === "zoomOut") changeZoom(1 / 1.2);
    else view.onChange({ x: 0, y: 0, zoom: action === "fit" ? view.fitZoom : 1 });
  };
  const cancelGesture = () => {
    autoPan.stop(); autoPointer.current = null;
    const transforming = transformRef.current?.cancelGesture() ?? false;
    const active = pointerRef.current !== null || transforming;
    const pointer = pointerRef.current;
    pointerRef.current = null;
    const position=positionRef.current;positionRef.current=null;setPositioningActive(false);position?.cancel();
    if (moveRef.current) { moveRef.current = null; setMoving(false); onMoveCancel?.(); }
    selectionMove.current = null; setSelectionHover(null);
    clickRef.current = null;
    textStart.current = null;
    pathRef.current = null;
    samplingRef.current = false;
    selectionRef.current = null;
    selectionSpace.current = false;
    if (pointer !== null && (gestureTool.current === "brush" || gestureTool.current === "eraser")) onStrokeCancel?.();
    setBox(null); setPath(null); setPan(null);
    if (pointer !== null && containerRef.current?.hasPointerCapture(pointer)) containerRef.current.releasePointerCapture(pointer);
    return active;
  };
  const showSelection = () => {
    const selection = selectionRef.current;
    if (!selection) return;
    if (selection.kind === "marquee") setBox(selection.rect());
    else setPath(selection.path());
  };
  autoContext.current = {
    read: () => {
      const element = containerRef.current, pointer = autoPointer.current;
      const overlayActive = !!selectionMatrix && transformRef.current?.hasGesture();
      if (!element || !pointer || (!overlayActive && (pointerRef.current === null || !clickRef.current?.moved || (!selectionRef.current && !selectionMove.current && !(tool === "move" && selectionOutline.length))))) return null;
      return {pointer:toLocal(pointer.clientX,pointer.clientY),width:element.clientWidth,height:element.clientHeight,
        documentWidth,documentHeight,...view.viewport};
    },
    pan: (step) => {
      const current = viewport(), pointer = autoPointer.current;
      if (!current || !pointer) return;
      if (clickRef.current) clickRef.current.moved = true;
      view.onChange({...view.viewport,x:offsetX+step.x,y:offsetY+step.y});
      const point = screenToDocument(pointer.clientX,pointer.clientY,{...current,left:current.left+step.x,top:current.top+step.y},!moveRef.current && !transformRef.current?.hasGesture());
      if (!point) return;
      if (selectionRef.current) {
        selectionRef.current.update(point,{shift:pointer.shiftKey,alt:pointer.altKey,space:selectionSpace.current}); showSelection();
      } else if (moveRef.current) onMovePreview?.([1,0,0,1,point.x-moveRef.current.x,point.y-moveRef.current.y]);
      else transformRef.current?.previewAt(point,pointer.shiftKey,pointer.altKey);
    }
  };
  const selectionKey = (key: string, pressed: boolean) => {
    if (!selectionRef.current?.key(key,pressed)) return false;
    if (key === " ") selectionSpace.current = pressed;
    showSelection(); return true;
  };
  const cancelRef = useRef(cancelGesture);
  cancelRef.current = cancelGesture;
  useEffect(() => { cancelRef.current(); }, [tool, canInteract, positioning?.key]);
  useEffect(() => () => { cancelRef.current(); }, []);
  useImperativeHandle(ref, () => ({
    hasGesture: () => pointerRef.current !== null || (transformRef.current?.hasGesture() ?? false),
    cancelGesture,
    selectionKey,
    view: changeView
  }));
  // 将文档边界投影到当前视图；缩放与平移不改变选区状态。
  const originX = (stageSize.width - documentWidth * actualScale) / 2 + offset.x;
  const originY = (stageSize.height - documentHeight * actualScale) / 2 + offset.y;
  const marquee: LocalRect | null = box ? {x:originX+box.x*zoom,y:originY+box.y*zoom,width:box.width*zoom,height:box.height*zoom} : null;
  const selectionPath = selectionOutline.map(([x0, y0, x1, y1]) => {
    const start = selectionMatrix ? projectTransformPoint(selectionMatrix,{x:x0,y:y0}) : {x:x0,y:y0};
    const end = selectionMatrix ? projectTransformPoint(selectionMatrix,{x:x1,y:y1}) : {x:x1,y:y1};
    return `M${originX+start.x*actualScale} ${originY+start.y*actualScale}L${originX+end.x*actualScale} ${originY+end.y*actualScale}`;
  }).join(" ");
  const lassoPoints = tool === "lasso" ? path?.map((point) =>
    `${originX + point.x * actualScale} ${originY + point.y * actualScale}`
  ) ?? [] : [];
  const lassoPath = lassoPoints.map((point, index) => `${index ? "L" : "M"}${point}`).join(" ");

  return (
    <div
      ref={containerRef}
      className="photo-editor-canvas"
      data-document-size={`${documentWidth}x${documentHeight}`}
      data-tool={tool}
      data-selection-operation={selectionMove.current ?? (selectionRef.current ? "new" : undefined)}
      style={{cursor: tool==="none" && positioning ? positioningActive?"grabbing":"move" : (sampling || samplingRef.current) && (tool === "brush" || tool === "eraser") ? "crosshair" : selectionMove.current === "pixels" ? "grabbing" : selectionMove.current === "boundary" || selectionHover === "boundary" ? "move" : selectionHover === "pixels" ? "grab" : undefined}}
      data-canvas-viewport="true"
      data-canvas-viewport-blocked={!canInteract || !!(box || path || pan || transforming || moving || positioningActive) ? "true" : undefined}
      onPointerDown={(event) => {
        if (!canInteract || (tool === "none" && !positioning) || event.button !== 0 || pointerRef.current !== null) return;
        if (tool === "none" && positioning) {
          const point=toDocument(event.clientX,event.clientY,false);
          if(!point || point.x<0 || point.y<0 || point.x>=documentWidth || point.y>=documentHeight || !positioning.start(point)) return;
          positionRef.current=positioning;setPositioningActive(true);
          pointerRef.current=event.pointerId;gestureTool.current=tool;
          event.currentTarget.setPointerCapture(event.pointerId);return;
        }
        if (tool === "text") {
          const point=toDocument(event.clientX,event.clientY,false);
          if (!point || point.x<0 || point.y<0 || point.x>=documentWidth || point.y>=documentHeight) return;
          textStart.current=point;setBox({x:point.x,y:point.y,width:0,height:0});
        }
        if (tool === "move") {
          const point = toDocument(event.clientX,event.clientY);
          if (!point || !onMoveStart?.(point,{ duplicate: event.altKey, toggleAuto: event.ctrlKey || event.metaKey })) return;
          moveRef.current = point; setMoving(true);
        }
        if ((tool === "marquee" || tool === "lasso") && onSelectionMoveStart) {
          const point = toDocument(event.clientX,event.clientY,false);
          const mode = selectionModeForKeys(selectionMode,{shift:event.shiftKey,alt:event.altKey});
          if (point && mode === "replace" && pointInSelection(point,selectionOutline)) {
            const pixels = event.ctrlKey || event.metaKey;
            if (!onSelectionMoveStart(pixels)) return;
            moveRef.current = point; selectionMove.current = pixels ? "pixels" : "boundary"; setMoving(true);
          }
        }
        pointerRef.current = event.pointerId;
        clickRef.current = { x: event.clientX, y: event.clientY, moved: false };
        autoPointer.current = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey};
        gestureTool.current = tool;
        event.currentTarget.setPointerCapture(event.pointerId);
        if ((tool === "brush" || tool === "eraser") && event.altKey && onSampleColor) {
          samplingRef.current = true;
          const point = toDocument(event.clientX,event.clientY,false);
          if (point) onSampleColor(point);
          return;
        }
        if (textStart.current) return;
        if (moveRef.current) { autoPan.update(); return; }
        if (isGestureTool(tool)) {
          const point = toDocument(event.clientX, event.clientY);
          if (!point) return;
          if (tool === "marquee" || tool === "lasso") {
            selectionSpace.current = false;
            selectionRef.current = new SelectionGesture(tool,point,{width:documentWidth,height:documentHeight},selectionMode,
              {shift:event.shiftKey,alt:event.altKey,space:false});
            showSelection(); autoPan.update();
          } else {
            const first = { ...point, ...(event.pointerType === "pen" ? { pressure: event.pressure } : {}) };
            pathRef.current = [first];
            setPath(pathRef.current);
            onStrokeStart?.(first,{shift:event.shiftKey});
          }
          return;
        }
        setPan({ x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y });
      }}
      onPointerMove={(event) => {
        if (pointerRef.current !== null && pointerRef.current !== event.pointerId) return;
        if(positionRef.current) {
          const point=toDocument(event.clientX,event.clientY,false);if(point) positionRef.current.preview(point);return;
        }
        autoPointer.current = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey};
        const click = clickRef.current;
        if (click && Math.hypot(event.clientX - click.x, event.clientY - click.y) > 3) click.moved = true;
        autoPan.update();
        const local = toLocal(event.clientX, event.clientY);
        const point = toDocument(event.clientX, event.clientY);
        if (point) setCursor({ local, doc: point });
        if (samplingRef.current) { if (point) onSampleColor?.(point); return; }
        if (textStart.current && point) {
          const start=textStart.current;
          setBox({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.abs(start.x-point.x),height:Math.abs(start.y-point.y)});
          return;
        }
        const hitPoint = toDocument(event.clientX,event.clientY,false);
        setSelectionHover(hitPoint && (tool === "marquee" || tool === "lasso")
          && selectionModeForKeys(selectionMode,{shift:event.shiftKey,alt:event.altKey}) === "replace" && pointInSelection(hitPoint,selectionOutline)
          ? event.ctrlKey || event.metaKey ? "pixels" : "boundary" : null);
        if (moveRef.current && point) {
          if (click?.moved) onMovePreview?.([1,0,0,1,point.x-moveRef.current.x,point.y-moveRef.current.y]);
          return;
        }
        if (selectionRef.current && point) {
          // 空格状态来自键盘端口；Shift/Alt 同时从指针事件纠正，避免漏掉释放。
          selectionRef.current.update(point,{shift:event.shiftKey,alt:event.altKey,space:selectionSpace.current});
          showSelection(); return;
        }
        if (pathRef.current && point) {
          const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
          const points = (samples.length ? samples : [event]).flatMap((sample) => {
            const point = toDocument(sample.clientX, sample.clientY);
            return point ? [{ ...point, ...(event.pointerType === "pen" ? { pressure: sample.pressure } : {}) }] : [];
          });
          pathRef.current.push(...points);
          onStrokeMove?.(points);
          return;
        }
        if (pan) view.onChange({ zoom, x: pan.ox + (event.clientX - pan.x), y: pan.oy + (event.clientY - pan.y) });
      }}
      onPointerUp={(event) => {
        if (pointerRef.current !== event.pointerId) return;
        autoPan.stop(); autoPointer.current = null;
        pointerRef.current = null;
        if(positionRef.current) {
          const position=positionRef.current,point=toDocument(event.clientX,event.clientY,false);
          positionRef.current=null;setPositioningActive(false);
          if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if(point) position.end(point);else position.cancel();return;
        }
        const click = clickRef.current;
        clickRef.current = null;
        if (textStart.current) {
          const start=textStart.current,end=toDocument(event.clientX,event.clientY);
          textStart.current=null;setBox(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (end && click?.moved && Math.abs(end.x-start.x)>0 && Math.abs(end.y-start.y)>0) {
            const box:[number,number,number,number]=[Math.min(start.x,end.x),Math.min(start.y,end.y),Math.abs(end.x-start.x),Math.abs(end.y-start.y)];
            onText?.({x:box[0],y:box[1],box});
          } else onText?.({x:start.x,y:start.y});
          return;
        }
        if (samplingRef.current) {
          samplingRef.current = false;
          const point = toDocument(event.clientX,event.clientY,false);
          if (point) onSampleColor?.(point);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          return;
        }
        if (moveRef.current) {
          const start = moveRef.current, end = toDocument(event.clientX,event.clientY);
          moveRef.current = null; selectionMove.current = null; setMoving(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (end && (click?.moved || (click && Math.hypot(event.clientX-click.x,event.clientY-click.y)>3))) onMoveEnd?.([1,0,0,1,end.x-start.x,end.y-start.y]);
          else onMoveCancel?.();
          return;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (selectionRef.current) {
          const selection = selectionRef.current, end = toDocument(event.clientX,event.clientY);
          if (end) selection.update(end,{shift:event.shiftKey,alt:event.altKey,space:selectionSpace.current});
          selectionRef.current = null; selectionSpace.current = false; setBox(null); setPath(null);
          if (click && !click.moved && Math.hypot(event.clientX-click.x,event.clientY-click.y)<=3) {
            const current = viewport();
            if (current) onSelectionClick?.({x:(event.clientX-current.left)/zoom,y:(event.clientY-current.top)/zoom},selection.mode);
          } else if (selection.kind === "marquee") {
            const rect = selection.rect();
            if (rect.width > 0 && rect.height > 0) onMarquee?.(rect,selection.mode);
          } else onLasso?.(selection.path(),selection.mode);
          return;
        }
        if (pathRef.current) {
          const path = pathRef.current;
          pathRef.current = null;
          const end = toDocument(event.clientX, event.clientY);
          // 抬笔的 0 压感不是最后一笔的压力，沿用最后一个实际采样值。
          const points = end && (end.x !== path.at(-1)?.x || end.y !== path.at(-1)?.y) ? [...path, { ...end, pressure: path.at(-1)?.pressure }] : path;
          setPath(null);
          if (points.length === 0) return;
          if (points.length > path.length) onStrokeMove?.(points.slice(path.length));
          onStroke?.(points);
          return;
        }
        setPan(null);
      }}
      onPointerLeave={() => {
        setSelectionHover(null);
        setCursor(null);
      }}
      onPointerCancel={(event) => { if (pointerRef.current === event.pointerId) cancelGesture(); }}
      onLostPointerCapture={(event) => { if (pointerRef.current === event.pointerId) cancelGesture(); }}
      role="presentation"
    >
      {renderBackground ? (
        <div className="photo-editor-canvas__background" aria-hidden="true">
          {renderBackground({ x: originX, y: originY }, actualScale)}
        </div>
      ) : null}
      {transformFrame && canInteract && onTransform ? <LayerTransformOverlay ref={transformRef} frame={transformFrame} origin={{ x: originX, y: originY }} zoom={zoom}
        matrix={transformMatrix} linked={transformLinked} reference={transformReference} onReferenceChange={onTransformReferenceChange} moveOnly={transformMoveOnly} onBegin={onTransformBegin} onPreview={onTransformPreview} onCancel={onTransformCancel}
        onApply={onTransform} onGestureChange={changeTransformGesture}
        onPointerPosition={(event) => { autoPointer.current = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey}; autoPan.update(); }} passive={tool === "move"} /> : null}
      {marquee ? (
        <div
          className="photo-editor-canvas__marquee"
          data-testid="marquee"
          style={{ borderRadius: tool !== "text" && ellipse ? "50%" : undefined, left: `${marquee.x}px`, top: `${marquee.y}px`, width: `${marquee.width}px`, height: `${marquee.height}px` }}
        />
      ) : null}
      {cursor && !sampling && !samplingRef.current && (tool === "brush" || tool === "eraser") ? (
        <div
          className="photo-editor-canvas__brush-cursor"
          style={{
            left: `${cursor.local.x}px`,
            top: `${cursor.local.y}px`,
            width: `${Math.max(2, (brushSize ?? 0) * actualScale)}px`,
            height: `${Math.max(2, (brushSize ?? 0) * actualScale)}px`
          }}
        />
      ) : null}
      {cursor ? (
        <span className="photo-editor-canvas__coords">{`${Math.round(cursor.doc.x)}, ${Math.round(cursor.doc.y)}`}</span>
      ) : null}
      {selectionPath && showSelectionEdges ? (
        <svg className="photo-editor-canvas__selection photo-editor-canvas__selection--committed" data-testid="selection-outline">
          <path d={selectionPath} /><path d={selectionPath} />
        </svg>
      ) : null}
      {lassoPath ? (
        <svg className="photo-editor-canvas__selection" data-testid="lasso-preview">
          <path d={lassoPath} /><path d={lassoPath} />
          <path className="photo-editor-canvas__lasso-close" d={`M${lassoPoints.at(-1)}L${lassoPoints[0]}`} />
        </svg>
      ) : null}
      {renderOverlay?.({x:originX,y:originY},zoom)}
      <div className="photo-editor-canvas__zoom" data-canvas-viewport-control="true" onPointerDown={(event) => event.stopPropagation()}>
        <IconButton size="sm" label="缩小" title={shortcutLabel("缩小（Mod+-）")} onClick={() => changeView("zoomOut")}><ZoomOutIcon size={16} /></IconButton>
        <span>{Math.round(actualScale * 100)}%</span>
        <IconButton size="sm" label="放大" title={shortcutLabel("放大（Mod++）")} onClick={() => changeView("zoomIn")}><ZoomInIcon size={16} /></IconButton>
        <Button
          size="sm" tone="ghost" title={shortcutLabel("适合窗口（Mod+0）")}
          onClick={() => changeView("fit")}
        >
          适合窗口
        </Button>
        <Button size="sm" tone="ghost" title={shortcutLabel("实际大小（Mod+1）")} onClick={() => changeView("actualSize")}>100%</Button>
      </div>
    </div>
  );
});
