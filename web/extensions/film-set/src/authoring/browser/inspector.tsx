import { prepareFilmSetGroup } from "@woohaa3/contracts";
/**
 * 片场聚焦检查器（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，
 * 任务 4.1/6.4 / design D3；change: 2026-10-10-improve-film-set-editing-and-inspector）。
 * 固定镜头与列表导航、独立属性滚动；视口工具与 AI 草稿目标互不驱动。
 *
 * 右侧 dock 与共享历史 drawer 使用同一 inspector：历史打开时工具栏收起，使「左右圆点」「模型工具」
 * 「历史」三者同时可达且互不遮挡。只读 Navigation panel route 决定偏移；不写规范状态。
 */
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { readFilmSetAnimationProjection, isFilmSetGroupNode, filmSetAnimationsOf, animationSnapshotHash, isFilmSetNode } from "@woohaa3/contracts";
import type { ModelEditorSession, ModelCaptureSession as ModelShotCaptureSession, AuthoringGenerationProps } from "@woohaa3/frontend/extension-api";
import type { FilmSetObjectSession } from "./object-session.js";
import type { FilmSetObjectAction } from "./object-action.js";
import { FilmSetViewportTools } from "./workspace-viewport-tools.js";
import { FilmSetCameraProperties } from "./workspace-camera-properties.js";
import { GizmoReadout } from "./gizmo-readout.js";
import { FilmSetObjectToolbar } from "./film-set-object-toolbar.js";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { SelectInput } from "@woohaa3/ui/forms";
import { CloseIcon } from "@woohaa3/ui/icons";
import { FilmSetNavigation, FilmSetStillOutput } from "./workspace-navigation.js";
import { FilmSetGenerateDock } from "./film-set-generate-dock.js";
import { FilmSetObjectBinding } from "./film-set-object-binding.js";
import { FilmSetAnimationPlayer } from "./film-set-animation-player.js";
import { FilmSetOutputMenu } from "./workspace-output-menu.js";
import { FilmSetAnimationControls } from "./film-set-animation-controls.js";
import { FilmSetAdaptationConfirm } from "./film-set-adaptation.js";
import { FilmSetVideoExportControl } from "./film-set-video-export-control.js";
import { NativeVideoExportControl } from "./native-video-export-control.js";
import { nativeRecordingAvailable } from "./native-recording-availability.js";
import type { ShotReferenceRecordingController } from "./shot-reference-recording-controller.js";
import type { ShotImageReferences } from "./shot-image-reference.js";

/** 读取聚焦节点是否为片场业务（composite-asset + extensionId="film-set"）。 */
function focusedIsFilmSet(ctx: Context, nodeId: string): boolean {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return isFilmSetGroupNode(node, canvas?.nodeData?.[nodeId]) || isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId]);
}

/** 自由观察方向；与 Bevy 相机模式一一对应，选择只影响编辑态观察。 */
const OBSERVE_VIEWS = [
  { value: "perspective", label: "自由观察" },
  { value: "front", label: "正面" },
  { value: "top", label: "俯视" },
  { value: "right", label: "右侧" }
] as const;

type ObserveView = (typeof OBSERVE_VIEWS)[number]["value"];

export function FilmSetInspector({
  ctx,
  session,
  objectSession,
  objectAction,
  captureSession,
  writable,
  canvasId,
  images,
  recording,
  onLayoutChange
}: {
  ctx: Context;
  session: ModelEditorSession;
  objectSession: FilmSetObjectSession;
  objectAction?: FilmSetObjectAction;
  captureSession: ModelShotCaptureSession;
  writable: boolean;
  canvasId?: string;
  images?: ShotImageReferences;
  recording?: ShotReferenceRecordingController;
  onLayoutChange?: (nodeId: string, layout: { navigationWidth: number; bottomBar: number; gridVisible: boolean }) => void;
}) {
  useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  useSyncExternalStore(ctx.compositeAssets.subscribe, ctx.compositeAssets.getRevision, ctx.compositeAssets.getRevision);
  useSyncExternalStore(listener => ctx.slots.subscribe("authoring.generate", listener), () => ctx.slots.version(), () => ctx.slots.version());
  const snapshot = useSyncExternalStore(
    ctx.canvasNavigation.subscribe,
    ctx.canvasNavigation.getSnapshot,
    ctx.canvasNavigation.getSnapshot
  );
  const playback = useSyncExternalStore(ctx.filmSetPlayback.subscribe, ctx.filmSetPlayback.getSnapshot, ctx.filmSetPlayback.getSnapshot);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const objectState = useSyncExternalStore(objectSession.subscribe, objectSession.getState, objectSession.getState);
  const nodeId = state.nodeId ?? "";
  const [aiCollapsed, setAiCollapsed] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [gridVisible, setGridVisible] = useState(true);
  const [observeView, setObserveView] = useState<ObserveView>("perspective");
  useLayoutEffect(() => {
    if (nodeId) onLayoutChange?.(nodeId, { navigationWidth: navigationCollapsed ? 40 : 224, bottomBar: 56, gridVisible });
  }, [nodeId, navigationCollapsed, gridVisible, onLayoutChange]);
  const onNativeBusyChange = useCallback(() => {}, []);
  const [exportBusy, setExportBusy] = useState(false);
  const cancelGestures = () => {
    ctx.canvasRuntime.controller()?.cancelTransientGesture?.();
    objectAction?.cancelGesture();
    objectSession.cancelEdit();
    session.cancelPose();
    session.cancelFocus();
  };
  const inspectObject = (id: string | null) => {
    cancelGestures();
    session.setToolMode("model");
    objectSession.select(id);
  };
  const inspectShot = (id: string) => {
    cancelGestures();
    ctx.filmSetPlayback.select(nodeId!, id);
    session.selectCamera(`clip:${id}`);
    session.setToolMode("camera");
  };
  useEffect(() => {
    setAiCollapsed(false);
    if (nodeId && focusedIsFilmSet(ctx, nodeId)) session.setToolMode("model");
  }, [nodeId, session, ctx]);
  const isFilmSet = !!nodeId && focusedIsFilmSet(ctx, nodeId);
  const readOnly = ctx.canvasRuntime.modelFocusMode() === "history";
  const historyOpen = snapshot.panel?.type === "node-history" && snapshot.panel.nodeId === nodeId;
  const objectsReady = objectState.nodeId === nodeId;
  const rendererReady = useSyncExternalStore(ctx.canvasRuntime.subscribe ?? (() => () => {}), () => ctx.canvasRuntime.runtime()?.isReady() ?? false, () => false);
  const currentCanvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const currentAnimation = readFilmSetAnimationProjection(currentCanvas, nodeId);
  const collection = currentAnimation ? filmSetAnimationsOf(currentAnimation) : null;
  const activeClip = playback.nodeId === nodeId
    ? collection?.clips.find(clip => clip.id === playback.clipId)
    : collection?.clips.find(clip => clip.id === collection.defaultClipId) ?? collection?.clips[0];
  const selectedItem = objectsReady ? objectSession.selectedItem() : null;
  const inspectingShot = state.toolMode === "camera";
  // The workspace owns one whole-set draft. Explicit legacy clip/item entry
  // points keep their original controllers and limited grants elsewhere.
  const authoritativeAnimation = readFilmSetAnimationProjection(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), nodeId);
  const contentHash = authoritativeAnimation ? animationSnapshotHash(authoritativeAnimation) : undefined;
  const generateBlockedReason = !authoritativeAnimation ? "原片场不可用，草稿保留。" : null;
  const hasGenerate = ctx.slots.list("authoring.generate").length > 0;
  // 生成入口经宿主的 `renderGenerate` 渲染（design D6/D8）：宿主包裹 `authoring.generate`
  // 贡献并注入 MCP 指引与 Agent 会话能力（重开复用同一会话、按状态显示详情入口）。扩展不直接
  // 读 slot 渲染贡献，否则会漏掉会话注入而看不到「查看…与对话」入口。
  const generateWritable = writable && !readOnly && !generateBlockedReason;
  const generateInput: AuthoringGenerationProps = {
    canvasId: canvasId ?? "",
    nodeId,
    mode: "film-set",
    presentation: "dock",
    writable: generateWritable,
    disabledReason: generateWritable ? null : generateBlockedReason ?? "当前会话不可写，无法直接生成。",
    ...(contentHash ? { expectedContentHash: contentHash } : {}),
    clipId: null,
    itemId: null,
    selectedCameraId: null,
    onAuthorize: () => ctx.canvasNavigation.openDialog({ dialogId: "provider-credentials", payload: {} })
  };
  const previewBlockedReason = !activeClip ? "尚无镜头，请先从左侧新建。" : !rendererReady ? "渲染器尚未就绪。" : readOnly ? "历史版本不提供镜头输出预览。" : null;
  const enterPreview = () => {
    if (previewBlockedReason || !activeClip || exportBusy) return;
    cancelGestures();
    ctx.filmSetPlayback.select(nodeId, activeClip.id);
    session.selectCamera(`clip:${activeClip.id}`);
    ctx.filmSetPlayback.preview();
  };
  const renderGenerate = () => (hasGenerate ? ctx.modelWorkspace.renderGenerate(generateInput) : null);

  if (!nodeId || !isFilmSet) return null;

  const cameraPanel = <FilmSetCameraProperties session={session} disabled={!writable || !rendererReady || readOnly || playback.preview || exportBusy} />;

  const header = (
    <header className="model-inspector-header">
      <div>
        <h2>{inspectingShot ? "镜头属性" : "对象属性"}</h2>
        {readOnly ? <p>历史版本 · 只读</p> : null}
      </div>
      <IconButton label="退出片场编辑" onClick={() => ctx.canvasRuntime.exitModelFocus()}><CloseIcon /></IconButton>
    </header>
  );

  return (
    <>
    {!readOnly && !playback.preview && objectState.pointer && objectSession.dragReadout() ? (
      <GizmoReadout point={objectState.pointer}>{objectSession.dragReadout()!}</GizmoReadout>
    ) : null}
    <div className="film-set-view-bar" data-canvas-scrollable="true" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <div className="film-set-view-bar__modes">
        <Button size="sm" tone={!playback.preview ? "primary" : "ghost"} disabled={exportBusy} onClick={() => { cancelGestures(); ctx.filmSetPlayback.edit(); }}>场景编辑</Button>
        <Button size="sm" tone={playback.preview ? "primary" : "ghost"} title={previewBlockedReason ?? "查看当前镜头的正式构图"} disabled={!!previewBlockedReason || exportBusy} onClick={enterPreview}>镜头预览</Button>
      </div>
      {!playback.preview ? <div className="film-set-view-bar__observe">
        <SelectInput className="film-set-observe-select" label="自由观察方式" value={observeView} options={OBSERVE_VIEWS}
          onValueChange={value => { cancelGestures(); setObserveView(value as ObserveView); ctx.canvasRuntime.controller()?.setFocusedModelView(value as ObserveView); }} />
      </div> : <span className="film-set-view-bar__status" title={activeClip?.name}>{activeClip?.name ?? "镜头不可用"} · 只读预览</span>}
    </div>
    <FilmSetNavigation ctx={ctx} nodeId={nodeId} objectSession={objectSession} objectAction={objectAction}
      collection={collection} activeClipId={activeClip?.id} inspectingShot={inspectingShot} images={images} recording={recording}
      writable={writable && !readOnly && !playback.preview && !exportBusy} readOnly={readOnly}
      collapsed={navigationCollapsed} onCollapsedChange={value => { cancelGestures(); setNavigationCollapsed(value); }}
      onSelectObject={inspectObject} onSelectShot={inspectShot} />
    <div className="model-editor-dock" data-canvas-scrollable="true" data-inspector="true" data-history-open={historyOpen ? "true" : undefined} data-film-set="true">
      {header}
      <div className="model-inspector-scroll film-set-inspector-properties" onWheel={event => event.stopPropagation()}>
        {state.cameraWriteError ? <p className="film-set-object-error">{state.cameraWriteError}</p> : state.cameraWritePending ? <p className="film-set-object-hint">正在确认构图修改…</p> : null}
        {readOnly ? <p className="film-set-object-hint">历史版本只读，不能修改或输出。</p> : !writable ? <p className="film-set-object-hint">当前会话不可写。</p> : !rendererReady ? <p className="film-set-object-hint">渲染器尚未就绪，暂不能操作视口工具。</p> : null}
        {currentCanvas ? prepareFilmSetGroup(currentCanvas, nodeId)?.diagnostics.map(diagnostic => <p key={diagnostic.bindingId} className="film-set-object-feedback">{diagnostic.bindingId}：{diagnostic.message}</p>) : null}
        {!inspectingShot ? <FilmSetObjectToolbar section="properties" session={objectSession} writable={writable && rendererReady && !playback.preview} readOnly={readOnly} nodeId={nodeId} onDelete={() => objectSession.deleteSelected()} action={objectAction}>
          {selectedItem && activeClip ? <>
            <FilmSetObjectBinding key={`${activeClip.id}:${selectedItem.id}`} ctx={ctx} nodeId={nodeId} item={selectedItem} clip={activeClip} collection={collection!} writable={writable && !readOnly && !playback.preview} />
            {activeClip.kind === "dynamic" ? <FilmSetAdaptationConfirm key={`${activeClip.id}:${selectedItem.id}:adaptation`} ctx={ctx} nodeId={nodeId} itemId={selectedItem.id} clipId={activeClip.id} writable={writable && !readOnly && !playback.preview} /> : null}
          </> : selectedItem ? <p className="film-set-object-hint">尚无镜头；场景摆放可用，新建镜头后再配置动作。</p> : null}
        </FilmSetObjectToolbar> : null}
        <div hidden={!inspectingShot && !!collection?.clips.length}>
          <FilmSetAnimationControls showOutput={false} presentation="properties" key={nodeId} ctx={ctx} nodeId={nodeId} writable={writable && !readOnly && !playback.preview && !exportBusy} composition={cameraPanel} images={images} onSelectShot={inspectShot} />
        </div>
      </div>
    </div>
    <div className="film-set-viewport-overlay">
    <FilmSetViewportTools session={session} objects={objectSession} camera={inspectingShot} selectedItemId={selectedItem?.id ?? null}
      clipId={activeClip?.id} disabled={!writable || readOnly || !rendererReady || exportBusy || state.cameraWritePending}
      hidden={playback.preview} grid={gridVisible} onGrid={() => setGridVisible(!gridVisible)}
      aiVisible={hasGenerate && !readOnly} aiExpanded={!aiCollapsed} onAiToggle={() => { cancelGestures(); setAiCollapsed(!aiCollapsed); }}
      onObject={inspectObject} onShot={inspectShot} cancel={cancelGestures} />
    {hasGenerate ? <FilmSetGenerateDock key={nodeId} hidden={readOnly || playback.preview} collapsed={aiCollapsed}>{renderGenerate()}</FilmSetGenerateDock> : null}
    </div>
    <div className="film-set-bottom" data-canvas-scrollable="true" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <section className="film-set-bottom__output">
        {activeClip?.kind === "dynamic" ? <FilmSetAnimationPlayer ctx={ctx} captureSession={captureSession} writable={writable && !readOnly && rendererReady && !exportBusy} duration={activeClip.timeline.duration} onPreview={cancelGestures}
          output={<section className="film-set-output">
          {nativeRecordingAvailable() ? <NativeVideoExportControl key={`${nodeId}:${activeClip.id}`} ctx={ctx} disabled={!writable || readOnly} target={{ nodeId, clipId: activeClip.id, title: activeClip.name }} onBusyChange={onNativeBusyChange} /> : <FilmSetVideoExportControl ctx={ctx} disabled={!writable || readOnly || !rendererReady} onBusyChange={setExportBusy} />}
        </section>} /> : <div className="film-set-static-output">
          <span>{activeClip ? "静态镜头" : "从左侧新建镜头"}</span>
          {activeClip ? <FilmSetOutputMenu><FilmSetStillOutput images={images} nodeId={nodeId} clipId={activeClip.id} writable={writable && !readOnly} /></FilmSetOutputMenu> : null}
        </div>}
      </section>
    </div>
    {!playback.preview && inspectingShot ? ctx.modelWorkspace.renderCameraPreview(readOnly) : null}
    </>
  );
}
