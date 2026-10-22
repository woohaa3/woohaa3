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
import {LayerStyleEditor} from "./layer-style-editor.js";
import { useLayerPropertiesEditing } from "./use-layer-properties-editing.js";
import { useNewLayerDialog } from "./new-layer-dialog.js";
import {useEditorDisplay,type EditorDisplayControls,type EditorDisplayAction} from "./editor-display.js";
import { useAdjustmentEditing } from "./use-adjustment-editing.js";
import {EditorSidebar} from "./editor-sidebar.js";
import {DEFAULT_PANEL_LAYOUT,type EditorPanelLayout} from "./editor-panel-layout.js";
import {ChevronDownIcon,ChevronRightIcon} from "./ui/icons.js";
import { ToolOptionsPanel, type PhotoEditorProperty } from "./photo-editor-tool-options.js";
import { ADJUSTMENT_LAYER_ACTIONS } from "./photo-editor-layer-actions.js";
export { ToolOptionsPanel } from "./photo-editor-tool-options.js";
import { useTextEditing } from "./use-text-editing.js";
import { TextInputOverlay } from "./text-input-overlay.js";
import { LiveStrokePreview } from "./live-stroke-preview.js";
import {SourceDetailPreview,type DetailFrame} from "./source-detail-preview.js";
import { usePaintTools } from "./paint-tool-state.js";
import { TransformSession } from "./transform-session.js";
import { IDENTITY_MATRIX, frameCenter, type TransformPoint } from "./transform-layer.js";
import { Button } from "./ui/Button.js";
import { EditorCanvasMenu } from "./photo-editor-context-menu.js";
import { EditorWorkspaceController } from "./editor-workspace.js";
import type { EditorDialogPort } from "./ports.js";
import type { EditorDocumentsMenu } from "./photo-editor-menu.js";
import { EditorMenuBar, EditorToolRail, PHOTO_TOOLS, type PhotoEditorTool } from "./photo-editor-chrome.js";
import { TransformOptions } from "./layer-transform-ui.js";
import { PhotoCanvas, type PhotoCanvasHandle, type PhotoCanvasView } from "./photo-editor-canvas.js";
import { HistoryPanel, LayerPanel } from "./photo-editor-panels.js";
import {
  buildLasso,
  buildRectSelection,
  buildStroke,
  clampBrushSize,
  clampFeather,
  pointInSelection,
  type DocumentPoint,
  type EditorToolId,
  type SelectionMode
} from "./photo-editor-tools.js";
import type { EditorPreview,EditorPreviewRegion } from "./editor-wasm.js";
import { editorInputConsumesKeys, FILL_SHORTCUTS, isEditorMac, resolveEditorShortcut, type EditorShortcut } from "./photo-editor-shortcuts.js";
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
};

/**
 * 编辑器界面。组件只消费控制器的快照，不直接持有内核。
 *
 * 预览在每次修订变化后重新取一次；`previewSide` 固定，避免每帧调用内核。
 */
export function PhotoEditorApp({ controller, canvasView, onPreview, onDetailPreview, renderCanvasBackground, readonly = false, onApply, closing = false, dialogs, display: controlledDisplay, documents }: PhotoEditorAppProps) {
  const localDisplay=useEditorDisplay();
  const display=controlledDisplay??localDisplay;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller])
  );
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
  const {brush:paintBrush,setBrush,colors,setColor,setBackground,colorAction,percent,resetDigits} = usePaintTools(tool,snapshot.view.document?.editTarget);
  const [altHeld,setAltHeld] = useState(false);
  const strokeAnchor = useRef<{point:DocumentPoint;key:string} | null>(null);
  const strokeEnd = useRef<{point:DocumentPoint;key:string} | null>(null);

  const view = snapshot.view;
  const documentView = view.document;
  const brush={...paintBrush,target:documentView?.editTarget ?? "pixels"};
  const activeLayerId = documentView?.activeLayerId ?? null;
  useEffect(() => { strokeAnchor.current = null; strokeEnd.current = null; resetDigits(); }, [activeLayerId,tool,brush.target,resetDigits]);
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

  const run = useCallback(
    (id: string, params: unknown = null) => {
      if (propertiesEditing.active) {setMessage("请先确认或取消图层属性编辑");return false;}
      if (adjustmentEditing.active) {setMessage("请先确认或取消调整参数编辑");return false;}
      if (textEditing.active) {setMessage("请先确认或取消文字编辑");return false;}
      if (readonly || busy || closing || newLayer.modalActive) {
        setMessage("只读预览不允许修改");
        return false;
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
  const beginStroke = (point: DocumentPoint, modifiers?: {shift:boolean}) => {
    if (readonly || busy || closing) return;
    const key = `${activeLayerId}:${tool}:${brush.target}`;
    const anchor = strokeAnchor.current;
    const line = modifiers?.shift && anchor?.key === key;
    const params = buildStroke(line ? [anchor.point,point] : [point], line ? {...brush,smoothing:0} : brush, { erase: tool === "eraser", zoom: canvasView.viewport.zoom });
    strokeEnd.current = params && liveStroke.begin(params) ? {point,key} : null;
  };

  const applySave = useCallback(async () => {
    if (!onApply) return;
    if (newLayer.modalActive) return;
    if (propertiesEditing.active) {setMessage("请先确认或取消图层属性编辑");return;}
    if (adjustmentEditing.active) {setMessage("请先确认或取消调整参数编辑");return;}
    if (textEditing.active) {setMessage("请先确认或取消文字编辑");return;}
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
  const locked = newLayer.modalActive || readonly || closing || busy || canvasView.transitioning || snapshot.state.phase === "saving" || snapshot.state.phase === "freezing" || !documentView;
  const transforming = tool === "transform";
  const viewDisabled=locked;
  const displayDisabled=locked||textEditing.active||adjustmentEditing.active||propertiesEditing.active;
  const toggleDisplay=(action:EditorDisplayAction)=>{
    if(displayDisabled||canvasRef.current?.hasGesture()||nudge.current) return;
    display.toggle(action);
  };
  const canSave = !locked && !transforming && !textEditing.active && !adjustmentEditing.active && !propertiesEditing.active && snapshot.state.dirty;
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
  const canvasTool: EditorToolId = !spaceHeld && !locked && !textEditing.active && !adjustmentEditing.active && !propertiesEditing.active && (tool === "move" || tool === "marquee" || tool === "lasso" || tool === "brush" || tool === "eraser" || tool === "text") ? tool : spaceHeld ? "pan" : "none";
  const chooseTool = (next: PhotoEditorTool, selectionOnly = false) => {
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
    setTool(next);
  };
  const previewTransform = (matrix: number[]) => {
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
      chooseTool(action.tool);
      if (action.cycle && action.tool === "marquee") setEllipse((current) => !current);
    } else if (action.kind === "color") {
      colorAction(action.action);
    } else if (action.kind === "paintPercent" && (tool === "brush" || tool === "eraser")) {
      percent(action.digit,action.property);
    } else if (action.kind === "brush" && (tool === "brush" || tool === "eraser")) {
      setBrush((current) => action.property === "size"
        ? { ...current, size: clampBrushSize(current.size + action.direction * (current.size < 10 ? 1 : current.size < 100 ? 5 : 10)) }
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

  const revealProperties=()=>{
    if(!display.state.sidebarVisible) display.toggle("sidebar");
    display.updatePanels?.({propertiesCollapsed:false});
  };
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
            onBrush={(patch) => {
              if (patch.target && activeLayerId !== null) selectTarget({id:activeLayerId},patch.target === "mask");
              setBrush((current) => ({ ...current, ...patch }));
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

  return (
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
        const action = resolveEditorShortcut(event.nativeEvent, isEditorMac());
        if (!action) return;
        if (action.kind === "confirm" && !transforming) return;
        if (action.kind === "nudge" && tool !== "move") return;
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
        if (event.repeat && action.kind !== "brush" && action.kind !== "view" && action.kind !== "nudge") return;
        applyShortcut(action);
      }}>

      <EditorMenuBar commands={commands} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
        display={{state:display.state,toggle:toggleDisplay}} displayDisabled={displayDisabled} viewDisabled={viewDisabled}
        mergeLabel={(documentView?.layers.filter(layer => layer.selected || layer.active).length ?? 0) > 1 ? "合并图层" : activeLayer?.kind === "group" ? "合并组" : "向下合并"}
        canUndo={documentView?.canUndo ?? false} canRedo={documentView?.canRedo ?? false}
        canTransform={!!documentView?.transformFrame} canTransformSelection={!!documentView?.selectionFrame}
        onTransform={selectionOnly => chooseTool("transform", selectionOnly)}
        onView={action => applyShortcut({kind: "view", action})}
        onCommand={runLayerAction} onApply={() => void applySave()} canSave={canSave} saving={busy}
        {...(documents ? { documents } : {})} />
      <div className="photo-editor__contextbar" hidden={!display.state.toolsVisible}>
        <span className="photo-editor__tool-label">{toolLabel}</span>
          {transforming ? <TransformOptions linked={transformLinked} onLinkedChange={setTransformLinked} reference={transformReference} onReferenceChange={setTransformReference} frame={transformFrame ?? null} matrix={transformMatrix} readonly={locked} onValidChange={setTransformValid} onPreview={previewTransform} onConfirm={() => endTransform(true)} onCancel={() => endTransform(false)} /> : null}
          {tool === "move" ? <label><input type="checkbox" checked={autoSelect} disabled={locked} onChange={(event) => setAutoSelect(event.currentTarget.checked)} />自动选择图层</label> : null}
          {tool === "move" ? <Button size="sm" disabled={locked || !documentView?.transformFrame} onClick={() => chooseTool("transform")}>自由变换</Button> : null}
          {(tool === "marquee" || tool === "lasso") ? <Button size="sm" disabled={locked || !documentView?.selectionFrame} onClick={() => chooseTool("transform",true)}>变换选区</Button> : null}
          {renderOptions("tools")}

      </div>
      <div className="photo-editor__body">
        <EditorToolRail ellipse={ellipse} onMarqueeKind={setEllipse} tool={tool} onTool={chooseTool} readonly={locked || transforming || textEditing.active || adjustmentEditing.active || propertiesEditing.active}
          hidden={!display.state.toolsVisible}
          color={colors.foreground} onColor={setColor} background={colors.background} onBackground={setBackground} onColorAction={colorAction} />
        <EditorCanvasMenu commands={commands} disabled={displayDisabled} transforming={transforming}
          canTransform={!!documentView?.transformFrame} canTransformSelection={!!documentView?.selectionFrame}
          canConfirm={transformValid} hasGesture={() => !!canvasRef.current?.hasGesture() || !!nudge.current}
          onTransform={selectionOnly => chooseTool("transform", selectionOnly)} onEndTransform={endTransform} onCommand={run}>
          <PhotoCanvas ref={canvasRef}
            view={canvasView}
            {...(renderCanvasBackground ? { renderBackground: renderCanvasBackground } : {})}
            documentWidth={documentView?.width ?? 0}
            documentHeight={documentView?.height ?? 0}
            interactive={!locked}
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
            renderOverlay={(origin,zoom)=>textEditing.active ? <TextInputOverlay editing={textEditing} origin={origin} zoom={zoom} disabled={locked} onEnd={endText} /> : null}
            brushSize={brush.size}
            sampling={altHeld}
            onSampleColor={(point) => { const result = controller.sampleColor(point.x,point.y); if (result.ok) { if (result.value) setColor(result.value); } else setMessage(result.message); }}
            onMarquee={applyMarquee}
            onLasso={applyLasso}
            onSelectionClick={(point, mode = selectionMode) => {
              if (mode === "replace" && documentView?.hasSelection && !pointInSelection(point, documentView.selectionOutline)) run("select.deselect");
            }}
            onStrokeStart={beginStroke}
            onStrokeMove={(points) => { if (strokeEnd.current && points.length) strokeEnd.current.point = points[points.length-1]; liveStroke.append(points); }}
            onStroke={() => { if (liveStroke.finish() && strokeEnd.current) strokeAnchor.current = strokeEnd.current; strokeEnd.current = null; }}
            onStrokeCancel={() => { liveStroke.cancel(); strokeEnd.current = null; }}
          />
        </EditorCanvasMenu>

        <EditorSidebar display={display} canChange={()=>!canvasRef.current?.hasGesture()} disabled={displayDisabled || transforming}
          properties={<section className="photo-editor__panel photo-editor__panel--properties">
            <header className="photo-editor__panel-title"><span>{collapseControl("propertiesCollapsed","属性")}属性</span><span>{propertyTool==="mask"?"蒙版":propertyTool==="text"?"文字":propertyTool==="adjustment"?"调整":"图层"}</span></header>
            <div className="photo-editor__object-properties">
              <p className="photo-editor__property-name">{activeLayer?.name??"未选择图层"}</p>
              {propertyTool ? renderOptions("properties") : <>
                <p>{documentView?.width} × {documentView?.height} px · {documentView?.mode}</p>
                {documentView?.transformFrame ? <dl className="photo-editor__geometry-properties"><dt>X / Y</dt><dd>{documentView.transformFrame[0]} / {documentView.transformFrame[1]} px</dd><dt>宽 / 高</dt><dd>{documentView.transformFrame[2]-documentView.transformFrame[0]} / {documentView.transformFrame[3]-documentView.transformFrame[1]} px</dd></dl>:null}
                {documentView?.transformFrame ? <Button size="sm" disabled={locked || transforming} onClick={()=>chooseTool("transform")}>变换所选图层</Button>:null}
              </>}
            </div>
          </section>}
          layers={
          <LayerPanel collapseControl={collapseControl("layersCollapsed","图层")}
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
        <span className="photo-editor__status-gap" />
      </div>
    </div>
  );
}
