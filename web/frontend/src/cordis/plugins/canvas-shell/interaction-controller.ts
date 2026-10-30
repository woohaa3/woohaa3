import { sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
/**
 * 浏览器画布交互控制器：共享输入路由、瞬时态、渲染调度和生命周期。
 * 连续手势只更新本地预览，完成后经服务端命令提交；普通模型视角不持久化。
 * 2D 手势、视口和模型编辑各由独立模块处理，不在此重建命中几何。
 * （change: replace-godot-canvas-runtime-with-bevy / split-frontend-god-plugins）
 */
import { bevyNodeHistoryStripDot, type CanvasRenderScene } from "@woohaa3/contracts";
import { createSurfaceMetrics } from "./canvas-surface-metrics.js";
import { createModelGestureFamily } from "./model-gesture-family.js";
import { buildSceneWithResources as buildSceneWithResourcesModule } from "./scene-builder.js";
import { hoverNodeStore } from "../../services/hover-store.js";
import { createHoverTracker } from "./interaction-hover.js";
import { create2dInputFamily } from "./interaction-2d-input.js";
import { createKeyboardShortcuts } from "./interaction-keyboard.js";
import { createDoubleClickHandler } from "./interaction-double-click.js";
import { createSurfaceInteractions } from "./interaction-surface.js";
import { installCanvasDiagnostics } from "./interaction-diagnostics.js";
import { installCanvasListeners, removeCanvasListeners } from "./interaction-listeners.js";
import { createInteractionQueries } from "./interaction-queries.js";
import { createViewportTransition } from "./interaction-viewport-transition.js";
import { createFrameSubmission } from "./interaction-frame-submission.js";
import { gestureLabel } from "./gesture-label.js";
import { createModelFocusFacade } from "./interaction-model-focus-facade.js";
import { createInteractionFrameLoop } from "./interaction-frame-loop.js";
import { beginStartupSpan } from "../../services/telemetry-primitives.js";
import { sharedCanvasNodeIndex, indexNodeSize } from "./canvas-node-index.js";
import { errorDetail } from "../canvas-runtime/runtime-issues.js";
import { advanceTransientState } from "./interaction-frame-prelude.js";
import { collectModelPlacements } from "./interaction-placements.js";
import { INITIAL_WHEEL_SOURCE } from "./input/wheel-gesture.js";
import type { TextureUploader } from "../canvas-runtime/texture-sync.js";
import { createLocalViewportStore } from "../canvas-runtime/local-viewport.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import type { InteractionCore, InteractionState, Viewport } from "./interaction-core.js";
import type { InteractionController, InteractionControllerOptions } from "./interaction-types.js";
export type { InteractionController, InteractionControllerOptions, Gesture } from "./interaction-types.js";
export { MEMORY_CLIPBOARD_KEY } from "./interaction-keyboard.js";
export function installInteractionController(options: InteractionControllerOptions): InteractionController {  const target = options.target ?? (globalThis as unknown as Window & typeof globalThis);
  const canvas = options.canvas;
  const writable = options.isWritable ?? (() => options.getSession()?.isWritable() ?? false);
  /** modal 打开时禁止画布输入（design D6）。 */
  const modalActive = options.isModalActive ?? (() => false);
  /**
   * 聚焦相机输入门禁：只由 modal Dialog 阻断（change: fix-model-focus-navigation-and-camera-parity，D6）。
   * 非模态 editor/history panel 不阻断 focus 缩放/观察/双击进入。
   */
  const focusInputBlocked = options.isFocusInputBlocked ?? modalActive;
  const textureSync: TextureUploader | null = options.textureSync ?? null;
  let compositeAssetMediaReady: ReadonlySet<string> | null = null;
  let disposed = false;
  /**
   * 场景失效信号（change: optimize-model-scene-snapshot-hot-path，design D3；
   * change: 2026-10-10-optimize-canvas-interaction-hot-path，design D2）。
   *
   * 输入与订阅只标记 dirty，唯一帧入口合并并选择完整或增量提交。
   */
  let sceneInvalidated = true;
  /** 本帧累计的失效来源（诊断/去重；结算后清空）。 */
  const dirtyReasons = new Set<string>();
  const markInvalidated = (reason: string) => {
    dirtyReasons.add(reason);
    sceneInvalidated = true;
  };
  /** 最近一次快照提交失败的原因（诊断用；渲染失败不影响后续帧与输入）。 */
  let renderError: string | null = null;
  let seq = 0;
  const reportFrameIssue = (operation: string, error: unknown) => {
    const detail = errorDetail(error);
    if (operation === "scene" || operation === "frame") renderError = detail;
    try { options.getRuntime()?.reportRuntimeIssue?.({ key: `frame:${operation}`, scope: "frame", operation,
      message: operation === "scene" ? "画布更新失败，正在尝试恢复。" : "部分画布预览更新失败，可以重试。",
      detail, recoverable: true }); } catch { /* Diagnostic isolation. */ }
  };
  const frameLoop = createInteractionFrameLoop({ target,
    advance: () => model.advanceModelFly(), render: () => runFrame(false),
    report: reportFrameIssue,
    recovered: operation => options.getRuntime()?.clearRuntimeIssue?.(`frame:${operation}`)
  });
  const localViewport = createLocalViewportStore(options.canvasId ?? "default");
  const viewportListeners = new Set<() => void>();
  const state: InteractionState = {
    gesture: { kind: "none" },
    selected: [],
    localPositions: new Map(),
    localSizes: new Map(),
    draft: null,
    viewportPreview: null,
    spacePressed: false,
    lastPointerWorld: null,
    hoveredNodeId: null,
    hoveredPort: null,
    hoveredEdgeId: null,
    hoveredVideoNode: null,
    dropTargetGroupIds: [],
    wheelSource: INITIAL_WHEEL_SOURCE,
    viewportCommitTimer: null,
    lastNotifiedViewport: null
  };

  const unbindPlaybackGate = hoverNodeStore.bindPlaybackGate(() => disposed || modalActive()
    || state.gesture.kind !== "none" || state.viewportPreview !== null || hoverNodeStore.hasPlaybackOwner()
    || options.getRuntime()?.acceptsPlayback?.() === false);
  // 可用表面尺寸 + client/world 换算（抽出以保持文件在文件体积守卫内）。
  const activeViewport = (): Viewport => state.viewportPreview ?? localViewport.get();
  const { surfaceSize, readBounds, clientToWorld, pointerWorld, worldToClient } = createSurfaceMetrics({
    canvas,
    target,
    activeViewport
  });

  const modelPlacements = () => collectModelPlacements();
  /**
   * 拖动粘连瞬时投影 provider（change: add-drag-touch-connections）。
   * 由 2D input family 实现（它拥有 drag gesture），controller 只转发；闭包避免长依赖。
   */
  const attachProjectionRef: { current: (() => import("@woohaa3/contracts").BevyDragAttach | null) | null } = {
    current: null
  };
  /**
   * 聚合把手瞬时投影 provider（change: add-multi-select-aggregate-connect）。
   * 由 2D input family 实现，controller 只转发。
   */
  const aggregateProjectionRef: {
    current: (() => import("@woohaa3/contracts").BevyAggregateConnect | null) | null;
  } = { current: null };
  // 合成快照并附带本帧引用到的 prepared resources（change: optimize-model-scene-snapshot-hot-path）。
  /** 一帧的瞬时态快照（供场景构建读取）。 */
  const frameState = () => ({
    selected: state.selected,
    badgeResize: state.gesture.kind === "group-badge-resize" ? state.gesture : null,
    draft: state.draft,
    marquee: marqueeRect(),
    localPositions: state.localPositions,
    localSizes: state.localSizes,
    viewportPreview: state.viewportPreview,
    fallbackViewport: localViewport.get(),
    hoveredNodeId: state.hoveredNodeId,
    hoveredPort: state.hoveredPort,
    hoveredEdgeId: state.hoveredEdgeId,
    hoveredHistory: state.hoveredHistory,
    pressedHistory: state.gesture.kind === "history-press" ? state.gesture : null,
    dropTargetGroupIds: state.dropTargetGroupIds,
    dragAttach: attachProjectionRef.current?.() ?? null,
    aggregateConnect: aggregateProjectionRef.current?.() ?? null,
    compositeAssetReadyPlanes: compositeAssetMediaReady
  });
  /**
   * 首个完整场景构建是否已计时。
   *
   * `perf.startup` 的 `scene-build` 只记第一次：之后的构建是同一次会话里的增量重建，混进来会
   * 让"启动有多慢"随用户操作次数变化（task 3.4）。
   */
  let firstSceneBuildMeasured = false;
  const buildSceneWithResources = () => {
    const build = () => buildSceneWithResourcesModule(options, surfaceSize, () => modelPlacements(), frameState());
    if (firstSceneBuildMeasured) return build();
    // 第一次完整构建包含模型资源装配与全表投影，是启动路径上唯一可分离的"建场"成本。
    const finish = beginStartupSpan("scene-build");
    try {
      return build();
    } catch (error) {
      finish("failure");
      throw error;
    } finally {
      firstSceneBuildMeasured = true;
      finish();
    }
  };

  const frameSubmission = createFrameSubmission({
    options, state, viewport: activeViewport, surface: surfaceSize,
    transient: () => ({ dragAttach: attachProjectionRef.current?.() ?? null,
      aggregateConnect: aggregateProjectionRef.current?.() ?? null }),
    build: buildSceneWithResources
  });
  const buildScene = (): CanvasRenderScene | null => buildSceneWithResources()?.scene ?? null;
  // 2D interaction/gizmo 查询：命中由 Rust snapshot 计算（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
  let frameExecuting = false;
  const queries = createInteractionQueries({ getRuntime: () => options.getRuntime(), publishNow: () => runFrame(true),
    beforeQuery: () => {
      if (!frameExecuting && options.getRuntime()?.queueViewport
        && (dirtyReasons.has("viewport") || dirtyReasons.has("viewport-transition"))) {
        runFrame(false);
      }
    }
  });

  /**
   * 当前框选选区矩形（世界坐标，change: fix-group-and-marquee-preview）。
   * 只在 marquee 手势进行中返回；拖拽中每帧随 `state.gesture.current` 更新。
   */
  const marqueeRect = (): { x: number; y: number; width: number; height: number } | null => {
    if (state.gesture.kind !== "marquee") return null;
    const { start, current } = state.gesture;
    return { x: start.x, y: start.y, width: current.x - start.x, height: current.y - start.y };
  };

  /** 清除全部悬停态；仅在确实有悬停时触发重绘。 */
  const clearHover = () => hover.clearHover();
  const suspendHoverPlayback = () => hover.suspendVideo();

  const notifyViewport = () => {
    const viewport = activeViewport();
    const changed =
      !state.lastNotifiedViewport
      || state.lastNotifiedViewport.x !== viewport.x
      || state.lastNotifiedViewport.y !== viewport.y
      || state.lastNotifiedViewport.zoom !== viewport.zoom;
    if (!changed) return;
    hoverNodeStore.invalidatePlayback();
    state.lastNotifiedViewport = { ...viewport };
    // 本地缩放/平移变化（含不推进画布 revision 的捏合与手势）通知宿主缩放读数跟进（fix-viewport-zoom-range）。
    for (const listener of viewportListeners) listener();
    options.onViewportChange?.(viewport);
    // 视口变化也改变节点屏幕位置：通知节点操作横条重排（design D7）。
    notifyProjection();
  };

  /**
   * 节点屏幕投影通知（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
   *
   * 每帧在 `performFrame` 中统一结算（不 per-pointer 触发 listener，避免热路径开销）：视口、
   * 拖动/改尺寸预览或节点尺寸实际变化时才通知订阅者。横条消费方按需重算唯一 runtime 投影。
   */
  let lastProjectionSignature = "";
  const projectionSignature = () => {
    const viewport = activeViewport();
    const parts: string[] = [`${viewport.x},${viewport.y},${viewport.zoom}`];
    for (const [id, position] of state.localPositions) parts.push(`p:${id}:${position.x},${position.y}`);
    for (const [id, size] of state.localSizes) parts.push(`s:${id}:${size.width},${size.height}`);
    // working 节点位置/尺寸签名（拖动提交前的规范位置变化）；selection/pan 不改变它。
    const index = sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
    // `byId` 保存的是带渲染数据的节点引用（与来源同一批对象），可直接用于几何 helper。
    if (index) for (const node of index.byId.values()) {
      const size = indexNodeSize(node);
      parts.push(`n:${node.id}:${node.position.x},${node.position.y},${size.width},${size.height}`);
    }
    return parts.join("|");
  };
  const notifyProjection = () => {
    const signature = projectionSignature();
    if (signature === lastProjectionSignature) return;
    lastProjectionSignature = signature;
    for (const listener of viewportListeners) listener();
  };

  const submit = (commands: ReturnType<typeof import("../../../extension-api/command-planner.js").planMoveNodes>) => {
    const session = options.getSession();
    if (!session || !writable() || commands.length === 0) return;
    // 结构动作经页面编辑历史（可撤销）；回退到直接提交（未注入 edit 服务时，如测试）。
    const label = gestureLabel(state.gesture.kind);
    if (options.onEditCommands) {
      return Promise.resolve(options.onEditCommands(commands, label)).then(result =>
        !result ? "unavailable" as const : !result.ok ? "rejected" as const
          : result.entry?.state === "committed" ? "committed" as const : "unavailable" as const,
        () => "rejected" as const);

    }
    const result = session.submitCommands(
      commands,
      `web-${state.gesture.kind === "none" ? "canvas" : state.gesture.kind}-${Date.now().toString(36)}-${seq++}`
    );
    if (!result.ok) return Promise.resolve("rejected" as const);
    return result.handle.settled.then(result => result.state === "committed" ? "committed" as const
      : result.state === "rejected" ? "rejected" as const : "unavailable" as const);
  };

  const setSelection = (nodeIds: string[]) => {
    state.selected = [...new Set(nodeIds)];
    nodeSelectionStore.setFromRuntime(
      { nodeIds: state.selected, primaryNodeId: state.selected[state.selected.length - 1] ?? null, editingFocus: false },
      // pending 节点也可被选中（纯画布编辑），因此用 working projection 的节点集合。
      new Set(workingCanvasOf(woohaa3CanvasStore.getState())?.document.nodes.map((node) => node.id) ?? [])
    );
    schedule();
  };

  /** 视口是本地状态：直接写入 localStorage，不发服务端命令。 */
  const commitViewport = (viewport: Viewport) => {
    localViewport.set(viewport);
  };

  /**
   * 模型聚焦/编辑 gesture family（change: 2026-09-28-split-frontend-god-plugins，task 3）。
   * 只注入共享坐标系、调度与提交能力；family 不自建 pointer 监听或 viewport 副本。
   */
  const model = createModelGestureFamily({
    canvas,
    options,
    writable,
    localViewportSet: (viewport) => localViewport.set(viewport),
    surfaceSize,
    activeViewport: () => activeViewport(),
    schedule: (reason?: string) => schedule(reason ?? "input"),
    nextSeq: () => seq++,
    queryGizmo: queries.queryGizmo,
    queryPoint: queries.queryPoint,
    focusContextContains: frameSubmission.focusContextContains
  });
  const clearHeldKeys = () => {
    // Space 临时平移也是 held input：与聚焦飞行键/粘连键一起复位，避免失焦、modal 或
    // 聚焦切换后残留闩锁把后续左键点击全部变成平移
    // （change: fix-space-pan-latch-after-focus-exit）。
    state.spacePressed = false;
    model.clearHeldKeys();
  };

  /**
   * 单帧推进（design D2 的唯一帧结算点）：先推进与场景无关的逐帧工作（视口通知、held input
   * 清理、聚焦有效性、纹理与视频/媒体会话、失效 selection/draft 清理），再按失效账本决定
   * 是否构建/提交场景。
   *
   * 规范状态、瞬时呈现、surface 与已引用资源均无净变化时，本函数不构建 `CanvasRenderScene`、
   * 不遍历模型顶点、不序列化 Scene IR、也不跨 WASM 边界。`force` 用于**唯一允许的同步引导**
   * 与错误恢复：宿主显式刷新、首次 generation=0 查询引导、单帧失败后下一帧重试。
   */
  let lastHoverOwner = "";
  const performFrame = (force: boolean) => {
    // dispose 后不得继续构建或提交（含无 rAF 环境下的同步 flush/invalidate）。
    if (disposed) return;
    frameLoop.step("viewport-notify", notifyViewport, undefined);
    // 节点屏幕投影通知（节点顶部操作横条锚定）：视口/拖动/改尺寸帧级变化在此随唯一帧结算。
    frameLoop.step("projection-notify", notifyProjection, undefined);
    // 瞬时 DOM overlay 需要和画布刷新保持同一帧节奏；它们自行读取当前 accepted/working 几何。
    frameLoop.step("frame-notify", () => options.onFrame?.(), undefined);
    // 推进与场景无关的逐帧工作（瞬时态/会话/失效清理）；返回就绪片场媒体平面集合。
    compositeAssetMediaReady = advanceTransientState({
      focusInputBlocked,
      clearHeldKeys,
      syncModelFocusValid: () => frameLoop.step("focus-valid", () => model.syncModelFocusValid(), undefined),
      projectResidency: () => frameLoop.step("residency-project", () => {
        // 先下发本帧视口/surface（缩略图档位与可见范围依赖它们），再投影准入集合。
        options.onViewportForResidency?.(activeViewport());
        options.onSurface?.(surfaceSize());
        options.projectResidency?.();
      }, undefined),
      syncTexture: () => frameLoop.step("image-sync", () => textureSync?.sync(), undefined),
      syncVideoSessions: () => frameLoop.step("video-sync", () => options.videoSessions?.sync(), undefined),
      syncCompositeAssetMedia: () => frameLoop.step("composite-media-sync", () => options.compositeAssetMediaSessions?.sync() ?? null, compositeAssetMediaReady),
      state,
      isFocused: () => !!(options.getModelFocus?.() || options.getImageFocus?.() || options.getVideoFocus?.()),
      setSelection,
      clearHover,
      cancelTransientGesture,
      cancelDragGesture: () => input.cancelDragGesture(),
      pruneAttach: () => input.pruneAttach(),
      cancelAggregateConnect: () => input.cancelAggregateConnect(),
      markInvalidated,
      writable
    });
    const runtime = options.getRuntime();
    const playbackBlocked = modalActive() || state.viewportPreview !== null || hoverNodeStore.hasPlaybackOwner() || runtime?.acceptsPlayback?.() === false;
    const ownerKey = `${state.gesture.kind}:${playbackBlocked}:${runtime?.generation?.() ?? 0}`;
    const ownerChanged = ownerKey !== lastHoverOwner;
    if (ownerChanged) {
      lastHoverOwner = ownerKey;
      hoverNodeStore.invalidatePlayback();
    }
    const refreshGround = () => hover.refreshGround(point => queries.queryPoint({
      x: (point.x - activeViewport().x) / activeViewport().zoom,
      y: (point.y - activeViewport().y) / activeViewport().zoom }, activeViewport().zoom));
    // 无失效且非强制：跳过全部场景构建/序列化/跨边界（静止画布热路径）。
    if (!force && !sceneInvalidated) { if (ownerChanged || hover.needsRefresh()) refreshGround(); return; }
    sceneInvalidated = false;
    const reasons = new Set(dirtyReasons);
    dirtyReasons.clear();
    const outcome = frameSubmission.run(reasons, force);
    renderError = outcome.error;
    if (outcome.retry) sceneInvalidated = true;
    else refreshGround();
  };

  // 资源同步和场景构建也可能抛错；保护整个帧，避免纹理错误终止永久 rAF。
  const runFrame = (force: boolean) => {
    // A cold query or synchronous subscriber can request a flush while this scene
    // is still being built. Finish its acceptance before retrying on the next frame.
    if (frameExecuting) { markInvalidated("input"); return; }
    // 帧耗时在所有构建里都计时（change: 2026-10-25-enhance-telemetry-performance-collection，
    // design D4：`perf.frame` 是产品事实，不是开发期采集）。
    const started = target.performance.now();
    const previous = frameExecuting; frameExecuting = true;
    try {
      performFrame(force);
    } catch (error) {
      reportFrameIssue("scene", error);
      sceneInvalidated = true;
    } finally {
      frameExecuting = previous;
      sceneDiagnostics.frameExecutions++;
      sceneDiagnostics.frameExecutionMs += Math.max(0, target.performance.now() - started);
    }
  };

  /** 只登记失效；无 rAF 的测试环境同步推进。 */
  const schedule = (reason: unknown = "input") => {
    if (reason === "viewport" || reason === "viewport-transition") hoverNodeStore.invalidatePlayback();
    markInvalidated(typeof reason === "string" ? reason : "input");
    // 无 rAF（测试/无动画环境）：退化为同步推进，保持既有可观测行为。
    if (typeof target.requestAnimationFrame !== "function") runFrame(true);
  };
  /** 显式刷新强制构建；普通查询等待下一帧合并。 */
  const flush = () => runFrame(true);
  // 视口平移过渡（change: 2026-10-09，任务 4.1）：只改本地视口，用户手动干预会中断。
  const viewportTransition = createViewportTransition({
    target,
    activeViewport,
    getPreview: () => state.viewportPreview,
    setPreview: (viewport) => { state.viewportPreview = viewport; },
    commit: commitViewport,
    invalidate: () => markInvalidated("viewport-transition"),
    renderFrame: () => runFrame(false),
    reducedMotion: () => (target as unknown as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
    ...(options.viewportTransitionMs !== undefined ? { defaultDurationMs: options.viewportTransitionMs } : {})
  });

  /** 指针 hover 与视频播放跟踪（实现见 `interaction-hover.ts`）。 */
  const hover = createHoverTracker({
    projectCanvas: canvas => options.compositeAssets?.projectCanvas(canvas) ?? canvas,
    nodeCapabilities: options.nodeCapabilities,
    content: options.compositeAssets?.contentContributions,
    state,
    historyAt: nodeId => {
      const node = frameSubmission.renderedNode(nodeId);
      if (!node || !state.lastPointerWorld) return;
      const dots = node.historyStrip?.dots ?? [];
      let closest: string | undefined, distance = Infinity;
      dots.forEach((dot, index) => {
        const point = bevyNodeHistoryStripDot(node, index, dots.length);
        const next = Math.abs(point.x - state.lastPointerWorld!.x);
        if (next < distance) { closest = dot.presentationId; distance = next; }
      });
      return closest;
    },
    videoSessions: options.videoSessions,
    // 连续导航期间保持播放资格关闭；结束后按最终视口查询一次固定指针。
    modalActive: () => modalActive() || state.viewportPreview !== null || hoverNodeStore.hasPlaybackOwner() || options.getRuntime()?.acceptsPlayback?.() === false,
    // 普通视频卡片的 hover 预览不受 capture playback owner 影响：截图/录制只冻结被捕捉内容
    // （拍摄预览候选与场景动画由上面的 `modalActive` 复合门禁撤销），无关卡片的解码预览
    // 不参与被捕捉画面。否则后台镜头参考录制重试期间视频 hover 一直不播放。
    videoPlaybackBlocked: () => modalActive() || state.viewportPreview !== null || options.getRuntime()?.acceptsPlayback?.() === false,
    schedule,
    // 卡片空白但落在模型网格（卡片下方）时命中模型节点，驱动模型 hover 播放（play-model-animations-on-hover）。
    modelPick: (point, surface) => queries.queryModelPick(point, surface)
  });

  // 视口模块由 2D input family 拥有；core 的 scheduleViewportCommit 通过可空引用转发。
  const viewportRef: { current: { scheduleViewportCommit: () => void } | null } = { current: null };
  /**
   * 拖动粘连手势取消引用（change: add-drag-touch-connections）：在 2D input family 创建后绑定，
   * core（surface / E2E）通过它转发取消，避免长依赖环。
   */
  const dragCancelRef: { current: (() => void) | null } = { current: null };

  const core: InteractionCore = {
    options,
    target,
    canvas,
    writable,
    modalActive,
    focusInputBlocked,
    state,
    localViewport,
    viewportListeners,
    model,
    nextSeq: () => seq++,
    surfaceSize,
    readBounds,
    activeViewport,
    clientToWorld,
    pointerWorld,
    worldToClient,
    buildScene,
    buildDragScene: frameSubmission.dragScene,
    renderedNode: frameSubmission.renderedNode,
    ...queries,
    setSelection,
    submit,
    schedule,
    flush,
    clearHover,
    forgetHoverPointer: () => hover.forgetPointer(),
    updateHover: (hit) => hover.updateHover(hit),
    updateHoveredVideo: (hit) => hover.updateHoveredVideo(hit),
    settlePointerHover: (cardHit, point, surface) => hover.settlePointerHover(cardHit, point, surface),
    suspendHoverPlayback,
    clearHeldKeys,
    commitViewport,
    scheduleViewportCommit: () => viewportRef.current?.scheduleViewportCommit(),
    notifyViewport,
    onAttachKey: (code, down) => input.onAttachKey(code, down),
    attachActive: () => input.attachActive(),
    cancelDragGesture: () => (dragCancelRef.current ?? input.cancelDragGesture)(),
    attachProjection: () => attachProjectionRef.current?.() ?? null,
    pruneAttach: () => input.pruneAttach(),
    aggregateProjection: () => aggregateProjectionRef.current?.() ?? null,
    aggregateActive: () => state.gesture.kind === "aggregate-connect",
    cancelAggregateConnect: () => input.cancelAggregateConnect(),
    filmSetObjectAction: () => model.filmSetObjectAction()
  };

  const input = create2dInputFamily(core);
  const keyboard = createKeyboardShortcuts(core);
  const dblclick = createDoubleClickHandler(core);
  viewportRef.current = input.viewport;
  attachProjectionRef.current = input.attachProjection;
  dragCancelRef.current = input.cancelDragGesture;
  aggregateProjectionRef.current = input.aggregateProjection;

  // 瞬时手势取消 / 聚焦前视口结算 / document 级滚轮捏合 / resize（见 `interaction-surface.ts`）。
  const surface = createSurfaceInteractions({
    state,
    target,
    canvas,
    model,
    imageFocused: () => options.isImageFocused?.() ?? !!options.getImageFocus?.(),
    onWheel: input.onWheel,
    focusInputBlocked,
    activeViewport,
    localViewportSet: (viewport) => localViewport.set(viewport),
    schedule: () => schedule(),
    suspendHoverPlayback,
    clearHover,
    clearHeldKeys,
    attach: {
      onAttachKey: (code, down) => input.onAttachKey(code, down),
      attachActive: () => input.attachActive(),
      cancelDragGesture: () => input.cancelDragGesture(),
      cancelAggregateConnect: () => input.cancelAggregateConnect()
    }
  });
  const { cancelTransientGesture, settleViewportBeforeFocus, handlers: { onDocumentWheel, onDocumentPointerDown, onDocumentFocusChange, onDocumentBlur, onDocumentVisibility, onGestureStart, onGestureChange, onGestureEnd, onWindowResize } } = surface;

  installCanvasListeners(canvas, target, input, keyboard, dblclick, {
    onDocumentWheel,
    onDocumentPointerDown,
    onDocumentFocusChange,
    onDocumentBlur,
    onDocumentVisibility,
    onGestureStart,
    onGestureChange,
    onGestureEnd,
    onWindowResize
  });

  frameLoop.start();

  // 供 E2E/排障观察（生产无副作用）；change: 2026-09-28-split-frontend-god-plugins 后续拆分。
  const unsubscribeCapabilities = options.nodeCapabilities?.subscribe(() => {
    if (state.gesture.kind === "resize" || state.gesture.kind === "model-preview") cancelTransientGesture();
    schedule("node-capabilities");
  });
  const unsubscribePreview = modelPreviewStore.subscribe(() => schedule("model-preview"));
  const disposeDiagnostics = installCanvasDiagnostics({ core, target, state, activeViewport, setSelection, model,
    renderError: () => renderError,
    queryCounters: () => ({ queries: sceneDiagnostics.interactionQueries, unavailableQueries: sceneDiagnostics.interactionUnavailable }) });

  // 模型聚焦/编辑对外门面（文件体积守卫）：控制器主体只保留共享输入/调度/生命周期。
  const modelFocus = createModelFocusFacade(model, settleViewportBeforeFocus, () => {
    // 聚焦切换复位 Space 临时平移闩锁：它属于 2D overview 手势，不得跨越聚焦进出门禁；
    // 聚焦内部的 held 键由 `model.applyFocusTarget` 自行清理
    // （change: fix-space-pan-latch-after-focus-exit）。
    state.spacePressed = false;
  });

  return {
    start: () => schedule("start"),
    flush,
    /** 唯一失效入口（design D2）；缺省 reason 归一为 `invalidate`。 */
    invalidate: (reason) => schedule(reason ?? "invalidate"),
    surface: surfaceSize,
    zoomBy: (factor: number) => input.zoomBy(factor),
    zoomTo: (zoom: number) => input.zoomTo(zoom),
    zoomToFit: () => input.zoomToFit(),
    viewport: () => activeViewport(),
    restoreViewport: (viewport) => {
      viewportTransition.cancel();
      state.viewportPreview = null;
      commitViewport(viewport);
      schedule();
    },
    panViewportTo: (viewport, settings) => viewportTransition.pan(viewport, settings),
    lastPointerWorld: () => (state.lastPointerWorld ? { ...state.lastPointerWorld } : null),
    /** 最近一次快照提交失败原因（诊断用；change: fix-viewport-zoom-range）。 */
    renderError: () => renderError,
    subscribeViewport: (listener: () => void) => {
      viewportListeners.add(listener);
      return () => viewportListeners.delete(listener);
    },
    clientToWorld: (client) => clientToWorld(client),
    worldToClient: (world) => worldToClient(world),
    historyDotScreenPoint: (nodeId, operationId) => {
      if (options.getModelFocus?.() || options.getImageFocus?.() || options.getVideoFocus?.() || options.getModelEditor?.()) return null;
      if (attachProjectionRef.current?.()?.nodeId === nodeId) return null;
      const node = frameSubmission.renderedNode(nodeId);
      const dots = node?.historyStrip?.dots;
      const index = dots?.findIndex(dot => dot.operationId === operationId) ?? -1;
      if (!node || !dots || index < 0) return null;
      const point = worldToClient(bevyNodeHistoryStripDot(node, index, dots.length));
      const bounds = readBounds();
      if (point.x < bounds.left || point.y < bounds.top || point.x > bounds.left + bounds.width || point.y > bounds.top + bounds.height) return null;
      return { ...point, generation: options.getRuntime()?.generation?.() ?? 0 };
    },
    queryDropTarget: (point, excludedIds) => queries.queryDropTarget(point, excludedIds),
    queryCompositeAssetScopes: () => queries.queryCompositeAssetScopes(),
    cancelTransientGesture,
    ...modelFocus,
    selectNode: (nodeId) => {
      const known = new Set(workingCanvasOf(woohaa3CanvasStore.getState())?.document.nodes.map((node) => node.id) ?? []);
      if (!known.has(nodeId)) return false;
      setSelection([nodeId]); return true;
    },
    nodeScreenRect: (nodeId) => {
      const index = sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
      const node = index?.byId.get(nodeId);
      if (!index || !node) return null;
      // working 拖动/改尺寸预览优先（与画布投影同一来源），提交后由规范坐标接管。
      const position = state.localPositions.get(nodeId) ?? index.absolutePosition(nodeId);
      if (!position) return null;
      const size = state.localSizes.get(nodeId) ?? indexNodeSize(node);
      const topLeft = worldToClient(position);
      const viewport = activeViewport();
      return { left: topLeft.x, top: topLeft.y, width: size.width * viewport.zoom, height: size.height * viewport.zoom };
    },
    dispose() {
      disposed = true;
      disposeDiagnostics();
      unbindPlaybackGate();
      hover.forgetPointer();
      hoverNodeStore.invalidatePlayback();
      frameLoop.dispose();
      unsubscribeCapabilities?.();
      unsubscribePreview();
      modelPreviewStore.clear();
      viewportTransition.cancel();
      // 取消未提交的拖动粘连 / 聚合拉线手势（change: add-drag-touch-connections /
      // add-multi-select-aggregate-connect，design D6）。
      input.dispose();
      if (state.viewportCommitTimer !== null) target.clearTimeout?.(state.viewportCommitTimer);
      state.viewportCommitTimer = null;
      removeCanvasListeners(canvas, target, input, keyboard, dblclick, {
        onDocumentWheel,
        onDocumentPointerDown,
        onDocumentFocusChange,
        onDocumentBlur,
        onDocumentVisibility,
        onGestureStart,
        onGestureChange,
        onGestureEnd,
        onWindowResize
      });
      suspendHoverPlayback();
    }
  };
}
