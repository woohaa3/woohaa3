import { isFeatureGestureTool as isGestureTool, isFeatureStrokeTool as isStrokeTool, isFeaturePointTool as isPointTool, isFeatureVectorTool } from "./features/index.js";
import type { VectorPointer } from "./features/vectors/vector-tools.js";
import { DOCUMENT_COORDINATES } from "./features/coordinates.js";
/** 透明交互层：图片仍由原节点呈现，取景与聚焦动画共用工作区状态。 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { EditorViewAction } from "./photo-editor-shortcuts.js";
import { LayerTransformOverlay, type TransformGesturePort } from "./layer-transform-ui.js";
import { projectTransformPoint, type TransformFrame, type TransformPoint } from "./transform-layer.js";
import { SelectionAutoPan, type SelectionPanContext } from "./selection-autopan.js";
import type {StylePositionPort} from "./style-positioning.js";
import { SelectionGesture, selectionModeForKeys } from "./selection-gesture.js";
import type { SelectionSegment } from "./editor-view-model.js";
import type { EditorViewport } from "./viewport.js";
import {
  pointInSelection,
  type CanvasViewport,
  type DocumentPoint,
  type EditorToolId,
  type SelectionMode,
  type PixelRect
} from "./photo-editor-tools.js";

const screenToDocument = DOCUMENT_COORDINATES.viewToDocument;

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
  /** 钢笔节点（单击累积；双击闭合）。 */
  onPenPoint?: (point: [number, number], modifiers: { close: boolean; shift: boolean }) => void;
  /**
   * 矢量工具指针（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
   *
   * 画布只负责把客户坐标换算成**文档坐标**并转发，几何、命中与命令都在
   * `features/vectors/vector-tools.ts` 的归约器里。`samples` 只在拖动时给出（自由钢笔的
   * coalesced 采样），由归约器决定怎么用。返回 `true` 表示这次事件消费了指针，画布不再
   * 走平移/笔迹分支。
   */
  onVectorPointer?: (pointer: VectorPointer, samples?: readonly (readonly [number, number])[]) => void;
  onText?: (placement: {x:number;y:number;box?:[number,number,number,number]}) => void;
  /**
   * 修饰区域手势（U37：修补／内容识别移动／红眼）。
   *
   * 区域命令没有逐帧笔迹预览，共享画布只负责把「拖动起点/终点」或「单击点」交给调用方，
   * 不解释修饰语义（零偏移、64 处上限、红眼不是拖动都由域内模块判定）。
   */
  regionGestureKind?: "drag" | "click";
  onRegionGesture?: (from: DocumentPoint, to: DocumentPoint, moved: boolean) => void;
  renderOverlay?: (origin:{x:number;y:number},zoom:number) => ReactNode;
  /**
   * 参考线 / 标尺原点拖动（change: 2026-10-22-add-photocraft-view-workspace-workflows，U70）。
   *
   * 仲裁留在视图域：`onGuideDown` 命中参考线或标尺角落时返回 `true`，画布把这次按下交给
   * 它，后续 `move/up/cancel` 全部转发；返回 `false`（或没提供端口）时行为与之前完全一致。
   * 坐标是**客户坐标**，与 `viewPointer` 端口同一口径，画布不自己换算。
   */
  onGuideDown?: (client: [number, number]) => boolean;
  onGuideMove?: (client: [number, number]) => void;
  /** `cancelled` 为真表示指针被系统取消/失去捕获，调用方必须丢弃草稿而不提交。 */
  onGuideUp?: (client: [number, number], cancelled: boolean) => void;
  /** 拖动中的草稿（源像素），画布只负责画一条预览线，不写文档。 */
  guidePreview?: { vertical: boolean; position: number } | { origin: [number, number] } | null;
  /**
   * 视图/分析工具的**落点**手势（U73）：一次点击给出文档坐标。
   *
   * 返回 `true` 表示这次点击已被视图域消费（计数/注释落点），画布不再按当前工具处理。
   * 与参考线拖动同一套「先问视图域」的顺序，因此未传端口时行为完全不变。
   */
  onViewPoint?: (point: DocumentPoint, modifiers?: { close: boolean }) => boolean;
  onToolHover?: (point: DocumentPoint) => void;
  /**
   * Info 跟随光标的读数端口（U73）：给**客户坐标**，画布不换算。
   *
   * 换算（客户→源像素）与取色都在内核同一条路径上，画布只转发指针位置，因此读数不会与
   * 命中/落笔差半个像素。`null` 表示指针离开画布：读数必须清空，不能留上一次的值。
   */
  onProbe?: (client: [number, number] | null) => void;
  /**
   * 画布当前的真实取景（U72）：文档左上角在**客户坐标**里的位置 + 源像素缩放。
   *
   * 视图域用它把内核的视图变换对齐到眼前这块画布——参考线命中/拖动、Info 读数与标尺都经
   * 内核的同一份反算，若内核的 offset 不是画布真实位置，它们在缩放/平移后就会整体偏移。
   * 只在值真的变化时回调（含容器尺寸变化），不会每帧刷。
   */
  onFrame?: (origin: { x: number; y: number }, zoom: number) => void;
};

const MIN_ZOOM = 0.05;

/**
 * 指针事件的笔姿态采样（change: 2026-10-22-add-photocraft-painting-color-workflows，U31）。
 *
 * 只读浏览器已经给出的真实字段，不推测、不补零：
 * - `pointerType === "pen"` 时取 `pressure`、`tiltX`、`tiltY`、`twist`（旋转）；
 * - 鼠标/触摸没有这些传感器，返回 `{}`，下游保持短编码（`[x, y]`），不会被当成「垂直笔」。
 *
 * 为什么不顺手写 `timeStamp`：内核点编码的时间槽在旋转之后，写它就必然先占满
 * 倾斜/旋转三个槽位——没有倾斜传感器的笔会被记成「读到 0 度姿态」，正是本域明令禁止的
 * 「补 0 占位」。时间轴动态（`fade`）由内核对点位序列自身处理，编码器仍支持调用方显式传
 * `time`。
 *
 * 真实数位笔的倾斜/旋转**硬件证据**需要人工用设备采集（见 tasks 4.2）；这里的接线只保证
 * 「有传感器时字段真的到达内核」，不伪造任何读数。
 */
type PointerPose = { pressure?: number; tiltX?: number; tiltY?: number; rotation?: number; wheel?: number };

function pointerPose(event: { pointerType?: string; pressure?: number; tiltX?: number; tiltY?: number; twist?: number }): PointerPose {
  const pose: PointerPose = {};
  if (event.pointerType === "pen") {
    if (Number.isFinite(event.pressure)) pose.pressure = event.pressure;
    // `tiltX`/`tiltY` 是角度（−90–90）；`twist` 是笔杆旋转（0–360）。
    if (Number.isFinite(event.tiltX)) pose.tiltX = event.tiltX;
    if (Number.isFinite(event.tiltY)) pose.tiltY = event.tiltY;
    if (Number.isFinite(event.twist)) pose.rotation = event.twist;
  }
  return pose;
}

/** 容器内像素矩形。 */
type LocalRect = { x: number; y: number; width: number; height: number };

/** 需要画布手势的工具。 */


/** 笔迹类工具（画笔／橡皮／修饰）共用采样点与压力处理。 */


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
  brushSize, onText, renderOverlay, positioning, renderBackground, onPenPoint, regionGestureKind, onRegionGesture, onVectorPointer,
  onGuideDown, onGuideMove, onGuideUp, guidePreview, onViewPoint, onToolHover, onProbe, onFrame
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
  /** 参考线/原点拖动中（由视图域接管，画布只转发指针）。 */
  const guideRef = useRef(false);
  const [guideActive, setGuideActive] = useState(false);
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
  /** 修饰区域手势的起点（拖动的 from；红眼单击不保留）。 */
  const regionStart = useRef<DocumentPoint | null>(null);
  const pathRef = useRef<DocumentPoint[] | null>(null);
  const samplingRef = useRef(false);
  /** 矢量工具（拖绘/钢笔/锚点编辑）是否正被本画布持有。 */
  const vectorRef = useRef(false);
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
    if (guideRef.current) {
      guideRef.current = false;
      setGuideActive(false);
      // 取消不提交：视图域据此丢弃草稿，不写文档、不造历史。
      onGuideUp?.([0, 0], true);
    }
    const transforming = transformRef.current?.cancelGesture() ?? false;
    const active = pointerRef.current !== null || transforming;
    const pointer = pointerRef.current;
    pointerRef.current = null;
    // 矢量手势由域内归约器持有草稿/预览：取消时先让它自己丢弃，避免叠加层残留。
    if (vectorRef.current) { vectorRef.current = false; onVectorPointer?.({ type: "cancel", point: [0, 0] }); }
    const position=positionRef.current;positionRef.current=null;setPositioningActive(false);position?.cancel();
    if (moveRef.current) { moveRef.current = null; setMoving(false); onMoveCancel?.(); }
    selectionMove.current = null; setSelectionHover(null);
    clickRef.current = null;
    textStart.current = null;
    regionStart.current = null;
    pathRef.current = null;
    samplingRef.current = false;
    selectionRef.current = null;
    selectionSpace.current = false;
    if (pointer !== null && isStrokeTool(gestureTool.current)) onStrokeCancel?.();
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
  // 取景上报：内核的视图变换用「文档左上角在客户坐标里」的位置，缩放到实际的舞台几何后
  // 再交给它，参考线命中/拖动、Info 读数与标尺才不会在缩放/平移后整体偏移。值未变不回调。
  const frameKey = useRef<string | null>(null);
  useEffect(() => {
    if (!onFrame || documentWidth <= 0 || documentHeight <= 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = rect.left + originX;
    const y = rect.top + originY;
    const key = `${x}:${y}:${actualScale}`;
    if (frameKey.current === key) return;
    frameKey.current = key;
    onFrame({ x, y }, actualScale);
  }, [onFrame, originX, originY, actualScale, documentWidth, documentHeight]);
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
      style={{cursor: tool === "pan" ? (pan ? "grabbing" : "grab") : tool === "zoom" ? "zoom-in" : tool === "crop" || tool === "polygon-lasso" || tool === "magnetic-lasso" ? "crosshair" : tool==="none" && positioning ? positioningActive?"grabbing":"move" : (sampling || samplingRef.current) && (tool === "brush" || tool === "eraser") ? "crosshair" : selectionMove.current === "pixels" ? "grabbing" : selectionMove.current === "boundary" || selectionHover === "boundary" ? "move" : selectionHover === "pixels" ? "grab" : undefined}}
      data-canvas-viewport="true"
      data-canvas-viewport-blocked={!canInteract || !!(box || path || pan || transforming || moving || positioningActive) ? "true" : undefined}
      onDoubleClick={event => {
        if (canInteract && (tool === "polygon-lasso" || tool === "magnetic-lasso")) {
          const point = toDocument(event.clientX,event.clientY,false);
          if (point) onViewPoint?.(point,{close:true});
        }
      }}
      onPointerDown={(event) => {
        if (!canInteract || event.button !== 0 || pointerRef.current !== null) return;
        // 一次性落点（计数/注释）：用户明确要求「点画布放一个」，因此优先于当前工具。
        // 没有请求时 `onViewPoint` 返回 `false`，行为与之前完全一致。
        if (onViewPoint) {
          const point = toDocument(event.clientX, event.clientY, false);
          if (point && onViewPoint(point, { close: event.detail >= 2 })) return;
        }
        if (tool === "zoom") {
          const local = toLocal(event.clientX, event.clientY);
          const nextZoom = Math.max(MIN_ZOOM, Math.min(32, zoom * (event.altKey ? 1 / 1.5 : 1.5)));
          const ratio = nextZoom / zoom;
          const center = {x: (containerRef.current?.clientWidth ?? 0) / 2,y: (containerRef.current?.clientHeight ?? 0) / 2};
          view.onChange({zoom:nextZoom,x:local.x-center.x-(local.x-center.x-offset.x)*ratio,y:local.y-center.y-(local.y-center.y-offset.y)*ratio});
          return;
        }
        // 视图域先决定要不要接管这次按下（命中参考线/标尺角落）；不接管就走原来的工具仲裁。
        if (onGuideDown?.([event.clientX, event.clientY])) {
          guideRef.current = true;
          setGuideActive(true);
          pointerRef.current = event.pointerId;
          clickRef.current = { x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (tool === "none" && !positioning) return;
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
        // 矢量工具：几何/命中/命令全在 `features/vectors/vector-tools.ts`，画布只换算坐标并转发。
        if (onVectorPointer && isFeatureVectorTool(tool)) {
          const point = toDocument(event.clientX, event.clientY, false);
          if (!point) return;
          pointerRef.current = event.pointerId;
          vectorRef.current = true;
          gestureTool.current = tool;
          event.currentTarget.setPointerCapture(event.pointerId);
          onVectorPointer({
            type: "down",
            point: [point.x, point.y],
            shift: event.shiftKey,
            alt: event.altKey,
            doubleClick: event.detail >= 2
          });
          return;
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
        // 采样：画笔/橡皮的 Alt 临时取色，以及本域独立的吸管工具（`gesture: "sample"`）。
        // 吸管工具没有 Alt 也要采样；拖动中持续取色，抬笔只回一次写回（写回在调用方去重）。
        if ((isStrokeTool(tool) || tool === "eyedropper") && (sampling || event.altKey || tool === "eyedropper") && onSampleColor) {
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
          if (tool === "marquee" || tool === "lasso" || tool === "crop") {
            selectionSpace.current = false;
            selectionRef.current = new SelectionGesture(tool === "crop" ? "marquee" : tool,point,{width:documentWidth,height:documentHeight},selectionMode,
              {shift:event.shiftKey,alt:event.altKey,space:false});
            showSelection(); autoPan.update();
          } else if (tool === "pen") {
            // 钢笔：单击累积节点，几何与闭合由调用方（内核路径草稿）决定。
            onPenPoint?.([point.x, point.y], { close: event.detail >= 2, shift: event.shiftKey });
            return;
          } else if (isPointTool(tool)) {
            // 单击类工具（油漆桶/魔术橡皮）：一次点按一个事务，不产生拖动预览。
            onStroke?.([point]);
            return;
          } else if (onRegionGesture) {
            // 修饰区域命令（修补／内容识别移动／红眼）：记录起点，抬笔时交给域内判定。
            // 不走笔迹预览——区域命令没有逐帧预览，候选确认才是唯一写入口。
            regionStart.current = point;
            if (regionGestureKind === "click") {
              // 红眼是单击：按下即标记，不需要拖动距离。
              onRegionGesture(point, point, false);
              regionStart.current = null;
              return;
            }
          } else {
            const first = { ...point, ...pointerPose(event.nativeEvent) };
            pathRef.current = [first];
            setPath(pathRef.current);
            onStrokeStart?.(first,{shift:event.shiftKey});
          }
          return;
        }
        setPan({ x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y });
      }}
      onPointerMove={(event) => {
        if (canInteract && onToolHover) {
          const hoverPoint = toDocument(event.clientX,event.clientY,false);
          if (hoverPoint) onToolHover(hoverPoint);
        }
        if (pointerRef.current !== null && pointerRef.current !== event.pointerId) return;
        if (guideRef.current) { onGuideMove?.([event.clientX, event.clientY]); return; }
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
        // 只转发位置：换算与取色都在内核，画布不复制第二套坐标数学。
        onProbe?.([event.clientX, event.clientY]);
        if (samplingRef.current) { if (point) onSampleColor?.(point); return; }
        if (textStart.current && point) {
          const start=textStart.current;
          setBox({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.abs(start.x-point.x),height:Math.abs(start.y-point.y)});
          return;
        }
        const hitPoint = toDocument(event.clientX,event.clientY,false);
        // 矢量手势：拖动只更新叠加层（松手才由归约器出命令），因此这里不写文档。
        if (vectorRef.current && point && onVectorPointer) {
          const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
          const collected = (samples.length ? samples : []).flatMap((sample) => {
            const at = toDocument(sample.clientX, sample.clientY, false);
            return at ? [[at.x, at.y] as const] : [];
          });
          onVectorPointer(
            { type: "move", point: [point.x, point.y], shift: event.shiftKey, alt: event.altKey, moved: click?.moved },
            collected
          );
          return;
        }
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
          // 每个 coalesced 采样各自带真实的压力/倾斜/旋转；合并事件共享同一指针身份，
          // 因此采样缺 `pointerType` 时沿用外层事件（不会把笔当成鼠标而丢掉压力）。
          const points = (samples.length ? samples : [event.nativeEvent]).flatMap((sample) => {
            const point = toDocument(sample.clientX, sample.clientY);
            return point ? [{ ...point, ...pointerPose({ ...sample, pointerType: sample.pointerType ?? event.pointerType }) }] : [];
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
        if (vectorRef.current) {
          vectorRef.current = false;
          const point = toDocument(event.clientX, event.clientY, false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (point && onVectorPointer) onVectorPointer({
            type: "up",
            point: [point.x, point.y],
            shift: event.shiftKey,
            alt: event.altKey,
            doubleClick: event.detail >= 2,
            moved: clickRef.current?.moved
          });
          clickRef.current = null;
          return;
        }
        if (guideRef.current) {
          guideRef.current = false;
          setGuideActive(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          onGuideUp?.([event.clientX, event.clientY], false);
          return;
        }
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
            if (current && tool !== "crop") onSelectionClick?.({x:(event.clientX-current.left)/zoom,y:(event.clientY-current.top)/zoom},selection.mode);
          } else if (selection.kind === "marquee") {
            const rect = selection.rect();
            if (rect.width > 0 && rect.height > 0) onMarquee?.(rect,selection.mode);
          } else onLasso?.(selection.path(),selection.mode);
          return;
        }
        if (regionStart.current) {
          const from = regionStart.current;
          regionStart.current = null;
          const to = toDocument(event.clientX, event.clientY) ?? from;
          const moved = !!click?.moved || Math.hypot(to.x - from.x, to.y - from.y) > 0;
          onRegionGesture?.(from, to, moved);
          return;
        }
        if (pathRef.current) {
          const path = pathRef.current;
          pathRef.current = null;
          const end = toDocument(event.clientX, event.clientY);
          // 抬笔的 0 压感/0 倾斜不是最后一笔的真实姿态，沿用最后一个实际采样值；
          // 没有姿态的笔（鼠标）不补 `undefined` 键，保持短编码。
          const last = path.at(-1);
          const pose: Record<string, number> = {};
          for (const key of ["pressure", "tiltX", "tiltY", "rotation", "wheel"] as const) {
            const value = last?.[key];
            if (typeof value === "number") pose[key] = value;
          }
          const points = end && (end.x !== last?.x || end.y !== last?.y) ? [...path, { ...end, ...pose }] : path;
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
        // 离开画布就没有「光标下的像素」：清空读数，不让面板继续显示旧值。
        onProbe?.(null);
      }}
      onPointerCancel={(event) => { if (pointerRef.current === event.pointerId) cancelGesture(); }}
      onLostPointerCapture={(event) => { if (pointerRef.current === event.pointerId) cancelGesture(); }}
      data-view-guide-drag={guideActive ? "true" : undefined}
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
          style={{ borderRadius: tool === "marquee" && ellipse ? "50%" : undefined, left: `${marquee.x}px`, top: `${marquee.y}px`, width: `${marquee.width}px`, height: `${marquee.height}px` }}
        />
      ) : null}
      {cursor && !sampling && !samplingRef.current && (["brush","eraser","pencil","colorReplacement","backgroundEraser","clone","heal","retouch","quick"].includes(tool)) ? (
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
      {/* 参考线拖动预览：只画一条临时线，文档与叠加层数据都不动，松手才提交。 */}
      {guidePreview && "position" in guidePreview ? (
        <div
          className="photo-editor-canvas__guide-preview"
          data-guide-preview={guidePreview.vertical ? "vertical" : "horizontal"}
          style={guidePreview.vertical
            ? { left: `${originX + guidePreview.position * actualScale}px`, top: 0, width: 0, height: "100%" }
            : { left: 0, top: `${originY + guidePreview.position * actualScale}px`, width: "100%", height: 0 }}
        />
      ) : null}
      {renderOverlay?.({x:originX,y:originY},zoom)}
    </div>
  );
});
