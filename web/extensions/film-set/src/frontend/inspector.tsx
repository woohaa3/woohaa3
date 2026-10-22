/**
 * 模型聚焦右侧工具栏 wrap（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，
 * 任务 4.1/6.4 / design D3；change: 2026-10-10-improve-film-set-editing-and-inspector
 * 任务 6.1–6.8 / design D7：拆分为对象/镜头/动画三个任务页，选择联动、统一生成目标）。
 *
 * 右侧 dock 与共享历史 drawer 使用同一 inspector：历史打开时工具栏收起，使「左右圆点」「模型工具」
 * 「历史」三者同时可达且互不遮挡。只读 Navigation panel route 决定偏移；不写规范状态。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveFilmSetAssistantTarget } from "./assistant-target.js";
import type { FilmSetContext as Context } from "./context.js";
import { decodeFilmSetNodeData, filmSetAnimationsOf, resolveNodeDisplayName, COMPOSITE_ASSET_NODE_TYPE, isFilmSetNode } from "@woohaa3/contracts";
import type { ModelEditorSession, ModelCaptureSession as ModelShotCaptureSession, AuthoringGenerationProps } from "@woohaa3/frontend/extension-api";
import type { FilmSetObjectSession } from "../shared.js";
import type { FilmSetObjectAction } from "./film-set-object-feature.js";
import { FilmSetObjectToolbar } from "./film-set-object-toolbar.js";
import { IconButton } from "@woohaa3/frontend/extension-api";
import { CloseIcon } from "@woohaa3/frontend/extension-api";
import { Tabs } from "@woohaa3/frontend/extension-api";
import { FilmSetAnimationPlayer } from "./film-set-animation-player.js";
import { FilmSetAnimationControls } from "./film-set-animation-controls.js";
import { FilmSetAdaptationConfirm } from "./film-set-adaptation.js";

type FilmSetTab = "object" | "camera" | "animation";

/** 读取聚焦节点是否为片场业务（composite-asset + extensionId="film-set"）。 */
function focusedIsFilmSet(ctx: Context, nodeId: string): boolean {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId]);
}

/** 读取聚焦节点的3D业务模式（model3d 或片场）；非 3D 返回 null。 */
function resolveFocusedModelMode(ctx: Context, nodeId: string): "model3d" | "film-set" | null {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  if (node?.type === "model3d") return "model3d";
  if (isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId])) return "film-set";
  return null;
}

/** 读取聚焦节点的模型内容哈希（模型编辑的并发 precondition）。 */
function resolveFocusedModelContentHash(ctx: Context, nodeId: string): string | undefined {
  const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const data = canvas?.nodeData?.[nodeId] as { modelContentVersion?: { contentHash?: unknown } } | undefined;
  const hash = data?.modelContentVersion?.contentHash;
  return typeof hash === "string" && hash !== "" ? hash : undefined;
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
  canvasId
}: {
  ctx: Context;
  session: ModelEditorSession;
  objectSession: FilmSetObjectSession;
  objectAction?: FilmSetObjectAction;
  captureSession: ModelShotCaptureSession;
  writable: boolean;
  canvasId?: string;
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
  const [tab, setTab] = useState<FilmSetTab>("object");
  const selectedCameraId = state.selectedCameraId;
  const selectedItemId = objectState.selectedItemId;
  const nodeId = state.nodeId;

  // 显式选择对象 → 对象页；显式点选镜头 → 镜头页；显式选择片段 → 动画页。
  // 单纯点击页签不写内容、不重置观察、不隐式切换选择（任务 6.5）。
  useEffect(() => {
    if (selectedItemId) setTab("object");
  }, [selectedItemId]);
  const previousCamera = useRef({ nodeId, selectedCameraId });
  useEffect(() => {
    const previous = previousCamera.current;
    // enter() 自动选择场景镜头是初始化，不是用户切换检查任务。
    if (previous.nodeId === nodeId && previous.selectedCameraId !== selectedCameraId && selectedCameraId) setTab("camera");
    previousCamera.current = { nodeId, selectedCameraId };
  }, [nodeId, selectedCameraId]);
  useEffect(() => {
    if (playback.nodeId === nodeId && playback.clipId) setTab("animation");
  }, [playback.nodeId, playback.clipId, nodeId]);

  if (!nodeId || !focusedIsFilmSet(ctx, nodeId)) return null;
  const readOnly = ctx.canvasRuntime.modelFocusMode() === "history";
  const historyOpen = snapshot.panel?.type === "node-history" && snapshot.panel.nodeId === nodeId;
  const focusedModelMode = resolveFocusedModelMode(ctx, nodeId);
  const modelMode = focusedModelMode;
  const isFilmSet = focusedIsFilmSet(ctx, nodeId) && objectState.nodeId === nodeId;
  const rendererReady = ctx.canvasRuntime.runtime()?.isReady() ?? false;
  const currentCanvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
  const currentAnimation = focusedModelMode === "film-set" ? decodeFilmSetNodeData(currentCanvas?.nodeData[nodeId]) : null;
  const collection = currentAnimation?.ok ? filmSetAnimationsOf(currentAnimation.value) : null;
  const activeClip = collection?.clips.find(clip => clip.id === (playback.nodeId === nodeId ? playback.clipId : collection.defaultClipId));
  // 生成目标跟随真实上下文：对象页为选中对象，片场生成一律带目标片段（当前播放片段，否则默认
  // 片段），其余为片场/镜头。规范要求动作写入必须携带 clipId，否则工具授权不放行
  // （design D3 / `openspec/specs/model-authoring`）。
  const resolvedTarget = resolveFilmSetAssistantTarget({ tab, clip: activeClip,
    selectedItemId: isFilmSet ? selectedItemId ?? null : null, selectedCameraId: selectedCameraId ?? null,
    cameras: session.cameras(),
  });
  const generateMode = resolvedTarget.mode;
  const targetItemId = resolvedTarget.itemId;
  const targetClipId = resolvedTarget.clipId;
  const contentHash = resolvedTarget.expectedContentHash ?? (modelMode === "model3d" ? resolveFocusedModelContentHash(ctx, nodeId) : undefined);
  const generateBlockedReason = resolvedTarget.blockedReason;

  const hasGenerate = ctx.slots.list("authoring.generate").length > 0;
  // 生成入口经宿主的 `renderGenerate` 渲染（design D6/D8）：宿主包裹 `authoring.generate`
  // 贡献并注入 MCP 指引与 Agent 会话能力（重开复用同一会话、按状态显示详情入口）。扩展不直接
  // 读 slot 渲染贡献，否则会漏掉会话注入而看不到「查看…与对话」入口。
  const generateWritable = writable && !readOnly && !generateBlockedReason;
  const generateInput: AuthoringGenerationProps = {
    canvasId: canvasId ?? "",
    nodeId,
    mode: generateMode,
    writable: generateWritable,
    disabledReason: generateWritable ? null : generateBlockedReason ?? "当前会话不可写，无法直接生成。",
    ...(contentHash ? { expectedContentHash: contentHash } : {}),
    clipId: targetClipId,
    itemId: targetItemId,
    selectedCameraId: resolvedTarget.selectedCameraId,
    onAuthorize: () => ctx.canvasNavigation.openDialog({ dialogId: "provider-credentials", payload: {} })
  };
  const renderGenerate = () => (hasGenerate ? ctx.modelWorkspace.renderGenerate(generateInput) : null);

  const objectPanel = (
    <>
      <FilmSetObjectToolbar
        session={objectSession}
        writable={writable && rendererReady}
        readOnly={readOnly}
        nodeId={nodeId}
        onDelete={() => objectSession.deleteSelected()}
        action={objectAction}
        onExit={() => void ctx.canvasNavigation.requestExitNodeFocus()}
      />
      {generatorSlot()}
    </>
  );
  const cameraPanel = ctx.modelWorkspace.renderCameraPanel({
    cameraCollectionMutable: false,
    writable: writable && !readOnly, readOnly,
    ...(canvasId ? { canvasId } : {}), onActivateCamera: () => objectSession.select(null), renderGenerate
  });
  const animationPanel = (
    <>
      <FilmSetAnimationControls ctx={ctx} nodeId={nodeId} writable={writable && !readOnly} cameraId={selectedCameraId} />
      <FilmSetAdaptationConfirm
        ctx={ctx}
        nodeId={nodeId}
        itemId={selectedItemId}
        clipId={activeClip?.id ?? null}
        writable={writable && !readOnly}
      />
      {generatorSlot()}
    </>
  );

  function generatorSlot() {
    // 动画预览是瞬时查看模式：与基线一致不渲染生成宿主，保持预览画面无遮挡（也避免切页重复挂载）。
    if (readOnly || playback.preview) return null;
    return <div className="model-inspector-generate" data-generate-target={tab}>{renderGenerate()}</div>;
  }

  const header = (
    <header className="model-inspector-header">
      <div>
        <h2>{isFilmSet ? resolveFilmSetName(ctx, nodeId) : "模型编辑"}</h2>
        <p>{readOnly ? "历史版本 · 只读" : isFilmSet ? "片场编辑" : "取景与拍摄镜头"}</p>
      </div>
      <IconButton label={isFilmSet ? "退出片场编辑" : "退出模型编辑"} onClick={() => ctx.canvasRuntime.exitModelFocus()}><CloseIcon /></IconButton>
    </header>
  );

  return (
    <>
    <div className="model-editor-dock" data-inspector="true" data-history-open={historyOpen ? "true" : undefined} data-film-set={isFilmSet ? "true" : undefined}>
      {header}
      <div className="model-inspector-scroll">
      {isFilmSet ? (
        <Tabs
          className="film-set-tasks"
          label="片场检查任务"
          value={tab}
          onValueChange={(value) => setTab(value as FilmSetTab)}
          items={[
            { value: "object", label: "对象" },
            { value: "camera", label: "镜头" },
            { value: "animation", label: "动画" }
          ]}
          panels={{ object: objectPanel, camera: cameraPanel, animation: animationPanel }}
        />
      ) : cameraPanel}
      </div>
    </div>
    {isFilmSet && playback.preview ? <FilmSetAnimationPlayer ctx={ctx} captureSession={captureSession} writable={writable && !readOnly} /> : null}
    {!playback.preview ? ctx.modelWorkspace.renderCameraPreview(readOnly) : null}
    </>
  );
}
