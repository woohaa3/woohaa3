import {LayerGeometryControls} from "./layer-geometry-controls.js";
import {NavigatorPanel} from "./navigator-panel.js";
import {clipboardVisible,type NavigatorFrame,type NavigatorAction} from "./navigator-geometry.js";
import {HistogramPanel} from "./histogram-panel.js";
import type {PixelGridRegion} from "./pixel-grid-data.js";
import {InfoPanel} from "./info-panel.js";
import type {InfoRequest} from "./info-readout.js";
import {StickyModifierContext,NO_STICKY_MODIFIERS,ModifierKeysPanel} from "./modifier-keys.js";
import {useRasterizePrompt} from "./rasterize-prompt.js";
import {TextContextMenu} from "./text-context-menu.js";
import {useTextClipboard} from "./text-clipboard.js";
import {useColorPicker} from "./color-picker.js";
import {useMissingFonts} from "./missing-fonts.js";
import {LOREM_IPSUM} from "./text-placeholder.js";
import {useToolMemory} from "./tool-memory.js";
import {decodeRememberedTool,decodeMoveTarget,decodeSelectionMode,decodeFeather,decodeFalse,decodeTrue,decodeMarqueeLine,decodeMarqueeConstraint,DEFAULT_CONSTRAINT,decodeBucketMemory,decodeSampleMemory,decodeMagicWandMemory,decodeColorRangeMemory,decodeRetouchMemory,decodeSlotMemory,decodeGroupMemory} from "./tool-option-memory.js";
import {useToolReset,ToolResetMenu} from "./tool-reset.js";
import {EDITOR_THEMES,EditorThemeRoot,useEditorTheme,themedEditorDialogs} from "./editor-theme.js";
import {DocumentStatus,ZoomField} from "./editor-status-bar.js";
import {EyedropperOptions,DEFAULT_SAMPLE} from "./eyedropper-tool.js";
import {usePaintingSymmetry} from "./painting-symmetry.js";
import {BucketOptions,DEFAULT_BUCKET,bucketParams,type BucketSettings} from "./bucket-tool.js";
import {useCommandSearch} from "./command-search.js";
import {useFieldMenuShortcuts} from "./use-field-menu-shortcuts.js";
import {stepBrushSize,stepBrushHardness,normalizeBrushAngle} from "./brush-resize.js";
import {SpringTools} from "./spring-tools.js";
import {useEditorPreferences} from "./editor-preferences.js";
import {useColorRangeDialog} from "./color-range-dialog.js";
import {useFadeDialog} from "./fade-dialog.js";
import {useAdjustmentDialog,type AdjustmentKind} from "./adjustment-dialog.js";
import {useFileInfoDialog} from "./file-info-dialog.js";
import {useColorModeDialog} from "./color-mode-dialog.js";
import {useNewDocumentDialog} from "./new-document-dialog.js";
import {useExportDialog} from "./export-dialog.js";
import {useConditionalModeDialog} from "./conditional-mode-dialog.js";
import {useFilterDialog} from "./filter-dialog.js";
import type {GuidePreferences} from "./guides.js";
import {MagicWandOptions} from "./magic-wand-options.js";
import {RetouchOptions} from "./retouch-options.js";
import {TextStyleControls} from "./text-style-controls.js";
import {BrushSettingsPanel,DEFAULT_BRUSH_DYNAMICS,brushDynamicsPatch,decodeBrushDynamics,type BrushDynamics} from "./brush-settings-panel.js";
import {CloneSourcePanel} from "./clone-source-panel.js";
import {BrushPresetPanel} from "./brush-preset-panel.js";
import {buildRetouch,DEFAULT_RETOUCH,isRetouchTool,type RetouchSettings} from "./retouch-tools.js";
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {cycleBlend} from "./layer-blends.js";
import {cyclePaintMode} from "./paint-modes.js";
import {LayerStyleEditor} from "./layer-style-editor.js";
import {useLayerVisibilityEditing} from "./use-layer-visibility-editing.js";
import { useLayerPropertiesEditing } from "./use-layer-properties-editing.js";
import {LayerLayoutControls} from "./layer-layout-controls.js";
import {useFillDialog} from "./fill-dialog.js";
import {useStrokeDialog} from "./stroke-dialog.js";
import {useSpellingDialog} from "./spelling-dialog.js";
import {useFindReplaceDialog} from "./find-replace-dialog.js";
import {useDefinePatternDialog} from "./define-pattern-dialog.js";
import {useScriptImport} from "./script-import.js";
import {useImageGeometryDialogs} from "./image-geometry-dialogs.js";
import {useLayerActionDialogs} from "./layer-action-dialogs.js";
import { useNewLayerDialog } from "./new-layer-dialog.js";
import {editorChromeVisible,EDITOR_SCREEN_MODES,useEditorDisplay,type EditorScreenMode,type EditorDisplayControls,type EditorDisplayAction} from "./editor-display.js";
import { useAdjustmentEditing } from "./use-adjustment-editing.js";
import {EditorSidebar,PanelTabs} from "./editor-sidebar.js";
import {DEFAULT_PANEL_LAYOUT,type EditorPanelLayout} from "./editor-panel-layout.js";
import {ChevronDownIcon,ChevronRightIcon} from "./ui/icons.js";
import { ToolOptionsPanel, type PhotoEditorProperty } from "./photo-editor-tool-options.js";
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";
export { ToolOptionsPanel } from "./photo-editor-tool-options.js";
import { useTextEditing } from "./use-text-editing.js";
import { TextInputOverlay } from "./text-input-overlay.js";
import { LiveStrokePreview } from "./live-stroke-preview.js";
import {SourceDetailPreview,type DetailFrame} from "./source-detail-preview.js";
import { nativeBrushSettings, PaintPercentInput, usePaintTools } from "./paint-tool-state.js";
import { TransformSession } from "./transform-session.js";
import { IDENTITY_MATRIX, frameCenter, type TransformPoint } from "./transform-layer.js";
import { Button } from "./ui/Button.js";
import { EditorCanvasMenu } from "./photo-editor-context-menu.js";
import { EditorWorkspaceController } from "./editor-workspace.js";
import type { EditorDialogPort } from "./ports.js";
import type { EditorDocumentsMenu } from "./photo-editor-menu.js";
import {ColorPanel} from "./color-panel.js";
import { EditorMenuBar, EditorToolRail, type PhotoEditorTool } from "./photo-editor-chrome.js";
import {groupOf, isCanvasTool, memberIdFor, slotOf, toolGroups, toolLabelFor, toolbarMembers, type ToolMember} from "./toolbar-slots.js";
import {paintDispatch} from "./paint-dispatch.js";
import { TransformOptions } from "./layer-transform-ui.js";
import { PhotoCanvas, type PhotoCanvasHandle, type PhotoCanvasView } from "./photo-editor-canvas.js";
import { HistoryPanel, LayerPanel } from "./photo-editor-panels.js";
import {
  buildLasso,
  buildRectSelection,
  buildStroke,
  buildMagicWand,
  DEFAULT_MAGIC_WAND,
  DEFAULT_COLOR_RANGE,
  clampFeather,
  type DocumentPoint,
  type EditorToolId,
  type SelectionMode
} from "./photo-editor-tools.js";
import type { EditorPreview,EditorPreviewRegion } from "./editor-wasm.js";
import { editorInputConsumesKeys, FILL_SHORTCUTS, isEditorMac, nudgeTarget, resolveEditorShortcut, type EditorShortcut } from "./photo-editor-shortcuts.js";
import "./photo-editor.css";

export type PhotoEditorAppProps = {
  /** Chrome layout context. Embedded mode is positioned around the host content rectangle. */
  chromeMode?: "standalone" | "embedded";
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
};

/**
 * 编辑器界面。组件只消费控制器的快照，不直接持有内核。
 *
 * 预览在每次修订变化后重新取一次；`previewSide` 固定，避免每帧调用内核。
 */
export function PhotoEditorApp(props:PhotoEditorAppProps) {
  const dialogs=useMemo(()=>props.dialogs?themedEditorDialogs(props.dialogs):undefined,[props.dialogs]);
  return <EditorThemeRoot transparentChrome={props.chromeMode === "embedded"}><PhotoEditorContents {...props} dialogs={dialogs}/></EditorThemeRoot>;
}
function PhotoEditorContents({ controller, canvasView, onPreview, onDetailPreview, renderCanvasBackground, readonly = false, onApply, closing = false, dialogs, display: controlledDisplay, documents, chromeMode = "standalone" }: PhotoEditorAppProps) {
  const theme=useEditorTheme();
  const localDisplay=useEditorDisplay(undefined,undefined,!controlledDisplay);
  const display=controlledDisplay??localDisplay;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller])
  );
  const editorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<PhotoCanvasHandle>(null);
  const [infoPoint,setInfoPoint]=useState<DocumentPoint|null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const temporaryErase=useRef(false);

  const [sampledColor,setSampledColor]=useState<string|null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sampleSettings,setSampleSettings]=useToolMemory("sample",DEFAULT_SAMPLE,decodeSampleMemory,setMessage);
  const [magicWand,setMagicWand]=useToolMemory("selection.magicWand",DEFAULT_MAGIC_WAND,decodeMagicWandMemory,setMessage);
  const [retouch,setRetouch]=useToolMemory<RetouchSettings>("retouch",DEFAULT_RETOUCH,decodeRetouchMemory,setMessage);
  /**
   * 每槽记住的工具（design D4）。键是槽索引；只存非默认项，与本机工具记忆同一命名空间。
   * 槽位记忆决定槽位按钮显示哪个成员，字母键的组记忆另存 `groupMemory`。
   */
  const [slotMemory,setSlotMemory]=useToolMemory<Record<string,string>>("slots",{},decodeSlotMemory,setMessage);
  /** 每组上次所用工具（design D4）；字母键 `group_tool(key)` 语义。 */
  const [groupMemory,setGroupMemory]=useToolMemory<Record<string,string>>("groups",{},decodeGroupMemory,setMessage);
  const retouchPath=useRef<DocumentPoint[]|null>(null);
  const [retouchPatterns,setRetouchPatterns]=useState<{id:string;name:string;width:number;height:number}[]>([]);
  const [colorRange,setColorRange]=useToolMemory("selection.colorRange",DEFAULT_COLOR_RANGE,decodeColorRangeMemory,setMessage);  const [busy, setBusy] = useState(false);
  const [detailVersion,setDetailVersion]=useState(0);
  const detailRegions=useRef<EditorPreviewRegion[]|undefined>();
  const localDetailUpdate=useRef(false);
  const detailFailure=useRef<(message:string)=>void>(()=>{});
  const previewContext=useRef(canvasView);previewContext.current=canvasView;
  const details=useMemo(()=>new SourceDetailPreview(region=>controller.renderRegion(region),frame=>onDetailPreview?.(frame?{...frame,onUploadFailure:()=>detailFailure.current("图片细节上传失败，已保留基础预览，可重试")} :null),message=>detailFailure.current(message)),[controller,onDetailPreview]);
  useEffect(()=>()=>details.dispose(),[details]);

  // 画布工具与其参数（纯界面状态，不复制文档模型）。
  const [rememberedTool,setRememberedTool]=useToolMemory("current",decodeRememberedTool(null),decodeRememberedTool,setMessage);
  const [tool, setTool] = useState<PhotoEditorTool>(rememberedTool);
  const [,refreshToolMemory]=useState(0);
  const [textToolProperties, setTextToolProperties] = useState(rememberedTool==="text");
  const [layerEditRequest,setLayerEditRequest]=useState<{id:number;kind:"content"|"style"|"mask"}|null>(null);
  const [zoomScrubby,setZoomScrubby]=useToolMemory("zoom.scrubby",true,decodeTrue,setMessage);
  const [autoSelect, setAutoSelect] = useToolMemory("move.autoSelect",true,decodeTrue,setMessage);
  const [autoSelectTarget,setAutoSelectTarget]=useToolMemory("move.target",decodeMoveTarget(null),decodeMoveTarget,setMessage);
  const layerDigits=useRef(new PaintPercentInput());
  const nudge = useRef<{dx: number; dy: number} | null>(null);
  const previousTool = useRef<PhotoEditorTool>("marquee");  const springTools=useRef(new SpringTools<PhotoEditorTool>());
  useEffect(()=>{setRememberedTool(springTools.current.persistentTool(tool==="transform"?previousTool.current:tool));});
  const [boundaryMoveActive,setBoundaryMoveActive]=useState(false);
  const [selectionTransform, setSelectionTransform] = useState(false);
  const [transformMatrix, setTransformMatrix] = useState<readonly number[]>(IDENTITY_MATRIX);
  const [transformLinked, setTransformLinked] = useState(true);
  const [transformReference, setTransformReference] = useState<TransformPoint>();
  const [transformValid, setTransformValid] = useState(true);
  const [selectionMode, setSelectionMode] = useToolMemory<SelectionMode>("selection.mode","replace",decodeSelectionMode,setMessage);
  const [ellipse, setEllipse] = useToolMemory("selection.ellipse",false,decodeFalse,setMessage);
  const [marqueeLine,setMarqueeLine]=useToolMemory("selection.line",undefined as "row"|"column"|undefined,decodeMarqueeLine,setMessage);
  const [marqueeConstraint,setMarqueeConstraint]=useToolMemory("selection.constraint",DEFAULT_CONSTRAINT,decodeMarqueeConstraint,setMessage);
  const marqueeConstraintValid=marqueeConstraint.mode==="normal" || [marqueeConstraint.width,marqueeConstraint.height].every(value=>value.trim()!=="" && Number.isFinite(Number(value)) && Number(value)>=1 && Number(value)<=16384 && (marqueeConstraint.mode!=="size" || Number.isInteger(Number(value))));
  const [bucket,setBucket]=useToolMemory<BucketSettings>("bucket",DEFAULT_BUCKET,decodeBucketMemory,setMessage);
  const [feather, setFeather] = useToolMemory("selection.feather",0,decodeFeather,setMessage);
  const {brush:paintBrush,setBrush,resetPaint,colors,pixelBackground,setColor,setBackground,colorAction,percent,resetDigits} = usePaintTools(tool,snapshot.view.document?.editTarget,setMessage);
  // 画笔动态（I132）：面板读取 `brush.get`，写入 `tools.setBrush`；都是会话工具状态。
  const [brushDynamics,setBrushDynamics]=useState<BrushDynamics>(DEFAULT_BRUSH_DYNAMICS);
  useEffect(()=>{
    if(tool!=="brush"&&tool!=="pencil"&&tool!=="eraser")return;
    // 宿主/测试替身可能只实现部分接口：缺少只读画笔查询时保留默认面板值。
    if(typeof controller.currentBrush!=="function")return;
    const result=controller.currentBrush();
    if(result.ok)setBrushDynamics(decodeBrushDynamics(result.value));
  },[controller,tool]);

  const readAppliedBrush=()=>{
    const result=controller.currentBrush();if(!result.ok){setMessage(result.message);return;}
    setBrushDynamics(decodeBrushDynamics(result.value));
    setBrush(current=>({...current,...nativeBrushSettings(result.value)}));
  };
  const changeBrushDynamics=(patch:Partial<BrushDynamics>)=>{
    if(displayDisabled || transforming || canvasRef.current?.hasGesture())return;
    const next={...brushDynamics,...patch};
    const result=controller.setBrushDynamics(brushDynamicsPatch(next,patch));
    if(!result.ok){setMessage(result.message);return;}
    setBrushDynamics(next);
    if(patch.angle!==undefined)setBrush(current=>({...current,angle:patch.angle}));
  };

  const [altHeld,setAltHeld] = useState(false);
  const strokeAnchor = useRef<{point:DocumentPoint;key:string} | null>(null);
  const [strokePreviewAnchor,setStrokePreviewAnchor]=useState<{point:DocumentPoint;key:string}|null>(null);
  const strokeEnd = useRef<{point:DocumentPoint;key:string} | null>(null);

  const view = snapshot.view;
  const documentView = view.document;
  useEffect(()=>{const result=controller.patternLibrary();if(result.ok)setRetouchPatterns([...result.value.presets,...(result.value.patternPresets??[])]);},[controller,documentView?.revision]);
  const brush={...paintBrush,target:documentView?.editTarget ?? "pixels"};
  const activeLayerId = documentView?.activeLayerId ?? null;
  const readPixelGrid=useCallback((region:PixelGridRegion)=>controller.pixelGrid?.(region)??{ok:false as const,code:"unavailable",message:"像素网格暂不可用"},[controller]);
  const [navigatorFrame,setNavigatorFrame]=useState<{key:string;frame:NavigatorFrame}|null>(null);
  const moveBoxOwner=useRef<{key:string|undefined;revision:number;target:"layer"|"group"}|null>(null);
  const navigatorDocumentKey=documentView?.documentKey??String(snapshot.view.sessionActiveIndex);
  const onNavigatorFrame=useCallback((frame:NavigatorFrame)=>setNavigatorFrame({key:navigatorDocumentKey,frame}),[navigatorDocumentKey]);
  const readNavigator=useCallback(()=>controller.navigatorPreview?.()??{ok:false as const,code:"unavailable",message:"导航预览暂不可用"},[controller]);
  const navigatorNavigate=useCallback((action:NavigatorAction)=>canvasRef.current?.navigator?.(action),[]);
  const navigatorZoom=useCallback((zoom:number)=>canvasRef.current?.zoomTo(zoom),[]);
  const readHistogram=useCallback(()=>controller.histogram?.()??{ok:false as const,code:"unavailable",message:"直方图暂不可用"},[controller]);
  const readInfo=useCallback((params:InfoRequest)=>controller.infoReadout?.(params)??{ok:false as const,code:"unavailable",message:"信息暂不可用"},[controller]);
  const readFontSample=useCallback((family:string,size:number,scale:number)=>controller.fontPreview?.(family,size,scale)??{ok:false as const,code:"unavailable",message:"字体样例尚不可用"},[controller]);
  useEffect(() => {resetDigits();layerDigits.current.reset();},[activeLayerId,tool,brush.target,snapshot.view.sessionActiveIndex,resetDigits]);
  useEffect(()=>{strokeAnchor.current=null;strokeEnd.current=null;setStrokePreviewAnchor(null);},[controller]);
  const activeLayer = documentView?.layers.find((layer) => layer.id === activeLayerId);
  useEffect(() => {
    if (activeLayer?.textStyle) textEditing.setPreference(activeLayer.textStyle);
  }, [activeLayer]);
  const layerParam = useMemo(() => (activeLayerId === null ? {} : { layer: activeLayerId }), [activeLayerId]);

  const refreshPreview = useCallback(() => {
    localDetailUpdate.current=false;detailRegions.current=undefined;
    // 同步取消旧块读取；不能等待 React effect 才隔离同帧到达的新草稿。
    details.clear();
    const rendered = controller.render(2048);
    const document = controller.snapshot().view.document;
    if (rendered.ok && document) onPreview(rendered.value, { width: document.width, height: document.height });
    setDetailVersion(value=>value+1);
  }, [controller, onPreview, details]);
  detailFailure.current=message=>{if(localDetailUpdate.current)refreshPreview();setMessage(message);};
  const refreshStroke=useCallback(()=>{
    const context=previewContext.current;
    const document=controller.snapshot().view.document;
    if(!onDetailPreview || !document || !context.contentSize || context.transitioning ||
      !details.hasCoverage(document.width,document.height,{...context.contentSize,...context.viewport})) {refreshPreview();return;}
    const damage=controller.takeStrokeDamage();
    if(!damage.ok){refreshPreview();return;}
    if(!damage.value.length)return;
    details.pause();localDetailUpdate.current=true;
    detailRegions.current=[...(detailRegions.current??[]),...damage.value];
    setDetailVersion(value=>value+1);
  },[controller,details,onDetailPreview,refreshPreview]);

  const textEditing=useTextEditing(controller,refreshPreview,setMessage,()=>preferences.value.fillNewTextWithPlaceholder,()=>colors.foreground);
  const adjustmentEditing=useAdjustmentEditing(controller,activeLayer,refreshPreview,setMessage,readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing");
  const visibilityEditing=useLayerVisibilityEditing(controller,refreshPreview,setMessage,readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing");
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

  const layerDialogs=useLayerActionDialogs(dialogs,controller,
    readonly || closing || busy || canvasView.transitioning || !documentView ||
    snapshot.state.phase === "saving" || snapshot.state.phase === "freezing" ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);

  const geometryDialogs=useImageGeometryDialogs(dialogs,controller,
    readonly || closing || busy || canvasView.transitioning || !documentView ||
    snapshot.state.phase === "saving" || snapshot.state.phase === "freezing" ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage,colors);

  // 修订变化 → 重新取预览（只读也一样，历史预览需要看到对应画面）。
  useEffect(() => {
    refreshPreview();
  }, [refreshPreview, documentView?.revision, documentView?.width, documentView?.height]);

  useEffect(()=>{
    if(!onDetailPreview || !documentView || !canvasView.contentSize || readonly || closing || canvasView.transitioning) {details.clear();return;}
    // 缩小或移出已有覆盖后，基础图也须包含当前半笔，才能安全撤回旧细节。
    if(localDetailUpdate.current && !details.hasCoverage(documentView.width,documentView.height,{...canvasView.contentSize,...canvasView.viewport})) {refreshPreview();return;}
    const regions=detailRegions.current;
    details.update({width:documentView.width,height:documentView.height,contentVersion:detailVersion,changedRegions:regions,
      keepPrevious:localDetailUpdate.current,immediate:localDetailUpdate.current,
      view:{...canvasView.contentSize,...canvasView.viewport}});
    if(detailRegions.current===regions)detailRegions.current=[];
  },[details,onDetailPreview,refreshPreview,detailVersion,documentView?.width,documentView?.height,canvasView.contentSize?.width,canvasView.contentSize?.height,
    canvasView.viewport.x,canvasView.viewport.y,canvasView.viewport.zoom,canvasView.transitioning,readonly,closing]);

  const definePattern=useDefinePatternDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform" || !propertiesEditing.patternsReady,
    propertiesEditing.definePattern,setMessage);
  const fillDialog=useFillDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform" || !propertiesEditing.patternsReady,colors,refreshPreview,setMessage);
  const findReplace=useFindReplaceDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  const spelling=useSpellingDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  const edgeStroke=useStrokeDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",colors.foreground,refreshPreview,setMessage);
  const scriptImport=useScriptImport(controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform" || newLayer.modalActive,
    ()=>!!canvasRef.current?.hasGesture(),refreshPreview,setMessage);
  const colorRangeDialog=useColorRangeDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage,setColorRange);
  const fadeDialog=useFadeDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  const adjustmentDialog=useAdjustmentDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  const fileInfoDialog=useFileInfoDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  const colorModeDialog=useColorModeDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  // 滤镜（I035）：无参滤镜直接分派，有参滤镜打开表单。
  const filterDialog=useFilterDialog(dialogs,controller,()=>readonly || closing || busy || canvasView.transitioning || !documentView
    || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform"
    || !!canvasRef.current?.hasGesture() || !!nudge.current,refreshPreview);
  // 条件模式转换（I291）：只把表单编译成固定引擎的条件命令。
  const conditionalModeDialog=useConditionalModeDialog(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView
    || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform",refreshPreview,setMessage);
  // 导出（I045）：只有宿主提供文件交付端口时才出现。
  const exportDialog=useExportDialog(dialogs,controller,()=>readonly || closing || busy || canvasView.transitioning || !documentView
    || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform"
    || !!canvasRef.current?.hasGesture() || !!nudge.current);
  useEffect(()=>{const unregister=exportDialog.register();return()=>unregister();},[exportDialog.register]);
  // 新建文档（I064）：命令可用且没有活动手势/草稿时才打开。
  const newDocumentDialog=useNewDocumentDialog(dialogs,controller,()=>readonly || closing || busy || canvasView.transitioning
    || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool === "transform"
    || !!canvasRef.current?.hasGesture() || !!nudge.current);

  const run = useCallback(
    (id: string, params: unknown = null) => {
      if (propertiesEditing.active) {setMessage("请先确认或取消图层属性编辑");return false;}
      if (adjustmentEditing.active) {setMessage("请先确认或取消调整参数编辑");return false;}
      if (textEditing.active) {setMessage("请先确认或取消文字编辑");return false;}
      if (readonly || busy || closing || newLayer.modalActive) {
        setMessage("只读预览不允许修改");
        return false;
      }
      if(id==="edit.definePattern" && params===null){if(canvasRef.current?.hasGesture())return false;return definePattern.open();}
      if(id==="edit.fillHistory" && (canvasRef.current?.hasGesture() || nudge.current))return false;
      if(id==="edit.fill" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return fillDialog.open();}
      if(id==="edit.stroke" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return edgeStroke.open();}
      if(id==="image.colorMode" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return colorModeDialog.open();}
      if(id==="file.automate.conditionalModeChange" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return conditionalModeDialog.open();}
      if(id.startsWith("filter.") && id!=="filter.lastFilter" && params===null){
        if(canvasRef.current?.hasGesture() || nudge.current)return false;
        const mode=filterDialog.open(id);
        if(mode==="direct")return run(id,{});
        return mode==="dialog";
      }
      if(id==="file.fileInfo") {if(canvasRef.current?.hasGesture() || nudge.current)return false;return fileInfoDialog.open();}
      if(id==="file.new" && params===null){if(!newDocumentDialog.available)return false;return newDocumentDialog.open();}
      if(id==="edit.fade" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return fadeDialog.open(documentView?.history.at(-1)??"最近一步");}
      const destructive=id.startsWith("image.adjustments.") ? id.slice("image.adjustments.".length) : null;
      if(destructive && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return adjustmentDialog.open(destructive as AdjustmentKind);}
      if(id==="edit.checkSpelling" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return spelling.open();}
      if(id==="edit.findAndReplaceText" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return findReplace.open();}
      if(id==="select.colorRange" && params===null){if(canvasRef.current?.hasGesture() || nudge.current)return false;return colorRangeDialog.open(colorRange);}
      if(id==="file.scripts.browse" && params===null)return scriptImport.open();
      if((id==="edit.pasteSpecial.pasteInto" || id==="edit.pasteSpecial.pasteOutside") && (canvasRef.current?.hasGesture() || nudge.current))return false;
      canvasRef.current?.cancelGesture();
      if(id==="layer.layerStyle.scaleEffects" && params===null)return layerDialogs.scale();
      if(id==="layer.renameLayer" && params===null)return layerDialogs.rename();
      if(id==="layer.lockLayers" && params===null) return layerDialogs.locks();
      if (id === "layer.new.layer" && params === null) {
        const command = controller.snapshot().commands.get(id);
        if (!command?.allowed || !command.enabled) return false;
        const error = newLayer.open();
        setMessage(error);
        return error === null;
      }
      if(documents?.purge && (id==="edit.purge.clipboard" || id==="edit.purge.histories" || id==="edit.purge.all")) {
        const result=documents.purge.execute(id);setMessage(result.ok?null:result.message??"清理失败");return result.ok;
      }
      if(params===null && id==="view.newGuide") return geometryDialogs.open("guide");
      if(params===null && id==="image.trim") return geometryDialogs.open("trim");
      if(params===null && id==="file.automate.fitImage") return geometryDialogs.open("fit");
      if(params===null && id==="image.imageSize") return geometryDialogs.open("size");
      if(params===null && id==="image.canvasSize") return geometryDialogs.open("canvas");
      if(params===null && id==="image.rotation.arbitrary") return geometryDialogs.open("rotate");
      const fill = FILL_SHORTCUTS.find((entry) => entry.id === id);
      if (id === "edit.paste" && params === null && documentView) {
        const clip=controller.clipboardBounds?.();
        const frame=canvasRef.current?.navigationFrame?.()??(canvasView.contentSize?{viewport:canvasView.viewport,size:canvasView.contentSize,document:{width:documentView.width,height:documentView.height}}:null);
        const {x,y,zoom}=frame?.viewport??canvasView.viewport;
        params=clip?.ok&&clip.value&&frame&&clipboardVisible(clip.value,frame)?{}:{center:[documentView.width/2-x/zoom,documentView.height/2-y/zoom]};
      }
      if(id==="layer.matting.colorDecontaminate" && params===null) return layerDialogs.decontaminate();
      if(id==="layer.matting.defringe" && params===null) return layerDialogs.defringe();
      if(id==="select.findLayers" && params===null) return layerDialogs.find();
      const result = controller.dispatch(id, params === null && (fill || id === "edit.cut" || id === "edit.clear") ? {color:id==="edit.cut"?pixelBackground:colors[fill?.source ?? "background"]} : params);
      setMessage(result.ok ? id==="edit.purge.videoCache"?"没有视频图层可清理":null : result.message);
      return result.ok;
    },
    [controller, documents, geometryDialogs.open, scriptImport.open, definePattern.open,findReplace.open,spelling.open,edgeStroke.open,fillDialog.open,colorRangeDialog.open,colorRange,fadeDialog.open,adjustmentDialog.open,fileInfoDialog.open,colorModeDialog.open,retouchPatterns, readonly, busy, closing, textEditing.active, adjustmentEditing.active, propertiesEditing.active, newLayer.modalActive, newLayer.open, layerDialogs.locks, layerDialogs.rename, layerDialogs.scale, layerDialogs.find, layerDialogs.defringe, layerDialogs.decontaminate, colors.foreground, colors.background,pixelBackground, documentView, canvasView.viewport]
  );

  // 画布手势 → 命令参数（编译在 photo-editor-tools.ts，这里只做提交）。
  const applyMarquee = useCallback(
    (rect: { x: number; y: number; width: number; height: number }, mode = selectionMode) => {
      run("select.rect", buildRectSelection(rect, { mode, ellipse, line:marqueeLine, feather }));
    },
    [ellipse, marqueeLine, feather, run, selectionMode]
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
  const rasterizeBeforePaint=useRasterizePrompt(dialogs,controller,
    readonly || closing || busy || canvasView.transitioning || !documentView || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing" ||
    textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || tool==="transform",
    JSON.stringify([tool,brush,colors,bucket]),refreshPreview,setMessage);
  const beginStroke = (point: DocumentPoint, modifiers?: {shift:boolean;alt?:boolean;mod?:boolean}) => {
    if (readonly || busy || closing) return false;
    if (isRetouchTool(tool)) {
      // 分派决策是纯函数（`paint-dispatch.ts`）：每个绘画工具 id 的行为可在无浏览器环境下断言。
      const dispatch=paintDispatch(tool,{alt:modifiers?.alt,hasPattern:!!retouch.pattern});
      if(dispatch.kind==="other") return false;
      const command=commands.get(dispatch.command);
      if(!command?.allowed || !command.enabled) {setMessage(command?.disabledReason??"当前图层不能使用该绘制工具");return false;}
      if(dispatch.kind==="sample"){
        // 克隆类工具：Alt/Option 单击取样来源点（对应上游来源点手势），不绘制笔迹。
        setRetouch(current=>({...current,source:[point.x,point.y],offset:null}));
        setMessage(`已取样来源 (${Math.round(point.x)}, ${Math.round(point.y)})`);
        return false;
      }
      if(dispatch.kind==="point"){run(dispatch.command,buildRetouch(tool,point,[point],retouch,colors.foreground,documentView?.editTarget??"pixels",canvasView.viewport.zoom));return false;}
      if(dispatch.kind==="blocked"){setMessage(dispatch.reason);return false;}
      // 整笔在释放时一次提交；不伪造内核未提供的实时预览。
      retouchPath.current=[point];
      strokeEnd.current={point,key:String(snapshot.view.sessionActiveIndex)};
      return true;
    }
    const tap=buildStroke([point],brush,{erase:tool==="eraser" || temporaryErase.current && (tool==="brush" || tool==="pencil"),pencil:tool==="pencil",backgroundColor:colors.background,zoom:canvasView.viewport.zoom});
    if(tap && rasterizeBeforePaint(()=>{if(liveStroke.begin(tap))liveStroke.finish();}))return false;
    const key = String(snapshot.view.sessionActiveIndex);
    const anchor = strokeAnchor.current;
    const line = modifiers?.shift && anchor?.key === key;
    const params = buildStroke(line ? [anchor.point,point] : [point], line ? {...brush,smoothing:0} : brush, { erase: tool === "eraser" || temporaryErase.current && (tool==="brush" || tool==="pencil"),pencil:tool==="pencil",backgroundColor:colors.background, zoom: canvasView.viewport.zoom });
    strokeEnd.current = params && liveStroke.begin(params) ? {point,key} : null;
    return !!strokeEnd.current;
  };

  const applySave = useCallback(async () => {
    if (!onApply) return;
    if (newLayer.modalActive) return;
    if (propertiesEditing.active) {setMessage("请先确认或取消图层属性编辑");return;}
    if (adjustmentEditing.active) {setMessage("请先确认或取消调整参数编辑");return;}
    if (textEditing.active && !textEditing.checkpoint()) return;
    if (transformSession.active) { setMessage("请先确认或取消自由变换"); return; }
    canvasRef.current?.cancelGesture();
    setBusy(true);
    try {
      await onApply();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }, [onApply, transformSession, textEditing.active, adjustmentEditing.active, propertiesEditing.active, newLayer.modalActive]);

  const commands = snapshot.commands;
  const baseLocked = newLayer.modalActive || readonly || closing || busy || canvasView.transitioning || snapshot.state.phase === "saving" || snapshot.state.phase === "freezing" || !documentView;
  const painting=tool==="brush"||tool==="pencil"||tool==="eraser";
  const symmetry=usePaintingSymmetry(controller,documentView?.paintingSymmetry??null,documentView?.symmetryPaths??[],String(snapshot.view.sessionActiveIndex),baseLocked || visibilityEditing.active || !painting || textEditing.active || adjustmentEditing.active || propertiesEditing.active,()=>!!canvasRef.current?.hasGesture(),setMessage);
  const locked=baseLocked || visibilityEditing.active || symmetry.active;
  const transforming = tool === "transform";
  const textClipboard=useTextClipboard(textEditing,`${snapshot.view.sessionActiveIndex}`,locked || transforming || adjustmentEditing.active || propertiesEditing.active,setMessage);
  const preferences=useEditorPreferences(dialogs,controller,readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing" || !documentView || transforming || visibilityEditing.active || textEditing.active || adjustmentEditing.active || propertiesEditing.active,setMessage);
  // 标尺/参考线/网格（I096）：显示与吸附偏好来自本机编辑器偏好；参考线本身是文档视图状态。
  const guidePreferences=useMemo<GuidePreferences>(()=>({
    showRulers:preferences.value.showRulers,showGuides:true,showGrid:preferences.value.showGrid,
    snapToGuides:preferences.value.snapToGuides,snapToGrid:preferences.value.snapToGrid,snapToCanvas:true,gridSize:preferences.value.gridSize
  }),[preferences.value.showRulers,preferences.value.showGrid,preferences.value.snapToGuides,preferences.value.snapToGrid,preferences.value.gridSize]);
  const guideControls=useMemo(()=>({
    showRulers:guidePreferences.showRulers,showGuides:guidePreferences.showGuides,showGrid:guidePreferences.showGrid,
    snapToGuides:guidePreferences.snapToGuides,snapToGrid:guidePreferences.snapToGrid,
    toggle:(key:"showRulers"|"showGuides"|"showGrid"|"snapToGuides"|"snapToGrid")=>{
      if(key==="showGuides")return; // 参考线显示由「视图 ▸ 参考线」与 Extras 共同决定，不单独持久化。
      preferences.togglePreference(key,!(guidePreferences as unknown as Record<string,boolean>)[key]);
    }
  }),[guidePreferences,preferences]);
  const colorPicker=useColorPicker(dialogs,controller,`${snapshot.view.sessionActiveIndex}:${documentView?.editTarget}`,
    readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing" || !documentView || transforming || visibilityEditing.active || textEditing.active || adjustmentEditing.active || propertiesEditing.active || symmetry.active,setMessage);
  const missingFonts=useMissingFonts(dialogs,controller,String(snapshot.view.sessionActiveIndex),documentView?.revision,!!commands.get("type.resolveMissingFonts")?.allowed,
    readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing" || !documentView || transforming || visibilityEditing.active || textEditing.active || adjustmentEditing.active || propertiesEditing.active || symmetry.active,setMessage,refreshPreview);
  const viewDisabled=locked;
  const displayDisabled=locked||textEditing.active||adjustmentEditing.active||propertiesEditing.active;
  const chromeVisible=editorChromeVisible(display.state);
  const setScreenMode=(mode:EditorScreenMode)=>{if(displayDisabled||transforming||canvasRef.current?.hasGesture()||nudge.current)return;display.setScreenMode?.(mode);};
  const toggleDisplay=(action:EditorDisplayAction)=>{
    if(displayDisabled||canvasRef.current?.hasGesture()||nudge.current) return;
    display.toggle(action);
  };
  const canSave = !locked && !transforming && !textEditing.composing && !adjustmentEditing.active && !propertiesEditing.active && (snapshot.state.dirty || textEditing.active);
  const transformFrame = selectionTransform ? documentView?.selectionFrame : documentView?.transformFrame;
  /**
   * 槽位按钮显示哪个成员（design D4）：当前工具属于该槽时显示当前工具对应的成员；
   * 否则显示该槽上次所用的成员；再否则显示槽内首成员。
   */
  const shownMemberFor = (slot: {index:number; members:readonly ToolMember[]}):ToolMember => {
    const current = slot.members.filter(member => member.tool === tool);
    if (current.length) {
      const variant = tool === "marquee" ? marqueeVariantValue() : tool === "text" ? textEditing.style.orientation : undefined;
      return current.find(member => member.variant === variant) ?? current[0]!;
    }
    const remembered = slotMemory[String(slot.index)];
    return slot.members.find(member => member.id === remembered) ?? slot.members[0]!;
  };
  const toolLabel = tool === "marquee" ? marqueeLine==="row" ? "单行选框" : marqueeLine==="column" ? "单列选框" : ellipse ? "椭圆选框" : "矩形选框" : transforming ? selectionTransform ? "变换选区" : "自由变换" : toolLabelFor(tool, textEditing.style.orientation);
  const readThumbnail=useCallback((layer:number,mask:boolean)=>controller.layerThumbnail(layer,mask),[controller]);
  const selectedContentBounds=(rows:readonly {selected:boolean;bounds?:[number,number,number,number]|null}[])=>{
    const bounds=rows.filter(row=>row.selected && row.bounds).map(row=>row.bounds!);if(!bounds.length)return null;
    const x=Math.min(...bounds.map(b=>b[0])),y=Math.min(...bounds.map(b=>b[1]));return [x,y,Math.max(...bounds.map(b=>b[0]+b[2]))-x,Math.max(...bounds.map(b=>b[1]+b[3]))-y] as [number,number,number,number];
  };
  const selectTarget=(layer: {id:number},mask:boolean,solo=false,mode:"replace"|"toggle"|"range"="replace") => {
    if (!run("layer.select",{layer:layer.id,mode})) return;
    if (mode!=="replace") return;
    if (!mask && !run("view.layerMask",{layer:layer.id,mode:"off"})) return;
    if (!run(mask ? "channel.target.layerMask" : "channel.target.composite")) return;
    setTextToolProperties(false);
    if (solo) run("view.layerMask",{layer:layer.id,mode:"toggleGray"});
    if (mask || documentView?.layers.find(row=>row.id===layer.id)?.kind==="adjustment") revealProperties();
  };
  useEffect(()=>{
    const request=layerEditRequest;if(!request) return;
    setLayerEditRequest(null);
    if(locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || activeLayer?.id!==request.id) return;
    revealProperties();
    if(request.kind==="mask") return;
    if(request.kind==="style") propertiesEditing.styleEditing.start();
    else if(activeLayer.kind==="text") {setTool("text");textEditing.begin({layer:activeLayer.id});}
    else if(activeLayer.kind==="adjustment") setTextToolProperties(false);
  },[layerEditRequest,activeLayer,locked,transforming,textEditing.active,adjustmentEditing.active,propertiesEditing.active]);
  const requestLayerEditor=(layer:{id:number},kind:"content"|"style"|"mask")=>{
    selectTarget(layer,kind==="mask");setLayerEditRequest({id:layer.id,kind});
  };
  // 画布工具：全部已开放工具都把手势交给画布；未列出的（transform 之外的伪工具）为 none。
  const canvasTool: EditorToolId = !spaceHeld && !locked && !textEditing.active && !adjustmentEditing.active && !propertiesEditing.active && !(tool==="marquee" && !marqueeLine && !marqueeConstraintValid) && isCanvasTool(tool) ? tool : spaceHeld ? "pan" : "none";
  const marqueeVariantValue = ():string => marqueeLine ?? (ellipse ? "ellipse" : "rectangle");
  /**
   * 记录槽位与组记忆（design D4）：只由「选中工具」这一个动作写入，两张表不会各自漂移。
   * 槽位记忆按 `<槽索引>` 存成员 id；组记忆按组字母存成员 id，保留子工具变体。
   */
  const rememberToolForSlots = (next: PhotoEditorTool, variant?: string) => {
    const slot = slotOf(next);
    const sameTool = slot ? slot.members.filter(candidate => candidate.tool === next) : [];
    const member = sameTool.find(candidate => candidate.variant === variant) ?? sameTool[0];
    if (slot && member) setSlotMemory(current => current[String(slot.index)] === member.id ? current : {...current, [String(slot.index)]: member.id});
    const group = groupOf(next);
    if (group) {
      const key = toolbarMembers().find(entry => entry.tool === next)?.key;
      if (key) setGroupMemory(current => current[key] === member?.id ? current : {...current, [key]: member?.id??next});
    }
  };
  const chooseTool = (next: PhotoEditorTool, selectionOnly = false, keyboard=false, variant?:string) => {
    if (locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active) return;
    if(next==="marquee" && variant) {
      setEllipse(variant==="ellipse");setMarqueeLine(variant==="row" || variant==="column"?variant:undefined);
    } else if(next==="text" && variant && commands.get(`type.orientation.${variant}`)?.allowed) {
      textEditing.update({orientation:variant==="vertical"?"vertical":"horizontal"});
    }
    if(!keyboard)springTools.current.reset();
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
    setTool(next);
    rememberToolForSlots(next,variant??(next==="marquee"?marqueeVariantValue():next==="text"?textEditing.style.orientation:undefined));
  };
  useEffect(()=>{const previous=springTools.current.reset();if(previous!==null)setTool(previous);},[controller]);
  const springBusy=()=>!!canvasRef.current?.hasGesture() || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active;
  const restoreSpringTool=()=>{const previous=springTools.current.finish(springBusy());if(previous!==null){setTextToolProperties(previous==="text");setTool(previous);}};
  useEffect(()=>{restoreSpringTool();});
  const previewTransform = (matrix: number[]) => {
    setTransformMatrix(matrix);
    transformSession.preview(matrix);
  };
  const previewMoveTransform=(matrix:number[])=>{
    if(tool==="move" && preferences.value.showBoundingBoxWhenDraggingLayer) setTransformMatrix(matrix);else previewTransform(matrix);
  };
  const endTransform = (commit: boolean) => {
    if (commit && locked) return;
    if (commit && !transformValid) { setMessage("变换参数无效，请修改后重试或取消"); return; }
    if (commit && !transformSession.commit()) {
      if (!transforming) { setBoundaryMoveActive(false);transformSession.cancel(); setTransformMatrix(IDENTITY_MATRIX); setSelectionTransform(false); }
      return;
    }
    if (!commit) transformSession.cancel();
    setBoundaryMoveActive(false);
    setTransformMatrix(IDENTITY_MATRIX);
    setTransformValid(true);
    setSelectionTransform(false);
    if (transforming) setTool(previousTool.current);
  };

  const releaseInput = useCallback(() => {
    if (nudge.current) { nudge.current = null; transformSession.cancel(); setTransformMatrix(IDENTITY_MATRIX); }
    if(!propertiesEditing.presetPickerActive()) propertiesEditing.finish(false);
    adjustmentEditing.finish(false);
    visibilityEditing.finish(false);
    setSpaceHeld(false);
    temporaryErase.current=false;
    symmetry.cancel();
    setAltHeld(false);
    resetDigits();
    canvasRef.current?.cancelGesture();
    const previous=springTools.current.reset();if(previous!==null)setTool(previous);
  }, [transformSession,resetDigits,adjustmentEditing.finish,propertiesEditing.finish,visibilityEditing.finish,symmetry.cancel]);
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
  useEffect(() => { if (baseLocked) releaseInput(); }, [baseLocked, releaseInput]);

  const applyShortcut = (action: EditorShortcut, springKey?:string): void => {
    if(action.kind==="display") {toggleDisplay(action.action);return;}
    if (action.kind !== "paintPercent") {resetDigits();layerDigits.current.reset();}
    if(action.kind==="navigate"){if(!viewDisabled)canvasRef.current?.navigate?.(action.navigation);return;}
    if (action.kind === "view") { if (!viewDisabled) canvasRef.current?.view(action.action); return; }
    if (action.kind === "pan") {
      if (!canvasRef.current?.hasGesture()) setSpaceHeld(true);
      return;
    }
    if (adjustmentEditing.active || propertiesEditing.active) return;
    if (textEditing.active) {if (action.kind === "confirm") endText(true);return;}
    if (locked || canvasRef.current?.hasGesture()) return;
    if (action.kind === "confirm") { if (transforming) endTransform(true); return; }
    if (transforming) return;
    if(action.kind==="documentsClose") {if(action.mode==="all")documents?.onCloseAllDocuments?.();else if((documents?.list?.length??0)>1)documents?.onCloseOtherDocuments?.();return;}
    if(action.kind==="blendCycle") {
      if(tool==="brush" || tool==="pencil") setBrush(current=>({...current,mode:cyclePaintMode(current.mode??"Normal",action.direction)}));
      else if(activeLayer && propertiesEditing.blendEditing.preview(cycleBlend(activeLayer.blend,action.direction,activeLayer.kind==="group"))) propertiesEditing.blendEditing.finish(true);
      return;
    }
    if (action.kind === "nudge") {
      if((tool==="brush" || tool==="pencil" || tool==="eraser") && action.dx!==0 && !action.pixels && !action.duplicate){
        setBrush(current=>({...current,angle:normalizeBrushAngle((current.angle??0)+Math.sign(action.dx)*(Math.abs(action.dx)>1?15:1))}));return;
      }
      const target=nudgeTarget(tool,!!documentView?.hasSelection,action.pixels);
      if(!target) return;
      if (!nudge.current) {
        const boundary=target==="boundary";
        const started=boundary ? transformSession.begin(true) : transformSession.beginMove({x:0,y:0,autoSelect:false,duplicate:!!action.duplicate,selectedPixels:target==="selectedPixels",wholeLayer:target==="layer"});
        if (!started) return;
        setSelectionTransform(boundary);
        nudge.current = {dx:0,dy:0};
      }
      nudge.current.dx += action.dx; nudge.current.dy += action.dy;
      previewTransform([1,0,0,1,nudge.current.dx,nudge.current.dy]);
      return;
    }
    if (nudge.current) { nudge.current = null; endTransform(true); }
    if (action.kind === "toolGroup") {
      // 组切换（design D5）：现工具在组内时按 `cycle` 决定「原地不动」或「下一个」；
      // 不在组内时回到该组上次所用工具，没有记录则取组首。
      const group = toolGroups().get(action.key) ?? [];
      if (!group.length) return;
      const currentId = memberIdFor(tool, tool === "marquee" ? marqueeVariantValue() : tool === "text" ? textEditing.style.orientation : undefined);
      const current = group.findIndex(member => member.id === currentId);
      const remembered = group.find(member => member.id === (groupMemory[action.key] ?? ""))
        ?? group.find(member => member.tool === groupMemory[action.key]);
      const next = current >= 0
        ? (action.cycle ? group[(current + 1) % group.length]! : group[current]!)
        : (remembered ?? group[0]!);
      // 变体成员：先切变体，再选工具，避免工具已切换但变体仍停在旧值。
      if (next.tool === "marquee" && next.variant) {
        if (next.variant === "row" || next.variant === "column") {setEllipse(false);setMarqueeLine(next.variant);}
        else {setMarqueeLine(undefined);setEllipse(next.variant === "ellipse");}
      } else if (next.tool === "text" && next.variant) {
        const mode=next.variant==="vertical"?"vertical" as const:"horizontal" as const;
        if(commands.get(`type.orientation.${mode}`)?.allowed)textEditing.update({orientation:mode});
      }
      if(springKey)springTools.current.press(springKey,tool,next.tool,performance.now());
      chooseTool(next.tool, false, true,next.variant);
    } else if (action.kind === "tool") {
      chooseTool(action.tool,false,true);
    } else if (action.kind === "color") {
      colorAction(action.action);
    } else if (action.kind === "paintPercent") {
      if(tool==="brush" || tool==="pencil" || tool==="eraser") {layerDigits.current.reset();percent(action.digit,action.property);}
      else if(tool==="bucket") {
        resetDigits();
        if(action.property==="flow"){layerDigits.current.reset();return;}
        const scope=`bucket:${snapshot.view.sessionActiveIndex}:${documentView?.editTarget}`;
        const opacity=String(Math.max(1,Math.round(layerDigits.current.input(action.digit,"bucketOpacity",scope,performance.now())*100)));
        setBucket(current=>({...current,opacity}));
      }
      else if(activeLayer) {
        resetDigits();
        const property=action.property==="flow"?"fill":"opacity";
        const scope=`${tool}:${snapshot.view.sessionActiveIndex}:${documentView?.layers.filter(row=>row.selected || row.active).map(row=>row.id).join(",")}`;
        const value=String(layerDigits.current.input(action.digit,property,scope,performance.now())*100);
        if(property==="fill") propertiesEditing.updateFill(value);else propertiesEditing.update(value);
        propertiesEditing.finish(true);
      }
    } else if (action.kind === "brush" && (tool === "brush" || tool === "pencil" || tool === "eraser")) {
      setBrush((current) => action.property === "size"
        ? { ...current, size: stepBrushSize(current.size,action.direction) }
        : { ...current, hardness: stepBrushHardness(current.hardness,action.direction) });
    } else if(action.kind==="open"){documents?.onOpenFile?.();
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
    } else if(action.kind==="layerState") {
      if(activeLayer && !activeLayer.effectiveLocks.all && commands.get("layer.setProps")?.allowed && commands.get("layer.setProps")?.enabled) run("layer.setProps",{layer:activeLayer.id,locks:{transparency:!activeLayer.locks.transparency}});
    } else if (action.kind === "command") {
      const enabled = action.id === "edit.undo" ? documentView?.canUndo
        : action.id === "edit.redo" ? documentView?.canRedo : action.id === "edit.toggleLastState" ? documentView?.canUndo || documentView?.canRedo : commands.get(action.id)?.enabled;
      if (enabled) run(action.id,action.id==="layer.hideLayers" && activeLayer?{layer:activeLayer.id}:undefined);
    }
  };

  const fieldMenuShortcut=useFieldMenuShortcuts({owner:controller,targetKey:`${snapshot.view.sessionActiveIndex}:${documentView?.selectedLayerIds.join(",")}:${activeLayerId}`,isMac:isEditorMac(),
    blocked:locked || transforming || textEditing.active || !!canvasRef.current?.hasGesture() || newLayer.modalActive,
    before:()=>!propertiesEditing.styleActive && propertiesEditing.finish(true) && adjustmentEditing.finish(true),apply:applyShortcut});

  const revealProperties=()=>{
    display.showPanel?.("properties","properties");
    display.updatePanels?.({propertiesCollapsed:false});
  };
  const panelLayout=display.state.panelLayout??DEFAULT_PANEL_LAYOUT;
  const panelVisible=(group:"color"|"properties"|"character"|"navigator"|"history"|"layers"|"brushes")=>chromeVisible && display.state.sidebarVisible && !panelLayout.hiddenGroups[group] && !panelLayout.collapsedGroups[group];
  const navigatorTab=panelLayout.activeTabs.navigator??(display.state.navigatorVisible?"navigator":display.state.histogramVisible?"histogram":display.state.infoVisible?"info":"cloneSource");
  const navigatorActive=(tab:string)=>panelVisible("navigator") && navigatorTab===tab;
  const propertyFrame=documentView?.layerTransformFrame??(!documentView?.hasSelection?documentView?.transformFrame:null);
  const propertyTool:PhotoEditorProperty|null=textEditing.active || textToolProperties?"text":adjustmentEditing.active?"adjustment":documentView?.editTarget==="mask"?"mask":activeLayer?.kind==="text"?"text":activeLayer?.kind==="adjustment"?"adjustment":null;
  const canInsertLorem=!!commands.get("type.create")?.allowed && !locked && !transforming && !propertiesEditing.active && !adjustmentEditing.active && !textEditing.composing;
  const insertLorem=()=>{
    if(!canInsertLorem || canvasRef.current?.hasGesture() || !documentView)return;
    if(textEditing.active){textEditing.insertLorem();return;}
    const {width,height,resolutionDpi}=documentView;
    if(!textEditing.begin({x:width*.1,y:height*.1,box:[width*.1,height*.1,width*.8,height*.8],forceNew:true}))return;
    textEditing.update({text:LOREM_IPSUM,size:Math.min(72,Math.max(6,height/20*72/(resolutionDpi??72)))});
    springTools.current.reset();setTool("text");setTextToolProperties(true);revealProperties();
    textEditing.finish(true);
  };
  const runLayerAction = (id: string) => {
    if(id==="layer.layerStyle.blendingOptions"){
      if(locked || transforming || !activeLayer || propertiesEditing.active || textEditing.active || adjustmentEditing.active || canvasRef.current?.hasGesture() || nudge.current)return false;
      display.showPanel?.("layers","layers");propertiesEditing.styleEditing.start();return true;
    }
    if(id==="type.resolveMissingFonts")return missingFonts.open();
    const adjustment = ADJUSTMENT_LAYER_ACTIONS.find(action => action.id === id);
    const result=run(id, adjustment?.params ?? null);
    if (result && (adjustment || id.startsWith("layer.layerMask."))) {
      setTextToolProperties(false);
      revealProperties();
    }
    return result;
  };
  const resetOptions=(all:boolean)=>{
    if(canvasRef.current?.hasGesture() || nudge.current)return;
    if(all || tool==="brush" || tool==="pencil" || tool==="eraser")resetPaint(all?"all":tool as "brush"|"pencil"|"eraser");
    if(all || tool==="marquee" || tool==="lasso") {setSelectionMode("replace");setFeather(0);if(all || tool==="marquee" && !marqueeLine)setMarqueeConstraint({mode:"normal",width:"1",height:"1"});}
    if(all || tool==="move"){setAutoSelect(true);setAutoSelectTarget("group");display.updatePanels?.({showMoveTransform:DEFAULT_PANEL_LAYOUT.showMoveTransform});}
    if(all || tool==="bucket")setBucket({...DEFAULT_BUCKET});
    if(all || tool==="eyedropper")setSampleSettings({...DEFAULT_SAMPLE});
    if(all || tool==="zoom")setZoomScrubby(true);
    if(all || tool==="text")textEditing.update({...textEditing.style,size:48,font:"Noto Sans SC",bold:false,align:"left",antialias:"smooth",orientation:"horizontal"});
    strokeAnchor.current=null;setStrokePreviewAnchor(null);resetDigits();layerDigits.current.reset();
  };
  const toolReset=useToolReset(dialogs,controller,readonly || closing || busy || canvasView.transitioning || !documentView || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing" || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || symmetry.active,resetOptions,setMessage);
  const search=useCommandSearch({dialogs,controller,purge:documents?.purge,blocked:readonly || closing || busy || canvasView.transitioning || snapshot.state.phase==="saving" || snapshot.state.phase==="freezing" || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active,execute:entry=>{
    if(canvasRef.current?.hasGesture()) return false;
    if(entry.id==="tool.reset"){toolReset.resetCurrent();return true;}
    if(entry.id==="tool.resetAll"){toolReset.confirmAll();return true;}
    if(entry.id==="window.theme.system"){theme.select("system");return true;}
    const selectedTheme=EDITOR_THEMES.find(item=>entry.id===`window.theme.${item.id}`);
    if(selectedTheme){theme.select(selectedTheme.id);return true;}
    if(entry.id==="view.darkenInterface"||entry.id==="view.lightenInterface"){theme.step(entry.id==="view.lightenInterface");return true;}
    if(entry.tool) {chooseTool(entry.tool,false,false,entry.variant);return true;}
    if(entry.id==="edit.transform" || entry.id==="select.transformSelection") {chooseTool("transform",entry.id==="select.transformSelection");return true;}
    return runLayerAction(entry.id);
  },error:setMessage});
  const updatePanels=useCallback((patch:Partial<EditorPanelLayout>)=>{if(!displayDisabled && !transforming && !canvasRef.current?.hasGesture()) display.updatePanels?.(patch);},[displayDisabled,transforming,display.updatePanels]);
  const collapseControl=(key:"layersCollapsed"|"historyCollapsed"|"propertiesCollapsed",name:string)=>{
    const Icon=panelLayout[key]?ChevronRightIcon:ChevronDownIcon;
    return <Button size="sm" tone="ghost" title={`${panelLayout[key]?"展开":"折叠"}${name}`} disabled={displayDisabled} onClick={()=>updatePanels({[key]:!panelLayout[key]})}><Icon size={13}/></Button>;
  };
  const renderOptions=(surface:"tools"|"properties")=>(
    <ToolOptionsPanel zoomScrubby={zoomScrubby} onZoomScrubby={setZoomScrubby} resolutionDpi={documentView?.resolutionDpi??72}
            readonly={locked || transforming || propertiesEditing.active}
            surface={surface} tool={tool} property={propertyTool}
            selection={{ mode: selectionMode, ellipse, feather }}
            marqueeConstraint={marqueeLine?undefined:marqueeConstraint} onMarqueeConstraint={patch=>setMarqueeConstraint(current=>({...current,...patch}))}
            onSelectionMode={setSelectionMode}
            onFeather={(value) => setFeather(clampFeather(value))}
            brush={brush}
            onBrush={(patch) => {
              if (patch.target && activeLayerId !== null) selectTarget({id:activeLayerId},patch.target === "mask");
              setBrush((current) => ({ ...current, ...patch }));
            }}
            fontPreview={preferences.value.fontPreview} readFontSample={readFontSample}
            fontNamesInEnglish={preferences.value.showFontNamesInEnglish} recentFontLimit={preferences.value.recentFonts}
            text={text}
            onPreviewFont={font=>{if(!locked && !transforming && !propertiesEditing.active && !adjustmentEditing.active)textEditing.previewFont(font,activeLayer?.kind==="text"?activeLayer.id:undefined);}}
            onText={(patch)=>{
              if(activeLayer?.kind==="text" && !textEditing.active && !textEditing.begin({layer:activeLayer.id})) return;
              textEditing.update(patch);
            }}
            textActive={textEditing.active} textComposing={textEditing.composing} textEscapeCommits={preferences.value.useEscapeToCommit}
            editingText={activeLayer?.text !== null && activeLayer?.text !== undefined}
            onEditText={()=>{if (activeLayerId!==null) textEditing.begin({layer:activeLayerId});}}
            onConfirmText={()=>endText(true)} onCancelText={()=>endText(false)}
            runCommand={run}
            layerParam={layerParam}
            hasSelection={documentView?.hasSelection ?? false}
            hasMask={activeLayer?.hasMask ?? false}
            canApplyMask={activeLayer?.kind === "raster" || activeLayer?.kind === "pixel"}
            maskProperties={{...propertiesEditing.maskEditing,disabled:locked || transforming || textEditing.active || adjustmentEditing.active || !!activeLayer?.effectiveLocks.all || (propertiesEditing.active && !propertiesEditing.maskEditing.active)}}
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

  return (
    <div ref={editorRef} className="photo-editor" data-editor-chrome-mode={chromeMode} data-editor-chrome={chromeVisible?undefined:"hidden"} data-screen-mode={display.state.screenMode??"standard"} role="application" aria-label="PhotoCraft 图像编辑器" tabIndex={-1}
      onCopy={(event)=>clipboardEvent(event,"edit.copy")}
      onCut={(event)=>clipboardEvent(event,"edit.cut")}
      onPaste={(event)=>clipboardEvent(event,"edit.paste")}
      onKeyDownCapture={(event)=>{
        if((isEditorMac()?event.metaKey:event.ctrlKey) && event.shiftKey && !event.altKey && (event.key==="F1"||event.key==="F2") && !event.nativeEvent.isComposing && event.keyCode!==229 && !editorInputConsumesKeys(event.target)) {
          if(newLayer.modalActive || (event.target as Element).closest('[role="menu"]'))return;
          event.preventDefault();event.stopPropagation();if(!event.repeat)theme.step(event.key==="F2");return;
        }
        if(symmetry.active) {
          if(!event.nativeEvent.isComposing && event.keyCode!==229 && (event.key==="Enter" || event.key==="Escape")){event.preventDefault();event.stopPropagation();symmetry.finish(event.key==="Enter");return;}
          if(!editorInputConsumesKeys(event.target)){event.preventDefault();event.stopPropagation();}return;
        }
        if((isEditorMac()?event.metaKey:event.ctrlKey) && event.key.toLowerCase()==="f" && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode!==229 && search.available) {
          if((event.target as Element).closest('[role="dialog"],[role="menu"]')) return;
          event.preventDefault();event.stopPropagation();if(!event.repeat && !canvasRef.current?.hasGesture()) search.open();return;
        }
        const cycle=resolveEditorShortcut(event.nativeEvent,isEditorMac());
        if(cycle?.kind==="documentCycle" && documents?.onActivateDocument && (documents.list?.length??0)>1) {
          event.preventDefault();event.stopPropagation();
          if(event.repeat || busy || closing || newLayer.modalActive || visibilityEditing.active || transforming || textEditing.composing || canvasRef.current?.hasGesture()) return;
          const entries=documents.list!;
          const current=entries.findIndex(entry=>entry.active);if(current<0) return;
          if(textEditing.active && !textEditing.finish(true)) return;
          if(!propertiesEditing.finish(true) || !adjustmentEditing.finish(true)) return;
          documents.onActivateDocument(entries[(current+cycle.direction+entries.length)%entries.length].id);return;
        }
        if(fieldMenuShortcut(event)) return;
        if(visibilityEditing.active) {
          if(event.key==="Escape") {event.preventDefault();event.stopPropagation();visibilityEditing.finish(false);}
          return;
        }
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
          event.preventDefault();event.stopPropagation();endText(event.key!=="Escape" || preferences.value.useEscapeToCommit);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="s") {
          event.preventDefault();event.stopPropagation();if(!event.repeat && !locked) void applySave();
        }
      }}
      onPointerUp={()=>restoreSpringTool()}
      onPointerCancel={()=>restoreSpringTool()}
      onPointerDownCapture={(event) => {
        if((event.target as Element).closest(".photo-editor-canvas"))springTools.current.useCanvas();
        if (!editorInputConsumesKeys(event.target) && !(event.target as Element).closest("button, .photo-editor-curve")) event.currentTarget.focus({ preventScroll: true });
      }}
      onBlur={(event) => {
        // 参数控件与曲线门户自行结算，提交失败时保留待修正输入。
        if ((event.target as Element).closest(".photo-editor-curve, [data-adjustment-control], [data-layer-opacity], [data-layer-fill], [data-layer-style]")) return;
        const next=event.relatedTarget;
        // A menu portal belongs to this editor even though its DOM is outside the stage.
        const menuOwner=next instanceof Element?next.closest("[data-menu-bar-owner]")?.getAttribute("data-menu-bar-owner"):null;
        if(menuOwner && [...event.currentTarget.querySelectorAll("[data-menu-bar]")].some(menu=>menu.getAttribute("data-menu-bar")===menuOwner))return;
        if (!event.currentTarget.contains(next as Node | null) && !(next instanceof Element && next.closest(".photo-editor-curve"))) releaseInput();
      }}
      onKeyUpCapture={(event)=>{
        if(event.code==="Backquote" || event.key==="`" || event.key==="~") {
          if(temporaryErase.current){event.preventDefault();event.stopPropagation();}
          temporaryErase.current=false;
        }
      }}
      onKeyUp={(event) => {
        const held=springTools.current.pending;
        const previous=springTools.current.release(event.key.toLowerCase(),performance.now(),springBusy());
        if(held && !springTools.current.pending)refreshToolMemory(value=>value+1);
        if(previous!==null){event.preventDefault();event.stopPropagation();setTextToolProperties(previous==="text");setTool(previous);}

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
        if(spaceHeld && event.key.toLowerCase()==="f" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing && event.keyCode!==229) {
          event.preventDefault();event.stopPropagation();if(!event.repeat && !locked && !transforming && !textEditing.active && !adjustmentEditing.active && !propertiesEditing.active && !canvasRef.current?.hasGesture())preferences.cycleCanvasColor(event.shiftKey);return;
        }
        if(event.key.toLowerCase()==="f" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode!==229) {
          event.preventDefault();event.stopPropagation();if(!event.repeat && !textEditing.active)setScreenMode(EDITOR_SCREEN_MODES[(EDITOR_SCREEN_MODES.findIndex(mode=>mode.id===(display.state.screenMode??"standard"))+1)%3]!.id);return;
        }
        if (textEditing.active) {
          if (event.nativeEvent.isComposing || event.keyCode===229) return;
          if (event.key==="Escape" || ((event.ctrlKey || event.metaKey) && event.key==="Enter")) {
            event.preventDefault();event.stopPropagation();endText(event.key!=="Escape" || preferences.value.useEscapeToCommit);
          }
          return;
        }
        if((event.code==="Backquote" || event.key==="`" || event.key==="~") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing && event.keyCode!==229 && !locked && !transforming && !adjustmentEditing.active && !propertiesEditing.active && (tool==="brush" || tool==="pencil")) {
          event.preventDefault();event.stopPropagation();temporaryErase.current=true;return;
        }
        if (event.key === "Alt" && (tool === "brush" || tool === "pencil" || tool === "bucket") && !event.nativeEvent.isComposing && event.keyCode !== 229 && !locked && !canvasRef.current?.hasGesture()) {
          event.preventDefault(); event.stopPropagation(); setAltHeld(true); return;
        }
        if (!event.nativeEvent.isComposing && event.keyCode !== 229 && canvasRef.current?.selectionKey?.(event.key,true)) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        const action = resolveEditorShortcut(event.nativeEvent, isEditorMac(),preferences.value.useShiftForToolSwitch);
        if (!action) return;
        if (action.kind === "confirm" && !transforming) return;
        if (action.kind === "nudge" && tool !== "move" && tool!=="marquee" && tool!=="lasso" && !action.pixels && !((tool==="brush" || tool==="pencil" || tool==="eraser") && action.dx!==0 && !action.duplicate)) return;
        if (action.kind === "escape" && nudge.current) {
          event.preventDefault(); event.stopPropagation(); nudge.current = null; endTransform(false); return;
        }
        if (action.kind === "escape") {
          if (event.repeat) { event.preventDefault(); event.stopPropagation(); return; }
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
        if (event.repeat && action.kind !== "brush" && action.kind !== "view" && action.kind !== "navigate" && action.kind !== "nudge") return;
        if(action.kind==="tool" && action.tool!=="transform" && !event.shiftKey && !locked && !springBusy())springTools.current.press(event.key.toLowerCase(),tool,action.tool==="brush" && action.cycle && (tool==="brush" || tool==="pencil") ? tool==="brush"?"pencil":"brush":action.tool,performance.now());
        applyShortcut(action,action.kind==="toolGroup" && !event.shiftKey && !locked && !springBusy()?event.key.toLowerCase():undefined);
      }}>

      {scriptImport.input}
      <EditorMenuBar textClipboard={textClipboard} textActions={commands.get("type.create")?.allowed?{canInsertLorem,insertLorem,
        canAntialias:!locked && !transforming && !textEditing.composing && !adjustmentEditing.active && !propertiesEditing.active && (textEditing.active || !!commands.get("type.antiAlias.smooth")?.enabled),antialias:text.antialias,
        canOrientation:!locked && !transforming && !textEditing.composing && !adjustmentEditing.active && !propertiesEditing.active && (textEditing.active || !!commands.get("type.orientation.vertical")?.enabled),
        setOrientation:mode=>{if(locked || transforming || textEditing.composing || adjustmentEditing.active || propertiesEditing.active || canvasRef.current?.hasGesture() || nudge.current || !commands.get(`type.orientation.${mode}`)?.allowed)return;if(textEditing.active)textEditing.update({orientation:mode});else run(`type.orientation.${mode}`);},
        setAntialias:mode=>{if(locked || transforming || textEditing.composing || adjustmentEditing.active || propertiesEditing.active || canvasRef.current?.hasGesture() || nudge.current || !commands.get(`type.antiAlias.${mode}`)?.allowed)return;if(textEditing.active)textEditing.update({antialias:mode});else run(`type.antiAlias.${mode}`);}}:undefined} theme={theme} commands={commands} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
        display={{...display,state:display.state,toggle:toggleDisplay,setScreenMode:display.setScreenMode?setScreenMode:undefined}} displayDisabled={displayDisabled} viewDisabled={viewDisabled}
        cloneSourceAvailable={!!commands.get("cloneSource.list")?.allowed}
        brushPresetsAvailable={!!commands.get("brush.presets.list")?.allowed}
        guides={guideControls}
        mergeLabel={(documentView?.layers.filter(layer => layer.selected || layer.active).length ?? 0) > 1 ? "合并图层" : activeLayer?.kind === "group" ? "合并组" : "向下合并"}
        canUndo={documentView?.canUndo ?? false} canRedo={documentView?.canRedo ?? false}
        canTransform={!!documentView?.transformFrame} canTransformSelection={!!documentView?.selectionFrame}
        onTransform={selectionOnly => chooseTool("transform", selectionOnly)}
        onView={action => applyShortcut({kind: "view", action})}
        onSearch={search.available?()=>{if(!canvasRef.current?.hasGesture()) search.open();}:undefined}
        onPreferences={preferences.available?()=>{if(!canvasRef.current?.hasGesture() && !nudge.current) preferences.open();}:undefined}
        onCommand={runLayerAction} onApply={() => void applySave()} canSave={canSave} saving={busy}
        {...(documents ? { documents:{...documents,onDuplicateDocument:documents.onDuplicateDocument?()=>{if(!canvasRef.current?.hasGesture() && !nudge.current && !displayDisabled)documents.onDuplicateDocument?.();}:undefined,...(newDocumentDialog.available?{onNewDocument:()=>{if(!canvasRef.current?.hasGesture() && !nudge.current && !displayDisabled)newDocumentDialog.open();}}:{}),...(exportDialog.available?{onExport:()=>{if(!canvasRef.current?.hasGesture() && !nudge.current && !displayDisabled)exportDialog.open();}}:{})} } : {})} />
      <div className="photo-editor__contextbar" data-narrow-options={display.state.narrowOptionsBar || undefined} hidden={!chromeVisible || !display.state.optionsVisible}>
        <ToolResetMenu key={`${snapshot.view.sessionActiveIndex}:${tool}`} tool={tool} label={toolLabel??tool} disabled={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active} onReset={()=>{if(!canvasRef.current?.hasGesture())toolReset.resetCurrent();}} onAll={toolReset.available?()=>{if(!canvasRef.current?.hasGesture())toolReset.confirmAll();}:undefined}/>
          {transforming ? <TransformOptions resolutionDpi={documentView?.resolutionDpi??72} linked={transformLinked} onLinkedChange={setTransformLinked} reference={transformReference} onReferenceChange={setTransformReference} frame={transformFrame ?? null} matrix={transformMatrix} readonly={locked} onValidChange={setTransformValid} onPreview={previewTransform} onConfirm={() => endTransform(true)} onCancel={() => endTransform(false)} /> : null}
          {tool==="bucket"?<BucketOptions controller={controller} value={bucket} onChange={patch=>setBucket(current=>({...current,...patch}))} disabled={locked}/>:null}
          {tool === "move" ? <label><input type="checkbox" checked={autoSelect} disabled={locked} onChange={(event) => setAutoSelect(event.currentTarget.checked)} />自动选择</label> : null}
          {tool==="move" ? <label><input type="checkbox" checked={panelLayout.showMoveTransform} disabled={locked} onChange={event=>updatePanels({showMoveTransform:event.currentTarget.checked})}/>显示变换控件</label>:null}
          {tool==="move" ? <select title="自动选择目标" value={autoSelectTarget} disabled={locked} onChange={event=>setAutoSelectTarget(event.currentTarget.value as "layer"|"group")}><option value="group">组</option><option value="layer">图层</option></select>:null}
          {tool === "move" ? <Button size="sm" disabled={locked || !documentView?.transformFrame} onClick={() => chooseTool("transform")}>自由变换</Button> : null}
          {tool==="move"?<LayerLayoutControls quick commands={commands} readonly={locked || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active} hasSelection={documentView?.hasSelection??false} onCommand={(id,params)=>{if(!canvasRef.current?.hasGesture() && !nudge.current)run(id,params??null);}}/>:null}
          {(tool === "marquee" || tool === "lasso") ? <Button size="sm" disabled={locked || !documentView?.selectionFrame} onClick={() => chooseTool("transform",true)}>变换选区</Button> : null}
          {tool==="eyedropper"?<EyedropperOptions value={sampleSettings} onChange={setSampleSettings} disabled={locked}/>:null}
          {tool==="magicWand"?<MagicWandOptions value={magicWand} onChange={patch=>setMagicWand(current=>({...current,...patch}))} disabled={locked}/>:null}
          {isRetouchTool(tool)?<RetouchOptions tool={tool} value={retouch} onChange={patch=>setRetouch(current=>({...current,...patch}))} disabled={locked || transforming} patterns={retouchPatterns} resolutionDpi={documentView?.resolutionDpi??72}/>:null}
          {tool==="text"?<Button size="sm" tone="ghost" disabled={locked || transforming} onClick={()=>display.showPanel?.("character","character")}>字符 / 段落</Button>:null}
          {painting?<Button size="sm" tone="ghost" disabled={locked || transforming} onClick={()=>display.showPanel?.("brushes","settings")}>画笔设置</Button>:null}
          {painting?symmetry.controls:null}
          {renderOptions("tools")}

      </div>
      {display.state.screenModeError && !chromeVisible?<div className="photo-editor__screen-error">{display.state.screenModeError}</div>:null}
      <div className="photo-editor__body">
        <EditorToolRail tool={tool} onTool={(next,variant)=>chooseTool(next,false,false,variant)} shownMemberFor={shownMemberFor} onTextOrientation={mode=>{
          if(locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || canvasRef.current?.hasGesture() || nudge.current || mode==="vertical" && !commands.get("type.orientation.vertical")?.allowed)return;
          chooseTool("text");if(commands.get(`type.orientation.${mode}`)?.allowed)textEditing.update({orientation:mode});
        }} quickMask={!!documentView?.quickMask} onQuickMask={()=>run("select.editInQuickMaskMode")} screenMode={display.state.screenMode} onScreenMode={display.setScreenMode?setScreenMode:undefined} onView={action=>canvasRef.current?.view(action)} doubleColumn={panelLayout.toolbarDouble} onToggleColumns={()=>updatePanels({toolbarDouble:!panelLayout.toolbarDouble})} onMarqueeKind={(ellipse,line)=>{setEllipse(ellipse);setMarqueeLine(line);}} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
          hidden={!chromeVisible || !display.state.toolsVisible}
          onEditColor={colorPicker.available?target=>{if(!canvasRef.current?.hasGesture())colorPicker.open(colors[target],target==="foreground"?setColor:setBackground);}:undefined}
          color={colors.foreground} onColor={setColor} background={colors.background} onBackground={setBackground} onColorAction={colorAction} />
        <EditorCanvasMenu commands={commands} disabled={displayDisabled} transforming={transforming}
          canTransform={!!documentView?.transformFrame} canTransformSelection={!!documentView?.selectionFrame}
          canConfirm={transformValid} hasGesture={() => !!canvasRef.current?.hasGesture() || !!nudge.current}
          onTransform={selectionOnly => chooseTool("transform", selectionOnly)} onEndTransform={endTransform} onCommand={run}>
          <StickyModifierContext.Provider value={display.state.stickyModifiers??NO_STICKY_MODIFIERS}><PhotoCanvas ref={canvasRef}
            onNavigatorFrame={display.state.navigatorVisible && navigatorActive("navigator")?onNavigatorFrame:undefined}
            pixelGrid={display.state.pixelGridVisible&&display.state.extrasVisible?{contextKey:`${documentView?.documentKey??snapshot.view.sessionActiveIndex}:${documentView?.revision}:${detailVersion}`,read:readPixelGrid}:undefined}
            onPointerPosition={display.state.infoVisible && navigatorActive("info")?setInfoPoint:undefined}
            showScrollbars={!display.state.screenMode || display.state.screenMode==="standard"}
            view={canvasView}
            {...(renderCanvasBackground ? { renderBackground: renderCanvasBackground } : {})}
            documentWidth={documentView?.width ?? 0}
            documentHeight={documentView?.height ?? 0}
            interactive={!locked}
            tool={canvasTool}
            positioning={propertiesEditing.positioning}
            resolutionDpi={documentView?.resolutionDpi??72}
            screenResolution={preferences.value.screenResolution}
            measurementUnit={preferences.value.measurementUnit} pointPicaSize={preferences.value.pointPicaSize}
            pasteboard={preferences.value.pasteboard}
            transparency={preferences.value.transparency}
            selectedBounds={selectedContentBounds(documentView?.layers??[])}
            enableGestures={preferences.value.enableGestures}
            overscroll={preferences.value.overscroll}
            zoomWithScrollWheel={preferences.value.zoomWithScrollWheel} zoomWithTrackpadPinch={preferences.value.zoomWithTrackpadPinch}
            zoomScrubby={zoomScrubby}
            animatedZoom={preferences.value.animatedZoom}
            zoomClickedPointToCenter={preferences.value.zoomClickedPointToCenter}
            enableFlickPanning={preferences.value.enableFlickPanning}
            showTransformationValues={preferences.value.showTransformationValues}
            hasSelection={!!documentView?.hasSelection}
            selectionContains={point=>{const result=controller.selectionContains(point.x,point.y);return result.ok && result.value;}}
            selectionOutline={selectionTransform ? documentView?.selectionOutline : transformSession.active ? [] : documentView?.selectionOutline}
            showSelectionEdges={display.state.extrasVisible}
            selectionMatrix={selectionTransform ? transformMatrix : undefined}
            onSelectionMoveStart={(pixels) => {
              if (!transformSession.begin(!pixels)) return false;
              setSelectionTransform(!pixels); setTransformMatrix(IDENTITY_MATRIX); return true;
            }}
            transformFrame={(transforming || (tool === "move" && display.state.extrasVisible && (panelLayout.showMoveTransform || boundaryMoveActive))) && !spaceHeld ? transformFrame : null}
            transformMatrix={transformMatrix}
            transformLinked={transformLinked} transformReference={transformReference} onTransformReferenceChange={setTransformReference}
            transformMoveOnly={tool === "move"}
            moveHoverKey={`${autoSelect}:${autoSelectTarget}:${documentView?.revision}:${documentView?.editTarget}:${documentView?.hasSelection}:${display.state.extrasVisible}:${locked}`}
            onMoveHover={(point,modifiers)=>{
              if(locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || !display.state.extrasVisible || documentView?.editTarget==="mask" || documentView?.hasSelection || autoSelect===modifiers.toggleAuto || !controller.moveHoverAt)return null;
              const result=controller.moveHoverAt({...point,target:autoSelectTarget});if(result.ok)return result.value;setMessage(result.message);return null;
            }}
            guides={documentView?.guides}
            guidePreferences={guidePreferences}
            onGuidesChange={action=>{
              if(locked || !display.state.extrasVisible)return;
              if(action.kind==="create")run("view.newGuide",{orientation:action.orientation,position:action.position});
              else if(action.kind==="move")run("view.moveGuide",{orientation:action.orientation,index:action.index,position:action.position});
              else run("view.deleteGuide",{orientation:action.orientation,index:action.index});
            }}
            onRulerOrigin={origin=>{if(!locked)run("view.setRulerOrigin",{x:origin[0],y:origin[1]});}}
            measureMoveDistance={display.state.extrasVisible && tool==="move" && !locked}
            onMoveMeasure={(point)=>{
              const selectedIds=new Set((documentView?.layers??[]).filter(row=>row.selected).map(row=>row.id));
              if(locked || !controller.moveHoverAt || !selectedIds.size)return undefined;
              const result=controller.moveHoverAt({...point,target:autoSelectTarget});
              if(!result.ok){setMessage(result.message);return undefined;}
              // null 或命中自身选择：上游此时量到画布边缘。
              if(!result.value || selectedIds.has(result.value.layer))return null;
              const frame=result.value.frame;
              return [frame[0],frame[1],frame[2],frame[3]] as const;
            }}
            onMovePick={(point,modifiers)=>{
              if(documentView?.editTarget==="mask" || documentView?.hasSelection || autoSelect===modifiers.toggleAuto) return true;
              const result=controller.pickLayerAt({...point,target:autoSelectTarget,mode:modifiers.add?"add":"replace"});
              if(!result.ok) {setMessage(result.message);return false;}
              refreshPreview();
              if(result.value!==null)return true;
              const fresh=controller.snapshot().view.document;
              if(!fresh || !controller.snapshot().commands.get("layer.selectInRect")?.allowed)return false;
              moveBoxOwner.current={key:fresh.documentKey,revision:fresh.revision,target:autoSelectTarget};return "box";
            }}
            onMoveBoxEnd={(start,end,add,dragged)=>{
              const owner=moveBoxOwner.current;moveBoxOwner.current=null;
              const fresh=controller.snapshot().view.document;
              if(locked || !owner || !fresh || fresh.documentKey!==owner.key || fresh.revision!==owner.revision || !controller.canDispatchCommands())return;
              if(dragged){const width=end.x-start.x,height=end.y-start.y;if(!width || !height)return;
                run("layer.selectInRect",{...start,width,height,target:owner.target,mode:add?"add":"replace"});
              }else if(start.x<0 || start.y<0 || start.x>=fresh.width || start.y>=fresh.height)run("select.deselectLayers",{});
              refreshPreview();
            }}
            moveBoundingBox={tool==="move" && preferences.value.showBoundingBoxWhenDraggingLayer}
            onMoveStart={(point, modifiers) => {const started=transformSession.beginMove({ ...point, autoSelect:false, duplicate: modifiers.duplicate, wholeLayer:modifiers.wholeLayer, selectedPixels:modifiers.selectedPixels ?? (documentView?.hasSelection && tool==="move") });if(started && tool==="move" && preferences.value.showBoundingBoxWhenDraggingLayer) setBoundaryMoveActive(true);return started;}}
            onMovePreview={previewMoveTransform}
            onMoveEnd={(matrix) => { previewTransform(matrix); endTransform(true); }}
            onMoveCancel={() => endTransform(false)}
            onTransformBegin={() => transformSession.begin()}
            onTransformPreview={previewMoveTransform}
            onTransform={(matrix) => { previewTransform(matrix); if (!transforming) endTransform(true); }}
            onTransformCancel={() => { if (!transforming) endTransform(false); }}
            ellipse={ellipse}
            marqueeLine={marqueeLine}
            marqueeConstraint={marqueeConstraintValid?{mode:marqueeConstraint.mode,width:Number(marqueeConstraint.width),height:Number(marqueeConstraint.height)}:undefined}
            selectionMode={selectionMode}
            onText={(placement)=>{revealProperties();return textEditing.begin(placement);}}
            onBucket={point=>{
              const params=bucketParams(bucket,point,colors.foreground,documentView?.editTarget??"pixels");
              if(!params){setMessage("请输入 1–100% 不透明度、0–255 容差，并选择填充图案。");return;}
              if(rasterizeBeforePaint(()=>{const result=controller.dispatch("paint.bucket",params);setMessage(result.ok?null:result.message);refreshPreview();}))return;
              run("paint.bucket",params);
            }}
            onTextEdit={point=>{
              if(locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active) return;
              const hit=controller.pickLayerAt({...point,target:"layer",select:false});
              if(!hit.ok) {setMessage(hit.message);return;}
              const id=hit.value;
              if(typeof id!=="number" || controller.snapshot().view.document?.layers.find(layer=>layer.id===id)?.kind!=="text") return;
              const selected=controller.dispatch("layer.select",{layer:id});if(!selected.ok) {setMessage(selected.message);return;}
              if(textEditing.begin({layer:id,...point})) {setTool("text");revealProperties();}
            }}
            renderOverlay={(origin,zoom)=><><ModifierKeysPanel display={{...display,state:{...display.state,modifiersVisible:chromeVisible && display.state.modifiersVisible}}} disabled={locked}/>{painting?symmetry.overlay(origin,zoom,documentView?.width??0,documentView?.height??0):null}{textEditing.active ? <TextContextMenu editing={textEditing} clipboard={textClipboard} disabled={locked} onEnd={endText} onLorem={canInsertLorem?insertLorem:undefined}><TextInputOverlay editing={textEditing} origin={origin} zoom={zoom} disabled={locked} preciseCursor={preferences.value.cursors.other==="precise"} smartQuotes={preferences.value.useSmartQuotes} escapeCommits={preferences.value.useEscapeToCommit} onEnd={endText}
              onFormat={command=>{
                if(locked || textEditing.composing)return;
                // 格式快捷键（I127）只写已开放的字符/段落字段，正式提交仍由原生 `type.setStyle` 完成。
                if(command.kind==="style"){
                  const style=command.style;
                  const patch:Record<string,unknown>={};
                  if(style.caps==="all")patch.caps="all";
                  if(style.underline===true)patch.underline=true;
                  if(style.strikethrough===true)patch.strikethrough=true;
                  if(style.fauxBold===true){patch.fauxBold=true;textEditing.update({bold:true});}
                  if(style.fauxItalic===true)patch.fauxItalic=true;
                  textEditing.updateStyle(patch);
                  return;
                }
                if(command.kind==="hyphenate"){textEditing.updateStyle({hyphenate:!textEditing.textStyle?.hyphenate});return;}
                // 相对步进：以当前草稿值为基准，缺少基准时用原生默认值起步。
                const current=textEditing.textStyle;
                const step=command.amount;
                switch(command.field){
                  case "leadingBy": textEditing.updateStyle({leading:Math.max(.01,Math.min(5000,(current?.leading??textEditing.style.size*1.2)+step))});return;
                  case "baselineShiftBy": textEditing.updateStyle({baselineShift:Math.max(-5000,Math.min(5000,(current?.baselineShift??0)+step))});return;
                  case "trackingBy": textEditing.updateStyle({tracking:Math.max(-1000,Math.min(10000,(current?.tracking??0)+step))});return;
                  case "leading": textEditing.updateStyle({leading:Math.max(.01,Math.min(5000,step))});return;
                }
              }}/></TextContextMenu> : null}</>}
            cursors={preferences.value.cursors} brushHardness={brush.hardness}
            brushSize={brush.size}
            eraserMode={brush.eraserMode}
            brushResize={{values:brush,hardness:preferences.value.varyBrushHardnessOnHud,commit:values=>setBrush(current=>({...current,...values}))}}
            strokeAnchor={strokePreviewAnchor?.key===String(snapshot.view.sessionActiveIndex)?strokePreviewAnchor.point:null}
            sampling={altHeld}
            samplingColors={{foreground:colors.foreground,background:colors.background,current:sampledColor}}
            onSampleColor={(point,modifiers) => { const result = controller.sampleColor(point.x,point.y,sampleSettings); if (result.ok) {setSampledColor(result.value); if (result.value) {if(modifiers?.background)setBackground(result.value);else setColor(result.value);} } else setMessage(result.message); }}
            onMarquee={applyMarquee}
            onLasso={applyLasso}
            onSelectionClick={(_point, mode = selectionMode) => {
              if (mode === "replace" && documentView?.hasSelection) run("select.deselect");
            }}
            onMagicWand={(point,mode)=>{
              if(commands.get("select.magicWand")?.allowed) run("select.magicWand",buildMagicWand(point,magicWand,mode));
            }}
            onStrokeStart={beginStroke}
            onStrokeTap={point=>{if(liveStroke.replaceTap(point) && strokeEnd.current)strokeEnd.current={...strokeEnd.current,point};}}
            onStrokeMove={(points) => { if (strokeEnd.current && points.length) strokeEnd.current.point = points[points.length-1]; if(isRetouchTool(tool)){if(retouchPath.current)retouchPath.current.push(...points);return;} liveStroke.append(points); }}
            onStroke={(points) => {
              if(isRetouchTool(tool)){
                const path=retouchPath.current??points;retouchPath.current=null;strokeEnd.current=null;
                if(!path.length)return;
                const dispatch=paintDispatch(tool,{hasPattern:!!retouch.pattern});
                if(dispatch.kind!=="stroke")return;
                const params=buildRetouch(tool,path[0]!,path,retouch,colors.foreground,documentView?.editTarget??"pixels",canvasView.viewport.zoom,selectionMode);
                if(params)run(dispatch.command,params);
                return;
              }
              if (liveStroke.finish() && strokeEnd.current) {strokeAnchor.current = strokeEnd.current;setStrokePreviewAnchor({...strokeEnd.current});} strokeEnd.current = null;
            }}
            onStrokeCancel={() => { if(isRetouchTool(tool)){retouchPath.current=null;strokeEnd.current=null;return;} liveStroke.cancel(); strokeEnd.current = null; }}
          /></StickyModifierContext.Provider>
        </EditorCanvasMenu>

        <EditorSidebar color={<ColorPanel foreground={colors.foreground} background={colors.background} onForeground={setColor} onBackground={setBackground} onPick={background=>colorPicker.available && colorPicker.open(background?colors.background:colors.foreground,background?setBackground:setColor)} onAction={colorAction} disabled={displayDisabled} active={panelLayout.activeTabs.color} onActive={id=>updatePanels({activeTabs:{...panelLayout.activeTabs,color:id}})} report={setMessage}/>} character={<PanelTabs active={panelLayout.activeTabs.character} onActive={id=>updatePanels({activeTabs:{...panelLayout.activeTabs,character:id}})} tabs={(["character","paragraph"] as const).map(group=>({id:group,label:group==="character"?"字符":"段落",content:<TextStyleControls group={group} style={textEditing.textStyle} size={textEditing.style.size} disabled={displayDisabled || transforming || textEditing.composing || !textEditing.active && activeLayer?.kind!=="text"} onChange={patch=>{if(!textEditing.active && activeLayer?.kind==="text" && !textEditing.begin({layer:activeLayer.id}))return;textEditing.updateStyle(patch);}}/>}))}/> } characterVisible={!!commands.get("type.create")?.allowed} infoVisible={!!(display.state.navigatorVisible || display.state.histogramVisible || display.state.infoVisible || display.state.cloneSourceVisible)} info={<PanelTabs active={panelLayout.activeTabs.navigator} onActive={id=>updatePanels({activeTabs:{...panelLayout.activeTabs,navigator:id}})} tabs={[
          ...(display.state.navigatorVisible ? [{id:"navigator",label:"导航器",content:<NavigatorPanel active={navigatorActive("navigator")} key={navigatorDocumentKey} contextKey={`${navigatorDocumentKey}:${documentView?.revision}:${detailVersion}`} frame={navigatorFrame?.key===navigatorDocumentKey?navigatorFrame.frame:null} read={readNavigator} transparency={preferences.value.transparency} navigate={navigatorNavigate} zoomTo={navigatorZoom} blocked={displayDisabled} pinch={preferences.value.zoomWithTrackpadPinch}/>}] : []),
          ...(display.state.histogramVisible ? [{id:"histogram",label:"直方图",content:<HistogramPanel active={navigatorActive("histogram")} documentKey={documentView?.documentKey??String(snapshot.view.sessionActiveIndex)} contextKey={`${documentView?.revision}:${detailVersion}`} read={readHistogram}/>}] : []),
          ...(display.state.infoVisible ? [{id:"info",label:"信息",content:<InfoPanel active={navigatorActive("info")} key={snapshot.view.sessionActiveIndex} contextKey={`${documentView?.documentKey??snapshot.view.sessionActiveIndex}:${documentView?.revision}:${detailVersion}`} point={infoPoint} size={sampleSettings.size} unit={preferences.value.measurementUnit} pointPicaSize={preferences.value.pointPicaSize} resolutionDpi={documentView?.resolutionDpi??72} read={readInfo}/>}] : []),
          ...(display.state.cloneSourceVisible ? [{id:"cloneSource",label:"克隆源",content:<CloneSourcePanel controller={controller} visible={navigatorActive("cloneSource")} disabled={displayDisabled||transforming} documentKey={documentView?.documentKey??String(snapshot.view.sessionActiveIndex)} allowed={!!commands.get("cloneSource.list")?.allowed} message={setMessage}/>}] : [])
        ]}/>} brushes={<PanelTabs active={panelLayout.activeTabs.brushes} onActive={id=>updatePanels({activeTabs:{...panelLayout.activeTabs,brushes:id}})} tabs={[
          {id:"presets",label:"画笔",content:<BrushPresetPanel controller={controller} syncCurrent={()=>controller.setBrushDynamics({size:brush.size,hardness:brush.hardness,opacity:brush.opacity,flow:brush.flow,smoothing:{amount:brush.smoothing,enabled:true},angle:brush.angle??brushDynamics.angle,mode:brush.mode??"Normal"})} onApplied={readAppliedBrush} visible={!!display.state.brushPresetsVisible && panelVisible("brushes") && (panelLayout.activeTabs.brushes??"presets")==="presets"} disabled={displayDisabled||transforming} documentKey={documentView?.documentKey??String(snapshot.view.sessionActiveIndex)} canDefineFromSelection={!!commands.get("brush.defineFromSelection")?.allowed && !!commands.get("brush.defineFromSelection")?.enabled} defineBlockedReason={commands.get("brush.defineFromSelection")?.disabledReason ?? "请先建立非空像素选区"}/>},
          {id:"settings",label:"画笔设置",content:<BrushSettingsPanel value={brushDynamics} disabled={displayDisabled||transforming} onChange={changeBrushDynamics}/>}
        ]}/>} brushesVisible={!!display.state.brushPresetsVisible && !!commands.get("brush.presets.list")?.allowed} display={{...display,state:{...display.state,sidebarVisible:chromeVisible && display.state.sidebarVisible}}} canChange={()=>!canvasRef.current?.hasGesture()} disabled={displayDisabled || transforming}
          properties={<PanelTabs active={panelLayout.activeTabs.properties} onActive={id=>updatePanels({activeTabs:{...panelLayout.activeTabs,properties:id}})} tabs={[{id:"properties",label:"属性",content:<section className="photo-editor__panel photo-editor__panel--properties">
            <header className="photo-editor__panel-title"><span>{collapseControl("propertiesCollapsed","属性")}属性</span><span>{propertyTool==="mask"?"蒙版":propertyTool==="text"?"文字":propertyTool==="adjustment"?"调整":"图层"}</span></header>
            <div className="photo-editor__object-properties">
              <p className="photo-editor__property-name">{activeLayer?.name??"未选择图层"}</p>
              {propertyTool ? renderOptions("properties") : <>
                <p>{documentView?.width} × {documentView?.height} px · {documentView?.mode}</p>
                {documentView?.transformFrame ? <Button size="sm" disabled={locked || transforming} onClick={()=>chooseTool("transform")}>变换所选图层</Button>:null}
              </>}
                {documentView && propertyFrame && propertyTool!=="mask" ? <LayerGeometryControls key={`${documentView.documentKey}:${documentView.revision}:${documentView.activeLayerId}:${preferences.value.measurementUnit}`} frame={propertyFrame} linked={transformLinked} onLinkedChange={setTransformLinked}
                  unit={preferences.value.measurementUnit} dpi={documentView.resolutionDpi??72} pointPicaSize={preferences.value.pointPicaSize} documentSize={documentView}
                  disabled={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || !commands.get("edit.transform")?.allowed || !commands.get("edit.transform")?.enabled}
                  onApply={matrix=>{
                    const current=controller.snapshot().view.document;
                    if(locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active || visibilityEditing.active || nudge.current || canvasRef.current?.hasGesture() || !commands.get("edit.transform")?.allowed || !commands.get("edit.transform")?.enabled || !current || current.documentKey!==documentView.documentKey || current.revision!==documentView.revision)return false;
                    if(!transformSession.beginMove({x:propertyFrame[0],y:propertyFrame[1],autoSelect:false,duplicate:false,wholeLayer:true}))return false;transformSession.preview(matrix);
                    if(!transformSession.commit()){transformSession.cancel();return false;}setMessage(null);return true;
                  }}/>:null}
            </div>
          </section>},{id:"adjustments",label:"调整",content:<div className="photo-editor__adjustment-presets">{ADJUSTMENT_LAYER_ACTIONS.filter(action=>commands.get(action.id)?.allowed).map(action=><Button key={action.id} size="sm" tone="ghost" disabled={displayDisabled || transforming || !commands.get(action.id)?.enabled} onClick={()=>runLayerAction(action.id)}>{action.label}</Button>)}</div>}]}/>}
          layers={
          <LayerPanel workspaceOwner={controller} collapseControl={collapseControl("layersCollapsed","图层")}
            view={view}
            commands={commands}
            readonly={baseLocked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
            visibilityEditing={visibilityEditing}
            onDelete={bypass=>documentView?.editTarget==="mask" && activeLayer?.hasMask ? run("layer.layerMask.delete",{layer:activeLayer.id}):layerDialogs.delete(bypass)}
            onTrashMask={layer=>layerDialogs.mask(layer)}
            onFitLayer={layer=>{
              if(locked || !run("layer.select",{layer:layer.id,mode:"replace"}))return;
              const doc=controller.snapshot().view.document;canvasRef.current?.view("fitLayers",selectedContentBounds(doc?.layers??[]));
            }}
            onEditContent={layer=>requestLayerEditor(layer,"content")}
            onEditStyle={layer=>requestLayerEditor(layer,"style")}
            onEditMask={layer=>requestLayerEditor(layer,"mask")}
            blendEditing={propertiesEditing.blendEditing}
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
            onToggleVisible={(layer,{alt}) => alt ? run("layer.showOnly",{layer:layer.id}) : run("layer.setProps", { layer: layer.id, visible: !layer.visible })}
            onBlend={(layer, blend) => run("layer.setProps", { layer: layer.id, blend })}
            onRename={(layer, name) => run("layer.setProps", { layer: layer.id, name })}
            onCommand={(id,params)=>params===undefined ? runLayerAction(id) : run(id,params)}
            reorderPreview={{
              // 面板开关（I218/I177）：默认开启，可在偏好或此菜单里关闭。
              enabled: !locked && preferences.value.previewLayerReorder,
              begin: () => { controller.beginReorderPreview(); },
              preview: params => { if(!controller.previewReorder(params).ok) return; refreshPreview(); },
              end: () => { if(controller.endReorderPreview().ok) refreshPreview(); }
            }}
          />
          } history={<HistoryPanel collapseControl={collapseControl("historyCollapsed","操作历史")} view={view} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active} onUndo={() => run("edit.undo")} onRedo={() => run("edit.redo")}
            commands={snapshot.commands} onHistoryCommand={run}
            onGoTo={index=>{if(canvasRef.current?.hasGesture())return;run("history.selectState",{state:index});}} />
        } />
      </div>

      <div className="photo-editor__status" hidden={!chromeVisible}>
        {documentView ? (
          <><ZoomField key={snapshot.view.sessionActiveIndex??"none"} zoom={canvasView.viewport.zoom} width={documentView.width} height={documentView.height} disabled={locked} onChange={zoom=>canvasRef.current?.zoomTo(zoom)}/><Button size="sm" tone="ghost" disabled={locked} onClick={()=>canvasRef.current?.view("fit")}>适合屏幕</Button><DocumentStatus document={documentView} tool={toolLabel??tool}/>{documentView.hasSelection?<span>{display.state.extrasVisible?"有选区":"有选区（边界已隐藏）"}</span>:null}</>
        ) : (
          <span>未打开文档</span>
        )}
        <span>{readonly ? "只读" : ({ idle: "准备中", "loading-module": "加载中", opening: "打开中", editing: "编辑中", freezing: "正在导出", saving: snapshot.state.savePercent===undefined ? "正在保存" : `正在保存 ${snapshot.state.savePercent}%`, saved: "已保存", unavailable: "不可用", failed: "操作失败" })[snapshot.state.phase]}</span>
        {snapshot.state.dirty ? <span>有未保存修改</span> : null}
        {missingFonts.fonts.length?<span className="photo-editor__message" title={missingFonts.fonts.join("、")}>缺少字体：{missingFonts.fonts.slice(0,3).join("、")}{missingFonts.fonts.length>3?` 等 ${missingFonts.fonts.length} 种`:""}，正在使用替代字体。{dialogs && !readonly?<Button size="sm" disabled={displayDisabled || transforming} onClick={()=>missingFonts.open()}>替换…</Button>:null}</span>:null}
        {message || snapshot.state.message || theme.error || display.state.screenModeError ? <span className="photo-editor__message">{message ?? snapshot.state.message ?? theme.error ?? display.state.screenModeError}</span> : null}
        <span className="photo-editor__status-gap" />
      </div>
    </div>
  );
}
