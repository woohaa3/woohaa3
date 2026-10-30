import { prepareFilmSetGroup } from "@woohaa3/contracts";
/**
 * 片场聚焦检查器（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，
 * 任务 4.1/6.4 / design D3；change: 2026-10-10-improve-film-set-editing-and-inspector）。
 * 固定镜头与列表导航、独立属性滚动；视口工具与 AI 草稿目标互不驱动。
 *
 * 右侧 dock 与共享历史 drawer 使用同一 inspector：历史打开时工具栏收起，使「左右圆点」「模型工具」
 * 「历史」三者同时可达且互不遮挡。只读 Navigation panel route 决定偏移；不写规范状态。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { readFilmSetAnimationProjection, isFilmSetGroupNode, filmSetAnimationsOf, filmSetClipHash, resolveNodeDisplayName, COMPOSITE_ASSET_NODE_TYPE, isFilmSetNode } from "@woohaa3/contracts";
import type { ModelEditorSession, ModelCaptureSession as ModelShotCaptureSession, AuthoringGenerationProps } from "@woohaa3/frontend/extension-api";
import type { FilmSetObjectSession } from "./object-session.js";
import type { FilmSetObjectAction } from "./object-action.js";
import { GizmoReadout } from "./gizmo-readout.js";
import { FilmSetObjectToolbar } from "./film-set-object-toolbar.js";
import { Button, IconButton } from "@woohaa3/ui/primitives";
import { CloseIcon, FilmIcon } from "@woohaa3/ui/icons";
import { FilmSetGenerateDock } from "./film-set-generate-dock.js";
import { FilmSetObjectBinding } from "./film-set-object-binding.js";
import { FilmSetAnimationPlayer } from "./film-set-animation-player.js";
import { FilmSetAnimationControls } from "./film-set-animation-controls.js";
import { FilmSetAdaptationConfirm } from "./film-set-adaptation.js";
import { FilmSetVideoExportControl } from "./film-set-video-export-control.js";
import { NativeVideoExportControl } from "./native-video-export-control.js";
import { nativeRecordingAvailable } from "./native-recording-availability.js";
import type { ShotImageReferences } from "./shot-image-reference.js";

/** 读取聚焦节点是否为片场业务（composite-asset + extensionId="film-set"）。 */
function focusedIsFilmSet(ctx: Context, nodeId: string): boolean {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return isFilmSetGroupNode(node, canvas?.nodeData?.[nodeId]) || isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId]);
}

/** 真实片场名称（共享解析规则；不读未提交草稿）。 */
function resolveFilmSetName(ctx: Context, nodeId: string): string {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const data = canvas?.nodeData?.[nodeId] as { title?: unknown; prompt?: unknown } | undefined;
  return resolveNodeDisplayName({ type: COMPOSITE_ASSET_NODE_TYPE, explicitName: data?.title, prompt: data?.prompt }).displayName;
}

export function FilmSetInspector({
  ctx,
  session,
  objectSession,
  objectAction,
  captureSession,
  writable,
  canvasId,
  images
}: {
  ctx: Context;
  session: ModelEditorSession;
  objectSession: FilmSetObjectSession;
  objectAction?: FilmSetObjectAction;
  captureSession: ModelShotCaptureSession;
  writable: boolean;
  canvasId?: string;
  images?: ShotImageReferences;
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
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [listHeight, setListHeight] = useState(180);
  const divider = useRef<{ y: number; height: number } | null>(null);
  const [aiTarget, setAiTarget] = useState<{ clipId: string | null; itemId: string | null } | null>(null);
  const followedSelection = useRef("");
  const [draftLocked, setDraftLocked] = useState(false);
  const onDraftStateChange = useCallback((value: { hasDraft: boolean; busy: boolean }) => setDraftLocked(value.hasDraft || value.busy), []);
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
    setCompositionOpen(false);
    setAiTarget(null);
    setDraftLocked(false);
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
  const followingTarget = { clipId: activeClip?.id ?? null, itemId: inspectingShot ? null : selectedItem?.id ?? null };
  const target = aiTarget ?? followingTarget;
  // Only empty controllers follow inspection. Nonempty drafts and accepted rounds keep their identity.
  useEffect(() => {
    const key = JSON.stringify(followingTarget);
    if (followedSelection.current === key) return;
    followedSelection.current = key;
    if (!draftLocked) setAiTarget(previous => previous?.clipId === followingTarget.clipId && previous?.itemId === followingTarget.itemId ? previous : followingTarget);
  }, [draftLocked, followingTarget.clipId, followingTarget.itemId]);
  const targetClip = collection?.clips.find(clip => clip.id === target.clipId);
  const targetItem = objectSession.objects().find(item => item.itemId === target.itemId);
  const contentHash = targetClip ? filmSetClipHash(targetClip) : undefined;
  const generateBlockedReason = !targetClip
    ? "原目标镜头不可用，请选择一个拍摄镜头。"
    : target.itemId && !targetItem ? "原目标对象已移除，草稿保留。"
    : target.itemId && (targetClip.kind === "static" || !targetClip.bindings.some(binding => binding.itemId === target.itemId))
      ? "此对象尚未启用该动态镜头的动作；请显式启用动作或切换 AI 目标。" : null;
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
    clipId: target.clipId,
    itemId: target.itemId,
    onDraftStateChange,
    selectedCameraId: null,
    onAuthorize: () => ctx.canvasNavigation.openDialog({ dialogId: "provider-credentials", payload: {} })
  };
  const renderGenerate = () => (hasGenerate ? ctx.modelWorkspace.renderGenerate(generateInput) : null);

  if (!nodeId || !isFilmSet) return null;

  const cameraPanel = ctx.modelWorkspace.renderCameraPanel({
    presentation: "composition", cameraCollectionMutable: false,
    captureEnabled: false,
    writable: writable && rendererReady && !readOnly && !playback.preview, readOnly,
    ...(canvasId ? { canvasId } : {}), onActivateCamera: () => activeClip && inspectShot(activeClip.id)
  });

  const header = (
    <header className="model-inspector-header">
      <div>
        <h2 title={resolveFilmSetName(ctx, nodeId)}>{resolveFilmSetName(ctx, nodeId)}</h2>
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
    <div className="model-editor-dock" data-inspector="true" data-history-open={historyOpen ? "true" : undefined} data-film-set="true">
      {header}
      <div className="film-set-current-shot">
        <Button size="sm" tone="ghost" aria-label="检查当前镜头" title="检查当前镜头" disabled={!activeClip || exportBusy} onClick={() => activeClip && inspectShot(activeClip.id)}>
          <span className="film-set-shot-name">{activeClip?.name ?? "尚无镜头"}</span>
          {activeClip ? <span>{activeClip.kind === "static" ? "静态" : `动态 · ${activeClip.timeline.duration} 秒`}</span> : null}
        </Button>
      </div>
      <div className="film-set-inspector-list" style={{ height: listHeight }} onWheel={event => event.stopPropagation()}>
        <FilmSetObjectToolbar section="list" onSelect={inspectObject} session={objectSession} writable={writable && !playback.preview} readOnly={readOnly} nodeId={nodeId} onDelete={() => objectSession.deleteSelected()} action={objectAction}
          objectSelectionActive={!inspectingShot}
          listHeader={<div className="film-set-section-heading">
            <h3>片场内容</h3>
            <FilmSetAnimationControls presentation="create" ctx={ctx} nodeId={nodeId} writable={writable && !readOnly && !playback.preview && !exportBusy} onSelectShot={inspectShot} />
          </div>}
          listItems={collection?.clips.length ? collection.clips.map(clip => <li key={`shot:${clip.id}`} className="film-set-object-list__item">
            <button type="button" className="film-set-object-row" aria-label={`镜头 · ${clip.name}`} aria-selected={clip.id === activeClip?.id && inspectingShot} disabled={exportBusy} title={`${clip.name}${clip.id === collection.defaultClipId ? " · 默认" : ""}`} onClick={() => inspectShot(clip.id)}>
              <span className="film-set-object-row__icon"><FilmIcon /></span>
              <span className="film-set-object-row__name">{clip.name}{clip.id === collection.defaultClipId ? " · 默认" : ""}</span>
              <span className="film-set-object-row__kind">{clip.kind === "static" ? "静态镜头" : `动态镜头 · ${clip.timeline.duration} 秒`}</span>
            </button>
          </li>) : null} />
      </div>
      <div className="film-set-inspector-divider" title="拖动调整列表高度" onPointerDown={event => { divider.current = { y: event.clientY, height: listHeight }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (divider.current) setListHeight(Math.max(80, Math.min(280, divider.current.height + event.clientY - divider.current.y))); }}
        onPointerUp={() => { divider.current = null; }} onPointerCancel={() => { divider.current = null; }} />
      <div className="model-inspector-scroll film-set-inspector-properties" onWheel={event => event.stopPropagation()}>
        {inspectingShot ? <h3 className="film-set-inspecting" title={activeClip?.name}>{activeClip?.name ?? "镜头已移除"}</h3> : null}
        {state.cameraWriteError ? <p className="film-set-object-error">{state.cameraWriteError}</p> : state.cameraWritePending ? <p className="film-set-object-hint">正在确认构图修改…</p> : null}
        {readOnly ? <p className="film-set-object-hint">历史版本只读，不能修改或输出。</p> : !writable ? <p className="film-set-object-hint">当前会话不可写。</p> : !rendererReady ? <p className="film-set-object-hint">渲染器尚未就绪，暂不能操作视口工具。</p> : null}
        {currentCanvas ? prepareFilmSetGroup(currentCanvas, nodeId)?.diagnostics.map(diagnostic => <p key={diagnostic.bindingId} className="film-set-object-feedback">{diagnostic.bindingId}：{diagnostic.message}</p>) : null}
        {!inspectingShot ? <FilmSetObjectToolbar section="properties" session={objectSession} writable={writable && rendererReady && !playback.preview} readOnly={readOnly} nodeId={nodeId} onDelete={() => objectSession.deleteSelected()} action={objectAction}>
          {selectedItem && activeClip ? <>
            <FilmSetObjectBinding key={`${activeClip.id}:${selectedItem.id}`} ctx={ctx} nodeId={nodeId} item={selectedItem} clip={activeClip} collection={collection!} writable={writable && !readOnly && !playback.preview} />
            {activeClip.kind === "dynamic" ? <FilmSetAdaptationConfirm key={`${activeClip.id}:${selectedItem.id}`} ctx={ctx} nodeId={nodeId} itemId={selectedItem.id} clipId={activeClip.id} writable={writable && !readOnly && !playback.preview} /> : null}
          </> : selectedItem ? <p className="film-set-object-hint">尚无镜头；场景摆放可用，新建镜头后再配置动作。</p> : null}
        </FilmSetObjectToolbar> : null}
        <div hidden={!inspectingShot && !!collection?.clips.length}>
          <FilmSetAnimationControls presentation="properties" key={nodeId} ctx={ctx} nodeId={nodeId} writable={writable && !readOnly && !playback.preview && !exportBusy} composition={cameraPanel} images={images} compositionOpen={compositionOpen} onCompositionOpenChange={setCompositionOpen} onSelectShot={inspectShot} />
        </div>
        {inspectingShot && activeClip?.kind === "dynamic" ? <section className="film-set-output"><h3>输出 · {activeClip.name}</h3>
          {nativeRecordingAvailable() ? <NativeVideoExportControl key={`${nodeId}:${activeClip.id}`} ctx={ctx} disabled={!writable || readOnly} target={{ nodeId, clipId: activeClip.id, title: activeClip.name }} onBusyChange={onNativeBusyChange} /> : <FilmSetVideoExportControl ctx={ctx} disabled={!writable || readOnly || !rendererReady} onBusyChange={setExportBusy} />}
        </section> : null}
      </div>
    </div>
    <div className="film-set-viewport-tools" title={inspectingShot ? `自由观察 · 编辑镜头 ${activeClip?.name ?? "不可用"}` : "自由观察 · 场景摆放"} hidden={playback.preview} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      {activeClip && (inspectingShot || !selectedItem) ? <div>{([ ["orbit", "方位旋转", "方位"], ["elevation", "仰角", "仰角"], ["distance", "推拉", "推拉"], ["focus", "移动注视点", "注视点"] ] as const).map(([tool, label, text]) => <Button key={tool} aria-label={label} title={label} size="sm" tone={inspectingShot && state.cameraTool === tool ? "primary" : "ghost"} disabled={!writable || readOnly || !rendererReady || exportBusy || state.cameraWritePending} onClick={() => { inspectShot(activeClip.id); session.setCameraTool(tool); }}>{text}</Button>)}</div> : null}
      {selectedItem && !inspectingShot ? <div>{([ ["move", "移动对象", "移动"], ["yaw", "Y 旋转", "旋转"], ["scale", "等比缩放", "缩放"] ] as const).map(([tool, label, text]) => <Button key={tool} aria-label={label} title={label} size="sm" tone={!inspectingShot && objectState.tool === tool ? "primary" : "ghost"} disabled={!writable || readOnly || !rendererReady || exportBusy || state.cameraWritePending} onClick={() => { inspectObject(selectedItem.id); objectSession.setTool(tool); }}>{text}</Button>)}</div> : null}
    </div>
    {hasGenerate ? <FilmSetGenerateDock key={nodeId} hidden={readOnly || playback.preview} collapsed={aiCollapsed} onCollapsedChange={setAiCollapsed}
      shotName={targetClip?.name ?? "原镜头不可用"} selectedItem={targetItem ? { id: targetItem.itemId, name: targetItem.name } : null}
      targetItemId={target.itemId} onTargetChange={itemId => { setDraftLocked(true); setAiTarget({ clipId: target.clipId, itemId }); }}
      targetKey={JSON.stringify([target.clipId, target.itemId])}
      targets={collection?.clips.flatMap(clip => [{ value: JSON.stringify([clip.id, null]), label: `${clip.name} › 整个镜头` }, ...objectSession.objects().map(item => ({ value: JSON.stringify([clip.id, item.itemId]), label: `${clip.name} › ${item.name}` }))]) ?? []}
      onSelectTarget={value => { if (!value) return; const [clipId, itemId] = JSON.parse(value); setDraftLocked(true); setAiTarget({ clipId, itemId }); }}
    >{renderGenerate()}</FilmSetGenerateDock> : null}
    {activeClip?.kind === "dynamic" ? <FilmSetAnimationPlayer ctx={ctx} captureSession={captureSession} writable={writable && !readOnly && rendererReady && !exportBusy} duration={activeClip.timeline.duration} onPreview={cancelGestures} /> : null}
    {!playback.preview && inspectingShot ? ctx.modelWorkspace.renderCameraPreview(readOnly) : null}
    </>
  );
}
