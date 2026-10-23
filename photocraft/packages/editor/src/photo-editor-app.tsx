import { useCanvasLasso } from "./features/selections/canvas-lasso.js";
import { useCanvasCrop } from "./features/composition/canvas-crop.js";
import { featureMenuCommands } from "./features/menu-commands.js";
import { PaintingContextOptions } from "./features/painting/context-options.js";
import { toolFamily } from "./features/tool-groups.js";
import { PaintingControlsContext } from "./features/painting/controls-context.js";
import { SmartChildEditor } from "./features/smart/child-editor.js";
/**
 * PhotoCraft 图像编辑器界面（React）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2–3.6 / design D1/D2/D3）。
 *
 * 这是我们自己的**全量前端**：工具栏、工具参数、图层面板、历史、状态条与透明交互层都是 React 组件；
 * 功能通过 `EditorWorkspaceController` 的命令与受控草稿接口调用 Rust 内核，没有任何
 * egui/iframe。
 *
 * 交互边界：
 * - 选择图层 → `layer.select` 或内核受控 `beginMove` 自动命中接口；
 * - 显隐/不透明度/混合/重命名 → `layer.setProps`；
 * - 选框/套索/羽化 → `select.rect` / `select.lasso` / `select.modify.feather`（画布手势只提供
 *   文档坐标，参数由 [photo-editor-tools.ts] 编译）；
 * - 画笔/橡皮 → `paint.stroke`；蒙版 → `layer.layerMask.*`；
 * - 原位文字 → beginText/previewText/commitText/cancelText；调整层 → `layer.newAdjustmentLayer.*`；
 * - 整图旋转/翻转 → `image.imageRotation.*`；图层旋转/翻转 → `edit.transform.*`。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import {LayerStyleEditor} from "./layer-style-editor.js";
import { ViewAidsOverlay, type CanvasAids } from "./view-aids-overlay.js";
import { createGuideGesture, type ViewDrag } from "./features/views/guide-gesture.js";
import { activePlacement, consumePlacement, subscribePlacement } from "./features/views/placement.js";
import { publishHover } from "./features/views/hover.js";
import { paneViewport, splitPanes, syncPaneViewports, type PaneSource } from "./features/views/panes.js";
import { ViewPanes } from "./features/views/panes-view.js";
import type { EditorViewport } from "./viewport.js";


import { useLayerPropertiesEditing } from "./use-layer-properties-editing.js";
import { useNewLayerDialog } from "./new-layer-dialog.js";
import {useEditorDisplay,type EditorDisplayControls,type EditorDisplayAction} from "./editor-display.js";
import { useAdjustmentEditing } from "./use-adjustment-editing.js";
import {EditorSidebar} from "./editor-sidebar.js";
import {DEFAULT_PANEL_LAYOUT,type EditorPanelLayout} from "./editor-panel-layout.js";
import {ChevronDownIcon,ChevronRightIcon,ZoomInIcon,ZoomOutIcon} from "./ui/icons.js";
import { SelectionModeButtons, ToolOptionsPanel, type PhotoEditorProperty } from "./photo-editor-tool-options.js";
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";
export { ToolOptionsPanel } from "./photo-editor-tool-options.js";
import { useTextEditing } from "./use-text-editing.js";
import { FEATURE_SECTIONS, FEATURE_PANELS } from "./features/index.js";
// 构图域的画布叠加层（裁剪框 / 整图旋转预览 / 变形网格）：组件自己订阅域状态，没活跃叠加层时不渲染。
import { MountedCompositionOverlay } from "./features/composition/index.js";
import type { RecentFileEntry, RecentFileStore } from "@woohaa3/photocraft-protocol";
import { isQuickMaskCommand } from "./features/selections/draft-state.js";
import { disarmCanvasPick, takeCanvasPick } from "./features/selections/canvas-pick.js";
const { RetouchPanel, LayerFilterPanel } = FEATURE_PANELS;
import {
  PathOverlay,
  RETOUCH_MENU_TOOLS,
  usePathDraft
} from "./editor-tool-panels.js";
import { CloneSourceOverlay, RETOUCH_COMMANDS, cloneStrokeSource, regionGestureKind as retouchRegionKind } from "./features/retouch/index.js";
import { TextInputOverlay } from "./text-input-overlay.js";
import { LiveStrokePreview } from "./live-stroke-preview.js";
import {SourceDetailPreview,type DetailFrame} from "./source-detail-preview.js";
import { usePaintTools, mergeBrushPatch } from "./paint-tool-state.js";
import { usePaintingGestureSettings } from "./features/painting/gesture-settings.js";
import { decodeSampledColor } from "./features/painting/tool-modes.js";
import { TransformSession } from "./transform-session.js";
import { IDENTITY_MATRIX, frameCenter, type TransformPoint } from "./transform-layer.js";
import { Button, IconButton } from "./ui/Button.js";
import { EditorCanvasMenu } from "./photo-editor-context-menu.js";
import { EditorWorkspaceController } from "./editor-workspace.js";
import type { EditorDialogPort } from "./ports.js";
import { isRetouchTool } from "./photo-editor-tools.js";
import type { EditorDocumentsMenu } from "./photo-editor-menu.js";
import { EditorMenuBar, EditorToolRail, PHOTO_TOOLS, type EditorFeaturePanel, type PhotoEditorTool } from "./photo-editor-chrome.js";
import { requestInterchange, requestExportPreset } from "./features/io/menu-request.js";
import { TransformOptions } from "./layer-transform-ui.js";
import { PhotoCanvas, type PhotoCanvasHandle, type PhotoCanvasView } from "./photo-editor-canvas.js";
import { useVectorGesture } from "./features/vectors/canvas-bridge.js";
import { VECTOR_TOOLS } from "./features/vectors/vector-tools.js";
import { presetChoice, subscribePresetChoice } from "./features/vectors/preset-selection.js";
import { pathChoice, subscribePathChoice } from "./features/vectors/path-selection.js";
import { setShapeToolOptions, shapeToolOptions, subscribeShapeToolOptions } from "./features/vectors/shape-options.js";

/** 画布工具白名单里的矢量工具 id（12 个），避免每次都线性查找。 */
const vectorToolIds = new Set<string>(VECTOR_TOOLS.map(vector => vector.id));
import { HistoryPanel, LayerPanel } from "./photo-editor-panels.js";
import {
  buildLasso,
  buildRectSelection,
  buildStroke,
  clampBrushSize,
  clampFeather,
  pointInSelection,
  type BrushSettings,
  type DocumentPoint,
  type EditorToolId,
  type SelectionMode
} from "./photo-editor-tools.js";
import type { EditorPreview,EditorPreviewRegion } from "./editor-wasm.js";
import { editorInputConsumesKeys, FILL_SHORTCUTS, isEditorMac, shortcutLabel, type EditorShortcut } from "./photo-editor-shortcuts.js";
import { useCustomizationPreferences } from "./features/customization/use-customization-preferences.js";
import { brushOptionValues, resolveWithPreferences, restoreBrushOptions, workspacePanelLayout } from "./features/customization/shell-adapter.js";
import { defaultCustomizationStore } from "./features/customization/preferences.js";
import "./photo-editor.css";

export type PhotoEditorAppProps = {
  display?:EditorDisplayControls;
  dialogs?: EditorDialogPort;
  controller: EditorWorkspaceController;
  canvasView: PhotoCanvasView;
  onPreview: (preview: EditorPreview, size: { width: number; height: number }) => void;
  onDetailPreview?:(frame:DetailFrame|null)=>void;
  /** 像素呈现端口：Woohaa 用 Bevy 节点，独立宿主用 Canvas。 */
  renderCanvasBackground?: (origin: { x: number; y: number }, zoom: number) => ReactNode;
  /** 只读历史预览时禁止写操作。 */
  readonly?: boolean;
  onApply?: () => void | Promise<void>;
  /** 正在执行「返回保存」，禁用重复触发。 */
  closing?: boolean;
  /**
   * 文档菜单能力（change: 2026-10-21-add-photocraft-document-workspace，D2）。
   *
   * 打开文件 / 关闭 / 文档清单属于菜单，不挂在文档标签条上。宿主提供时才显示「文件」菜单
   * 与「窗口 ▸ 文档清单」；PhotoCraft dev 宿主不提供，菜单保持原样。
   */
  documents?: EditorDocumentsMenu;
  /**
   * 申请独立文档槽位（change: 2026-10-22-add-photocraft-file-workflows，U01）。
   *
   * 一个编辑会话只有一个文档槽位；已有文档时再「新建」，必须由宿主另开一个文档/标签。
   * 宿主提供本端口时，新建会先产出**自包含工程字节**再交给它落地；不提供时新建入口按
   * 「当前会话为空才能建」如实禁用，不会让用户点了才吃内核拒绝。
   */
  onRequestDocumentSlot?: (input: { bytes: Uint8Array; name: string }) =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 最近文件索引与重开端口（change: 2026-10-22-add-photocraft-file-workflows，U04）。
   *
   * 字节由宿主持有；本域不缓存内容、不把文件名当路径权限。省略 `recentFiles` 表示宿主没有
   * 该能力（不渲染本区，也不伪造空列表）；传 `null` 表示宿主明确报告不可用。
   */
  recentFiles?: RecentFileStore | null;
  /**
   * 最近文件索引的本机持久化诊断（U04）。
   *
   * 记录可以跨会话保留而字节不能；**持久化失败**同样必须让用户看到，否则列表看起来正常、
   * 刷新后却全部消失。
   */
  recentFilesError?: string | null;
  onReopenRecent?: (entry: RecentFileEntry) => Promise<{ ok: true } | { ok: false; reason: string }>;
  onRemoveRecent?: (id: string) => void;
  /**
   * 逐条回答「这条记录现在还有字节可重开吗」。
   *
   * 记录可以跨会话保留而字节不能（浏览器不授予路径权限）：宿主必须逐条回答，
   * 界面据此显示「需重新选择」，而不是点一次才发现打不开。
   */
  hasRecentBytes?: (entry: RecentFileEntry) => boolean;
  /**
   * 应用一条导出预设（U04）。
   *
   * 导出参数预设的实现/校验/存储归栅格交换域；宿主在此把选择转交给它的面板/会话，
   * 编辑器核心只做转交，不读取也不解释导出设置。
   */
  onApplyExportPreset?: (preset: { name: string; settings: unknown }) => void;
};

/**
 * 编辑器界面。组件只消费控制器的快照，不直接持有内核。
 *
 * 预览在每次修订变化后重新取一次；`previewSide` 固定，避免每帧调用内核。
 */
export function PhotoEditorApp({ controller, canvasView, onPreview, onDetailPreview, renderCanvasBackground, readonly = false, onApply, closing = false, dialogs, display: controlledDisplay, documents, onRequestDocumentSlot, recentFiles, recentFilesError, onReopenRecent, onRemoveRecent, hasRecentBytes, onApplyExportPreset }: PhotoEditorAppProps) {
  const localDisplay=useEditorDisplay();
  const display=controlledDisplay??localDisplay;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller])
  );
  // 本机偏好（快捷键/工具栏/菜单/工作区）：订阅后才能让改键位等设置立刻影响按键分派与渲染。
  const customizer = useCustomizationPreferences();
  const editorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<PhotoCanvasHandle>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailVersion,setDetailVersion]=useState(0);
  const detailRegions=useRef<EditorPreviewRegion[]|undefined>();
  const localDetailUpdate=useRef(false);
  const detailFailure=useRef<(message:string)=>void>(()=>{});
  const previewContext=useRef(canvasView);previewContext.current=canvasView;
  const details=useMemo(()=>new SourceDetailPreview(region=>controller.renderRegion(region),frame=>onDetailPreview?.(frame?{...frame,onUploadFailure:()=>detailFailure.current("图片细节上传失败，已保留基础预览，可重试")} :null),message=>detailFailure.current(message)),[controller,onDetailPreview]);
  useEffect(()=>()=>details.dispose(),[details]);

  // 画布工具与其参数（纯界面状态，不复制文档模型）。
  const [tool, setTool] = useState<PhotoEditorTool>("marquee");
  const [textToolProperties, setTextToolProperties] = useState(false);
  const [autoSelect, setAutoSelect] = useState(true);
  const nudge = useRef<{dx: number; dy: number} | null>(null);
  const previousTool = useRef<PhotoEditorTool>("marquee");
  const [selectionTransform, setSelectionTransform] = useState(false);
  const [transformMatrix, setTransformMatrix] = useState<readonly number[]>(IDENTITY_MATRIX);
  const [transformLinked, setTransformLinked] = useState(true);
  const [transformReference, setTransformReference] = useState<TransformPoint>();
  const [transformValid, setTransformValid] = useState(true);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("replace");
  const [ellipse, setEllipse] = useState(false);
  const [feather, setFeather] = useState(0);
  const [tolerance, setTolerance] = useState(32);
  const [sampleAllLayers, setSampleAllLayers] = useState(false);
  const [contiguous, setContiguous] = useState(true);
  const [retouchTool, setRetouchTool] = useState("paint.spotHealing");
  const [sampleNext, setSampleNext] = useState(false);
  const retouchAnchor = useRef<[number, number] | null>(null);
  const [retouchAligned, setRetouchAligned] = useState(true);
  const [retouchSample, setRetouchSample] = useState<[number, number] | null>(null);
  const pathDraft = usePathDraft();
  const [penTarget, setPenTarget] = useState("shape");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openFeaturePanels, setOpenFeaturePanels] = useState<EditorFeaturePanel[]>(() => FEATURE_SECTIONS.filter(section => display.state.panelLayout?.activePanel === `feature.${section.id}` || display.state.panelLayout?.detachedPanels?.[`feature.${section.id}`]).map(section => section.id));
  const [panelRequest, setPanelRequest] = useState<{panel: string; command: string; sequence: number}>();
  const [filteredLayerIds, setFilteredLayerIds] = useState<number[] | null>(null);
  const [aidsVersion, setAidsVersion] = useState(0);
  const updateAids = useCallback(() => setAidsVersion(value => value + 1), []);
  const view = snapshot.view;
  const documentView = view.document;
  const {brush:paintBrush,setBrush,colors,setColor,setBackground,colorAction,percent,resetDigits} = usePaintTools(tool,snapshot.view.document?.editTarget);
  // 绘画域工具设置（任务 3.4）：canvasTool 白名单、拖动/单击/渐变/吸管分支都从这里编译命令。
  const painting = usePaintingGestureSettings(documentView?.width ?? 0, documentView?.height ?? 0);
  const [altHeld,setAltHeld] = useState(false);
  const strokeAnchor = useRef<{point:DocumentPoint;key:string} | null>(null);
  const strokeEnd = useRef<{point:DocumentPoint;key:string} | null>(null);
  /** 本域拖动类工具的起点/终点与已收集点位（渐变只要两端，铅笔等要整条轨迹）。 */
  const paintStroke = useRef<{ tool: string; points: DocumentPoint[] } | null>(null);

  const smartChild = typeof controller.smartChildController === "function" ? controller.smartChildController() : null;
  const viewAids = useMemo(() => {
    const result = controller.viewAids?.();
    return result?.ok ? result.value as CanvasAids : {};
  }, [controller, aidsVersion]);
  const guideSnapshot = useMemo(() => {
    const result = controller.vectorSnapshot?.();
    return result?.ok ? (result.value as {guides?: {horizontal?: number[]; vertical?: number[]}}).guides ?? {} : {};
  }, [controller, documentView?.revision, aidsVersion]);
  // 参考线/原点拖动（U70）：命中与反算在内核，几何草稿只在拖动期间存在。
  const [guideDrag, setGuideDrag] = useState<ViewDrag | null>(null);
  // 并排双视图（U72）：只有活动视图用宿主视口，其它视图各自记住取景。
  const [paneViewports, setPaneViewports] = useState<Record<string, EditorViewport>>({});
  const panes = useMemo(() => splitPanes(viewAids as PaneSource), [viewAids]);
  /**
   * 让非活动窗格**锁住**自己的取景。
   *
   * 不这样做就会出现一个真实缺陷：非活动窗格没有记录时退回宿主视口，于是用户平移活动画布时
   * 另一块画布跟着一起动——「取景独立」名存实亡。这里让每个窗格在第一次出现时把当时的取景
   * 记下来，此后只有活动窗格继续跟随宿主。没有变化时返回同一个引用，不会自激重渲染。
   */
  useEffect(() => {
    if (!panes) return;
    setPaneViewports((current) => syncPaneViewports(panes, current, canvasView.viewport));
  }, [panes, canvasView.viewport]);
  const activeViewId = (viewAids as { activeView?: string }).activeView;
  // 内核记录的每个视图（取景/旋转）。叠加层按各自视图的旋转画，避免两个窗格共用一份角度。
  const paneViews = (viewAids as { views?: ReadonlyArray<{ id: string; label: string; zoom: number; offset: [number, number]; rotation: number; active: boolean }> }).views ?? [];
  /**
   * 点非活动窗格：先记住即将离开的窗格此刻的取景，再把目标窗格正显示的那份取景交给宿主，
   * 最后在内核切换活动视图。顺序很重要——先交接取景再切，画面不会跳一下。
   */
  const activatePane = useCallback((viewId: string) => {
    const target = panes?.find((pane) => pane.id === viewId);
    if (!target || target.active) return;
    const leaving = panes?.find((pane) => pane.active);
    // 目标窗格**此刻显示**的取景（不是它内核里的记录）：激活后画面必须完全不跳。
    const handoff = paneViewport(target, canvasView.viewport, paneViewports);
    if (leaving) setPaneViewports((current) => ({ ...current, [leaving.id]: canvasView.viewport }));
    // 先交接取景再切活动视图：反过来会让状态栏在新旧之间闪一下。
    canvasView.onChange(handoff);
    const result = controller.setViewAids?.({ viewAction: "activate", viewId });
    if (result && !result.ok) setMessage(result.message);
    updateAids();
  }, [controller, panes, canvasView, paneViewports, updateAids]);
  /**
   * Info 跟随光标（U73）：指针事件很密，按 ~25Hz 节流后再跨到内核；读数一律由内核给出。
   *
   * 非活动视图的读数会被内核以「不是活动视图」拒绝，此时**清空**而不是留着上一个像素——
   * 面板宁可显示「—」，也不能拿另一处的读数冒充光标下这个位置。
   */
  const probeRef = useRef(0);
  const probeCanvas = useCallback((client: [number, number] | null, viewId?: string) => {
    if (!client) { publishHover(null); return; }
    const views = controller.features?.views;
    if (!views || typeof views.viewPointer !== "function") return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - probeRef.current < 40) return;
    probeRef.current = now;
    const result = views.viewPointer("probe", client, viewId ? { viewId } : {});
    if (!result.ok || result.value.kind !== "probe") { publishHover(null); return; }
    publishHover(result.value.probe);
  }, [controller]);
  // 换文档/卸载时读数必须失效：旧文档的像素不能留在面板上。
  useEffect(() => () => publishHover(null), [documentView?.name]);
  /**
   * 画布真实取景 → 内核视图变换（U72/U73）。
   *
   * 参考线命中/拖动、Info 读数与标尺都经内核的 `ViewTransform` 反算；只把「缩放」告诉内核、
   * 不告诉它平移到哪，画布一平移这些读数就会整体偏。这里在取景真的变化时才写一次（画布已经
   * 按值去重），并且只写 zoom/offset，不碰旋转与活动视图。
   */
  const frameSync = useRef("");
  const syncFrame = useCallback((viewId: string, origin: { x: number; y: number }, zoom: number) => {
    const key = `${viewId}:${origin.x}:${origin.y}:${zoom}`;
    if (frameSync.current === key) return;
    frameSync.current = key;
    controller.setViewAids?.({ viewId, zoom, offset: [origin.x, origin.y] });
  }, [controller]);
  // 面板发起的「在画布上点一下」请求（U73 计数/注释落点）：一次性，消费即清。
  const [placement, setPlacement] = useState(() => activePlacement());
  useEffect(() => subscribePlacement(() => setPlacement(activePlacement())), []);
  const guideGesture = useMemo(() => {
    const snapshot = controller.features?.views?.viewSnapshot;
    const identity = typeof snapshot === "function"
      ? (() => { const result = snapshot.call(controller.features.views); return result?.ok && result.value && typeof result.value === "object" ? (result.value as { document?: { id?: number } }).document?.id : undefined; })()
      : undefined;
    const active = viewAids as { activeView?: string; lockGuides?: boolean };
    return createGuideGesture(controller, identity, active?.activeView, active?.lockGuides);
  }, [controller, documentView?.revision, aidsVersion]);
  const brush={...paintBrush,target:documentView?.editTarget ?? "pixels"};
  /**
   * 通道面板的当前目标：RGB 分量交给内核按 `channel_view` 限制，Alpha/专色必须显式落笔。
   *
   * 上游 `inject_target` 只在调用方没有 `target` 时注入，而笔刷总会带 `target`，所以
   * Alpha/专色必须在这里把索引显式传给 `buildStroke`，否则笔迹会静默写到图层像素上。
   */
  const channelTarget = documentView?.channelTarget ?? { kind: "composite" as const };
  const channelStrokeIndex = channelTarget.kind === "alpha" ? channelTarget.index : undefined;
  // 工具选项记忆（U78）：切到画笔类工具时恢复上次设置。只改工具状态，不写文档、不造 dirty。
  const restoredTool = useRef<PhotoEditorTool | null>(null);
  useEffect(() => {
    if (tool !== "brush" && tool !== "eraser") return;
    if (restoredTool.current === tool) return;
    restoredTool.current = tool;
    // 只覆盖有记忆的数值字段；没记忆时原样保留当前设置。
    setBrush(current => restoreBrushOptions(customizer, tool, current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  useEffect(() => {
    if (tool !== "brush" && tool !== "eraser") return;
    defaultCustomizationStore().rememberToolOptions(tool, brushOptionValues(brush));
    // 只记忆数值字段（尺寸/硬度/不透明度/流量/平滑）；颜色与目标不持久化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, brush.size, brush.hardness, brush.opacity, brush.flow, brush.smoothing]);
  // 笔刷库是可选端口：精简宿主/测试替身可以不实现，界面退化为只有基础画笔参数。
  const brushLibrary = useMemo(
    () => (typeof controller.brushLibrary === "function" ? controller.brushLibrary() : null),
    [controller]
  );
  useEffect(() => {
    // 库是工具状态：只有进入可写编辑后恢复一次，失败保留默认库并提示。
    if (brushLibrary && snapshot.state.phase === "editing" && !brushLibrary.snapshot().list) void brushLibrary.restore();
  }, [brushLibrary, snapshot.state.phase]);
  const activeLayerId = documentView?.activeLayerId ?? null;
  useEffect(() => { strokeAnchor.current = null; strokeEnd.current = null; resetDigits(); }, [activeLayerId,tool,brush.target,channelStrokeIndex,resetDigits]);
  const activeLayer = documentView?.layers.find((layer) => layer.id === activeLayerId);
  useEffect(() => {
    if (activeLayer?.textStyle) textEditing.setPreference(activeLayer.textStyle);
  }, [activeLayer]);
  const layerParam = useMemo(() => (activeLayerId === null ? {} : { layer: activeLayerId }), [activeLayerId]);

  const refreshPreview = useCallback(() => {
    localDetailUpdate.current=false;detailRegions.current=undefined;
    // 同步取消旧块读取；不能等待 React effect 才隔离同帧到达的新草稿。
    details.clear();
    // 通道面板查看单通道（RGB 分量/Alpha/专色/图层蒙版）时，主画布显示该通道的灰度视图；
    // 复合目标仍走合成预览，因此默认路径的行为与像素完全一致。
    const view = controller.snapshot().view.document;
    const channelView = view && view.channelTarget.kind !== "composite"
      ? controller.features.channels.channelViewPreview(2048)
      : null;
    const rendered = channelView?.ok ? channelView : controller.render(2048);
    const document = controller.snapshot().view.document;
    if (rendered.ok && document) onPreview(rendered.value, { width: document.width, height: document.height });
    setDetailVersion(value=>value+1);
  }, [controller, onPreview, details]);
  detailFailure.current=message=>{if(localDetailUpdate.current)refreshPreview();setMessage(message);};
  const refreshStroke=useCallback(()=>{
    const context=previewContext.current;
    const document=controller.snapshot().view.document;
    // 修饰笔迹（U37/U38/U39）不维护共享画笔的 `stroke_damage`：它在内核里走「基线 + 重放」，
    // 没有逐点脏区。此时局部刷新会拿到空脏区并早退，表现为「落笔成功、也是一步历史，但画面
    // 停在落笔前」。整幅重绘是唯一正确的刷新方式，不能把它当成「没有改动」跳过。
    if(controller.hasRetouch?.()) {refreshPreview();return;}
    if(!onDetailPreview || !document || !context.contentSize || context.transitioning ||
      !details.hasCoverage(document.width,document.height,{...context.contentSize,...context.viewport})) {refreshPreview();return;}
    const damage=controller.takeStrokeDamage();
    if(!damage.ok){refreshPreview();return;}
    if(!damage.value.length)return;
    details.pause();localDetailUpdate.current=true;
    detailRegions.current=[...(detailRegions.current??[]),...damage.value];
    setDetailVersion(value=>value+1);
  },[controller,details,onDetailPreview,refreshPreview]);

  const textEditing=useTextEditing(controller,refreshPreview,setMessage);
  const adjustmentEditing=useAdjustmentEditing(controller,activeLayer,refreshPreview,setMessage,readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing");
  const propertiesEditing=useLayerPropertiesEditing(controller,activeLayer,refreshPreview,setMessage,readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing");
  const {brightness,contrast,hue,saturation,lightness,points:curvePoints}=adjustmentEditing.values;
  const text=textEditing.style;
  const endText=(commit:boolean)=>{
    if (commit && locked) return;
    if (textEditing.finish(commit)) editorRef.current?.focus({preventScroll:true});
  };

  const liveStroke = useMemo(() => new LiveStrokePreview(controller, refreshPreview, setMessage,refreshStroke), [controller, refreshPreview,refreshStroke]);
  useEffect(() => () => liveStroke.cancel(), [liveStroke]);
  const transformSession = useMemo(() => new TransformSession(controller, refreshPreview, setMessage), [controller, refreshPreview]);
  useEffect(() => () => transformSession.cancel(), [transformSession]);
  const newLayer = useNewLayerDialog(dialogs, controller,
    readonly || closing || busy || canvasView.transitioning || !documentView ||
    snapshot.state.phase === "saving" || snapshot.state.phase === "freezing" ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || tool === "transform");

  // 修订变化 → 重新取预览（只读也一样，历史预览需要看到对应画面）。
  useEffect(() => {
    refreshPreview();
  }, [refreshPreview, documentView?.revision, documentView?.width, documentView?.height, channelTarget.kind, channelTarget.kind === "alpha" || channelTarget.kind === "color" ? channelTarget.index : null]);

  useEffect(()=>{
    // 单通道视图是内核灰度渲染，没有可叠加的合成细节块：清掉旧块，避免把合成像素贴到通道视图上。
    if(!onDetailPreview || !documentView || documentView.channelTarget.kind !== "composite" || !canvasView.contentSize || readonly || closing || canvasView.transitioning) {details.clear();return;}
    // 缩小或移出已有覆盖后，基础图也须包含当前半笔，才能安全撤回旧细节。
    if(localDetailUpdate.current && !details.hasCoverage(documentView.width,documentView.height,{...canvasView.contentSize,...canvasView.viewport})) {refreshPreview();return;}
    const regions=detailRegions.current;
    details.update({width:documentView.width,height:documentView.height,contentVersion:detailVersion,changedRegions:regions,
      keepPrevious:localDetailUpdate.current,immediate:localDetailUpdate.current,
      view:{...canvasView.contentSize,...canvasView.viewport}});
    if(detailRegions.current===regions)detailRegions.current=[];
  },[details,onDetailPreview,refreshPreview,detailVersion,documentView?.width,documentView?.height,canvasView.contentSize?.width,canvasView.contentSize?.height,
    canvasView.viewport.x,canvasView.viewport.y,canvasView.viewport.zoom,canvasView.transitioning,readonly,closing,
    documentView?.channelTarget.kind]);

  /** 供 `run()` 兜底改道使用：`toggleQuickMask` 定义在其后，避免环形依赖。 */
  const toggleQuickMaskRef = useRef<() => void>(() => undefined);

  const run = useCallback(
    (id: string, params: unknown = null) => {
      if (propertiesEditing.active) {setMessage("请先确认或取消图层属性编辑");return false;}
      if (adjustmentEditing.active) {setMessage("请先确认或取消调整参数编辑");return false;}
      if (textEditing.active) {setMessage("请先确认或取消文字编辑");return false;}
      if (readonly || busy || closing || newLayer.modalActive) {
        setMessage("只读预览不允许修改");
        return false;
      }
      // 兜底：上游 `select.editInQuickMaskMode` 一旦从菜单/脚本直达这里，会绕过本域草稿
      // （内核改了正式文档而选区域不知道有草稿）。统一改道本域会话，任何入口都进同一个草稿。
      if (isQuickMaskCommand(id)) {
        toggleQuickMaskRef.current();
        return true;
      }
      canvasRef.current?.cancelGesture();
      if (id === "layer.new.layer" && params === null) {
        const command = controller.snapshot().commands.get(id);
        if (!command?.allowed || !command.enabled) return false;
        const error = newLayer.open();
        setMessage(error);
        return error === null;
      }
      const fill = FILL_SHORTCUTS.find((entry) => entry.id === id);
      if (id === "edit.paste" && params === null && documentView) {
        const frame=documentView.selectionFrame;
        const {x,y,zoom}=canvasView.viewport;
        params={center:frame ? [(frame[0]+frame[2])/2,(frame[1]+frame[3])/2] : [documentView.width/2-x/zoom,documentView.height/2-y/zoom]};
      }
      const result = controller.dispatch(id, params === null && (fill || id === "edit.cut" || id === "edit.clear") ? {color:colors[fill?.source ?? "background"]} : params);
      setMessage(result.ok ? null : result.message);
      return result.ok;
    },
    [controller, readonly, busy, closing, textEditing.active, adjustmentEditing.active, propertiesEditing.active, newLayer.modalActive, newLayer.open, colors.foreground, colors.background, documentView, canvasView.viewport]
  );

  /**
   * 快速蒙版草稿是否在场（画笔是否改道的依据）。
   *
   * 刻意**按需读内核**而不是缓存到 ref/state：从面板进入快速蒙版不改变修订号，
   * 任何"修订变了再同步"的缓存都会漏掉面板那条路径，于是画布画笔继续写图层像素。
   * 只在按下/抬笔时各读一次，成本是一次 `selectionDraftStateJson()`。
   */
  const quickMaskDraft = useCallback((): { active: boolean; kind: string | null } => {
    const draft = controller.features?.selections?.draftState?.();
    const value = draft?.ok ? (draft.value as { active?: boolean; kind?: string }) : null;
    return { active: value?.active === true, kind: value?.kind ?? null };
  }, [controller]);

  /**
   * 快速蒙版（Q）的**唯一**入口：必须经本域会话，不能走 `run()`。
   *
   * `select.editInQuickMaskMode` 若直接 `dispatch`，内核会改正式文档而选区域不知道有草稿：
   * 之后 `paintQuickMask` 报"没有活动的快速蒙版会话"、`saveProject` 却照常成功，用户被卡在
   * 既画不了也退不出的状态。经 `features.selections.*` 才能和面板的预览/确认/取消共用同一草稿，
   * 并让保存/切标签/关闭的统一门禁看到它。
   */
  const toggleQuickMask = useCallback(() => {
    const selections = controller.features?.selections;
    if (!selections?.beginQuickMask || !selections?.exitQuickMask) {
      setMessage("当前运行时缺少快速蒙版能力");
      return;
    }
    if (readonly || busy || closing) { setMessage("只读预览不允许修改"); return; }
    const draft = quickMaskDraft();
    // 草稿已开时按"确认并转回选区"退出；这与 Q 再按一次的桌面语义一致。
    if (draft.active) {
      if (draft.kind !== "quickMask") { setMessage("请先确认或取消当前选区草稿"); return; }
      const exited = selections.exitQuickMask(false);
      setMessage(exited.ok ? null : exited.message);
      if (exited.ok) refreshPreview();
      return;
    }
    const entered = selections.beginQuickMask();
    setMessage(entered.ok ? null : entered.message);
    if (!entered.ok) return;
    // 进入后自动切到画笔：快速蒙版唯一可用的输入就是笔迹，留在选框工具上会让人以为没反应。
    // 只在当前不是可画工具时切，避免抢掉用户已经选好的画笔/橡皮。
    if (tool !== "brush" && tool !== "eraser") setTool("brush");
    refreshPreview();
  }, [controller, readonly, busy, closing, refreshPreview, quickMaskDraft, tool]);
  toggleQuickMaskRef.current = toggleQuickMask;

  /**
   * 本次手势已经画进临时通道的点数。
   *
   * `onStrokeMove` 已经逐批发送过，抬笔的 `onStroke` 会收到**完整**路径；不去重就会把整条笔迹
   * 再画一遍，半透明笔会明显变深。
   */
  const quickMaskPainted = useRef(0);
  /** 尚未落笔的点位（按动画帧合并，见 `paintQuickMaskPoints`）。 */
  const quickMaskPending = useRef<DocumentPoint[]>([]);
  const quickMaskFrame = useRef<number | null>(null);

  /**
   * 真正落笔：点位/笔刷原样交给本域 `paintQuickMaskStroke`。
   *
   * 目标字段与黑白归并都由域内一处决定，共享外壳不再自己拼一份内核参数。
   */
  const flushQuickMask = useCallback(() => {
    quickMaskFrame.current = null;
    const points = quickMaskPending.current;
    quickMaskPending.current = [];
    const selections = controller.features?.selections;
    if (!selections?.paintQuickMaskStroke || points.length === 0) return;
    // 橡皮擦在快速蒙版里等于"遮出"：强制黑笔，否则会按前景色画成加选。
    const result = selections.paintQuickMaskStroke(points, tool === "eraser" ? { ...brush, color: "#000000" } : brush);
    if (result.ok) quickMaskPainted.current += points.length;
    setMessage(result.ok ? null : result.message);
    if (result.ok) refreshPreview();
  }, [controller, brush, tool, refreshPreview]);

  /**
   * 按动画帧合并点位后落笔。
   *
   * 实测一次 `paintQuickMask` ≈ 5.3ms、一次全量重渲染 ≈ 15.3ms；笔事件按 120Hz+ 到达时逐批提交
   * 必然掉帧。合并到一帧只多几毫秒延迟，落笔顺序与最终掩码完全一致。
   */
  const paintQuickMaskPoints = useCallback((points: readonly DocumentPoint[]) => {
    if (points.length === 0) return;
    quickMaskPending.current.push(...points);
    if (quickMaskFrame.current !== null) return;
    quickMaskFrame.current = requestAnimationFrame(() => flushQuickMask());
  }, [flushQuickMask]);
  // 卸载时不能丢下已采样但未落笔的点位。走 ref 是为了只在真正卸载时结算，
  // 而不是每次换笔刷/工具（dep 变化）都触发一次"结算"。
  const flushQuickMaskRef = useRef(flushQuickMask);
  flushQuickMaskRef.current = flushQuickMask;
  useEffect(() => () => {
    if (quickMaskFrame.current !== null) cancelAnimationFrame(quickMaskFrame.current);
    quickMaskFrame.current = null;
    if (quickMaskPending.current.length) flushQuickMaskRef.current();
  }, []);

  // 画布手势 → 命令参数（编译在 photo-editor-tools.ts，这里只做提交）。
  const applyMarquee = useCallback(
    (rect: { x: number; y: number; width: number; height: number }, mode = selectionMode) => {
      run("select.rect", buildRectSelection(rect, { mode, ellipse, feather }));
    },
    [ellipse, feather, run, selectionMode]
  );
  const applyLasso = useCallback(
    (points: { x: number; y: number }[], mode = selectionMode) => {
      const params = buildLasso(points, { mode, feather });
      if (!params) {
        setMessage("套索至少需要三个点");
        return;
      }
      run("select.lasso", params);
    },
    [feather, run, selectionMode]
  );
  /**
   * 绘画域拖动工具的整笔提交（任务 3.4）。
   *
   * 与画笔/橡皮不同，这些工具**不使用**共享临时笔迹（`beginStroke`）：它们各自的命令一次
   * 接受完整点列表，草稿语义由内核的「一条命令 = 一步历史」保证。因此这里只收集点位，抬笔时
   * 编译一次参数并走域像素通道（草稿门 + 冻结门 + `afterWrite`）。
   */
  const paintToolIds = ["pencil", "colorReplacement", "backgroundEraser", "gradient"] as const;
  const isPaintStrokeTool = (id: string) => (paintToolIds as readonly string[]).includes(id);
  const paintPointToolIds = ["bucket", "magicEraser"] as const;
  const isPaintPointTool = (id: string) => (paintPointToolIds as readonly string[]).includes(id);

  /** 单击类工具：一次点按一个事务，不开共享临时笔迹。 */
  const commitPaintPoint = (point: DocumentPoint) => {
    const target = documentView?.editTarget === "mask" ? "mask" as const : "pixels" as const;
    const compiled = painting.compilePoint(tool, point, colors.foreground, { target });
    if (!compiled) { setMessage("工具参数非法：请检查容差/不透明度"); return false; }
    const result = controller.features.painting.paintCommand(compiled.id, compiled.params);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  };

  const beginPaintStroke = (point: DocumentPoint) => {
    paintStroke.current = { tool, points: [point] };
    return true;
  };

  const committedPaintStroke = () => {
    const draft = paintStroke.current;
    paintStroke.current = null;
    if (!draft) return false;
    const session = controller.features.painting;
    const target = documentView?.editTarget === "mask" ? "mask" as const : "pixels" as const;
    if (draft.tool === "gradient") {
      const from = draft.points[0], to = draft.points[draft.points.length - 1];
      // 起点/终点重合不提交（内核也会拒绝），提示而不是静默成功。
      if (!from || !to || (from.x === to.x && from.y === to.y)) { setMessage("渐变需要一条非零长度的拖动"); return false; }
      const compiled = painting.compileGradient(from, to, { target, zoom: canvasView.viewport.zoom });
      if (!compiled) { setMessage("渐变参数非法：请检查色标与不透明度"); return false; }
      const result = session.paintCommand(compiled.id, compiled.params);
      setMessage(result.ok ? null : result.message);
      return result.ok;
    }
    const compiled = painting.compileStroke(draft.tool, draft.points, colors.foreground, { target, zoom: canvasView.viewport.zoom });
    if (!compiled) { setMessage("工具参数非法：请检查尺寸/容差/颜色"); return false; }
    const result = session.paintCommand(compiled.id, compiled.params);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  };

  /** 当前修饰工具对应的命令（clone/heal 是画布工具，其余由「修饰」下拉选择）。 */
  const retouchCommand = (): string => tool === "clone" ? "paint.cloneStamp" : tool === "heal" ? "paint.healingBrush" : retouchTool;
  /**
   * 读活动仿制源槽位（多仿制源，U39）。
   *
   * 返回 `null` 表示宿主没有这个端口（精简装配/测试替身），调用方回退到 app 本地取样点。
   */
  const readCloneSlot = (): { source: [number, number] | null; anchor: [number, number] | null } | null => {
    const session = controller.features.retouch;
    if (typeof session.cloneSources !== "function") return null;
    const listed = session.cloneSources();
    if (!listed.ok) return { source: null, anchor: null };
    const state = listed.value;
    const slot = state.slots.find((entry) => entry.index === state.active) ?? state.slots[0] ?? null;
    return {
      source: slot?.source ? [slot.source[0], slot.source[1]] : null,
      anchor: slot?.anchor ? [slot.anchor[0], slot.anchor[1]] : null
    };
  };
  /**
   * 修饰工具的手势形态：`stroke` 走逐帧笔迹；区域命令（修补／内容识别移动／红眼）
   * 没有逐帧预览，由 `onRegionGesture` 的候选 → 确认入口处理。
   */
  const retouchGesture = (): "stroke" | "region-drag" | "region-click" | null => {
    if (!isRetouchTool(tool)) return null;
    const command = retouchCommand();
    const region = RETOUCH_COMMANDS.some(entry => entry.id === command && entry.gesture === "region");
    if (!region) return "stroke";
    return retouchRegionKind(command as never) === "click" ? "region-click" : "region-drag";
  };

  const beginStroke = (point: DocumentPoint, modifiers?: {shift:boolean}) => {
    if (readonly || busy || closing) return;
    if (tool === "wand" || tool === "quick") return;
    if (isPaintStrokeTool(tool)) { beginPaintStroke(point); return; }
    // 快速蒙版草稿在场时，画笔属于临时通道：这里显式改道，避免笔迹落进图层像素却仍显示"正在编辑选区"。
    if (quickMaskDraft().kind === "quickMask") {
      // 不在这里落笔：单击的唯一点位同样会进 `onStroke`，先画会造成半透明笔重复叠加。
      quickMaskPainted.current = 0;
      return;
    }
    if (isRetouchTool(tool)) {
      // 区域命令（修补／内容识别移动／红眼）没有逐帧预览：它们走 `onRegionGesture` 的
      // 候选 → 确认入口，绝不能落成一条普通笔迹。
      if (retouchGesture() !== "stroke") return;
      const command = retouchCommand();
      const needsSource = tool === "clone" || tool === "heal";
      // 仿制/修复的取样源以**活动仿制源槽位**为准（多仿制源，U39）。该规则在域内
      // `cloneStrokeSource` 里，共享文件只做一次调用：槽位有源时不要把 app 本地的旧取样点塞进
      // `source`，否则上游 `clone_source::resolve` 会用它盖掉槽位，切槽位等于没生效。
      const source = needsSource ? cloneStrokeSource(readCloneSlot(), retouchSample, point, retouchAligned) : null;
      if (source && "reason" in source) { setMessage(source.reason); return; }
      const params = buildStroke([point], brush, { zoom: canvasView.viewport.zoom, channel: channelStrokeIndex });
      if (!params) return;
      if (needsSource && !retouchAnchor.current) retouchAnchor.current = [point.x, point.y];
      setRetouchStroking(true);
      liveStroke.begin({ ...params, layer: activeLayerId, aligned: retouchAligned, ...(source ?? {}) }, command);
      return;
    }
    // 目标通道也属于锚点身份：切通道后 Shift 直线不能从上一个通道的落点连过来。
    const key = `${activeLayerId}:${tool}:${brush.target}:${channelTarget.kind === "alpha" ? channelTarget.index : channelTarget.kind}`;
    const anchor = strokeAnchor.current;
    const line = modifiers?.shift && anchor?.key === key;
    const params = buildStroke(line ? [anchor.point,point] : [point], line ? {...brush,smoothing:0} : brush, { erase: tool === "eraser", zoom: canvasView.viewport.zoom, channel: channelStrokeIndex });
    strokeEnd.current = params && liveStroke.begin(params) ? {point,key} : null;
  };

  const finishPath = () => {
    if (pathDraft.points.length < 3 || readonly || busy || closing) return;
    const path = { subpaths: [{ closed: true, knots: pathDraft.points }] };
    const result = penTarget === "shape" ? controller.vectorCommand("shape.create", {kind: "path", path, fill: colors.foreground, name: "路径形状"})
      : penTarget === "mask" ? controller.vectorCommand("layer.vectorMask.add", {...layerParam, path})
      : controller.vectorCommand("path.set", {name: "work", path});
    setMessage(result.ok ? null : result.message);
    if (result.ok) pathDraft.reset();
  };

  const applySave = useCallback(async () => {
    const save = documents?.onSave ?? onApply;
    if (!save) return;
    if (newLayer.modalActive) return;
    if (propertiesEditing.active) {setMessage("请先确认或取消图层属性编辑");return;}
    if (adjustmentEditing.active) {setMessage("请先确认或取消调整参数编辑");return;}
    if (textEditing.active) {setMessage("请先确认或取消文字编辑");return;}
    if (transformSession.active) { setMessage("请先确认或取消自由变换"); return; }
    canvasRef.current?.cancelGesture();
    setBusy(true);
    try {
      await save();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }, [onApply, documents?.onSave, transformSession, textEditing.active, adjustmentEditing.active, propertiesEditing.active, newLayer.modalActive]);

  const commands = snapshot.commands;
  // 真正不可写：只读、关闭中、忙碌、过渡或导出中。**不含「没有文档」**。
  const panelReadonly = newLayer.modalActive || readonly || closing || busy || canvasView.transitioning || snapshot.state.phase === "saving" || snapshot.state.phase === "freezing";
  // 当前文档不可写：除上述原因外，没有文档也算（多数面板在没有文档时本来无事可做）。
  const locked = panelReadonly || !documentView;

  // 矢量工具（U08–U16）：手势状态与命令提交都在域内归约器/桥里，应用层只提供参数与提示。
  const vectorShapeOptions = useSyncExternalStore(
    useCallback(listener => subscribeShapeToolOptions(listener), []),
    useCallback(() => shapeToolOptions(), [])
  );
  // Custom Shape 的当前预设也是工具状态：上下文栏要跟着面板的选择变（渲染期读 store 不会重渲）。
  const chosenPreset = useSyncExternalStore(
    useCallback(listener => subscribePresetChoice(listener), []),
    useCallback(() => presetChoice(), [])
  );
  // 路径目标同理：上下文栏必须显示画布真正会改的那条路径（面板与画布共用同一份选择）。
  const chosenPath = useSyncExternalStore(
    useCallback(listener => subscribePathChoice(listener), []),
    useCallback(() => pathChoice(), [])
  );
  const vectorBridge = useVectorGesture(controller, documentView, tool, {
    fill: colors.foreground,
    stroke: vectorShapeOptions.stroke,
    penTarget: penTarget === "mask" ? "mask" : penTarget === "path" ? "work" : "shape",
    layer: activeLayerId,
    canvas: [documentView?.width ?? 8192, documentView?.height ?? 8192],
    zoom: canvasView.viewport.zoom,
    shapeOptions: {
      radius: vectorShapeOptions.radius,
      sides: vectorShapeOptions.sides,
      starRatio: vectorShapeOptions.starRatio,
      weight: vectorShapeOptions.weight,
    },
    readonly: locked,
    onMessage: setMessage
  });
  const transforming = tool === "transform";
  const viewDisabled=locked;
  const displayDisabled=locked||textEditing.active||adjustmentEditing.active||propertiesEditing.active;
  const toggleDisplay=(action:EditorDisplayAction)=>{
    if(displayDisabled||canvasRef.current?.hasGesture()||nudge.current) return;
    display.toggle(action);
  };
  const canSave = !locked && !transforming && !textEditing.active && !adjustmentEditing.active && !propertiesEditing.active && !controller.hasActiveDraft() && (!!documents?.onSave || snapshot.state.dirty);
  const transformFrame = selectionTransform ? documentView?.selectionFrame : documentView?.transformFrame;
  const toolLabel = tool === "marquee" ? ellipse ? "椭圆选框" : "矩形选框" : transforming ? selectionTransform ? "变换选区" : "自由变换" : PHOTO_TOOLS.find((entry) => entry.id === tool)?.label;
  const readThumbnail=useCallback((layer:number,mask:boolean)=>controller.layerThumbnail(layer,mask),[controller]);
  const selectTarget=(layer: {id:number},mask:boolean,solo=false,mode:"replace"|"toggle"|"range"="replace") => {
    if (!run("layer.select",{layer:layer.id,mode})) return;
    if (mode!=="replace") return;
    if (!mask && !run("view.layerMask",{layer:layer.id,mode:"off"})) return;
    if (!run(mask ? "channel.target.layerMask" : "channel.target.composite")) return;
    setTextToolProperties(false);
    if (solo) run("view.layerMask",{layer:layer.id,mode:"toggleGray"});
    if (mask || documentView?.layers.find(row=>row.id===layer.id)?.kind==="adjustment") revealProperties();
  };
  /** 是否正在落一笔修饰笔迹（仿制源叠加框据此按「落笔时自动隐藏」决定画不画）。 */
  const [retouchStroking, setRetouchStroking] = useState(false);
  /**
   * 修饰面板的重读计数。
   *
   * 画布 Alt+单击取样、红眼单击都只改域会话的工具状态，不改文档：面板里 `useState` 存的是
   * 上次加载的快照，不会自己刷新。计数变化时换 key 让面板重新读一次，避免「画布已取样、
   * 面板还写着尚未设置采样点」这种两处说法不一致。
   */
  const [retouchPanelVersion, setRetouchPanelVersion] = useState(0);
  /**
   * 仿制源叠加取样框（U39）：只在仿制/修复工具下计算。
   *
   * 文档→容器坐标换算由共享画布提供（`origin` + `zoom`），这里只把它交给域会话；
   * 取样框几何、可见性（选项关闭／没有取样点／落笔自动隐藏）与不透明度都在
   * `clone-overlay.ts` 里判定一次，避免共享文件再解释一遍缩放/旋转/翻转。
   */
  const readCloneOverlay = (origin: { x: number; y: number }, zoom: number) => {
    if (tool !== "clone" && tool !== "heal") return null;
    const result = controller.features.retouch.cloneOverlayFrame(brush.size, retouchStroking, (point) => ({
      x: origin.x + point.x * zoom,
      y: origin.y + point.y * zoom
    }));
    return result.ok ? result.value : null;
  };
  const canvasLasso = useCanvasLasso(controller, tool, documentView?.width ?? 0, documentView?.height ?? 0, selectionMode, canvasView.viewport.zoom, refreshPreview, setMessage);
  const canvasCrop = useCanvasCrop(controller, documentView?.width ?? 0, documentView?.height ?? 0, refreshPreview, setMessage);
  const canvasTool: EditorToolId = tool === "hand" && !locked ? "pan" : !spaceHeld && !locked && !textEditing.active && !adjustmentEditing.active && !propertiesEditing.active && (tool === "crop" || tool === "polygon-lasso" || tool === "magnetic-lasso" || tool === "zoom" || tool === "move" || tool === "marquee" || tool === "lasso" || tool === "brush" || tool === "eraser" || tool === "text" || tool === "pen" || tool === "wand" || tool === "quick" || tool === "pencil" || tool === "colorReplacement" || tool === "backgroundEraser" || tool === "gradient" || tool === "bucket" || tool === "magicEraser" || tool === "eyedropper" || isRetouchTool(tool) || vectorToolIds.has(tool)) ? tool : spaceHeld ? "pan" : "none";
  const chooseTool = (next: PhotoEditorTool, selectionOnly = false) => {
    if (next !== tool && (canvasLasso.active || canvasCrop.active)) { setMessage("请先确认或取消当前工具操作"); return; }
    if (locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active) return;
    if (nudge.current) { nudge.current = null; endTransform(true); }
    if (next === "transform") {
      const frame = selectionOnly ? documentView?.selectionFrame : documentView?.transformFrame;
      if (!frame || !transformSession.begin(selectionOnly)) return;
      setSelectionTransform(selectionOnly);
      previousTool.current = tool;
      setTransformMatrix(IDENTITY_MATRIX);
      setTransformReference(frameCenter(frame));
      setTransformValid(true);
    }
    if(next==="text") revealProperties();
    setTextToolProperties(next==="text");
    setSampleNext(false);
    // 单击待命只对选区工具有效；换到画笔/文字后不该在下次回到选框时"意外"建行/取样。
    if (next !== "marquee" && next !== "lasso") disarmCanvasPick(controller);
    setTool(next);
  };
  const previewTransform = (matrix: number[]) => {
    if (tool === "move" && transformFrame && !selectionTransform && typeof controller.snapPoint === "function") {
      const [x, y] = transformFrame;
      const result = controller.snapPoint([x + (matrix[4] ?? 0), y + (matrix[5] ?? 0)], canvasView.viewport.zoom);
      if (result.ok) {
        const point = (result.value as { point?: number[] }).point;
        if (point?.length === 2) matrix = [...matrix.slice(0, 4), point[0] - x, point[1] - y];
      }
    }
    setTransformMatrix(matrix);
    transformSession.preview(matrix);
  };
  const endTransform = (commit: boolean) => {
    if (commit && locked) return;
    if (commit && !transformValid) { setMessage("变换参数无效，请修改后重试或取消"); return; }
    if (commit && !transformSession.commit()) {
      if (!transforming) { transformSession.cancel(); setTransformMatrix(IDENTITY_MATRIX); setSelectionTransform(false); }
      return;
    }
    if (!commit) transformSession.cancel();
    setTransformMatrix(IDENTITY_MATRIX);
    setTransformValid(true);
    setSelectionTransform(false);
    if (transforming) setTool(previousTool.current);
  };

  const releaseInput = useCallback(() => {
    if (nudge.current) { nudge.current = null; transformSession.cancel(); setTransformMatrix(IDENTITY_MATRIX); }
    if(!propertiesEditing.presetPickerActive()) propertiesEditing.finish(false);
    adjustmentEditing.finish(false);
    setSpaceHeld(false);
    setAltHeld(false);
    resetDigits();
    canvasRef.current?.cancelGesture();
  }, [transformSession,resetDigits,adjustmentEditing.finish,propertiesEditing.finish]);
  useEffect(() => {
    const element = editorRef.current;
    if (element && !element.closest("[hidden]")) element.focus({ preventScroll: true });
    const window_ = element?.ownerDocument.defaultView;
    window_?.addEventListener("blur", releaseInput);
    const document_ = element?.ownerDocument;
    const onVisibility = () => { if (document_?.hidden) {propertiesEditing.finish(false);releaseInput();} };
    document_?.addEventListener("visibilitychange", onVisibility);
    return () => {
      window_?.removeEventListener("blur", releaseInput);
      document_?.removeEventListener("visibilitychange", onVisibility);
    };
  }, [releaseInput]);
  useEffect(() => { if (locked) releaseInput(); }, [locked, releaseInput]);

  const applyShortcut = (action: EditorShortcut): void => {
    if(action.kind==="display") {toggleDisplay(action.action);return;}
    if (action.kind !== "paintPercent") resetDigits();
    if (action.kind === "view") { if (!viewDisabled) canvasRef.current?.view(action.action); return; }
    if (action.kind === "pan") {
      if (!canvasRef.current?.hasGesture()) setSpaceHeld(true);
      return;
    }
    if (adjustmentEditing.active || propertiesEditing.active) return;
    if (textEditing.active) {if (action.kind === "confirm") endText(true);return;}
    // 快速蒙版放在共享草稿门禁之后：其它受控草稿在场时不抢按键，由它们先结算。
    if (action.kind === "quickMask") { if (!locked && !canvasRef.current?.hasGesture()) toggleQuickMask(); return; }
    // `\` 只切查看状态（会话级、无内容历史），所以过共享 `run()` 是安全的；
    // 面板「切换叠加（\）」的文案由这一条兑现，而不只是一个按钮。
    if (action.kind === "maskOverlay") {
      if (!commands.get("layer.toggleMaskOverlay")?.enabled) return;
      run("layer.toggleMaskOverlay");
      return;
    }
    if (locked || canvasRef.current?.hasGesture()) return;
    if (action.kind === "confirm") { if (transforming) endTransform(true); return; }
    if (transforming) return;
    if (action.kind === "nudge") {
      if (tool !== "move" || !documentView?.transformFrame) return;
      if (!nudge.current) {
        if (!transformSession.begin()) return;
        nudge.current = {dx:0,dy:0};
      }
      nudge.current.dx += action.dx; nudge.current.dy += action.dy;
      previewTransform([1,0,0,1,nudge.current.dx,nudge.current.dy]);
      return;
    }
    if (nudge.current) { nudge.current = null; endTransform(true); }
    if (action.kind === "tool") {
      const group = toolFamily(action.tool).filter(id => PHOTO_TOOLS.some(entry => entry.id === id) && !customizer.toolbarHidden.includes(`tool.${id}`));
      const next = action.cycle && group.length > 1 ? group[(group.indexOf(tool) + 1) % group.length] : action.tool;
      chooseTool(next as PhotoEditorTool);
      if (action.cycle && action.tool === "marquee") setEllipse((current) => !current);
    } else if (action.kind === "color") {
      colorAction(action.action);
    } else if (action.kind === "paintPercent") {
      if (["brush","eraser","clone","heal","retouch"].includes(tool)) percent(action.digit,action.property);
      else if (action.property === "opacity" && (tool === "bucket" || tool === "magicEraser" || tool === "gradient")) {
        painting.update(tool, { opacity: Math.max(1,Math.round(percent(action.digit,action.property,false)*100)) });
      }
    } else if (action.kind === "brush") {
      const stepSize = (size: number) => clampBrushSize(size + action.direction * (size < 10 ? 1 : size < 100 ? 5 : 10));
      if (tool === "pencil" && action.property === "size") painting.update("pencil",{size:stepSize(painting.settings.pencil.size)});
      else if (tool === "colorReplacement" && action.property === "size") painting.update("colorReplacement",{size:stepSize(painting.settings.colorReplacement.size ?? 30)});
      else if (tool === "backgroundEraser") painting.update("backgroundEraser",action.property === "size" ? {size:stepSize(painting.settings.backgroundEraser.size)} : {hardness:Math.max(0,Math.min(1,painting.settings.backgroundEraser.hardness+action.direction*.25))});
      else if (["brush","eraser","clone","heal","retouch","quick"].includes(tool)) setBrush((current) => action.property === "size"
        ? { ...current, size: stepSize(current.size) }
        : { ...current, hardness: Math.max(0, Math.min(1, current.hardness + action.direction * .25)) });
    } else if (action.kind === "save") {
      if (canSave) void applySave();
    } else if (action.kind === "clipping") {
      const id=activeLayer?.clipped ? "layer.releaseClippingMask" : "layer.createClippingMask";
      if (commands.get(id)?.allowed && commands.get(id)?.enabled) run(id);
    } else if (action.kind === "delete") {
      // 蒙版目标不能落到像素清除；无选区时按所选对象删除，沿用上游桌面分派。
      const several = (documentView?.layers.filter(layer => layer.selected || layer.active).length ?? 0) > 1;
      const id = documentView?.editTarget === "mask" && !(several && !documentView.hasSelection)
        ? documentView.hasSelection ? "edit.fillBackground" : "layer.layerMask.delete"
        : documentView?.hasSelection ? "edit.clear" : "layer.delete";
      if (commands.get(id)?.allowed && commands.get(id)?.enabled) run(id);
    } else if (action.kind === "command") {
      const enabled = action.id === "edit.undo" ? documentView?.canUndo
        : action.id === "edit.redo" ? documentView?.canRedo : commands.get(action.id)?.enabled;
      if (enabled) run(action.id);
    }
  };

  const openFeaturePanel = (feature: EditorFeaturePanel) => {
    setOpenFeaturePanels(current => current.includes(feature) ? current : [...current, feature]);
    setAdvancedOpen(false);
    if (!display.state.sidebarVisible) display.toggle("sidebar");
    display.updatePanels?.({ activePanel: `feature.${feature}` });
  };
  const revealProperties=()=>{
    if(!display.state.sidebarVisible) display.toggle("sidebar");
    display.updatePanels?.({propertiesCollapsed:false,activePanel:"properties"});
  };
  /**
   * 打开本域「格式与导出」面板并落在指定模式（change: 2026-10-22-add-photocraft-raster-interchange）。
   *
   * 「文件 ▸ 导出为…」与「文件 ▸ Save for Web…」和「图像 ▸ 格式与导出…」是同一块面板；
   * 菜单项必须把用户直接放到对应模式，否则「Save for Web」只是打开了面板、还要用户自己再切一次。
   */
  const openInterchange = (tab: "export" | "layers" | "matrix", mode?: "export" | "web") => {
    requestInterchange({ tab, ...(mode ? { mode } : {}) });
    openFeaturePanel("interchange");
  };
  /** 内核提供本域导出端口时才显示「文件 ▸ 导出为… / Save for Web…」，旧内核不显示死菜单项。 */
  const coversInterchange = typeof (controller as unknown as { features?: { io?: { exportRaster?: unknown } } })
    .features?.io?.exportRaster === "function";
  /**
   * 交给菜单栏的文档菜单能力。
   *
   * 「文件 ▸ 导出为… / Save for Web…」是本域面板的另两个入口：共享 chrome 只认识
   * `EditorDocumentsMenu` 上的回调，因此在这里把回调接到 `openInterchange` 上
   * （change: 2026-10-22-add-photocraft-raster-interchange，U06）。没有文档菜单能力时
   * 「文件」菜单本就不渲染，也就不追加这两个条目。
   */
  const documentsForBar = useMemo<EditorDocumentsMenu | undefined>(() => {
    if (!documents) return undefined;
    if (!coversInterchange) return documents;
    return {
      ...documents,
      onExportRaster: () => openInterchange("export", "export"),
      onExportWeb: () => openInterchange("export", "web")
    };
  }, [documents, coversInterchange, openInterchange]);
  const panelLayout=display.state.panelLayout??DEFAULT_PANEL_LAYOUT;
  const propertyTool:PhotoEditorProperty|null=textEditing.active || textToolProperties?"text":adjustmentEditing.active?"adjustment":documentView?.editTarget==="mask"?"mask":activeLayer?.kind==="text"?"text":activeLayer?.kind==="adjustment"?"adjustment":null;
  const runLayerAction = (id: string) => {
    const adjustment = ADJUSTMENT_LAYER_ACTIONS.find(action => action.id === id);
    if (run(id, adjustment?.params ?? null) && (adjustment || id.startsWith("layer.layerMask."))) {
      setTextToolProperties(false);
      revealProperties();
    }
  };
  const updatePanels=useCallback((patch:Partial<EditorPanelLayout>)=>{if(!displayDisabled && !transforming && !canvasRef.current?.hasGesture()) display.updatePanels?.(patch);},[displayDisabled,transforming,display.updatePanels]);
  const collapseControl=(key:"layersCollapsed"|"historyCollapsed"|"propertiesCollapsed",name:string)=>{
    const Icon=panelLayout[key]?ChevronRightIcon:ChevronDownIcon;
    return <Button size="sm" tone="ghost" title={`${panelLayout[key]?"展开":"折叠"}${name}`} disabled={displayDisabled} onClick={()=>updatePanels({[key]:!panelLayout[key]})}><Icon size={13}/></Button>;
  };
  const renderOptions=(surface:"tools"|"properties")=>(
    <ToolOptionsPanel
            readonly={locked || transforming || propertiesEditing.active}
            surface={surface} tool={tool} property={propertyTool}
            selection={{ mode: selectionMode, ellipse, feather }}
            onSelectionMode={setSelectionMode}
            onFeather={(value) => setFeather(clampFeather(value))}
            brush={brush}
            {...(brushLibrary ? { brushLibrary } : {})}
            onBrushPreset={(name) => {
              // 预设只改工具参数（内核会话里的笔刷设置），不写文档也不造 dirty。
              const settings = brushLibrary?.brushSettings(name);
              if (!settings) return;
              const size = typeof settings.size === "number" ? settings.size : brush.size;
              const hardness = typeof settings.hardness === "number" ? settings.hardness : brush.hardness;
              const opacity = typeof settings.opacity === "number" ? settings.opacity : brush.opacity;
              const flow = typeof settings.flow === "number" ? settings.flow : brush.flow;
              const smoothing = typeof settings.smoothing === "object" && settings.smoothing && typeof (settings.smoothing as { amount?: unknown }).amount === "number"
                ? Number((settings.smoothing as { amount: number }).amount)
                : brush.smoothing;
              const dynamics: Record<string, unknown> = {};
              for (const key of ["spacing", "spacingEnabled", "angle", "roundness", "flipX", "flipY", "shapeDynamics", "scattering", "transfer", "smoothing"] as const) {
                if (settings[key] !== undefined && key !== "smoothing") dynamics[key] = settings[key];
              }
              const next: BrushSettings = {
                ...brush,
                size: clampBrushSize(size),
                hardness: Math.min(1, Math.max(0, hardness)),
                opacity: Math.min(1, Math.max(0, opacity)),
                flow: Math.min(1, Math.max(0, flow)),
                smoothing: Math.min(1, Math.max(0, smoothing)),
                ...(Object.keys(dynamics).length ? { dynamics } : {})
              };
              setBrush(next);
            }}
            onBrush={(patch) => {
              if (patch.target && activeLayerId !== null) selectTarget({id:activeLayerId},patch.target === "mask");
              setBrush((current) => mergeBrushPatch(current, patch as Partial<BrushSettings> & Record<string, unknown>));
            }}
            text={text}
            onText={(patch)=>{
              if(activeLayer?.kind==="text" && !textEditing.active && !textEditing.begin({layer:activeLayer.id})) return;
              textEditing.update(patch);
            }}
            textActive={textEditing.active} textComposing={textEditing.composing}
            editingText={activeLayer?.text !== null && activeLayer?.text !== undefined}
            onEditText={()=>{if (activeLayerId!==null) textEditing.begin({layer:activeLayerId});}}
            onConfirmText={()=>endText(true)} onCancelText={()=>endText(false)}
            runCommand={run}
            layerParam={layerParam}
            hasSelection={documentView?.hasSelection ?? false}
            hasMask={activeLayer?.hasMask ?? false}
            canApplyMask={activeLayer?.kind === "raster" || activeLayer?.kind === "pixel"}
            adjustment={{ brightness, contrast, hue, saturation, lightness }}
            onAdjustment={(patch) => adjustmentEditing.update("brightness" in patch || "contrast" in patch ? "brightnessContrast" : "hueSaturation",patch)}
            adjustmentActive={adjustmentEditing.active} adjustmentCancelRevision={adjustmentEditing.cancelRevision}
            onEndAdjustment={adjustmentEditing.finish}
            editingAdjustment={activeLayer?.adjustment ?? null}
            curvePoints={curvePoints} curveSamples={adjustmentEditing.samples}
            onCurvePoints={(points)=>adjustmentEditing.update("curves",{points})}
          />
  );

  const clipboardEvent = (event: React.ClipboardEvent, id: string) => {
    if (editorInputConsumesKeys(event.target)) return;
    // 浏览器菜单产生的原生事件也只作用于图片内部；不读写系统节点 JSON。
    event.preventDefault(); event.stopPropagation();
    if (locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || canvasRef.current?.hasGesture()) return;
    const command=commands.get(id);
    if (command?.allowed && command.enabled) run(id);
  };

  // 独立文档槽位的桥接：面板只给「字节 + 名称」，宿主决定用哪条打开路径落地。
  const requestDocumentSlot = useMemo(() => {
    if (!onRequestDocumentSlot) return undefined;
    return async (bytes: Uint8Array, name: string) =>
      onRequestDocumentSlot({ bytes, name: name.trim() || "未命名" });
  }, [onRequestDocumentSlot]);

  // 最近文件与导出预设的桥接：本域只转交，不缓存字节、不解释导出设置。
  const recentFilesPort = useMemo(() => (recentFiles === undefined ? {} : { recentFiles }), [recentFiles]);
  /**
   * 「滤镜 → 修饰工具…」面板切换修饰命令。
   *
   * 面板与上下文栏下拉共用同一个 `retouchTool`；选了仿制图章/修复画笔时还要把画布工具切到
   * `clone`/`heal`，否则 `retouchCommand()` 仍按 `retouchTool` 之外的路径推导、画布落下的是
   * 一条普通笔迹（面板说在仿制、画布在画别的）。其余命令统一切到 `retouch` 画布工具。
   */
  const activateRetouchTool = (id: string) => {
    setMessage(null);
    setRetouchTool(id);
    chooseTool(id === "paint.cloneStamp" ? "clone" : id === "paint.healingBrush" ? "heal" : "retouch");
  };
  const featurePanelContext = {
    controller, locked, panelRequest, readonly: panelReadonly, requestDocumentSlot, ...recentFilesPort,
    ...(recentFilesError ? { recentFilesError } : {}),
    ...(onReopenRecent ? { reopenRecent: onReopenRecent } : {}),
    ...(onRemoveRecent ? { removeRecent: onRemoveRecent } : {}),
    ...(hasRecentBytes ? { hasRecentBytes } : {}),
    applyExportPreset: (preset: { name: string; settings: unknown }) => {
      if (onApplyExportPreset) { onApplyExportPreset(preset); return; }
      const result = requestExportPreset(preset.settings);
      if (!result.ok) { setMessage(result.reason); return; }
      openFeaturePanel("interchange");
    },
    documentBusy: panelReadonly, documentView, activeLayer, activeLayerId, colors, brush,
    refreshPreview, updateAids, retouchTool, retouchSample, retouchAligned, setRetouchAligned,
    activateRetouchTool, armRetouchSample: () => setSampleNext(true), setMessage,
    setColor: (color: string, target: "foreground" | "background" = "foreground") =>
      (target === "background" ? setBackground(color) : setColor(color)),
    applyPanelLayout: (layout: Record<string, unknown>) => {
      const next = workspacePanelLayout(layout, panelLayout);
      if (next) display.updatePanels?.(next);
    }
  };
  // 一个画布窗格的全部接线（U72）：并排时用**同一段代码**渲染每块画布，参数只有取景、
  // 交互归属与该视图的旋转。这样不会出现「主画布能用、另一块只是缩略图」的假并排，也不会
  // 复制第二套手势/叠加层逻辑——内容、历史、工具与撤销天然是同一份。
  const renderCanvasPane = (
    paneView: PhotoCanvasView,
    options: { interactive: boolean; ref?: Ref<PhotoCanvasHandle>; rotation?: number; viewId?: string },
  ) => (
          <PhotoCanvas ref={options.ref}
            view={paneView}
            {...(renderCanvasBackground ? { renderBackground: renderCanvasBackground } : {})}
            documentWidth={documentView?.width ?? 0}
            documentHeight={documentView?.height ?? 0}
            interactive={options.interactive}
            tool={canvasTool}
            positioning={propertiesEditing.positioning}
            selectionOutline={selectionTransform ? documentView?.selectionOutline : transformSession.active ? [] : documentView?.selectionOutline}
            showSelectionEdges={display.state.extrasVisible}
            selectionMatrix={selectionTransform ? transformMatrix : undefined}
            onSelectionMoveStart={(pixels) => {
              if (!transformSession.begin(!pixels)) return false;
              setSelectionTransform(!pixels); setTransformMatrix(IDENTITY_MATRIX); return true;
            }}
            transformFrame={(transforming || (tool === "move" && display.state.extrasVisible)) && !spaceHeld ? transformFrame : null}
            transformMatrix={transformMatrix}
            transformLinked={transformLinked} transformReference={transformReference} onTransformReferenceChange={setTransformReference}
            transformMoveOnly={tool === "move"}
            onMoveStart={(point, modifiers) => transformSession.beginMove({ ...point, autoSelect: documentView?.editTarget !== "mask" && !documentView?.hasSelection && autoSelect !== modifiers.toggleAuto, duplicate: modifiers.duplicate })}
            onMovePreview={previewTransform}
            onMoveEnd={(matrix) => { previewTransform(matrix); endTransform(true); }}
            onMoveCancel={() => endTransform(false)}
            onTransformBegin={() => transformSession.begin()}
            onTransformPreview={previewTransform}
            onTransform={(matrix) => { previewTransform(matrix); if (!transforming) endTransform(true); }}
            onTransformCancel={() => { if (!transforming) endTransform(false); }}
            ellipse={ellipse}
            selectionMode={selectionMode}
            onText={(placement)=>{revealProperties();return textEditing.begin(placement);}}
            onGuideDown={(client) => {
              if (!display.state.extrasVisible || !guideGesture) return false;
              // 标尺角落优先：那里没有参考线，但拖动的是原点。
              const drag = guideGesture.beginGuide(client).drag ?? guideGesture.beginOrigin(client);
              if (!drag) return false;
              setGuideDrag({ ...drag });
              return true;
            }}
            onGuideMove={(client) => {
              const drag = guideGesture?.update(client);
              if (drag) setGuideDrag({ ...drag });
            }}
            onGuideUp={(_client, cancelled) => {
              if (!guideGesture) { setGuideDrag(null); return; }
              if (cancelled) guideGesture.cancel();
              else {
                const result = guideGesture.commit();
                if (!result.ok) setMessage(result.message);
                else if (result.value.changed) updateAids();
              }
              setGuideDrag(null);
            }}
            guidePreview={guideDrag && guideDrag.kind === "guide" && Number.isFinite(guideDrag.position)
              ? { vertical: guideDrag.vertical, position: guideDrag.position }
              // 从标尺刚按下还没移动：没有位置可画，宁可不画预览线也不画到 NaN。
              : null}
            onViewPoint={(point, modifiers) => {
              if (tool === "polygon-lasso" || tool === "magnetic-lasso") return canvasLasso.add(point, modifiers?.close);
              // 只有存在一次性落点请求时才消费这次点击；没有请求时返回 `false`，画布按当前工具处理。
              // 用 `consumePlacement` 的返回值而不是闭包里的 `placement`：同一帧内的第二次点击
              // 也不会被上一次请求消费（一次性语义由请求本身负责，而不是界面状态的更新时机）。
              return consumePlacement([point.x, point.y]);
            }}
            renderOverlay={(origin,zoom)=>{
              return <>
                {display.state.extrasVisible ? <ViewAidsOverlay aids={viewAids} guides={guideSnapshot} origin={origin} zoom={zoom} width={documentView?.width ?? 0} height={documentView?.height ?? 0}
                  {...(options.rotation === undefined ? {} : { rotation: options.rotation })}
                  // 原点拖动时用草稿零点画刻度，松手前就能看到刻度跟着走（文档不动）。
                  rulerOrigin={guideDrag?.kind === "origin" ? guideDrag.origin : undefined}
                  onRulerDown={(vertical, pointerId) => {
                    if (!guideGesture) return false;
                    // 覆盖层已在标尺条上拦住指针事件（不让它冒泡成画布落笔），后续 move/up 在这里
                    // 用 pointerId 走 window 续跟；松手/取消的结算与画布内拖动共用同一套逻辑。
                    const drag = guideGesture.startRulerGuide(vertical, pointerId);
                    if (!drag) return false;
                    setGuideDrag({ ...drag });
                    const move = (event: PointerEvent) => {
                      if (event.pointerId !== pointerId) return;
                      const next = guideGesture.update([event.clientX, event.clientY]);
                      if (next) setGuideDrag({ ...next });
                    };
                    const finish = (cancelled: boolean) => (event: PointerEvent) => {
                      if (event.pointerId !== pointerId) return;
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                      window.removeEventListener("pointercancel", cancel);
                      guideGesture.releasePointer();
                      if (cancelled) guideGesture.cancel();
                      else {
                        const result = guideGesture.commit();
                        if (!result.ok) setMessage(result.message);
                        else if (result.value.changed) updateAids();
                      }
                      setGuideDrag(null);
                    };
                    const up = finish(false);
                    const cancel = finish(true);
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                    window.addEventListener("pointercancel", cancel);
                    return true;
                  }} /> : null}
                <MountedCompositionOverlay origin={origin} zoom={zoom} readonly={readonly} />
                {(() => { const frame = readCloneOverlay(origin, zoom); return frame ? <CloneSourceOverlay frame={frame} /> : null; })()}
                {vectorBridge.overlay(origin, zoom)}
                {canvasLasso.overlay(origin, zoom)}
                {tool === "crop" ? canvasCrop.overlay(origin, zoom, locked) : null}
                {textEditing.active ? <TextInputOverlay editing={textEditing} origin={origin} zoom={zoom} disabled={locked} onEnd={endText} /> : null}
                {tool === "pen" && pathDraft.points.length ? <PathOverlay points={pathDraft.points} closed={pathDraft.closed} zoom={zoom} origin={origin} /> : null}
              </>;
            }}
            onVectorPointer={(pointer, samples) => vectorBridge.pointer(pointer, samples)}
            onToolHover={point => canvasLasso.hover(point)}
            onProbe={(client) => probeCanvas(client, options.viewId)}
            onFrame={(origin, zoom) => { if (options.viewId) syncFrame(options.viewId, origin, zoom); }}
            brushSize={tool === "pencil" ? painting.settings.pencil.size : tool === "backgroundEraser" ? painting.settings.backgroundEraser.size : tool === "colorReplacement" ? painting.settings.colorReplacement.size ?? 30 : brush.size}
            sampling={altHeld || sampleNext}
            onSampleColor={(point) => {
              if (isRetouchTool(canvasTool)) {
                const sample: [number, number] = [Math.round(point.x), Math.round(point.y)];
                setRetouchSample(sample);
                if (tool === "clone" || tool === "heal") {
                  const session = controller.features.retouch;
                  const listed = session.cloneSources();
                  const slot = listed.ok ? listed.value.slots.find(entry => entry.index === listed.value.active) ?? listed.value.slots[0] : null;
                  if (slot) {
                    const written = session.setCloneSource(slot.index, { source: sample }) as { ok?: boolean; message?: string } | undefined;
                    if (written?.ok === false) setMessage(written.message ?? "无法写入仿制源取样点");
                    setRetouchPanelVersion(value => value + 1);
                  }
                }
                retouchAnchor.current = null; setSampleNext(false); setMessage(null);
                return;
              }
              if (tool === "eyedropper") {
                const params = painting.compileSample(point);
                if (!params) { setMessage("采样坐标或采样尺寸无效"); return; }
                const result = controller.features.painting.sampleColorOptions(params);
                if (!result.ok) { setMessage(result.message); return; }
                const color = decodeSampledColor(result.value);
                if (color === undefined) { setMessage("采样结果结构非法"); return; }
                if (color === null) { setMessage("该点没有有效颜色（图外或透明）"); return; }
                if (painting.eyedropperTarget === "background") setBackground(color.hex);
                else setColor(color.hex);
                setMessage(`已取样 ${color.hex}${color.alpha < 1 ? ` · 不透明度 ${Math.round(color.alpha * 100)}%` : ""}`);
                return;
              }
              const result = controller.sampleColor(point.x,point.y);
              if (result.ok) { if (result.value) setColor(result.value); } else setMessage(result.message);
            }}
            onMarquee={(rect, mode) => tool === "crop" ? canvasCrop.preview(rect) : applyMarquee(rect, mode)}
            onLasso={applyLasso}
            onSelectionClick={(point, mode = selectionMode) => {
              if (readonly || locked) return;
              if (takeCanvasPick(controller, point)) { refreshPreview(); return; }
              if (mode === "replace" && documentView?.hasSelection && !pointInSelection(point, documentView.selectionOutline)) run("select.deselect");
            }}
            {...(isRetouchTool(tool) && retouchGesture() !== "stroke" ? {
              regionGestureKind: retouchGesture() === "region-click" ? "click" as const : "drag" as const,
              onRegionGesture: (from: DocumentPoint, to: DocumentPoint, moved: boolean) => {
                if (readonly || busy || closing) return;
                const session = controller.features.retouch;
                const command = retouchCommand();
                if (retouchGesture() === "region-click") {
                  // 红眼：单击累积位置，不改文档；候选由面板「计算候选」统一确认。
                  const marked = session.markRedEye(from);
                  setMessage(marked.ok ? null : marked.message ?? "无法标记这个位置");
                  if (marked.ok) setRetouchPanelVersion(value => value + 1);
                  return;
                }
                if (!moved) { setMessage("拖动距离不足 1 像素（偏移不能为 0）"); return; }
                const result = session.beginRetouchRegionDrag(command as never, { from, to });
                setMessage(result.ok ? null : result.message ?? "无法计算候选");
                // 候选改的是预览文档（不动内容哈希）：必须重绘，否则用户看不到任何变化，
                // 面板的「确认」也会因为没触发重渲染而一直不可按。
                if (result.ok) refreshPreview();
              }
            } : {})}
            onStrokeStart={beginStroke}
            onStrokeMove={(points) => {
              if (quickMaskDraft().kind === "quickMask") { paintQuickMaskPoints(points); return; }
              if (paintStroke.current) { paintStroke.current.points.push(...points); return; }
              if (strokeEnd.current && points.length) strokeEnd.current.point = points[points.length-1];
              liveStroke.append(points);
            }}
            onStroke={(points) => {
              if (isPaintPointTool(tool)) { if (points[0]) commitPaintPoint(points[0]); return; }
              if (paintStroke.current) { committedPaintStroke(); return; }
              if (quickMaskDraft().kind === "quickMask") {
                const painted = quickMaskPainted.current + quickMaskPending.current.length;
                if (tool !== "wand" && tool !== "quick" && points.length > painted) quickMaskPending.current.push(...points.slice(painted));
                if (quickMaskFrame.current !== null) cancelAnimationFrame(quickMaskFrame.current);
                flushQuickMask();
                quickMaskPainted.current = 0;
                strokeEnd.current = null;
                return;
              }
              setRetouchStroking(false);
              if (tool === "wand" && points[0]) run("select.magicWand", { x: points[0].x, y: points[0].y, tolerance, contiguous, sampleAllLayers, mode: selectionMode });
              else if (tool === "quick") run("select.quick", {points: points.map(point => [point.x, point.y]), size: brush.size, sampleAllLayers, mode: selectionMode === "intersect" ? "replace" : selectionMode});
              else if (liveStroke.finish() && strokeEnd.current) strokeAnchor.current = strokeEnd.current;
              strokeEnd.current = null;
            }}
            onStrokeCancel={() => {
              paintStroke.current = null; liveStroke.cancel(); strokeEnd.current = null;
              setRetouchStroking(false); quickMaskPainted.current = 0;
              if (quickMaskFrame.current !== null) cancelAnimationFrame(quickMaskFrame.current);
              quickMaskFrame.current = null; quickMaskPending.current = [];
            }}
            onPenPoint={(point, modifiers) => {
              if (readonly || locked) return;
              if (modifiers.close) {
                finishPath();
                return;
              }
              const snapped = controller.snapPoint(point, paneView.viewport.zoom);
              const next = snapped.ok ? (snapped.value as {point: [number, number]}).point : point;
              pathDraft.add([Math.round(next[0]), Math.round(next[1])]);
            }}
          />
  );
  return (
    <PaintingControlsContext.Provider value={{ painting, tool, choose: id => chooseTool(id as PhotoEditorTool) }}>
    <div ref={editorRef} className="photo-editor" role="application" aria-label="PhotoCraft 图像编辑器" tabIndex={-1}
      onCopy={(event)=>clipboardEvent(event,"edit.copy")}
      onCut={(event)=>clipboardEvent(event,"edit.cut")}
      onPaste={(event)=>clipboardEvent(event,"edit.paste")}
      onKeyDownCapture={(event)=>{
        if (propertiesEditing.active && !event.nativeEvent.isComposing && event.keyCode!==229) {
          if (event.key==="Escape") {event.preventDefault();event.stopPropagation();if(!canvasRef.current?.cancelGesture()) propertiesEditing.finish(false);return;}
          if (propertiesEditing.styleActive && event.key==="Enter" && !(event.target as Element).closest("button,select")) {
            event.preventDefault();event.stopPropagation();propertiesEditing.finish(true);return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="s") {
            event.preventDefault();event.stopPropagation();setMessage("请先确认或取消图层属性编辑");return;
          }
        }
        if (adjustmentEditing.active && !event.nativeEvent.isComposing && event.keyCode!==229) {
          if (event.key==="Escape" && !(event.target as Element).closest(".photo-editor-curve, [data-adjustment-control]")) {
            event.preventDefault();event.stopPropagation();adjustmentEditing.finish(false);return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="s") {
            event.preventDefault();event.stopPropagation();setMessage("请先确认或取消调整参数编辑");return;
          }
        }
        if (!textEditing.active || textEditing.composing || event.nativeEvent.isComposing || event.keyCode===229) return;
        if (event.key==="Escape" || ((event.ctrlKey || event.metaKey) && event.key==="Enter")) {
          event.preventDefault();event.stopPropagation();endText(event.key!=="Escape");
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="s") {
          event.preventDefault();event.stopPropagation();setMessage("请先确认或取消文字编辑");
        }
      }}
      onPointerDownCapture={(event) => {
        if (!editorInputConsumesKeys(event.target) && !(event.target as Element).closest("button, .photo-editor-curve")) event.currentTarget.focus({ preventScroll: true });
      }}
      onBlur={(event) => {
        // 参数控件与曲线门户自行结算，提交失败时保留待修正输入。
        if ((event.target as Element).closest(".photo-editor-curve, [data-adjustment-control], [data-layer-opacity], [data-layer-fill], [data-layer-style]")) return;
        const next=event.relatedTarget;
        if (!event.currentTarget.contains(next as Node | null) && !(next instanceof Element && next.closest(".photo-editor-curve"))) releaseInput();
      }}
      onKeyUp={(event) => {
        if (event.key === "Alt") {
          if (altHeld) { event.preventDefault(); event.stopPropagation(); }
          setAltHeld(false);
        }
        if (canvasRef.current?.selectionKey?.(event.key,false)) { event.preventDefault(); event.stopPropagation(); return; }
        if (event.key.startsWith("Arrow") && nudge.current) {
          event.preventDefault(); event.stopPropagation(); nudge.current = null; endTransform(true);
        }
        if (event.code === "Space" || event.key === " ") {
          if (spaceHeld) event.stopPropagation();
          setSpaceHeld(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || editorInputConsumesKeys(event.target) || event.currentTarget.closest("[hidden]")) return;
        if (!event.nativeEvent.isComposing && event.keyCode !== 229 && !locked && ["Escape","Enter","Backspace"].includes(event.key)) {
          if (canvasLasso.active) {
            event.preventDefault(); event.stopPropagation();
            if (event.key === "Escape") canvasLasso.cancel(); else if (event.key === "Enter") canvasLasso.finish(); else canvasLasso.back();
            return;
          }
          if (canvasCrop.active && event.key !== "Backspace") {
            event.preventDefault(); event.stopPropagation();
            if (event.key === "Escape") canvasCrop.cancel(); else canvasCrop.confirm();
            return;
          }
        }
        if (tool === "pen" && pathDraft.points.length && !locked) {
          if (event.key === "Escape" || event.key === "Enter" || event.key === "Backspace") {
            event.preventDefault(); event.stopPropagation();
            if (event.key === "Escape") pathDraft.reset();
            else if (event.key === "Backspace") pathDraft.undo();
            else finishPath();
            return;
          }
        }
        // 矢量工具键盘（U11/U12）：Enter 结束开放路径、Backspace 撤锚、Delete 删选中锚点、Escape 取消。
        if (vectorToolIds.has(tool) && !locked) {
          const key = event.key === "Escape" ? "Escape"
            : event.key === "Enter" ? "Enter"
              : event.key === "Backspace" ? "Backspace"
                : event.key === "Delete" ? "Delete" : null;
          if (key && vectorBridge.active()) {
            event.preventDefault(); event.stopPropagation();
            vectorBridge.key(key);
            return;
          }
        }
        if (textEditing.active) {
          if (event.nativeEvent.isComposing || event.keyCode===229) return;
          if (event.key==="Escape" || ((event.ctrlKey || event.metaKey) && event.key==="Enter")) {
            event.preventDefault();event.stopPropagation();endText(event.key!=="Escape");
          }
          return;
        }
        if (event.key === "Alt" && (tool === "brush" || tool === "eraser") && !event.nativeEvent.isComposing && event.keyCode !== 229 && !locked && !canvasRef.current?.hasGesture()) {
          event.preventDefault(); event.stopPropagation(); setAltHeld(true); return;
        }
        if (!event.nativeEvent.isComposing && event.keyCode !== 229 && canvasRef.current?.selectionKey?.(event.key,true)) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        const action = resolveWithPreferences(customizer, event.nativeEvent, isEditorMac());
        if (!action) return;
        if (action.kind === "confirm" && !transforming) return;
        if (action.kind === "nudge" && tool !== "move") return;
        if (action.kind === "escape" && nudge.current) {
          event.preventDefault(); event.stopPropagation(); nudge.current = null; endTransform(false); return;
        }
        if (action.kind === "escape") {
          if (event.repeat) { event.preventDefault(); event.stopPropagation(); return; }
          // 快速蒙版草稿在场时，Esc 语义是"取消并恢复进入前的选区"（与面板的取消同一出口）。
          if (quickMaskDraft().kind === "quickMask") {
            const selections = controller.features?.selections;
            event.preventDefault(); event.stopPropagation();
            const exited = selections?.exitQuickMask?.(true);
            setMessage(exited && !exited.ok ? exited.message : null);
            if (exited?.ok) refreshPreview();
            return;
          }
          if (transforming) {
            event.preventDefault(); event.stopPropagation();
            canvasRef.current?.cancelGesture();
            endTransform(false);
            return;
          }
          const cancelled = canvasRef.current?.cancelGesture();
          if (!cancelled && !spaceHeld && !(documentView?.hasSelection && !locked)) return;
          if (!event.repeat) {
            setSpaceHeld(false);
            if (!cancelled && !spaceHeld && documentView?.hasSelection && !locked) run("select.deselect");
          }
        }
        event.preventDefault(); event.stopPropagation();
        if (event.repeat && action.kind !== "brush" && action.kind !== "view" && action.kind !== "nudge") return;
        applyShortcut(action);
      }}>

      <EditorMenuBar featureCommands={featureMenuCommands(controller)} onFeatureCommand={(panel, command) => {
        if (controller.hasActiveDraft() || canvasRef.current?.hasGesture()) { setMessage("请先确认或取消当前编辑"); return; }
        setPanelRequest(previous => ({panel, command, sequence: (previous?.sequence ?? 0) + 1}));
        openFeaturePanel(panel);
      }} commands={commands} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
        documentlessReadonly={panelReadonly || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
        display={{state:display.state,toggle:toggleDisplay}} displayDisabled={displayDisabled} viewDisabled={viewDisabled}
        mergeLabel={(documentView?.layers.filter(layer => layer.selected || layer.active).length ?? 0) > 1 ? "合并图层" : activeLayer?.kind === "group" ? "合并组" : "向下合并"}
        canUndo={documentView?.canUndo ?? false} canRedo={documentView?.canRedo ?? false}
        canTransform={!!documentView?.transformFrame} canTransformSelection={!!documentView?.selectionFrame}
        onTransform={selectionOnly => chooseTool("transform", selectionOnly)}
        onView={action => applyShortcut({kind: "view", action})}
        onOpenFeature={feature => {
          if (feature === "typography") chooseTool("text");
          openFeaturePanel(feature);
        }}
        onCommand={runLayerAction} onApply={() => void applySave()} canSave={canSave} saving={busy}
        {...(documentsForBar ? { documents: { ...documentsForBar, onNewDocument: () => { openFeaturePanel("filesNewDocument"); } }, transfer: documentsForBar.transfer } : {})} />
      <div className="photo-editor__contextbar" hidden={!display.state.toolsVisible}>
        <span className="photo-editor__tool-label">{toolLabel}</span>
          {transforming ? <TransformOptions linked={transformLinked} onLinkedChange={setTransformLinked} reference={transformReference} onReferenceChange={setTransformReference} frame={transformFrame ?? null} matrix={transformMatrix} readonly={locked} onValidChange={setTransformValid} onPreview={previewTransform} onConfirm={() => endTransform(true)} onCancel={() => endTransform(false)} /> : null}
          {tool === "move" ? <label><input type="checkbox" checked={autoSelect} disabled={locked} onChange={(event) => setAutoSelect(event.currentTarget.checked)} />自动选择图层</label> : null}
          {tool === "move" ? <Button size="sm" disabled={locked || !documentView?.transformFrame} onClick={() => chooseTool("transform")}>自由变换</Button> : null}
          {(tool === "marquee" || tool === "lasso") ? <Button size="sm" disabled={locked || !documentView?.selectionFrame} onClick={() => chooseTool("transform",true)}>变换选区</Button> : null}
          {tool === "crop" ? <>
            <span className="photo-editor__brush-note">拖动建立裁剪框，拖动边角调整；Enter 确认，Esc 取消。</span>
            <label><input type="checkbox" checked={canvasCrop.deletePixels} disabled={locked || canvasCrop.active} onChange={event => canvasCrop.setDeletePixels(event.currentTarget.checked)} />删除裁剪的像素</label>
            <Button size="sm" disabled={locked || canvasCrop.active} onClick={() => canvasCrop.preview({x:0,y:0,width:documentView?.width ?? 1,height:documentView?.height ?? 1})}>整个画布</Button>
            <Button size="sm" disabled={locked || !canvasCrop.active} onClick={canvasCrop.confirm}>确认裁剪</Button>
            <Button size="sm" tone="ghost" disabled={!canvasCrop.active} onClick={canvasCrop.cancel}>取消</Button>
          </> : null}
          {tool === "polygon-lasso" || tool === "magnetic-lasso" ? <>
            <SelectionModeButtons value={selectionMode} disabled={locked || canvasLasso.active} onChange={setSelectionMode}/>
            {tool === "magnetic-lasso" ? <><label>宽度<input type="number" min={1} max={256} value={canvasLasso.edgeWidth} disabled={locked || canvasLasso.active} onChange={e => canvasLasso.setEdgeWidth(Math.max(1,Math.min(256,Number(e.currentTarget.value))))}/></label><label>对比度<input type="number" min={1} max={100} value={canvasLasso.contrast} disabled={locked || canvasLasso.active} onChange={e => canvasLasso.setContrast(Math.max(1,Math.min(100,Number(e.currentTarget.value))))}/></label></> : null}
            <span className="photo-editor__brush-note">单击建立锚点，磁性套索沿移动追边；双击或 Enter 闭合，Backspace 回退。</span>
            <Button size="sm" disabled={locked || canvasLasso.count < 3} onClick={canvasLasso.finish}>闭合选区</Button>
            <Button size="sm" tone="ghost" disabled={!canvasLasso.active} onClick={canvasLasso.cancel}>取消</Button>
          </> : null}
          {tool === "hand" || tool === "zoom" ? <><Button size="sm" onClick={() => canvasRef.current?.view("fit")}>适合屏幕</Button><Button size="sm" onClick={() => canvasRef.current?.view("actualSize")}>100%</Button>{tool === "zoom" ? <span>单击放大，Alt/Option 单击缩小</span> : null}</> : null}
          {renderOptions("tools")}
          <PaintingContextOptions disabled={locked} onMore={() => openFeaturePanel("painting")} />
          {vectorToolIds.has(tool) ? <>
            {/* 图内拖绘的参数（U08/U09）：与面板的数值创建共用 `shapeCreateParams`。 */}
            {(tool === "shape-rect" || tool === "shape-rounded-rect") ? <label>圆角<input type="number" min={0} value={vectorShapeOptions.radius} disabled={locked}
              onChange={event => setShapeToolOptions({ radius: Math.max(0, Number(event.currentTarget.value)) })} /></label> : null}
            {(tool === "shape-polygon" || tool === "shape-star") ? <label>边数<input type="number" min={3} max={100} value={vectorShapeOptions.sides} disabled={locked}
              onChange={event => setShapeToolOptions({ sides: Math.max(3, Math.min(100, Math.round(Number(event.currentTarget.value)))) })} /></label> : null}
            {tool === "shape-star" ? <label>内外比例<input type="number" min={0.01} max={0.99} step={0.01} value={vectorShapeOptions.starRatio} disabled={locked}
              onChange={event => setShapeToolOptions({ starRatio: Math.max(0.01, Math.min(0.99, Number(event.currentTarget.value))) })} /></label> : null}
            {tool === "shape-line" ? <label>线宽<input type="number" min={0} value={vectorShapeOptions.weight} disabled={locked}
              onChange={event => setShapeToolOptions({ weight: Math.max(0, Number(event.currentTarget.value)) })} /></label> : null}
            {(tool === "pen-freeform" || tool === "pen-curvature") ? <label>输出<select value={penTarget} disabled={locked}
              onChange={event => setPenTarget(event.currentTarget.value)}><option value="shape">形状图层</option><option value="path">工作路径</option><option value="mask">矢量蒙版</option></select></label> : null}
            {/* 路径工具的目标（钢笔落点、直接选择、路径选择共用）：面板里改，这里显示。 */}
            {(tool === "pen-freeform" || tool === "pen-curvature" || tool === "path-select" || tool === "direct-select") ?
              <span className="photo-editor__tool-label" data-path-choice={chosenPath}>
                {chosenPath === "work" ? "目标：工作路径（图层自带路径时优先改图层）" : chosenPath === "layer" ? "目标：当前图层路径" : `目标：路径 ${chosenPath}`}
              </span> : null}
            {tool === "custom-shape" ? <span className="photo-editor__tool-label" data-preset-choice={chosenPreset?.name ?? ""}>
              {chosenPreset ? `预设：${chosenPreset.group} · ${chosenPreset.name}` : "先在「形状与路径」面板选择预设"}
            </span> : null}
            <span className="photo-editor__brush-note">拖动绘制（Shift 约束，Alt 从中心）；Esc 取消；松手才提交一步历史。</span>
          </> : null}
          {tool === "pen" ? <>
            <label>输出<select value={penTarget} disabled={locked || !!pathDraft.points.length} onChange={event => setPenTarget(event.currentTarget.value)}><option value="shape">形状图层</option><option value="path">工作路径</option><option value="mask">矢量蒙版</option></select></label>
            <Button size="sm" disabled={locked || pathDraft.points.length < 3} onClick={finishPath}>闭合并确认</Button>
            <Button size="sm" tone="ghost" disabled={!pathDraft.points.length} onClick={pathDraft.undo}>删除末节点</Button>
            <Button size="sm" tone="ghost" disabled={!pathDraft.points.length} onClick={pathDraft.reset}>取消路径</Button>
          </> : null}
          {tool === "wand" || tool === "quick" ? <>
            <SelectionModeButtons value={selectionMode} disabled={locked} intersect={tool === "wand"} onChange={setSelectionMode} />
            {tool === "wand" ? <><label>容差<input type="number" min={0} max={255} value={tolerance} disabled={locked} onChange={event => setTolerance(Math.max(0, Math.min(255, Number(event.currentTarget.value))))} /></label><label><input type="checkbox" checked={contiguous} disabled={locked} onChange={event => setContiguous(event.currentTarget.checked)} />连续</label></> : <label>笔头大小<input type="number" min={1} max={5000} value={brush.size} disabled={locked} onChange={event => setBrush({...brush, size: clampBrushSize(Number(event.currentTarget.value))})} /></label>}
            <label><input type="checkbox" checked={sampleAllLayers} disabled={locked} onChange={event => setSampleAllLayers(event.currentTarget.checked)} />对所有图层取样</label>
          </> : null}
          {isRetouchTool(tool) ? <>
            {tool === "retouch" ? <select value={retouchTool} disabled={locked} onChange={event => { setRetouchTool(event.currentTarget.value); setMessage(null); }}>{RETOUCH_MENU_TOOLS.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select> : null}
            <label>大小<input type="number" min={1} max={5000} value={brush.size} disabled={locked} onChange={event => setBrush({...brush, size: clampBrushSize(Number(event.currentTarget.value))})} /></label>
            <label>强度<input type="number" min={1} max={100} value={Math.round(brush.opacity * 100)} disabled={locked} onChange={event => setBrush({...brush, opacity: Math.max(.01, Math.min(1, Number(event.currentTarget.value) / 100))})} /></label>
            <RetouchPanel key={`retouch-${retouchPanelVersion}`} readonly={locked} tool={tool === "clone" ? "paint.cloneStamp" : tool === "heal" ? "paint.healingBrush" : retouchTool} controller={controller} onSample={() => {setSampleNext(true); setMessage("单击画布选择采样点");}} samplePoint={retouchSample} aligned={retouchAligned} onAligned={setRetouchAligned} />
          </> : null}

      </div>
      <div className="photo-editor__body">
        <EditorToolRail ellipse={ellipse} onMarqueeKind={setEllipse} tool={tool} onTool={chooseTool} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
          hidden={!display.state.toolsVisible}
          color={colors.foreground} onColor={setColor} background={colors.background} onBackground={setBackground} onColorAction={colorAction} />
        <EditorCanvasMenu commands={commands} disabled={displayDisabled} transforming={transforming}
          canTransform={!!documentView?.transformFrame} canTransformSelection={!!documentView?.selectionFrame}
          canConfirm={transformValid} hasGesture={() => !!canvasRef.current?.hasGesture() || !!nudge.current}
          onTransform={selectionOnly => chooseTool("transform", selectionOnly)} onEndTransform={endTransform} onCommand={run}>
          {panes ? (
            <ViewPanes panes={panes} onActivate={activatePane}
              renderPane={(pane) => {
                // 每个窗格自己的取景：活动视图 = 宿主视口，其余 = 各自记住的取景。
                const view = paneViewport(pane, canvasView.viewport, paneViewports);
                const rotation = paneViews.find((entry) => entry.id === pane.id)?.rotation;
                return renderCanvasPane({ ...canvasView, viewport: view }, {
                  // 只有活动视图接收输入（非活动窗格的按下只用于激活，不落笔）。
                  interactive: !locked && pane.active,
                  ...(pane.active ? { ref: canvasRef } : {}),
                  ...(rotation === undefined ? {} : { rotation }),
                  viewId: pane.id,
                });
              }} />
          ) : renderCanvasPane(canvasView, {
            interactive: !locked,
            ref: canvasRef,
            ...(activeViewId ? { viewId: activeViewId } : {}),
          })}
        </EditorCanvasMenu>

        <EditorSidebar onClosePanel={id => {
          if (controller.hasActiveDraft() || canvasRef.current?.hasGesture()) { setMessage("请先确认或取消当前编辑，再关闭面板"); return; }
          setOpenFeaturePanels(current => current.filter(feature => `feature.${feature}` !== id));
          const detachedPanels = {...display.state.panelLayout?.detachedPanels}; delete detachedPanels[id];
          display.updatePanels?.({activePanel:"layers",detachedPanels});
        }} panels={FEATURE_SECTIONS.filter(section => openFeaturePanels.includes(section.id)).map(section => ({
          id: `feature.${section.id}` as const, label: section.label.replace(/…$/, ""),
          content: <div className="photo-editor__feature-panel">{section.render(featurePanelContext)}</div>
        }))} display={display} canChange={()=>!canvasRef.current?.hasGesture()} disabled={displayDisabled || transforming}
          properties={<section className="photo-editor__panel photo-editor__panel--properties">
            <header className="photo-editor__panel-title"><span>{collapseControl("propertiesCollapsed","属性")}属性</span><span>{propertyTool==="mask"?"蒙版":propertyTool==="text"?"文字":propertyTool==="adjustment"?"调整":"图层"}</span>
              <Button size="sm" tone="ghost" disabled={panelReadonly} aria-expanded={advancedOpen} title="选择要打开的工具与面板"
                onClick={() => {setAdvancedOpen((value) => !value);}}>{advancedOpen ? "关闭列表" : "面板…"}</Button>
            </header>
            <div className="photo-editor__object-properties">
              <p className="photo-editor__property-name">{activeLayer?.name??"未选择图层"}</p>

              {propertyTool ? renderOptions("properties") : <>
                <p>{documentView?.width} × {documentView?.height} px · {documentView?.mode}</p>
                {documentView?.transformFrame ? <dl className="photo-editor__geometry-properties"><dt>X / Y</dt><dd>{documentView.transformFrame[0]} / {documentView.transformFrame[1]} px</dd><dt>宽 / 高</dt><dd>{documentView.transformFrame[2]-documentView.transformFrame[0]} / {documentView.transformFrame[3]-documentView.transformFrame[1]} px</dd></dl>:null}
                {documentView?.transformFrame ? <Button size="sm" disabled={locked || transforming} onClick={()=>chooseTool("transform")}>变换所选图层</Button>:null}
              </>}
              {advancedOpen ? <nav className="photo-editor__feature-picker">
                {FEATURE_SECTIONS.map(section => <Button key={section.id} size="sm" tone="ghost" onClick={() => openFeaturePanel(section.id)}>{section.label}</Button>)}
              </nav> : null}
            </div>
          </section>}
          layers={
          <LayerPanel filterControl={<LayerFilterPanel controller={controller} revision={documentView?.revision ?? 0} onFilter={setFilteredLayerIds} />} filteredLayerIds={filteredLayerIds} collapseControl={collapseControl("layersCollapsed","图层")}
            view={view}
            commands={commands}
            readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
            opacityEditing={{...propertiesEditing,disabled:locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.styleActive}}
            styleEditor={<LayerStyleEditor editing={propertiesEditing.styleEditing} disabled={!activeLayer || !!activeLayer.effectiveLocks.all || locked || transforming || textEditing.active || adjustmentEditing.active || (propertiesEditing.active && !propertiesEditing.styleActive)}/> }
            thumbnail={typeof controller.layerThumbnail === "function" ? readThumbnail : undefined}
            onSelect={(layer,mode) => selectTarget(layer,false,false,mode)}
            onAddMask={(invert) => {
              if (!activeLayer || activeLayer.hasMask) return;
              const operation=documentView?.hasSelection ? invert ? "hideSelection" : "revealSelection" : invert ? "hideAll" : "revealAll";
              if (run(`layer.layerMask.${operation}`,layerParam)) {setTextToolProperties(false);revealProperties();}
            }}
            onMask={(layer,modifiers) => modifiers.shift ? run("layer.layerMask.enabled",{layer:layer.id,enabled:!layer.maskEnabled}) : selectTarget(layer,true,modifiers.alt)}
            onToggleVisible={(layer) => run("layer.setProps", { layer: layer.id, visible: !layer.visible })}
            onBlend={(layer, blend) => run("layer.setProps", { layer: layer.id, blend })}
            onRename={(layer, name) => run("layer.setProps", { layer: layer.id, name })}
            onCommand={(id,params)=>params===undefined ? runLayerAction(id) : run(id,params)}
          />
          } history={<HistoryPanel collapseControl={collapseControl("historyCollapsed","操作历史")} view={view} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active} onUndo={() => run("edit.undo")} onRedo={() => run("edit.redo")}
            onGoTo={(index) => {
              canvasRef.current?.cancelGesture();
              const count = (documentView?.history.length ?? 1) - 1 - index;
              for (let step = 0; step < Math.abs(count); step++) {
                const result = controller.dispatch(count > 0 ? "edit.undo" : "edit.redo");
                if (!result.ok) { setMessage(result.message); break; }
              }
            }} />
        } />
      </div>

      <div className="photo-editor__status">
        <span>{readonly ? "只读" : ({ idle: "准备中", "loading-module": "加载中", opening: "打开中", editing: "编辑中", freezing: "正在导出", saving: "正在保存", saved: "已保存", unavailable: "不可用", failed: "操作失败" })[snapshot.state.phase]}</span>
        {documentView ? (
          <span>
            {documentView.width}×{documentView.height} · {documentView.mode} · {documentView.layers.length} 层
            {documentView.hasSelection ? display.state.extrasVisible?" · 有选区":" · 有选区（边界已隐藏）" : ""}
          </span>
        ) : (
          <span>未打开文档</span>
        )}
        {snapshot.state.dirty ? <span>有未保存修改</span> : null}
        {message || snapshot.state.message ? <span className="photo-editor__message">{message ?? snapshot.state.message}</span> : null}
        {/* 落点请求是画布级的一次性模式：正在等待点击时在状态栏说明，避免用户不知道下一次点击会被吃掉。 */}
        {placement ? <span className="photo-editor__message" data-placement-active="true">{placement.label}</span> : null}
        <span className="photo-editor__status-gap" />
        <div className="photo-editor__status-zoom" data-canvas-viewport-control="true">
          <IconButton size="sm" label="缩小" title={shortcutLabel("缩小（Mod+-）")} disabled={viewDisabled}
            onClick={() => canvasRef.current?.view("zoomOut")}><ZoomOutIcon size={15} /></IconButton>
          <span>{Math.round(canvasView.viewport.zoom * 100)}%</span>
          <IconButton size="sm" label="放大" title={shortcutLabel("放大（Mod++）")} disabled={viewDisabled}
            onClick={() => canvasRef.current?.view("zoomIn")}><ZoomInIcon size={15} /></IconButton>
          <Button size="sm" tone="ghost" disabled={viewDisabled} title={shortcutLabel("适合窗口（Mod+0）")}
            onClick={() => canvasRef.current?.view("fit")}>适合窗口</Button>
          <Button size="sm" tone="ghost" disabled={viewDisabled} title={shortcutLabel("实际大小（Mod+1）")}
            onClick={() => canvasRef.current?.view("actualSize")}>100%</Button>
        </div>
      </div>
      {smartChild ? <SmartChildEditor parent={controller} child={smartChild} onChanged={refreshPreview} /> : null}
    </div>
    </PaintingControlsContext.Provider>
  );
}
