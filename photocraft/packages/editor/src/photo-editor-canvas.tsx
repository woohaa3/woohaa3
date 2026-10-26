import {formatMeasurement,type MeasurementUnit,type PointPicaSize} from "./measurement-unit.js";
import {navigatorViewport,type NavigatorFrame,type NavigatorAction} from "./navigator-geometry.js";
import {PixelGridOverlay,type PixelGridPort} from "./pixel-grid-overlay.js";
import {useStickyModifiers,withStickyModifiers} from "./modifier-keys.js";
import {TouchNavigation} from "./touch-navigation.js";
import {ViewportScrollbars,type ViewportScrollbarHandle} from "./viewport-scrollbar.js";
import {clampViewport} from "./viewport-bounds.js";
import {WheelNavigation} from "./wheel-navigation.js";
import {pasteboardStyle,canvasBorderStyle,type Pasteboard} from "./pasteboard.js";
import {EraserIcon,PencilIcon,PenIcon} from "./ui/icons.js";
import {DEFAULT_CURSORS,brushCursor,type CursorPreferences} from "./brush-cursor.js";
import {navigateViewport,type ViewportNavigation} from "./viewport-navigation.js";
import {ZoomToolGesture,type ZoomGestureContext,type ZoomRectangle} from "./zoom-gesture.js";
import {DEFAULT_TRANSPARENCY_GRID,transparencyGridStyle,type TransparencyGrid} from "./transparency-grid.js";
const clampPenPressure=(pressure:number)=>Math.max(0,Math.min(1,pressure));
/** Pointer timestamps share requestAnimationFrame's time origin. Keep pen orientation in native degrees. */
const strokeSample=(point:DocumentPoint,event:{pointerType?:string;pressure:number;tiltX?:number;tiltY?:number;twist?:number;timeStamp:number}):DocumentPoint=>({...point,time:event.timeStamp,...(event.pointerType==="pen"?{pressure:event.pressure,tiltX:event.tiltX??0,tiltY:event.tiltY??0,rotation:event.twist??0}:{})});
import {clampEditorZoom,stepEditorZoom} from "./zoom-levels.js";
import {FlickPan,interpolateViewport,zoomAt} from "./viewport-motion.js";
import {resizeBrush,type BrushResizeValues} from "./brush-resize.js";
import {isEditorMac} from "./photo-editor-shortcuts.js";
import {StrokeConstraint} from "./stroke-constraint.js";
import {measureBoxes,measureLabels,shouldMeasure} from "./move-distance.js";
import {isRetouchTool} from "./retouch-tools.js";
import {decodeGuides,gridLines,guideAt,guideList,rulerTicks,snapPoint,type GuidePreferences} from "./guides.js";
/** 透明交互层：图片仍由原节点呈现，取景与聚焦动画共用工作区状态。 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useId, useRef, useState, type ReactNode } from "react";
import { Button, IconButton } from "./ui/Button.js";
import { ZoomInIcon, ZoomOutIcon, CopyIcon, CutIcon, PlusIcon, MinusIcon, CloseIcon, PointerIcon } from "./ui/icons.js";
import { shortcutLabel, type EditorViewAction } from "./photo-editor-shortcuts.js";
import { LayerTransformOverlay, type TransformGesturePort } from "./layer-transform-ui.js";
import { projectTransformPoint, type TransformFrame, type TransformPoint } from "./transform-layer.js";
import { SelectionAutoPan, type SelectionPanContext } from "./selection-autopan.js";
import type {StylePositionPort} from "./style-positioning.js";
import { SelectionGesture, selectionModeForKeys, type MarqueeConstraint } from "./selection-gesture.js";
import type { SelectionSegment } from "./editor-view-model.js";
import type { EditorViewport } from "./viewport.js";
import {
  screenToDocument,
  constrainMoveOffset,
  pointInSelection,
  type CanvasViewport,
  type DocumentPoint,
  type EditorToolId,
  type SelectionMode,
  type PixelRect
} from "./photo-editor-tools.js";

export type PhotoCanvasHandle = {
  navigationFrame?:()=>NavigatorFrame;
  navigator?:(action:NavigatorAction)=>void;
  navigate?:(navigation:ViewportNavigation)=>void;
  zoomTo:(zoom:number)=>void;
  view: (action: EditorViewAction,bounds?:[number,number,number,number]|null) => void;
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
  measurementUnit?:MeasurementUnit;pointPicaSize?:PointPicaSize;
  resolutionDpi?:number;
  screenResolution?:number;
  selectedBounds?:[number,number,number,number]|null;
  /** 是否接收视图和工具手势（过渡期间自动暂停）。 */
  interactive?: boolean;
  /**
   * 合成预览背景（change: 2026-10-21-extract-photocraft-subproject）。
   *
   * 编辑器画布是透明交互层：Woohaa 让 Bevy 节点在下方呈现像素，独立 dev 宿主则用
   * Canvas 画同一份 RGBA 预览。`origin` 是文档左上角在画布容器内的 CSS 像素，
   * `zoom` 是源像素到 CSS 像素的比例。
   */
  onNavigatorFrame?:(frame:NavigatorFrame)=>void;
  pixelGrid?:PixelGridPort;
  onPointerPosition?:(point:DocumentPoint|null)=>void;
  enableGestures?:boolean;
  showScrollbars?:boolean;
  overscroll?:boolean;
  zoomWithScrollWheel?:boolean;
  zoomWithTrackpadPinch?:boolean;
  pasteboard?:Pasteboard;
  renderBackground?: (origin: { x: number; y: number }, zoom: number) => ReactNode;
  /** 当前手势；none 不接收拖动，pan 仅用于按住空格时临时拖动。 */
  tool?: EditorToolId;
  /** 内核保存的选区边界；不依赖当前工具和上次拖动。 */
  selectionOutline?: SelectionSegment[];
  /** 只隐藏已提交边界；命中、移动和选区内容保持不变。 */
  showSelectionEdges?:boolean;
  ellipse?: boolean;
  marqueeLine?:"row"|"column";
  showTransformationValues?:boolean;
  cursors?:CursorPreferences;brushHardness?:number;
  zoomScrubby?:boolean;
  animatedZoom?:boolean;
  zoomClickedPointToCenter?:boolean;
  enableFlickPanning?:boolean;
  hasSelection?:boolean;
  selectionContains?:(point:DocumentPoint)=>boolean;
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
  onMoveHover?:(point:DocumentPoint,modifiers:{toggleAuto:boolean})=>{layer:number;frame:[number,number,number,number]}|null;
  moveHoverKey?:string;
  /** 标尺/参考线/网格（I096）：只影响显示与吸附，是文档视图状态。 */
  guides?:{horizontal?:unknown[];vertical?:unknown[];colors?:unknown[]};
  guidePreferences?:GuidePreferences;
  onGuidesChange?:(action:{kind:"create";orientation:"horizontal"|"vertical";position:number}|{kind:"move";orientation:"horizontal"|"vertical";index:number;position:number}|{kind:"delete";orientation:"horizontal"|"vertical";index:number})=>void;
  onRulerOrigin?:(origin:[number,number])=>void;
  /** Move 智能参考线距离测量（I021）：仅在 Move + Extras 时启用。 */
  measureMoveDistance?:boolean;
  /** 返回指针下方的目标框；`null` 表示悬停空白（量到画布边缘），`undefined` 表示不测量。 */
  onMoveMeasure?:(point:DocumentPoint)=>readonly [number,number,number,number]|null|undefined;
  transparency?:TransparencyGrid;
  onMovePick?: (point: DocumentPoint, modifiers: { duplicate: boolean; toggleAuto: boolean; add:boolean; wholeLayer?:boolean; selectedPixels?:boolean }) => boolean | "box";
  onMoveBoxEnd?: (start:DocumentPoint,end:DocumentPoint,add:boolean,dragged:boolean) => void;
  onMoveStart?: (point: DocumentPoint, modifiers: { duplicate: boolean; toggleAuto: boolean; add:boolean; wholeLayer?:boolean; selectedPixels?:boolean }) => boolean;
  moveBoundingBox?:boolean;
  onMovePreview?: (matrix: number[]) => void;
  onMoveEnd?: (matrix: number[]) => void;
  onMoveCancel?: () => void;
  /** 选框手势结束（已换算为文档坐标矩形）。 */
  marqueeConstraint?:MarqueeConstraint;
  onMarquee?: (rect: PixelRect, mode?: SelectionMode) => void;
  /** 套索手势结束（文档坐标点位）。 */
  onLasso?: (points: DocumentPoint[], mode?: SelectionMode) => void;
  /** 选区工具的单击；与拖动创建选区分开处理。 */
  onSelectionClick?: (point: DocumentPoint, mode?: SelectionMode) => void;
  /** 魔棒单击：只读取样后由调用者构造 `select.magicWand` 参数。 */
  onMagicWand?: (point: DocumentPoint, mode: SelectionMode) => void;
  /** 画笔/橡皮手势结束（文档坐标点位）。 */
  onStroke?: (points: DocumentPoint[]) => void;
  onStrokeTap?:(point:DocumentPoint)=>void;
  /** `alt`/`mod` 只在按住时出现，保持既有 `{shift}` 调用形状不变。 */
  onStrokeStart?: (point: DocumentPoint, modifiers?: {shift:boolean;alt?:boolean;mod?:boolean}) => boolean | void;
  sampling?: boolean;
  onSampleColor?: (point: DocumentPoint,modifiers?:{background:boolean}) => void;
  samplingColors?:{foreground:string;background:string;current:string|null};
  onStrokeMove?: (points: DocumentPoint[]) => void;
  onStrokeCancel?: () => void;
  /** 画笔笔头尺寸（源像素），用于显示光标圈。 */
  brushSize?: number;
  eraserMode?: "brush"|"pencil"|"block";
  brushResize?:{values:BrushResizeValues;hardness:boolean;commit:(values:BrushResizeValues)=>void};
  strokeAnchor?:DocumentPoint|null;
  onBucket?:(point:DocumentPoint)=>void;
  onTextEdit?:(point:DocumentPoint)=>void;
  onText?: (placement: {x:number;y:number;box?:[number,number,number,number];forceNew?:boolean}) => void;
  renderOverlay?: (origin:{x:number;y:number},zoom:number) => ReactNode;
};



/** 标尺带宽度（屏幕像素）：从顶部/左侧这条带拖出参考线（I096）。 */
const RULER_BAND=24;

/** 容器内像素矩形。 */
type LocalRect = { x: number; y: number; width: number; height: number };

/** 需要画布手势的工具。 */
function isGestureTool(tool: EditorToolId): boolean {
  return tool === "marquee" || tool === "lasso" || isPaintTool(tool);
}

/**
 * 画笔类工具：绘制手势、笔头光标与修饰键反馈共用同一判定。
 * 包含画笔/铅笔/橡皮与全部绘画、润饰工具（`retouch-tools.ts` 的参数编译范围）。
 */
function isPaintTool(tool: EditorToolId): boolean {
  return tool === "brush" || tool === "pencil" || tool === "eraser" || isRetouchTool(tool);
}

/**
 * 在原节点图片上叠加工具手势，使用工作区取景。
 *
 * 视图操作只提交取景，不重取编辑预览。
 */
export const PhotoCanvas = forwardRef<PhotoCanvasHandle, PhotoCanvasProps>(function PhotoCanvas({
  view,
  documentWidth,
  documentHeight,measurementUnit="pixels",pointPicaSize=72,transparency=DEFAULT_TRANSPARENCY_GRID,resolutionDpi=72,screenResolution=72,selectedBounds,
  interactive = true,
  tool = "none",
  selectionOutline = [],
  showSelectionEdges = true,
  ellipse = false,
  marqueeLine,
  selectionContains,
  hasSelection = selectionOutline.length>0,
  showTransformationValues=true,
  cursors=DEFAULT_CURSORS,brushHardness=1,zoomScrubby=true,animatedZoom=false,zoomClickedPointToCenter=false,enableFlickPanning=false,
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
  onMovePick,onMoveHover,moveHoverKey,onMoveBoxEnd, onMoveStart, onMovePreview, moveBoundingBox, onMoveEnd, onMoveCancel,
  measureMoveDistance,onMoveMeasure,guides,guidePreferences,onGuidesChange,onRulerOrigin,
  onMarquee, marqueeConstraint,
  onLasso,
  onSelectionClick,
  onMagicWand,
  onStroke,
  onStrokeStart,onStrokeTap,
  onStrokeMove,
  onStrokeCancel,
  sampling = false, samplingColors, onSampleColor,
  brushSize, eraserMode, brushResize, strokeAnchor, onText, onTextEdit,onBucket, renderOverlay, positioning, renderBackground,pasteboard,pixelGrid,onNavigatorFrame,onPointerPosition,enableGestures=true,showScrollbars=true,overscroll=true,zoomWithScrollWheel=false,zoomWithTrackpadPinch=true
}, ref) {
  const sticky=useStickyModifiers();
  const [zoomBox,setZoomBox]=useState<ZoomRectangle|null>(null);
  const [zooming,setZooming]=useState(false);
  const scrollbarRef=useRef<ViewportScrollbarHandle>(null);
  const [scrolling,setScrolling]=useState(false);
  const touches=useRef(new TouchNavigation());
  const [pinching,setPinching]=useState(false);
  const bucketTouch=useRef(false);
  const zoomContext=useRef<ZoomGestureContext>(null!);
  const [zoomGesture]=useState(()=>new ZoomToolGesture(()=>zoomContext.current,setZoomBox));
  const positionRef=useRef<StylePositionPort|null>(null);
  const [positioningActive,setPositioningActive]=useState(false);
  const autoPointer = useRef<{clientX:number;clientY:number;shiftKey:boolean;altKey:boolean} | null>(null);
  const autoContext = useRef<{read:()=>SelectionPanContext|null;pan:(step:{x:number;y:number})=>void} | null>(null);
  const [autoPan] = useState(() => new SelectionAutoPan(() => autoContext.current?.read() ?? null,(step) => autoContext.current?.pan(step)));
  const transformRef = useRef<TransformGesturePort>(null);
  const moveArrowId=useId();
  const selectionMove = useRef<"boundary" | "pixels" | null>(null);
  const [feedbackKeys,setFeedbackKeys]=useState({shift:false,alt:false,mod:false});
  const feedbackPoint=useRef<DocumentPoint|null>(null);
  const [selectionHover, setSelectionHover] = useState<"boundary" | "pixels" | null>(null);
  const layerBox=useRef<{start:DocumentPoint;add:boolean}|null>(null);
  const moveRef = useRef<DocumentPoint | null>(null);
  const pendingMove=useRef<{point:DocumentPoint;modifiers:{duplicate:boolean;toggleAuto:boolean;add:boolean;wholeLayer?:boolean;selectedPixels?:boolean}}|null>(null);
  const startPendingMove=()=>{
    const pending=pendingMove.current;if(!pending) return true;
    pendingMove.current=null;
    return onMoveStart?.(pending.point,pending.modifiers)??false;
  };
  const moveOffset=useRef<DocumentPoint|null>(null);
  const [moving, setMoving] = useState(false);
  /** 本次拖动是否为 Alt/Option 复制：复制拖动期间量原件与副本间距。 */
  const moveDuplicate=useRef(false);
  const pointerRef = useRef<number | null>(null);
  const clickRef = useRef<{ x: number; y: number; moved: boolean; threshold:number } | null>(null);
  const gestureTool = useRef<EditorToolId>("pan");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { zoom, x: offsetX, y: offsetY } = view.viewport;
  const offset = { x: offsetX, y: offsetY };
  const [pan, setPan] = useState<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const selectionSpace = useRef(false);
  const selectionRef = useRef<SelectionGesture | null>(null);
  const [box, setBox] = useState<PixelRect | null>(null);
  /** 路径手势（套索/画笔）：文档坐标点位。 */
  const forceNewText=useRef(false);
  const textStart = useRef<DocumentPoint | null>(null);
  const pathRef = useRef<DocumentPoint[] | null>(null);
  const [moveHover,setMoveHover]=useState<{layer:number;frame:[number,number,number,number]}|null>(null);
  /** 参考线命中/拖动与标尺拖动（I096）。 */
  const [guideHit,setGuideHit]=useState<{orientation:"horizontal"|"vertical";index:number;position:number}|null>(null);
  const guideDrag=useRef<{orientation:"horizontal"|"vertical";index:number;position:number;pointer:number}|null>(null);
  const rulerDrag=useRef<{orientation:"horizontal"|"vertical";pointer:number}|null>(null);
  const [guideDraft,setGuideDraft]=useState<{orientation:"horizontal"|"vertical";position:number}|null>(null);
  /** Cmd/Ctrl 悬停测距的目标框；`null` 表示量到画布边缘。 */
  const [measureTarget,setMeasureTarget]=useState<readonly [number,number,number,number]|null|undefined>(undefined);
  const penTap=useRef<{x:number;y:number;pressure:number;moved:boolean}|null>(null);
  const strokeConstraint=useRef<StrokeConstraint|null>(null);
  const resizeRef=useRef<{x:number;y:number;local:{x:number;y:number};base:BrushResizeValues;values:BrushResizeValues;hardness:boolean;commit:(values:BrushResizeValues)=>void}|null>(null);
  const [resizeValues,setResizeValues]=useState<BrushResizeValues|null>(null);
  const suppressContext=useRef(false);
  const samplingRef = useRef(false);
  const [path, setPath] = useState<DocumentPoint[] | null>(null);
  /** 指针在容器内的位置（画笔光标与坐标读数）。 */
  const [sampleBase,setSampleBase]=useState<string|null>(null);
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
      return current ? screenToDocument(clientX, clientY, current, clamp && !selectionRef.current && !isPaintTool(tool) && tool !== "move" && !moveRef.current) : null;
    },
    [viewport, tool]
  );

  const [transforming, setTransforming] = useState(false);
  const changeTransformGesture = useCallback((active: boolean) => {
    setTransforming(active);
    if (!active) { autoPan.stop(); autoPointer.current = null; }
  }, [autoPan]);
  const infoPointer=useRef<{x:number;y:number}|null>(null);
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
  useEffect(()=>{const pointer=infoPointer.current;if(onPointerPosition)onPointerPosition(pointer && !view.transitioning?toDocument(pointer.x,pointer.y,false):null);},[onPointerPosition,toDocument,view.transitioning,stageSize.width,stageSize.height]);
  useEffect(()=>{if(!onPointerPosition)return;const clear=()=>{infoPointer.current=null;onPointerPosition(null);};window.addEventListener("blur",clear);return()=>{window.removeEventListener("blur",clear);};},[onPointerPosition]);
  useEffect(()=>{onNavigatorFrame?.({viewport:view.viewport,size:stageSize,document:{width:documentWidth,height:documentHeight}});},[onNavigatorFrame,view.viewport.x,view.viewport.y,view.viewport.zoom,stageSize.width,stageSize.height,documentWidth,documentHeight]);
  const actualScale = zoom;
  const canInteract = interactive && !view.transitioning;
  useEffect(()=>{setMoveHover(null);setMeasureTarget(undefined);},[tool,moveHoverKey,measureMoveDistance,canInteract,view.viewport.x,view.viewport.y,view.viewport.zoom]);
  const motion=useRef<{frame:number|null;generation:number;flick:FlickPan}>({frame:null,generation:0,flick:new FlickPan()});
  const currentView=useRef(view);currentView.current=view;
  const stopMotion=()=>{const m=motion.current;m.generation++;if(m.frame!==null)cancelAnimationFrame(m.frame);m.frame=null;m.flick.stop();};
  const navigationBounds=useRef({overscroll,stageSize,documentWidth,documentHeight});navigationBounds.current={overscroll,stageSize,documentWidth,documentHeight};
  const publishView=(candidate:EditorViewport)=>{const current=currentView.current,bounds=navigationBounds.current,next=clampViewport(candidate,bounds.stageSize,{width:bounds.documentWidth,height:bounds.documentHeight},bounds.overscroll);currentView.current={...current,viewport:next};current.onChange(next);};
  useEffect(()=>{if(!canInteract)return;const next=clampViewport(currentView.current.viewport,stageSize,{width:documentWidth,height:documentHeight},overscroll),current=currentView.current.viewport;if(next.x!==current.x||next.y!==current.y)publishView(next);},[canInteract,overscroll,stageSize.width,stageSize.height,documentWidth,documentHeight]);
  zoomContext.current={view:currentView.current.viewport,width:stageSize.width,height:stageSize.height,documentWidth,documentHeight,scrubby:zoomScrubby,center:zoomClickedPointToCenter,publish:publishView,animate:next=>animateView(next)};
  useEffect(()=>()=>zoomGesture.cancel(),[zoomGesture]);
  const animateView=(next:EditorViewport)=>{
    stopMotion();if(!animatedZoom){publishView(next);return;}
    const m=motion.current,generation=m.generation,from={...currentView.current.viewport},start=performance.now();
    const frame=(now:number)=>{if(generation!==m.generation)return;publishView(interpolateViewport(from,next,now-start));if(now-start<220)m.frame=requestAnimationFrame(frame);else m.frame=null;};
    m.frame=requestAnimationFrame(frame);
  };
  const releasePan=(at:number)=>{
    const m=motion.current;if(!m.flick.release(at,enableFlickPanning))return;
    const generation=m.generation;let last=performance.now();
    const frame=(now:number)=>{if(generation!==m.generation)return;const delta=m.flick.step(now-last);last=now;
      if(delta){const v=currentView.current.viewport;publishView({...v,x:v.x+delta.x,y:v.y+delta.y});}
      if(m.flick.active)m.frame=requestAnimationFrame(frame);else m.frame=null;
    };m.frame=requestAnimationFrame(frame);
  };
  useEffect(()=>{const stop=()=>stopMotion();window.addEventListener("keydown",stop,true);window.addEventListener("pointerdown",stop,true);const clear=()=>{stop();if(zoomGesture.active || touches.current.contacts)cancelRef.current();setMoveHover(null);setMeasureTarget(undefined);feedbackPoint.current=null;};window.addEventListener("blur",clear);document.addEventListener("visibilitychange",clear);return()=>{stop();window.removeEventListener("keydown",stop,true);window.removeEventListener("pointerdown",stop,true);window.removeEventListener("blur",clear);document.removeEventListener("visibilitychange",clear);};},[]);
  useEffect(()=>{stopMotion();},[canInteract,documentWidth,documentHeight,enableFlickPanning,animatedZoom,overscroll,stageSize.width,stageSize.height]);
  const wheelNavigation=useRef(new WheelNavigation());
  const wheelState=useRef({canInteract,zoomWithScrollWheel,zoomWithTrackpadPinch,documentWidth,documentHeight});
  wheelState.current={canInteract,zoomWithScrollWheel,zoomWithTrackpadPinch,documentWidth,documentHeight};
  useEffect(()=>{
    const element=containerRef.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{
      const state=wheelState.current;
      if((event.target as Element).closest("input,textarea,select,button,[contenteditable=true]"))return;
      event.preventDefault();event.stopPropagation();
      if(!state.canInteract || pointerRef.current!==null || transformRef.current?.hasGesture() || scrollbarRef.current?.active() || touches.current.active)return;
      stopMotion();
      const rect=element.getBoundingClientRect(),next=wheelNavigation.current.apply(event,{...state,view:currentView.current.viewport,width:element.clientWidth,height:element.clientHeight,anchor:{x:event.clientX-rect.left-element.clientWidth/2,y:event.clientY-rect.top-element.clientHeight/2}});
      if(next)publishView(next);
    };
    const reset=()=>wheelNavigation.current.reset();
    element.addEventListener("wheel",wheel,{passive:false});element.addEventListener("pointerleave",reset);window.addEventListener("blur",reset);
    return()=>{element.removeEventListener("wheel",wheel);element.removeEventListener("pointerleave",reset);window.removeEventListener("blur",reset);reset();};
  },[]);
  useEffect(()=>{wheelNavigation.current.reset();},[canInteract,zoomWithScrollWheel,zoomWithTrackpadPinch,documentWidth,documentHeight]);
  const changeZoom = (factor: number) => {const v=currentView.current.viewport;animateView({...v,zoom:stepEditorZoom(v.zoom,factor,documentWidth,documentHeight)});};
  const changeView = (action: EditorViewAction,bounds=selectedBounds) => {
    if (pointerRef.current !== null || transformRef.current?.hasGesture() || scrollbarRef.current?.active() || touches.current.active || !canInteract) return;
    if (action === "zoomIn") changeZoom(1.2);
    else if (action === "zoomOut") changeZoom(-1);
    else if(action==="fitLayers" && bounds && bounds[2]>0 && bounds[3]>0){
      const next=clampEditorZoom(Math.min(Math.max(1,stageSize.width-40)/bounds[2],Math.max(1,stageSize.height-40)/bounds[3]),documentWidth,documentHeight);
      animateView({zoom:next,x:(documentWidth/2-bounds[0]-bounds[2]/2)*next,y:(documentHeight/2-bounds[1]-bounds[3]/2)*next});
    } else animateView({x:0,y:0,zoom:action==="fit" || action==="fitLayers"?view.fitZoom:clampEditorZoom(action==="twoHundredPercent"?2:action==="printSize"?screenResolution/resolutionDpi:1,documentWidth,documentHeight)});
  };
  const cancelGesture = (preserveTouches=false) => {
    bucketTouch.current=false;
    const touchWasActive=touches.current.active,touchIds=preserveTouches?[]:touches.current.reset();
    if(!preserveTouches)setPinching(false);
    stopMotion();zoomGesture.cancel();setZooming(false);
    setMoveHover(null);setMeasureTarget(undefined);feedbackPoint.current=null;
    autoPan.stop(); autoPointer.current = null;
    const transforming = transformRef.current?.cancelGesture() ?? false;
    const active = pointerRef.current !== null || transforming || !!scrollbarRef.current?.active() || touchWasActive;
    scrollbarRef.current?.cancel();
    const pointer = pointerRef.current;
    pointerRef.current = null;
    const position=positionRef.current;positionRef.current=null;setPositioningActive(false);position?.cancel();
    if (moveRef.current) { moveRef.current = null; setMoving(false); if(!pendingMove.current) onMoveCancel?.(); }
    moveDuplicate.current=false;
    pendingMove.current=null;if(layerBox.current){layerBox.current=null;setMoving(false);}
    selectionMove.current = null; setSelectionHover(null);setFeedbackKeys({shift:false,alt:false,mod:false});
    clickRef.current = null;
    textStart.current = null;
    pathRef.current = null;penTap.current=null;strokeConstraint.current=null;resizeRef.current=null;setResizeValues(null);
    samplingRef.current = false;setSampleBase(null);
    selectionRef.current = null;
    selectionSpace.current = false;
    if (pointer !== null && !resizeValues && isPaintTool(gestureTool.current)) onStrokeCancel?.();
    setBox(null); setPath(null); setPan(null);
    if (!preserveTouches && pointer !== null && containerRef.current?.hasPointerCapture(pointer)) containerRef.current.releasePointerCapture(pointer);
    for(const id of touchIds){if(containerRef.current?.hasPointerCapture(id))containerRef.current.releasePointerCapture(id);}
    return active;
  };
  const showSelection = () => {
    const selection = selectionRef.current;
    if (!selection) return;
    if (selection.kind === "marquee") setBox(selection.rect());
    else setPath(selection.path());
  };
  const moveMatrix=(point:DocumentPoint,shift:boolean)=>{
    const start=moveRef.current!;
    // 参考线/网格/画布边缘吸附只影响拖动显示（I096）；关闭吸附时保持原偏移。
    const target=shift?point:snapDocument(point,6).point;
    let delta={x:target.x-start.x,y:target.y-start.y};
    if(shift) delta=constrainMoveOffset(delta,moveOffset.current,selectionMove.current==="pixels" || (tool==="move" && selectionOutline.length>0) ? 8 : 4);
    moveOffset.current=delta;
    return [1,0,0,1,delta.x,delta.y];
  };
  autoContext.current = {
    read: () => {
      const element = containerRef.current, pointer = autoPointer.current;
      const overlayActive = !!selectionMatrix && transformRef.current?.hasGesture();
      if (!element || !pointer || pendingMove.current || (!overlayActive && (pointerRef.current === null || !clickRef.current?.moved || (!selectionRef.current && !moveRef.current && !layerBox.current && !textStart.current && !pathRef.current)))) return null;
      return {pointer:toLocal(pointer.clientX,pointer.clientY),width:element.clientWidth,height:element.clientHeight,
        documentWidth,documentHeight,...view.viewport};
    },
    pan: (step) => {
      const current = viewport(), pointer = autoPointer.current;
      if (!current || !pointer) return;
      if (clickRef.current) clickRef.current.moved = true;
      publishView({...currentView.current.viewport,x:offsetX+step.x,y:offsetY+step.y});
      const point = screenToDocument(pointer.clientX,pointer.clientY,{...current,left:current.left+step.x,top:current.top+step.y},!selectionRef.current && !moveRef.current && !layerBox.current && !pathRef.current && !transformRef.current?.hasGesture());
      if (!point) return;
      if (selectionRef.current) {
        selectionRef.current.update(point,{shift:pointer.shiftKey,alt:pointer.altKey,space:selectionSpace.current}); showSelection();
      } else if(layerBox.current){const start=layerBox.current.start;setBox({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.abs(start.x-point.x),height:Math.abs(start.y-point.y)});}
      else if (moveRef.current) {const matrix=moveMatrix(point,pointer.shiftKey);onMovePreview?.(matrix);}
      else if(textStart.current){const start=textStart.current;setBox({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.abs(point.x-start.x),height:Math.abs(point.y-start.y)});}
      else if(pathRef.current){
        const last=pathRef.current.at(-1),sample={...last,...point,time:performance.now()};
        const next=strokeConstraint.current?.update(sample,pointer.shiftKey)??sample;
        if(last && (next.x!==last.x || next.y!==last.y)){if(penTap.current)penTap.current.moved=true;pathRef.current.push(next);onStrokeMove?.([next]);}
      }
      else transformRef.current?.previewAt(point,pointer.shiftKey,pointer.altKey);
    }
  };
  const updateSelectionFeedback=(keys:typeof feedbackKeys)=>{
    setFeedbackKeys(keys);
    const point=feedbackPoint.current;
    if(tool==="move" && pointerRef.current===null) setMoveHover(canInteract && point && onMoveHover ? onMoveHover(point,{toggleAuto:keys.mod}):null);
    updateMeasureTarget(point,keys.mod);
    const inside=point && (selectionContains?selectionContains(point):pointInSelection(point,selectionOutline));
    setSelectionHover(inside && (tool==="marquee" || tool==="lasso") && ((keys.mod && !keys.shift) || selectionModeForKeys(selectionMode,keys,hasSelection)==="replace") ? keys.mod?"pixels":"boundary":null);
  };
  /**
   * Move 智能参考线距离测量：Cmd/Ctrl 悬停且没有按下指针时查询目标框。
   * 与上游一致，这是只读覆盖层：不改选择、历史或文档，也不为它写任何命令。
   */
  const updateMeasureTarget=(point:DocumentPoint|null,command:boolean)=>{
    if(!measureMoveDistance || !onMoveMeasure || !canInteract || !point || !shouldMeasure({tool,extrasVisible:true,transforming:!!transformRef.current?.hasGesture(),pressed:pointerRef.current!==null,command,hasSelectedLayers:!!selectedBounds,hasTarget:true})){
      setMeasureTarget(current=>current===undefined?current:undefined);return;
    }
    const target=onMoveMeasure(point);
    setMeasureTarget(current=>{
      if(target===undefined)return undefined;
      if(target===null)return current===null?current:null;
      return current && current!==null && current[0]===target[0] && current[1]===target[1] && current[2]===target[2] && current[3]===target[3] ? current : target;
    });
  };
  const selectionKey = (key: string, physical: boolean) => {
    const pressed=physical || (key==="Shift"?sticky.shift:key==="Alt"?sticky.alt:key===(isEditorMac()?"Meta":"Control")?sticky.command:false);
    if(key==="Shift" || key==="Alt" || key==="Control" || key==="Meta") updateSelectionFeedback({...feedbackKeys,[key==="Shift"?"shift":key==="Alt"?"alt":"mod"]:pressed});
    if (!selectionRef.current?.key(key,pressed)) return false;
    if (key === " ") selectionSpace.current = pressed;
    showSelection(); return true;
  };
  const cancelRef = useRef(cancelGesture);
  cancelRef.current = cancelGesture;
  useEffect(() => { if(pointerRef.current!==null || transformRef.current?.hasGesture() || touches.current.contacts)cancelRef.current(); }, [tool,zoomScrubby,enableGestures]);
  useEffect(() => { cancelRef.current(); }, [canInteract, positioning?.key]);
  useEffect(() => () => { cancelRef.current(); }, []);
  useImperativeHandle(ref, () => ({
    navigationFrame:()=>({viewport:currentView.current.viewport,size:stageSize,document:{width:documentWidth,height:documentHeight}}),
    navigator:action=>{if(pointerRef.current!==null || transformRef.current?.hasGesture() || scrollbarRef.current?.active() || touches.current.active || !canInteract)return;const next=navigatorViewport({viewport:currentView.current.viewport,size:stageSize,document:{width:documentWidth,height:documentHeight}},action);if(next){stopMotion();publishView(next);}},
    navigate:navigation=>{if(pointerRef.current!==null || transformRef.current?.hasGesture() || scrollbarRef.current?.active() || touches.current.active || !canInteract)return;stopMotion();publishView(navigateViewport(currentView.current.viewport,stageSize,{width:documentWidth,height:documentHeight},navigation));},
    zoomTo:(next:number)=>{if(pointerRef.current!==null || scrollbarRef.current?.active() || touches.current.active || !canInteract || !Number.isFinite(next) || next<=0)return;const v=currentView.current.viewport;stopMotion();publishView(zoomAt(v,clampEditorZoom(next,documentWidth,documentHeight),{x:0,y:0}));},
    hasGesture: () => pointerRef.current !== null || (transformRef.current?.hasGesture() ?? false) || !!scrollbarRef.current?.active() || touches.current.active,
    cancelGesture,
    selectionKey,
    view: changeView
  }));
  // 将文档边界投影到当前视图；缩放与平移不改变选区状态。
  const originX = (stageSize.width - documentWidth * actualScale) / 2 + offset.x;
  const originY = (stageSize.height - documentHeight * actualScale) / 2 + offset.y;
  const paintingTool=isPaintTool(tool);
  const cursorTip=brushCursor(cursors,brushSize??0,tool==="pencil" || tool==="eraser" && eraserMode==="pencil"?1:brushHardness,zoom,!!pathRef.current,tool==="eraser" && eraserMode==="block");
  const preciseOther=cursors.other==="precise" && ["move","text","marquee","lasso","bucket","eyedropper"].includes(tool);
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

  const feedbackMode=selectionRef.current?.mode ?? selectionModeForKeys(selectionMode,feedbackKeys,hasSelection);
  const feedbackIcon=selectionMove.current==="pixels" ? PointerIcon : selectionHover==="pixels" ? feedbackKeys.alt?CopyIcon:CutIcon : selectionHover==="boundary" || selectionMove.current==="boundary" ? null : feedbackMode==="add"?PlusIcon:feedbackMode==="subtract"?MinusIcon:feedbackMode==="intersect"?CloseIcon:null;
  const FeedbackIcon=feedbackIcon;
  const moveArrow=moveBoundingBox && moveRef.current && moveOffset.current && !pendingMove.current
    ? {start:moveRef.current,delta:moveOffset.current}
    : moveBoundingBox && transformMoveOnly && transformFrame && transformMatrix && (transformMatrix[4]!==0 || transformMatrix[5]!==0)
      ? {start:{x:(transformFrame[0]+transformFrame[2])/2,y:(transformFrame[1]+transformFrame[3])/2},delta:{x:transformMatrix[4]!,y:transformMatrix[5]!}}
      : null;
  /**
   * Move 距离覆盖层（I021）。
   *
   * 选中的联合内容框 → 指针下目标框（未命中时用画布边缘）；Alt 复制拖动期间改为量原件与副本。
   * 与上游一样，只读：不写选择、历史或内容。
   */
  const measure=measureMoveDistance && tool==="move" && canInteract && !transforming ? (()=>{
    const selection: readonly [number,number,number,number] | null = selectedBounds
      ? [selectedBounds[0],selectedBounds[1],selectedBounds[0]+selectedBounds[2],selectedBounds[1]+selectedBounds[3]] : null;
    if(!selection) return null;
    if(moveDuplicate.current && moveOffset.current){
      const delta=moveOffset.current;
      return measureBoxes(selection,[selection[0]+delta.x,selection[1]+delta.y,selection[2]+delta.x,selection[3]+delta.y]);
    }
    if(measureTarget===undefined || pointerRef.current!==null) return null;
    const target=measureTarget ?? ([0,0,documentWidth,documentHeight] as const);
    const overlay=measureBoxes(selection,target);
    return overlay.measures.length ? overlay : null;
  })() : null;
  const measureText=measure ? measureLabels(measure,{unit:measurementUnit,dpi:resolutionDpi,width:documentWidth,height:documentHeight,pointPica:pointPicaSize}) : [];
  // 标尺/参考线/网格（I096）：只读显示；指针拖动会分派原生 view.* 命令。
  const guideState=decodeGuides(guides);
  const guidesList=guideList(guideState,guides?.colors);
  const prefs=guidePreferences;
  const rulerX=rulerTicks(documentWidth,zoom).ticks;
  const rulerY=rulerTicks(documentHeight,zoom).ticks;
  const visibleGridX=prefs?.showGrid&&prefs.gridSize>0?gridLines(Math.max(0,-offset.x/zoom),Math.min(documentWidth,(stageSize.width-offset.x)/zoom),prefs.gridSize):[];
  const visibleGridY=prefs?.showGrid&&prefs.gridSize>0?gridLines(Math.max(0,-offset.y/zoom),Math.min(documentHeight,(stageSize.height-offset.y)/zoom),prefs.gridSize):[];
  /** 把屏幕点吸附到参考线/网格/画布边缘（仅显示层，不改变文档）。 */
  const snapDocument=(point:DocumentPoint,threshold:number)=>snapPoint(point,{guides:guidesList,grid:prefs?.showGrid?prefs.gridSize:null,canvas:{width:documentWidth,height:documentHeight},
    threshold:threshold/Math.max(zoom,1e-6),snapToGuides:prefs?.snapToGuides??true,snapToGrid:prefs?.snapToGrid??false,snapToCanvas:prefs?.snapToCanvas??true});

  return (
    <div
      ref={containerRef}
      className="photo-editor-canvas"
      data-document-size={`${documentWidth}x${documentHeight}`}
      data-tool={tool}
      data-selection-operation={selectionMove.current ?? (selectionRef.current ? "new" : undefined)}
      style={{...renderBackground && pasteboard?pasteboardStyle(pasteboard):{},cursor: resizeValues?"none":paintingTool && !sampling && !samplingRef.current ? cursorTip.mode==="precise"?"crosshair":"none":preciseOther?"crosshair":tool==="none" && positioning ? positioningActive?"grabbing":"move" : (sampling || samplingRef.current) && (tool === "brush" || tool === "pencil" || tool === "bucket" || tool==="eyedropper") ? "crosshair" : selectionMove.current === "pixels" ? "grabbing" : selectionMove.current === "boundary" || selectionHover === "boundary" ? "move" : selectionHover === "pixels" ? "grab" : undefined}}
      data-canvas-viewport="true"
      data-canvas-wheel-owner="local"
      data-canvas-viewport-blocked={!canInteract || !!(pinching || scrolling || box || zooming || path || pan || transforming || moving || positioningActive || resizeValues || sampleBase) ? "true" : undefined}
      onPointerDown={(rawEvent) => {
        const event=withStickyModifiers(rawEvent,sticky,isEditorMac());
        if(event.pointerType==="touch" && enableGestures && canInteract && !(event.target as Element).closest("input,textarea,select,button,[data-canvas-viewport-control]") && !scrollbarRef.current?.active() && (pointerRef.current===null || touches.current.contacts>0)) {
          const consumed=touches.current.down(event.pointerId,toLocal(event.clientX,event.clientY),{view:currentView.current.viewport,width:stageSize.width,height:stageSize.height,documentWidth,documentHeight});
          event.currentTarget.setPointerCapture(event.pointerId);
          if(consumed){event.preventDefault();event.stopPropagation();cancelGesture(true);setPinching(true);event.currentTarget.setPointerCapture(event.pointerId);return;}
        }
        if(touches.current.active)return;
        if(!canInteract || pointerRef.current!==null || scrollbarRef.current?.active()) return;
        // 标尺拖出参考线（I096）：命中已有参考线时改为拖动它。
        // 标尺带的 Alt/Option 单击设置标尺原点（I096）：优先于参考线创建/拖动。
        if(prefs?.showRulers && onRulerOrigin && event.button===0 && event.altKey){
          const origin=toLocal(event.clientX,event.clientY);
          if(origin.x>=0 && origin.y>=0 && origin.x<=RULER_BAND && origin.y<=RULER_BAND){
            onRulerOrigin([Math.round((origin.x-offset.x)/zoom),Math.round((origin.y-offset.y)/zoom)]);
            event.preventDefault();return;
          }
        }
        if(prefs?.showRulers && onGuidesChange && event.button===0 && !event.altKey){
          const local=toLocal(event.clientX,event.clientY);
          const hit=guideAt(guidesList,{x:(local.x-offset.x)/zoom,y:(local.y-offset.y)/zoom},zoom);
          if(hit && prefs.showGuides){
            guideDrag.current={orientation:hit.orientation,index:hit.index,position:hit.position,pointer:event.pointerId};
            setGuideHit({orientation:hit.orientation,index:hit.index,position:hit.position});
            pointerRef.current=event.pointerId;gestureTool.current=tool;
            event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return;
          }
          // 从上/左 24px 的标尺带开始拖动：生成新参考线。
          if(local.x>=0 && local.y>=0 && local.x<=stageSize.width && local.y<=stageSize.height && (local.x<=RULER_BAND || local.y<=RULER_BAND)){
            const orientation=local.y<=RULER_BAND?"horizontal":"vertical";
            rulerDrag.current={orientation,pointer:event.pointerId};
            setGuideDraft({orientation,position:orientation==="horizontal"?(local.y-offset.y)/zoom:(local.x-offset.x)/zoom});
            pointerRef.current=event.pointerId;gestureTool.current=tool;
            event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();return;
          }
        }
        setMoveHover(null);setMeasureTarget(undefined);
        suppressContext.current=false;
        if(!(tool==="eraser" && eraserMode==="block") && brushResize && (tool==="brush" || tool==="pencil" || tool==="eraser") && event.altKey && ((event.button===0 && event.ctrlKey) || (event.button===2 && !isEditorMac()))) {
          event.preventDefault();event.stopPropagation();
          resizeRef.current={x:event.clientX,y:event.clientY,local:toLocal(event.clientX,event.clientY),base:{...brushResize.values},values:{...brushResize.values},hardness:brushResize.hardness,commit:brushResize.commit};
          setResizeValues({...brushResize.values});pointerRef.current=event.pointerId;gestureTool.current=tool;suppressContext.current=true;
          event.currentTarget.setPointerCapture(event.pointerId);return;
        }
        if(event.button===1){
          event.preventDefault();event.stopPropagation();stopMotion();
          pointerRef.current=event.pointerId;gestureTool.current="pan";event.currentTarget.setPointerCapture(event.pointerId);
          motion.current.flick.start({x:event.clientX,y:event.clientY},event.nativeEvent.timeStamp);
          setPan({x:event.clientX,y:event.clientY,ox:offset.x,oy:offset.y});return;
        }
        if ((tool === "none" && !positioning) || event.button !== 0) return;
        if(tool==="bucket" && !(event.altKey && onSampleColor)) {
          event.preventDefault();event.stopPropagation();const point=toDocument(event.clientX,event.clientY,false);
          if(event.pointerType==="touch" && enableGestures){bucketTouch.current=true;pointerRef.current=event.pointerId;gestureTool.current="bucket";event.currentTarget.setPointerCapture(event.pointerId);}
          else if(point && point.x>=0 && point.y>=0 && point.x<documentWidth && point.y<documentHeight)onBucket?.(point);return;
        }
        if(tool==="magicWand" && onMagicWand) {
          event.preventDefault();event.stopPropagation();const point=toDocument(event.clientX,event.clientY,false);
          const mode=selectionModeForKeys(selectionMode,{shift:event.shiftKey,alt:event.altKey},hasSelection);
          if(point && point.x>=0 && point.y>=0 && point.x<documentWidth && point.y<documentHeight)onMagicWand(point,mode);return;
        }
        if(tool==="zoom" || tool==="pan" && (event.ctrlKey || event.metaKey || event.altKey)) {
          event.preventDefault();event.stopPropagation();stopMotion();
          pointerRef.current=event.pointerId;gestureTool.current="zoom";event.currentTarget.setPointerCapture(event.pointerId);
          setZooming(true);zoomGesture.start(toLocal(event.clientX,event.clientY),event.altKey);return;
        }
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
          forceNewText.current=event.shiftKey;
          textStart.current=point;setBox({x:point.x,y:point.y,width:0,height:0});
        }
        if (tool === "move") {
          const point = toDocument(event.clientX,event.clientY);
          const modifiers={duplicate:event.altKey,toggleAuto:event.ctrlKey || event.metaKey,add:event.shiftKey};
          if(!point) return;
          if(onMovePick) {const picked=onMovePick(point,modifiers);if(!picked)return;
            if(picked==="box")layerBox.current={start:point,add:modifiers.add};else pendingMove.current={point,modifiers};}
          else if(!onMoveStart?.(point,modifiers)) return;
          if(!layerBox.current){moveRef.current = point;moveDuplicate.current=modifiers.duplicate;}
          moveOffset.current=null;setMoving(true);
        }
        if ((tool === "marquee" || tool === "lasso") && onSelectionMoveStart) {
          const point = toDocument(event.clientX,event.clientY,false);
          const mode = selectionModeForKeys(selectionMode,{shift:event.shiftKey,alt:event.altKey},hasSelection);
          const inside=point && (selectionContains ? selectionContains(point) : pointInSelection(point,selectionOutline));
          const temporary=(event.ctrlKey || event.metaKey) && !event.shiftKey;
          if(point && temporary) {
            pendingMove.current={point,modifiers:{duplicate:event.altKey,toggleAuto:false,add:false,wholeLayer:!inside,selectedPixels:!!inside}};
            moveRef.current=point;moveDuplicate.current=event.altKey;moveOffset.current=null;selectionMove.current=inside?"pixels":null;setMoving(true);
          } else if (point && mode === "replace" && inside) {
            if (!onSelectionMoveStart(false)) return;
            moveRef.current = point; moveOffset.current=null;selectionMove.current = "boundary"; setMoving(true);
          }
        }
        pointerRef.current = event.pointerId;
        clickRef.current = { x: event.clientX, y: event.clientY, moved: false, threshold:(tool==="move" || pendingMove.current) && event.altKey ? 2 : 3 };
        autoPointer.current = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey};
        gestureTool.current = tool;
        event.currentTarget.setPointerCapture(event.pointerId);
        if ((tool==="eyedropper" || (tool === "brush" || tool === "pencil" || tool === "bucket") && event.altKey) && onSampleColor) {
          samplingRef.current = true;
          setSampleBase(tool==="eyedropper" && event.altKey?samplingColors?.background??null:samplingColors?.foreground??null);
          const point = toDocument(event.clientX,event.clientY,false);
          if (point) {setCursor({local:toLocal(event.clientX,event.clientY),doc:point});if(tool==="eyedropper")onSampleColor(point,{background:event.altKey});else onSampleColor(point);}
          return;
        }
        if (textStart.current) return;
        if (moveRef.current || layerBox.current) { autoPan.update(); return; }
        if (isGestureTool(tool)) {
          const point = toDocument(event.clientX, event.clientY);
          if (!point) return;
          if (tool === "marquee" || tool === "lasso") {
            selectionSpace.current = false;
            selectionRef.current = new SelectionGesture(tool,point,{width:documentWidth,height:documentHeight},selectionMode,
              {shift:event.shiftKey,alt:event.altKey,space:false},tool==="marquee"?marqueeLine:undefined,hasSelection,tool==="marquee"?marqueeConstraint:undefined);
            showSelection(); autoPan.update();
          } else {
            const first=strokeSample(point,event);
            penTap.current=event.pointerType==="pen"?{x:point.x,y:point.y,pressure:Number.isFinite(event.pressure)?clampPenPressure(event.pressure):0,moved:false}:null;
            strokeConstraint.current=new StrokeConstraint(first,event.shiftKey,zoom);
            pathRef.current = [first];
            setPath(pathRef.current);
            if(onStrokeStart?.(first,{shift:event.shiftKey,...(event.altKey?{alt:true}:{}),...(event.ctrlKey||event.metaKey?{mod:true}:{})})===false)cancelGesture();
          }
          return;
        }
        motion.current.flick.start({x:event.clientX,y:event.clientY},event.nativeEvent.timeStamp);
        setPan({ x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y });
      }}
      onPointerMove={(rawEvent) => {
        // 参考线拖动/标尺拉出（I096）：只在显示层移动，释放时才分派一次原生命令。
        if(guideDrag.current&&guideDrag.current.pointer===rawEvent.pointerId){
          const local=toLocal(rawEvent.clientX,rawEvent.clientY);
          const position=Math.round(guideDrag.current.orientation==="horizontal"?(local.y-offset.y)/zoom:(local.x-offset.x)/zoom);
          guideDrag.current.position=position;setGuideHit(current=>current?{...current,position}:current);rawEvent.preventDefault();return;
        }
        if(rulerDrag.current&&rulerDrag.current.pointer===rawEvent.pointerId){
          const local=toLocal(rawEvent.clientX,rawEvent.clientY);
          const position=Math.round(rulerDrag.current.orientation==="horizontal"?(local.y-offset.y)/zoom:(local.x-offset.x)/zoom);
          setGuideDraft({orientation:rulerDrag.current.orientation,position});rawEvent.preventDefault();return;
        }
        if(onPointerPosition){const control=(rawEvent.target as Element).closest("input,textarea,select,button,[data-canvas-viewport-control]");infoPointer.current=control?null:{x:rawEvent.clientX,y:rawEvent.clientY};onPointerPosition(control||view.transitioning?null:toDocument(rawEvent.clientX,rawEvent.clientY,false));}
        const event=withStickyModifiers(rawEvent,sticky,isEditorMac());
        if(event.pointerType==="touch" && touches.current.has(event.pointerId)) {
          const active=touches.current.active,next=touches.current.move(event.pointerId,toLocal(event.clientX,event.clientY));
          if(active){event.preventDefault();event.stopPropagation();if(next)publishView(next);return;}
        }
        if (pointerRef.current !== null && pointerRef.current !== event.pointerId) return;
        if(zoomGesture.active){zoomGesture.move(toLocal(event.clientX,event.clientY));event.preventDefault();return;}
        if(resizeRef.current) {
          const drag=resizeRef.current;drag.values=resizeBrush(drag.base,event.clientX-drag.x,event.clientY-drag.y,drag.hardness,zoom);setResizeValues(drag.values);
          event.preventDefault();return;
        }
        if(positionRef.current) {
          const point=toDocument(event.clientX,event.clientY,false);if(point) positionRef.current.preview(point);return;
        }
        autoPointer.current = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey};
        const click = clickRef.current;
        if (click && (click.threshold===2 ? Math.hypot(event.clientX-click.x,event.clientY-click.y)>=2 : Math.hypot(event.clientX-click.x,event.clientY-click.y)>click.threshold)) click.moved=true;
        autoPan.update();
        if(isPaintTool(tool)) setFeedbackKeys({shift:event.shiftKey,alt:event.altKey,mod:event.ctrlKey || event.metaKey});
        const local = toLocal(event.clientX, event.clientY);
        const point = toDocument(event.clientX, event.clientY);
        if (point) setCursor({ local, doc: point });
        if (samplingRef.current) { const raw=toDocument(event.clientX,event.clientY,false);if(raw){if(tool==="eyedropper")onSampleColor?.(raw,{background:event.altKey});else onSampleColor?.(raw);} return; }
        if (textStart.current && point) {
          const start=textStart.current;
          setBox({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.abs(start.x-point.x),height:Math.abs(start.y-point.y)});
          return;
        }
        const hitPoint = toDocument(event.clientX,event.clientY,false);
        feedbackPoint.current=hitPoint;
        updateSelectionFeedback({shift:event.shiftKey,alt:event.altKey,mod:event.ctrlKey || event.metaKey});
        if(layerBox.current && point){const start=layerBox.current.start;
          if(click?.moved)setBox({x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),width:Math.abs(start.x-point.x),height:Math.abs(start.y-point.y)});
          return;
        }
        if (moveRef.current && point) {
          if (click?.moved) {
            if(!startPendingMove()) {cancelGesture();return;}
            const matrix=moveMatrix(point,event.shiftKey);onMovePreview?.(matrix);
          }
          return;
        }
        if (selectionRef.current && point) {
          // 空格状态来自键盘端口；Shift/Alt 同时从指针事件纠正，避免漏掉释放。
          const selection=selectionRef.current;
          const samples=selection.kind==="lasso"?event.nativeEvent.getCoalescedEvents?.()??[]:[];
          for(const sample of [...samples,event]) {const next=toDocument(sample.clientX,sample.clientY,false);if(next)selection.update(next,{shift:event.shiftKey,alt:event.altKey,space:selectionSpace.current});}
          showSelection(); return;
        }
        if (pathRef.current && point) {
          const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
          const points = (samples.length ? samples : [event]).flatMap((sample) => {
            const point = toDocument(sample.clientX, sample.clientY);
            if(!point) return [];
            const tap=penTap.current;
            if(tap){if(Number.isFinite(sample.pressure))tap.pressure=Math.max(tap.pressure,clampPenPressure(sample.pressure));if(point.x!==tap.x || point.y!==tap.y)tap.moved=true;if(!tap.moved)return [];}
            const pressure=strokeSample(point,{...sample,pointerType:event.pointerType,pressure:sample.pressure,tiltX:sample.tiltX,tiltY:sample.tiltY,twist:sample.twist,timeStamp:sample.timeStamp});
            return [strokeConstraint.current?.update(pressure,event.shiftKey)??pressure];
          });
          pathRef.current.push(...points);
          if(points.length)onStrokeMove?.(points);
          return;
        }
        if (pan) {motion.current.flick.track({x:event.clientX,y:event.clientY},event.nativeEvent.timeStamp);publishView({ zoom, x: pan.ox + (event.clientX - pan.x), y: pan.oy + (event.clientY - pan.y) });}
      }}
      onPointerUp={(rawEvent) => {
        const event=withStickyModifiers(rawEvent,sticky,isEditorMac());
        // 参考线拖动结束：一次原生 move/delete 或 new。
        if(guideDrag.current&&guideDrag.current.pointer===event.pointerId){
          const drag=guideDrag.current;guideDrag.current=null;setGuideHit(null);pointerRef.current=null;
          if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
          const local=toLocal(event.clientX,event.clientY);
          const position=Math.round(drag.orientation==="horizontal"?(local.y-offset.y)/zoom:(local.x-offset.x)/zoom);
          // 拖出画布或落在标尺带内视为删除；否则移动。
          const outside=local.x<0||local.y<0||local.x>stageSize.width||local.y>stageSize.height||local.x<=RULER_BAND||local.y<=RULER_BAND;
          if(outside)onGuidesChange?.({kind:"delete",orientation:drag.orientation,index:drag.index});
          else if(position!==drag.position)onGuidesChange?.({kind:"move",orientation:drag.orientation,index:drag.index,position});
          event.preventDefault();return;
        }
        if(rulerDrag.current&&rulerDrag.current.pointer===event.pointerId){
          const drag=rulerDrag.current;rulerDrag.current=null;setGuideDraft(null);pointerRef.current=null;
          if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
          const local=toLocal(event.clientX,event.clientY);
          const position=Math.round(drag.orientation==="horizontal"?(local.y-offset.y)/zoom:(local.x-offset.x)/zoom);
          const inside=local.x>=0&&local.y>=0&&local.x<=stageSize.width&&local.y<=stageSize.height&&local.x>RULER_BAND&&local.y>RULER_BAND;
          if(inside)onGuidesChange?.({kind:"create",orientation:drag.orientation,position});
          event.preventDefault();return;
        }
        if(event.pointerType==="touch" && touches.current.has(event.pointerId)) {
          const active=touches.current.active,next=touches.current.move(event.pointerId,toLocal(event.clientX,event.clientY));
          touches.current.up(event.pointerId);
          if(active || pointerRef.current!==event.pointerId){event.preventDefault();event.stopPropagation();if(active && next)publishView(next);setPinching(touches.current.active);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);return;}
        }
        if (pointerRef.current !== event.pointerId) return;
        if(bucketTouch.current){bucketTouch.current=false;pointerRef.current=null;const point=toDocument(event.clientX,event.clientY,false);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(canInteract&&point&&point.x>=0&&point.y>=0&&point.x<documentWidth&&point.y<documentHeight)onBucket?.(point);return;}
        if(zoomGesture.active){zoomGesture.end(toLocal(event.clientX,event.clientY),event.altKey);setZooming(false);pointerRef.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();return;}
        if(resizeRef.current) {
          const drag=resizeRef.current;const next=resizeBrush(drag.base,event.clientX-drag.x,event.clientY-drag.y,drag.hardness,zoom);
          resizeRef.current=null;setResizeValues(null);pointerRef.current=null;
          if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if(next.size!==drag.base.size || next.hardness!==drag.base.hardness || next.opacity!==drag.base.opacity) drag.commit(next);
          event.preventDefault();event.stopPropagation();return;
        }
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
            onText?.({x:box[0],y:box[1],box,...(forceNewText.current?{forceNew:true}:{})});
          } else onText?.({x:start.x,y:start.y,...(forceNewText.current?{forceNew:true}:{})});
          return;
        }
        if (samplingRef.current) {
          samplingRef.current = false;setSampleBase(null);
          const point = toDocument(event.clientX,event.clientY,false);
          if (point) {if(tool==="eyedropper")onSampleColor?.(point,{background:event.altKey});else onSampleColor?.(point);}
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          return;
        }
        if(layerBox.current){const draft=layerBox.current,end=toDocument(event.clientX,event.clientY,false);
          layerBox.current=null;setBox(null);setMoving(false);
          if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
          const distance=click?Math.hypot(event.clientX-click.x,event.clientY-click.y):0;
          const dragged=!!click && (click.moved || (click.threshold===2?distance>=2:distance>click.threshold));
          if(end)onMoveBoxEnd?.(draft.start,end,draft.add,dragged);return;
        }
        if (moveRef.current) {
          const end = toDocument(event.clientX,event.clientY);
          const distance=click ? Math.hypot(event.clientX-click.x,event.clientY-click.y) : 0;
          const crossed=!!click && (click.moved || (click.threshold===2 ? distance>=2 : distance>click.threshold));
          const wasPending=!!pendingMove.current;
          const started=!wasPending || (crossed && startPendingMove());pendingMove.current=null;
          const matrix=started && end ? moveMatrix(end,event.shiftKey) : null;
          const boundaryClick=!crossed && selectionMove.current==="boundary";
          moveRef.current = null; moveOffset.current=null;selectionMove.current = null; setMoving(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (matrix && crossed) onMoveEnd?.(matrix);
          else if(started) onMoveCancel?.();
          if(boundaryClick && end) onSelectionClick?.(end,"replace");
          return;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (selectionRef.current) {
          const selection = selectionRef.current;
          const samples=selection.kind==="lasso"?event.nativeEvent.getCoalescedEvents?.()??[]:[];
          for(const sample of [...samples,event]) {const next=toDocument(sample.clientX,sample.clientY,false);if(next)selection.update(next,{shift:event.shiftKey,alt:event.altKey,space:selectionSpace.current});}
          selectionRef.current = null; selectionSpace.current = false; setBox(null); setPath(null);
          if (!selection.line && selection.constraint?.mode!=="size" && click && !click.moved && Math.hypot(event.clientX-click.x,event.clientY-click.y)<=3) {
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
          for(const sample of event.nativeEvent.getCoalescedEvents?.()??[]){
            const at=toDocument(sample.clientX,sample.clientY);if(!at)continue;
            const tap=penTap.current;if(tap){if(Number.isFinite(sample.pressure))tap.pressure=Math.max(tap.pressure,clampPenPressure(sample.pressure));if(at.x!==tap.x || at.y!==tap.y)tap.moved=true;if(!tap.moved)continue;}
            const next=strokeSample(at,sample),constrained=strokeConstraint.current?.update(next,event.shiftKey)??next;
            path.push(constrained);onStrokeMove?.([constrained]);
          }
          const rawEnd = toDocument(event.clientX, event.clientY);
          const tap=penTap.current;penTap.current=null;
          if(tap && rawEnd){if(rawEnd.x!==tap.x || rawEnd.y!==tap.y)tap.moved=true;if(Number.isFinite(event.pressure))tap.pressure=Math.max(tap.pressure,clampPenPressure(event.pressure));}
          const end=rawEnd ? strokeConstraint.current?.update(rawEnd,event.shiftKey)??rawEnd:null;strokeConstraint.current=null;
          // 抬笔的 0 压感不是最后一笔的压力，沿用最后一个实际采样值。
          let points = end && (end.x !== path.at(-1)?.x || end.y !== path.at(-1)?.y) ? [...path, {...path.at(-1),...end,time:event.timeStamp,pressure:path.at(-1)?.pressure}] : path;
          if(tap && !tap.moved && points.length){const point={...points[0],pressure:tap.pressure};points=[point];if(tap.pressure!==path[0]?.pressure)onStrokeTap?.(point);}
          setPath(null);
          if (points.length === 0) return;
          if (points.length > path.length) onStrokeMove?.(points.slice(path.length));
          onStroke?.(points);
          return;
        }
        if(pan){motion.current.flick.track({x:event.clientX,y:event.clientY},event.nativeEvent.timeStamp);publishView({zoom,x:pan.ox+event.clientX-pan.x,y:pan.oy+event.clientY-pan.y});releasePan(event.nativeEvent.timeStamp);}
        setPan(null);
      }}
      onContextMenuCapture={event=>{if(suppressContext.current) {suppressContext.current=false;event.preventDefault();event.stopPropagation();}}}
      onDoubleClick={event=>{
        if(!canInteract || tool!=="move" || event.button!==0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pointerRef.current!==null) return;
        const point=toDocument(event.clientX,event.clientY,false);
        if(point && point.x>=0 && point.y>=0 && point.x<documentWidth && point.y<documentHeight) {event.preventDefault();onTextEdit?.(point);}
      }}
      onPointerLeave={() => {
        infoPointer.current=null;onPointerPosition?.(null);
        setMoveHover(null);setMeasureTarget(undefined);
        feedbackPoint.current=null;setSelectionHover(null);
        setCursor(null);
      }}
      onPointerCancel={(event) => { if (pointerRef.current === event.pointerId || touches.current.has(event.pointerId)) cancelGesture(); }}
      onLostPointerCapture={(event) => { if (pointerRef.current === event.pointerId || touches.current.has(event.pointerId)) cancelGesture(); }}
      role="presentation"
    >
      {renderBackground ? (
        <div className="photo-editor-canvas__background" aria-hidden="true">
          <div data-transparency-grid={transparency.size} style={{position:"absolute",left:originX,top:originY,width:documentWidth*actualScale,height:documentHeight*actualScale,...transparencyGridStyle(transparency)}}/>
          {pasteboard?<div data-canvas-border={pasteboard.border} style={{position:"absolute",left:originX,top:originY,width:documentWidth*actualScale,height:documentHeight*actualScale,...canvasBorderStyle(pasteboard)}}/>:null}
          {renderBackground({ x: originX, y: originY }, actualScale)}
        </div>
      ) : null}
      {prefs?.showGrid && (visibleGridX.length||visibleGridY.length) ? <svg className="photo-editor-canvas__grid" data-canvas-grid={prefs.gridSize} aria-hidden="true">
        {visibleGridX.map(x=><line key={`gx${x}`} x1={originX+x*zoom} y1={originY} x2={originX+x*zoom} y2={originY+documentHeight*zoom}/>)}
        {visibleGridY.map(y=><line key={`gy${y}`} x1={originX} y1={originY+y*zoom} x2={originX+documentWidth*zoom} y2={originY+y*zoom}/>)}
      </svg>:null}
      {prefs?.showGuides && (guidesList.length||guideDraft) ? <svg className="photo-editor-canvas__guides" data-canvas-guides="true" aria-hidden="true">
        {guidesList.map(guide=>{const active=guideHit&&guideHit.orientation===guide.orientation&&guideHit.index===guide.index;
          const position=active&&guideHit?guideHit.position:guide.position;
          const color=guide.color?`rgb(${guide.color.join(",")})`:undefined;
          return guide.orientation==="horizontal"
            ? <line key={`h${guide.index}`} data-guide="horizontal" data-index={guide.index} x1={originX} y1={originY+position*zoom} x2={originX+documentWidth*zoom} y2={originY+position*zoom} style={color?{stroke:color}:undefined}/>
            : <line key={`v${guide.index}`} data-guide="vertical" data-index={guide.index} x1={originX+position*zoom} y1={originY} x2={originX+position*zoom} y2={originY+documentHeight*zoom} style={color?{stroke:color}:undefined}/>;})}
        {guideDraft?guideDraft.orientation==="horizontal"
          ? <line className="photo-editor-canvas__guide-draft" data-guide-draft="horizontal" x1={originX} y1={originY+guideDraft.position*zoom} x2={originX+documentWidth*zoom} y2={originY+guideDraft.position*zoom}/>
          : <line className="photo-editor-canvas__guide-draft" data-guide-draft="vertical" x1={originX+guideDraft.position*zoom} y1={originY} x2={originX+guideDraft.position*zoom} y2={originY+documentHeight*zoom}/>:null}
      </svg>:null}
      {prefs?.showRulers ? <svg className="photo-editor-canvas__rulers" data-canvas-rulers="true" aria-hidden="true">
        <rect className="photo-editor-canvas__ruler-band" x={0} y={0} width={stageSize.width} height={RULER_BAND}/>
        <rect className="photo-editor-canvas__ruler-band" x={0} y={0} width={RULER_BAND} height={stageSize.height}/>
        {rulerX.map(value=><g key={`rx${value}`}><line x1={originX+value*zoom} y1={RULER_BAND} x2={originX+value*zoom} y2={RULER_BAND-6}/><text x={originX+value*zoom+3} y={RULER_BAND-8}>{Math.round(value)}</text></g>)}
        {rulerY.map(value=><g key={`ry${value}`}><line x1={RULER_BAND} y1={originY+value*zoom} x2={RULER_BAND-6} y2={originY+value*zoom}/><text x={2} y={originY+value*zoom+10}>{Math.round(value)}</text></g>)}
      </svg>:null}
      {pixelGrid?<PixelGridOverlay port={pixelGrid} origin={{x:originX,y:originY}} size={stageSize} zoom={actualScale} document={{width:documentWidth,height:documentHeight}} transitioning={view.transitioning}/>:null}
      {transformFrame && canInteract && onTransform ? <LayerTransformOverlay ref={transformRef} frame={transformFrame} origin={{ x: originX, y: originY }} zoom={zoom}
        matrix={transformMatrix} linked={transformLinked} reference={transformReference} onReferenceChange={onTransformReferenceChange} moveOnly={transformMoveOnly} onBegin={onTransformBegin} onPreview={onTransformPreview} onCancel={onTransformCancel}
        onApply={onTransform} onGestureChange={changeTransformGesture}
        onPointerPosition={(event) => { autoPointer.current = {clientX:event.clientX,clientY:event.clientY,shiftKey:event.shiftKey,altKey:event.altKey}; autoPan.update(); }} passive={tool === "move"} /> : null}
      {moveHover && tool==="move" && canInteract && !moving && !transforming && pointerRef.current===null?<svg className="photo-editor-canvas__hover-bounds" data-move-hover={moveHover.layer}><rect x={originX+moveHover.frame[0]*zoom} y={originY+moveHover.frame[1]*zoom} width={(moveHover.frame[2]-moveHover.frame[0])*zoom} height={(moveHover.frame[3]-moveHover.frame[1])*zoom}/></svg>:null}
      {measure && (measure.measures.length || measure.extensions.length) ? <svg className="photo-editor-canvas__move-distance" data-move-distance="true">
        {measure.extensions.map(([x0,y0,x1,y1],index)=><line key={`e${index}`} className="photo-editor-canvas__move-distance-extension" x1={originX+x0*zoom} y1={originY+y0*zoom} x2={originX+x1*zoom} y2={originY+y1*zoom}/>)}
        {measure.measures.map((item,index)=>{const a=item.horizontal?{x:originX+item.from*zoom,y:originY+item.at*zoom}:{x:originX+item.at*zoom,y:originY+item.from*zoom};
          const b=item.horizontal?{x:originX+item.to*zoom,y:originY+item.at*zoom}:{x:originX+item.at*zoom,y:originY+item.to*zoom};
          const cap=4;return <g key={`m${index}`}>
            <line className="photo-editor-canvas__move-distance-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y}/>
            <line className="photo-editor-canvas__move-distance-cap" x1={a.x-(item.horizontal?0:cap)} y1={a.y-(item.horizontal?cap:0)} x2={a.x+(item.horizontal?0:cap)} y2={a.y+(item.horizontal?cap:0)}/>
            <line className="photo-editor-canvas__move-distance-cap" x1={b.x-(item.horizontal?0:cap)} y1={b.y-(item.horizontal?cap:0)} x2={b.x+(item.horizontal?0:cap)} y2={b.y+(item.horizontal?cap:0)}/>
          </g>;})}
      </svg>:null}
      {measure ? measureText.map((label,index)=>{const item=measure.measures[index];if(!item) return null;
        const local=item.horizontal?{x:originX+label.mid*zoom,y:originY+item.at*zoom}:{x:originX+item.at*zoom,y:originY+label.mid*zoom};
        return <span key={`t${index}`} className="photo-editor-canvas__move-distance-label" data-move-distance-label={label.text} style={{left:local.x,top:local.y}}>{label.text}</span>;}) : null}
      {marquee ? (
        <div
          className="photo-editor-canvas__marquee"
          data-testid="marquee"
          style={{ borderRadius: (tool==="marquee" && ellipse) ? "50%" : undefined, left: `${marquee.x}px`, top: `${marquee.y}px`, width: `${marquee.width}px`, height: `${marquee.height}px` }}
        />
      ) : null}
      {moveArrow?<svg className="photo-editor-canvas__move-arrow" data-move-arrow="true"><defs><marker id={moveArrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="currentColor"/></marker></defs><line x1={originX+moveArrow.start.x*zoom} y1={originY+moveArrow.start.y*zoom} x2={originX+(moveArrow.start.x+moveArrow.delta.x)*zoom} y2={originY+(moveArrow.start.y+moveArrow.delta.y)*zoom} markerEnd={`url(#${moveArrowId})`}/></svg>:null}
      {cursor && showTransformationValues && ((selectionRef.current?.kind==="marquee" && box) || (moveRef.current && moveOffset.current && !pendingMove.current && clickRef.current?.moved)) ? <span className="photo-editor-canvas__measurement" style={{left:cursor.local.x+18,top:cursor.local.y+30}}>{selectionRef.current?.kind==="marquee" && box ? `宽 ${formatMeasurement(box.width,measurementUnit,resolutionDpi,documentWidth,pointPicaSize)} · 高 ${formatMeasurement(box.height,measurementUnit,resolutionDpi,documentHeight,pointPicaSize)}` : `ΔX ${formatMeasurement(Math.round(moveOffset.current!.x),measurementUnit,resolutionDpi,documentWidth,pointPicaSize)} · ΔY ${formatMeasurement(Math.round(moveOffset.current!.y),measurementUnit,resolutionDpi,documentHeight,pointPicaSize)}`}</span> : null}
      {cursor && FeedbackIcon && (tool==="marquee" || tool==="lasso") ? <span className="photo-editor-canvas__selection-feedback" data-selection-feedback={selectionMove.current==="pixels"?"dragging":selectionHover==="pixels"?feedbackKeys.alt?"copy":"cut":feedbackMode} style={{left:cursor.local.x+12,top:cursor.local.y+12}}><FeedbackIcon size={14}/></span> : null}
      {resizeValues && resizeRef.current ? <div className="photo-editor-canvas__brush-resize" style={{left:resizeRef.current.local.x,top:resizeRef.current.local.y}} data-testid="brush-resize-hud">
        <div className="photo-editor-canvas__brush-cursor" style={{left:0,top:0,width:Math.max(2,resizeValues.size*zoom),height:Math.max(2,resizeValues.size*zoom)}}><span style={{width:`${resizeValues.hardness*100}%`,height:`${resizeValues.hardness*100}%`,opacity:resizeValues.opacity}}/></div>
        <span className="photo-editor-canvas__measurement" style={{left:18,top:18}}>直径 {resizeValues.size} px · {resizeRef.current.hardness?"硬度":"不透明度"} {Math.round((resizeRef.current.hardness?resizeValues.hardness:resizeValues.opacity)*100)}%</span>
      </div>:null}
      {cursor && !resizeValues && strokeAnchor && feedbackKeys.shift && !feedbackKeys.alt && !feedbackKeys.mod && !pathRef.current && !sampling && (tool==="brush" || tool==="pencil" || tool==="eraser") ? <svg className="photo-editor-canvas__selection" data-testid="stroke-line-preview"><path d={`M${originX+strokeAnchor.x*zoom} ${originY+strokeAnchor.y*zoom}L${cursor.local.x} ${cursor.local.y}`}/></svg>:null}
      {cursor && !resizeValues && !sampling && !samplingRef.current && paintingTool && cursorTip.mode==="outline" ? <div className="photo-editor-canvas__brush-cursor" data-brush-cursor={cursors.painting}
        style={{left:cursor.local.x,top:cursor.local.y,borderRadius:cursorTip.block?0:undefined,width:cursorTip.diameter,height:cursorTip.diameter}}>{cursorTip.center?<span className="photo-editor-canvas__brush-center"/>:null}</div>:null}
      {cursor && !resizeValues && !sampling && !samplingRef.current && paintingTool && cursorTip.mode==="standard"?<span className="photo-editor-canvas__tool-cursor" style={{left:cursor.local.x,top:cursor.local.y}}>{tool==="eraser"?<EraserIcon size={16}/>:tool==="pencil"?<PencilIcon size={16}/>:<PenIcon size={16}/>}</span>:null}
      {cursor && samplingRef.current && sampleBase && samplingColors?.current?<svg className="photo-editor-canvas__sample-ring" data-sample-ring="true" style={{left:cursor.local.x-32,top:cursor.local.y-32}} width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke={sampleBase} strokeWidth="10"/><circle cx="32" cy="32" r="26" fill="none" stroke={samplingColors.current} strokeWidth="10" strokeDasharray="81.682 163.364" transform="rotate(180 32 32)"/></svg>:null}
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
      {zoomBox?<svg className="photo-editor-canvas__selection" data-zoom-rectangle=""><rect x={zoomBox.x} y={zoomBox.y} width={zoomBox.width} height={zoomBox.height}/></svg>:null}
      {renderOverlay?.({x:originX,y:originY},zoom)}
      {showScrollbars?<ViewportScrollbars ref={scrollbarRef} view={view.viewport} width={stageSize.width} height={stageSize.height} documentWidth={documentWidth} documentHeight={documentHeight} overscroll={overscroll} disabled={!canInteract || pointerRef.current!==null || transforming || pinching} onChange={next=>{stopMotion();publishView(next);}} onGestureChange={setScrolling}/>:null}
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
