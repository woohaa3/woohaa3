/**
 * 片场聚焦检查器（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，
 * 任务 4.1/6.4 / design D3；change: 2026-10-10-improve-film-set-editing-and-inspector）。
 * 单栏承载拍摄镜头、构图与对象，AI 修改独立放在底部中央。
 *
 * 右侧 dock 与共享历史 drawer 使用同一 inspector：历史打开时工具栏收起，使「左右圆点」「模型工具」
 * 「历史」三者同时可达且互不遮挡。只读 Navigation panel route 决定偏移；不写规范状态。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { decodeFilmSetNodeData, filmSetAnimationsOf, filmSetClipHash, resolveNodeDisplayName, COMPOSITE_ASSET_NODE_TYPE, isFilmSetNode } from "@woohaa3/contracts";
import type { ModelEditorSession, ModelCaptureSession as ModelShotCaptureSession, AuthoringGenerationProps } from "@woohaa3/frontend/extension-api";
import type { FilmSetObjectSession } from "./object-session.js";
import type { FilmSetObjectAction } from "./object-action.js";
import { GizmoReadout } from "./gizmo-readout.js";
import { FilmSetObjectToolbar } from "./film-set-object-toolbar.js";
import { IconButton, CloseIcon } from "@woohaa3/frontend/extension-api";
import { FilmSetGenerateDock } from "./film-set-generate-dock.js";
import { FilmSetObjectBinding } from "./film-set-object-binding.js";
import { FilmSetAnimationPlayer } from "./film-set-animation-player.js";
import { FilmSetAnimationControls } from "./film-set-animation-controls.js";
import { FilmSetAdaptationConfirm } from "./film-set-adaptation.js";
import type { ShotImageReferences } from "./shot-image-reference.js";

/** 读取聚焦节点是否为片场业务（composite-asset + extensionId="film-set"）。 */
function focusedIsFilmSet(ctx: Context, nodeId: string): boolean {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId]);
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
  const selectedItemId = objectState.selectedItemId;
  const nodeId = state.nodeId;
  const [wholeShotForSelection, setWholeShotForSelection] = useState<string | null>(null);
  const [aiCollapsed, setAiCollapsed] = useState(false);
  const [compositionOpen, setCompositionOpen] = useState(false);
  const selectionKey = `${nodeId}:${selectedItemId}`;
  useEffect(() => setWholeShotForSelection(null), [nodeId, selectedItemId]);
  useEffect(() => {
    setAiCollapsed(false);
    setCompositionOpen(false);
    if (nodeId && focusedIsFilmSet(ctx, nodeId)) session.setToolMode("model");
  }, [nodeId, session, ctx]);
  const changeComposition = (open: boolean) => {
    if (open === compositionOpen) return;
    setCompositionOpen(open);
    if (open) {
      setAiCollapsed(true);
      objectSession.select(null);
    }
    session.setToolMode(open ? "camera" : "model");
  };
  if (!nodeId || !focusedIsFilmSet(ctx, nodeId)) return null;
  const readOnly = ctx.canvasRuntime.modelFocusMode() === "history";
  const historyOpen = snapshot.panel?.type === "node-history" && snapshot.panel.nodeId === nodeId;
  const objectsReady = objectState.nodeId === nodeId;
  const rendererReady = ctx.canvasRuntime.runtime()?.isReady() ?? false;
  const currentCanvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const currentAnimation = decodeFilmSetNodeData(currentCanvas?.nodeData[nodeId]);
  const collection = currentAnimation.ok ? filmSetAnimationsOf(currentAnimation.value) : null;
  const activeClip = collection?.clips.find(clip => clip.id === (playback.nodeId === nodeId ? playback.clipId : collection.defaultClipId))
    ?? collection?.clips.find(clip => clip.id === collection.defaultClipId)
    ?? collection?.clips[0];
  // 生成始终携带当前拍摄镜头，所选对象与“整个镜头”只决定 itemId。
  const selectedItem = objectsReady ? objectSession.selectedItem() : null;
  const targetItemId = selectedItem && wholeShotForSelection !== selectionKey ? selectedItem.id : null;
  const targetClipId = activeClip?.id ?? null;
  const contentHash = activeClip ? filmSetClipHash(activeClip) : undefined;
  // 片场生成门禁：必须解析出目标片段；对象动作还要求该对象绑定在目标片段内，否则不发并说明原因。
  const generateBlockedReason = !targetClipId
    ? "请先新建拍摄镜头，再用 AI 修改。"
    : targetItemId !== null && !!activeClip && !activeClip.bindings.some((binding) => binding.itemId === targetItemId)
      ? "请先将所选对象加入当前拍摄镜头，或将修改目标切为整个镜头。"
      : null;

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
    clipId: targetClipId,
    itemId: targetItemId,
    selectedCameraId: null,
    onAuthorize: () => ctx.canvasNavigation.openDialog({ dialogId: "provider-credentials", payload: {} })
  };
  const renderGenerate = () => (hasGenerate ? ctx.modelWorkspace.renderGenerate(generateInput) : null);

  const cameraPanel = ctx.modelWorkspace.renderCameraPanel({
    presentation: "composition", cameraCollectionMutable: false,
    captureEnabled: activeClip?.kind === "dynamic",
    writable: writable && !readOnly, readOnly,
    ...(canvasId ? { canvasId } : {}), onActivateCamera: () => objectSession.select(null)
  });

  const header = (
    <header className="model-inspector-header">
      <div>
        <h2>{resolveFilmSetName(ctx, nodeId)}</h2>
        <p>{readOnly ? "历史版本 · 只读" : "片场编辑"}</p>
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
      <div className="model-inspector-scroll">
      <FilmSetObjectToolbar
        session={objectSession} writable={writable && rendererReady} readOnly={readOnly}
        nodeId={nodeId} onDelete={() => objectSession.deleteSelected()} action={objectAction}
        onExit={() => void ctx.canvasNavigation.requestExitNodeFocus()}
      >
      {selectedItem && activeClip ? <>
        <FilmSetObjectBinding key={`${activeClip.id}:${selectedItem.id}`} ctx={ctx} nodeId={nodeId} item={selectedItem} clip={activeClip} collection={collection!} writable={writable && !readOnly} />
        <FilmSetAdaptationConfirm ctx={ctx} nodeId={nodeId} itemId={selectedItem.id} clipId={activeClip.id} writable={writable && !readOnly} />
      </> : null}
      </FilmSetObjectToolbar>
      <FilmSetAnimationControls key={nodeId} ctx={ctx} nodeId={nodeId} writable={writable && !readOnly} composition={cameraPanel}
        images={images} compositionOpen={compositionOpen} onCompositionOpenChange={changeComposition} />
      </div>
    </div>
    {hasGenerate ? <FilmSetGenerateDock key={nodeId}
      hidden={readOnly || playback.preview}
      collapsed={aiCollapsed}
      onCollapsedChange={collapsed => { if (!collapsed) changeComposition(false); setAiCollapsed(collapsed); }}
      shotName={activeClip?.name ?? "尚无拍摄镜头"}
      selectedItem={selectedItem ? { id: selectedItem.id, name: selectedItem.name } : null}
      targetItemId={targetItemId}
      onTargetChange={itemId => setWholeShotForSelection(itemId ? null : selectionKey)}
    >{renderGenerate()}</FilmSetGenerateDock> : null}
    {playback.preview && activeClip?.kind === "dynamic" ? <FilmSetAnimationPlayer ctx={ctx} captureSession={captureSession} writable={writable && !readOnly} /> : null}
    {!playback.preview && compositionOpen ? ctx.modelWorkspace.renderCameraPreview(readOnly) : null}
    </>
  );
}
