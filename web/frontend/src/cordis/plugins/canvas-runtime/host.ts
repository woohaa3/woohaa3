/**
 * Canvas Runtime Service（change: adopt-frontend-cordis-plugin-runtime，design D3）。
 *
 * 页面级句柄：装载 Bevy 运行时、挂载 DOM canvas 时创建 interaction controller 与
 * texture sync、持有上下文菜单瞬时状态。**不**保存规范画布状态（那是 store/Yjs）。
 *
 * React 只调用 `attach(canvas)` 并渲染 slot；controller/socket/timer 的生命周期由页面级
 * Context 统一 dispose（design D2）。
 */
import type { BevyRuntime } from "./bevy-runtime.js";
import { installInteractionController, type InteractionController, type InteractionControllerOptions } from "../canvas-shell/interaction-controller.js";
import { type FocusTargetInput } from "../canvas-shell/model-focus-session.js";
import { createAttachedMedia } from "./attached-media.js";
import { projectFocusContentRect } from "./project-focus-content-rect.js";
import { queryCompositeAssetItemPick, type CompositeAssetPickInput } from "./composite-asset-picking.js";
import { compositeFocusContextIds } from "../canvas-shell/composite-focus-context.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { defaultAppTheme, type BevyModelEditor, type GhostRenderNode, type ModelFocusProjection } from "@woohaa3/contracts";
import type { CanvasRuntimeService, CanvasRuntimeStatus } from "../../contracts.js";
import { type CanvasRuntimeOptions } from "./canvas-runtime-options.js";
import { installCanvasRuntimeMirrors } from "./canvas-runtime-mirrors.js";
import { FocusContentRectStore } from "./focus-content-rect-store.js";
import { FocusTransitionCoordinator } from "./focus-transition-coordinator.js";
import { MediaResourceStore } from "./media-resource-store.js";
import { hoverNodeStore } from "../../services/hover-store.js";
import { createDefaultMediaDecoder } from "./media-decoder.js";
import { VideoLeaseRegistry } from "./video-lease-registry.js";

const defaultMediaDecoder = createDefaultMediaDecoder();
import { applyFocusTargetTransition } from "./focus-target-transition.js";
import { isDocumentFocusTarget } from "../../navigation/contracts.js";
import { buildAttachInteractionOptions } from "./attach-interaction-options.js";
import { AnimationPlaybackStore } from "./animation-playback-store.js";
import { readNodeActionToolbars, activateNodeAction, readSelectionActionToolbar, activateSelectionAction } from "../canvas-shell/node-action-bridge.js";
import { ImageFocusStore } from "./image-focus-store.js";
import { VideoFocusStore } from "./video-focus-store.js";
import { ModelSceneOverrideStore } from "./model-scene-override-store.js";
import { installPerfFrameWindow } from "./perf-frame-window.js";
import { getGroupLayoutSizes } from "@woohaa3/contracts";
import { groupBadgePresentationScreenRect } from "./group-badge-screen-rect.js";
import {
  applyFilmSetObjectAction,
  applyFilmSetObjectGesture,
  applyModelEditorFocusGesture,
  applyModelEditorShotGesture,
  applyShotWheel,
  createModelEditorGestureRefs
} from "./model-editor-gestures.js";

export type { CanvasRuntimeOptions } from "./canvas-runtime-options.js";

export class CanvasRuntimeHost implements CanvasRuntimeService {
  private status: CanvasRuntimeStatus = { phase: "booting", error: null };
  private readonly listeners = new Set<() => void>();
  private readonly viewportListeners = new Set<() => void>();
  private readonly frameListeners = new Set<() => void>();
  private readonly modelFocusListeners = new Set<() => void>();
  private viewportRevision = 0;
  private sceneRevision = 0;
  /** 模型/片场内容身份版本：model-scene 通知时推进（候选表与准入投影据此失效）。 */
  private modelContentVersion = 0;
  private sceneNotificationQueued = false;
  private readonly sceneListeners = new Set<() => void>();
  sceneVersion = (): number => this.sceneRevision;
  subscribeScene = (listener: () => void): (()=>void) => { this.sceneListeners.add(listener);return ()=>{this.sceneListeners.delete(listener);}; };
  private sceneSubmitted = (): void => {
    this.sceneRevision++;
    // Queries may flush pending interaction work during a consumer's render.
    // Publish after that stack and coalesce multiple submissions in the same turn.
    if (this.sceneNotificationQueued || this.disposed) return;
    this.sceneNotificationQueued = true;
    queueMicrotask(() => {
      this.sceneNotificationQueued = false;
      if (!this.disposed) for (const listener of this.sceneListeners) listener();
    });
  };
  private ghosts: GhostRenderNode[] = [];
  private previews = new Map<string, string>();
  /** 当前模型聚焦瞬时投影（浏览器本地；不进 ServerCanvas/命令）。 */
  private modelFocus: ModelFocusProjection | null = null;
  /** 图片聚焦瞬时态（聚焦投影/目标/纹理；浏览器本地）。 */
  private readonly imageFocusStore = new ImageFocusStore();
  setImageFocusDetails=(frame:import("./focus-details.js").ImageFocusDetails|null):void=>{
    this.imageFocusStore.setDetails(frame);this.controllerInstance?.invalidate("image-focus-details");
  };
  registerImageViewportTarget = (target: import("../../focus/types.js").FocusViewportTarget): (() => void) =>
    this.imageFocusStore.registerViewportTarget(target);
  setImageFocusTexture = (texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null): void => {
    this.imageFocusStore.setTexture(texture);
    this.controllerInstance?.invalidate("image-focus-texture");
  };
  /** 视频聚焦瞬时态（聚焦投影/目标/纹理；浏览器本地）。 */
  private readonly videoFocusStore = new VideoFocusStore();
  setVideoFocusTexture = (texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null): void => {
    this.videoFocusStore.setTexture(texture);
    this.controllerInstance?.invalidate("video-focus-texture");
  };
  /** 当前编辑 gizmo/镜头工具瞬时态（浏览器本地；不进 ServerCanvas/命令）。 */
  private modelEditor: BevyModelEditor | null = null;
  /** 模型历史聚焦 owner（浏览器本地）。 */
  private historyFocus: { nodeId: string } | null = null;
  /** 聚焦 content rect 与右侧占用宽度（浏览器本地）。 */
  private readonly focusRectStore = new FocusContentRectStore();
  /** 三类聚焦共同的唯一过渡时间源（Canvas Runtime scope；design D6/D7）。 */
  private readonly focusTransition = new FocusTransitionCoordinator({
    prefersReducedMotion: () => this.options.prefersReducedMotion?.() ?? false
  });
  focusTransitionPort = () => this.focusTransition.port();
  /**
   * 当前三维聚焦过渡公共进度快照（design D6/D7）。
   *
   * 无活动三维过渡返回 null（Rust 回退内部计时）；由 controller 每帧读入渲染快照。
   */
  focusTransitionProgress = (): import("@woohaa3/contracts").BevyFocusTransition | null =>
    this.focusTransition.modelProgress();
  /**
   * Canvas Runtime scope 唯一持有的有界媒体资源 store
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D8/D9，任务 4.1）。
   *
   * 以稳定来源 identity 共享已解码 CPU 位图；feature 只取 lease，不各自创建解码器。
   */
  private readonly mediaResources = new MediaResourceStore({
    decode: (source) => (this.options.decodeMediaBitmap ?? defaultMediaDecoder)(source)
  });
  /** 取得共享媒体位图 lease；未提供解码/失败返回 null（调用方保留上一合法表示）。 */
  acquireMediaBitmap = (
    source: import("../../focus/media-resources.js").FocusMediaSource,
    pin?: string
  ): Promise<import("../../focus/media-resources.js").FocusMediaLease | null> =>
    this.mediaResources.acquire(source, pin);
  /** 丢弃某来源缓存（换源/设备恢复）。 */
  invalidateMediaSource = (key: string): void => this.mediaResources.invalidateSource(key);
  /**
   * 直接视频 registry：canonical direct/history 来源的独占 consumer lease
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D10，任务 5.1）。
   *
   * 卡片与聚焦通过 lease 接管同一隐藏解码元素，不各自创建第二个解码器。片场内部视频由各自播放头
   * 管理，不进入本 registry。
   */
  private readonly videoLeases = new VideoLeaseRegistry();
  /** 取得某视频来源的独占 lease；已有 consumer 持有返回 null（不抢占）。 */
  acquireVideoLease = (
    identity: import("./video-lease-registry.js").VideoSourceIdentity,
    quality: import("./video-lease-registry.js").VideoQuality = "card",
    pin?: string
  ): import("./video-lease-registry.js").VideoLease | null => this.videoLeases.acquire(identity, quality, pin);
  /** 丢弃某视频来源（删除/换源/设备恢复）。 */
  invalidateVideoSource = (identity: import("./video-lease-registry.js").VideoSourceIdentity): void =>
    this.videoLeases.invalidate(identity);
  focusContentRect = () => this.focusRectStore.get();
  subscribeFocusContentRect = (listener: () => void) => this.focusRectStore.subscribe(listener);
  setFocusContentRect = (rect: import("../../focus/types.js").FocusContentRect | null) => {
    const initial = this.focusRectStore.get() === null && rect !== null;
    if (!this.focusRectStore.set(rect)) return;
    this.applyFocusContentRect(rect, initial);
    this.focusRectStore.emit();
    // content rect 变化影响聚焦取景/相机：只请求失效，由唯一帧账本合并提交（design D2）。
    this.controllerInstance?.invalidate("focus-content-rect");
  };
  /** 把聚焦内容矩形投影到 controller content rect，并在首次布局时对非预览模型重取景。 */
  private applyFocusContentRect(
    rect: import("../../focus/types.js").FocusContentRect | null,
    initial: boolean
  ): void {
    projectFocusContentRect(this.controllerInstance, rect, this.focusRectStore.contentRectRight(), initial, this.modelFocus, this.options.nodeCapabilities);
  }
  /** 本地已校验模型 Scene IR override（nodeId → ops），只影响聚焦 ModelRoot。 */
  private readonly modelSceneOverrides = new ModelSceneOverrideStore();
  /** 宿主推入的模型场景（nodeId → 聚焦目标输入）；`null` 表示回落到 `options.getModelFocusTargets`。 */
  private modelFocusTargetsOverride: readonly FocusTargetInput[] | null = null;
  private runtimeInstance: BevyRuntime | null = null;
  private controllerInstance: InteractionController | null = null;
  private detach: (() => void) | null = null;
  private disposed = false;
  private loadPromise: Promise<BevyRuntime> | null = null;
  /** 帧窗口（`perf.frame`）：DOM canvas 挂上后开，卸载/释放时关（design D4）。 */
  private frameWindow: import("../../services/telemetry-performance.js").PerfFrameWindow | null = null;
  private readonly loadAbort = new AbortController();

  constructor(private readonly options: CanvasRuntimeOptions) {}

  getStatus = (): CanvasRuntimeStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  controller = (): InteractionController | null => this.controllerInstance;
  lastPointerWorld = (): { x: number; y: number } | null =>
    this.controllerInstance?.lastPointerWorld() ?? null;
  runtime = (): BevyRuntime | null => this.runtimeInstance;
  clientToWorld = (client: { x: number; y: number }): { x: number; y: number } | null =>
    this.controllerInstance?.clientToWorld(client) ?? null;
  worldToClient = (world: { x: number; y: number }): { x: number; y: number } | null =>
    this.controllerInstance?.worldToClient(world) ?? null;
  historyDotScreenPoint = (nodeId: string, operationId: string) =>
    this.controllerInstance?.historyDotScreenPoint?.(nodeId, operationId) ?? null;

  /** 通用 drop target 查询；未挂载控制器时稳定 unavailable（change: 2026-10-12 片场菱形范围）。 */
  queryDropTarget = (point: { x: number; y: number }, excludedIds: readonly string[] = []) =>
    this.controllerInstance?.queryDropTarget(point, excludedIds) ?? { ok: false as const, reason: "unavailable" as const };
  /** 复合资产范围几何读取；未挂载控制器时稳定 unavailable。 */
  queryCompositeAssetScopes = () =>
    this.controllerInstance?.queryCompositeAssetScopes() ?? { ok: false as const, reason: "unavailable" as const };

  // ── 模型聚焦查看（change: add-model-focus-viewing，任务 3.4） ──────────────────

  /** 当前模型聚焦投影；未聚焦返回 null。 */
  modelFocusProjection = (): ModelFocusProjection | null => this.modelFocus;
  /** 订阅模型聚焦投影变化；供 overlay UI 重排。 */
  subscribeModelFocus = (listener: () => void): (() => void) => {
    this.modelFocusListeners.add(listener);
    return () => {
      this.modelFocusListeners.delete(listener);
    };
  };
  private emitModelFocus = (): void => {
    for (const listener of this.modelFocusListeners) listener();
  };
  /** 退出模型聚焦并恢复进入前的 2D 视口（无聚焦时 no-op）。 */
  exitModelFocus = (): void => {
    this.controllerInstance?.exitModelFocus();
  };

  /** 以 canonical nodeId 直接进入聚焦（Canvas Navigation focus adapter 调用）。 */
  enterDirectFocus = (nodeId: string): boolean =>
    this.controllerInstance?.enterModelFocusForNode(nodeId) ?? false;
  /** 是否仍有活动聚焦。 */
  isFocused = (): boolean =>
    this.modelFocus !== null || this.imageFocusStore.getTargetId() !== null || this.videoFocusStore.getTargetId() !== null;

  // ── 图片聚焦（change: 2026-10-08-add-image-focus-editing-and-unified-node-history） ──

  /** 当前图片聚焦投影；未聚焦返回 null。 */
  imageFocusProjection = (): import("@woohaa3/contracts").BevyImageFocus | null => this.imageFocusStore.get();
  /** 宿主推入有效图片焦点目标集合（用于 adapter isTargetValid）。 */
  setImageFocusTargets = (nodeIds: readonly string[]): void => {
    this.imageFocusStore.setTargets(nodeIds);
  };
  /** 图片目标是否合法（adapter 校验）。 */
  isImageFocusTargetValid = (nodeId: string): boolean => this.imageFocusStore.isTargetValid(nodeId);
  /** 由图片编辑 feature 推入/清除图片聚焦投影（浏览器本地，不写规范状态）。 */
  setImageFocus = (projection: import("@woohaa3/contracts").BevyImageFocus | null): void => {
    this.imageFocusStore.set(projection);
    this.controllerInstance?.invalidate("image-focus");
  };
  /** 订阅图片聚焦投影变化。 */
  subscribeImageFocus = (listener: () => void): (() => void) => this.imageFocusStore.subscribe(listener);
  /** 编辑器接管画面之前，图片聚焦期间的画布导航按普通画布处理（见契约注释）。 */
  setImageFocusPending = (pending: boolean): void => { this.imageFocusStore.setPending(pending); };

  // ── 视频聚焦（change: 2026-10-10-add-video-node-focus-workspace） ─────────────

  /** 当前视频聚焦投影；未聚焦返回 null。 */
  videoFocusProjection = (): import("@woohaa3/contracts").BevyVideoFocus | null => this.videoFocusStore.get();
  /** 宿主推入有效视频焦点目标集合（用于 adapter isTargetValid）。 */
  setVideoFocusTargets = (nodeIds: readonly string[]): void => {
    this.videoFocusStore.setTargets(nodeIds);
  };
  /** 视频目标是否合法（adapter 校验）。 */
  isVideoFocusTargetValid = (nodeId: string): boolean => this.videoFocusStore.isTargetValid(nodeId);
  /** 由视频聚焦 feature 推入/清除视频聚焦投影（浏览器本地，不写规范状态）。 */
  setVideoFocus = (projection: import("@woohaa3/contracts").BevyVideoFocus | null): void => {
    this.videoFocusStore.set(projection);
    this.controllerInstance?.invalidate("video-focus");
  };
  /** 订阅视频聚焦投影变化。 */
  subscribeVideoFocus = (listener: () => void): (() => void) => this.videoFocusStore.subscribe(listener);

  /**
   * 应用完整 focus target transition（Canvas Navigation focus adapter）
   * （change: fix-model-focus-navigation-and-camera-parity，design D2）。
   */
  applyFocusTarget(
    target: import("../../navigation/contracts.js").CanvasFocusTarget | null,
    transition: { preserveSession: boolean; restoreDirectCamera?: boolean }
  ): { ok: true } | { ok: false; reason: string } {
    const controller = this.controllerInstance;
    // 独立文件文档不需要 controller：只为清空节点聚焦状态（文件呈现自己取景）。
    if (!controller) {
      return isDocumentFocusTarget(target)
        ? { ok: true }
        : { ok: false, reason: "renderer-unavailable" };
    }
    const result = applyFocusTargetTransition({
      host: {
        setImageFocusTargetId: (nodeId) => this.imageFocusStore.setTargetId(nodeId),
        setVideoFocusTargetId: (nodeId) => this.videoFocusStore.setTargetId(nodeId),
        hasModelFocus: () => this.modelFocus !== null,
        exitModelFocus: () => controller.exitModelFocus(),
        clearImageFocus: () => this.setImageFocus(null),
        clearVideoFocus: () => this.setVideoFocus(null),
        getHistoryFocus: () => this.historyFocus,
        setHistoryFocus: (nodeId) => {
          this.historyFocus = nodeId ? { nodeId } : null;
        }
      },
      controller,
      target,
      transition
    });
    // 三维（model/extension）聚焦的进度唯一由本 coordinator 驱动；二维媒体聚焦直接投影 viewport，
    // 不进入三维进度（design D6/D7：同一过渡不能同时使用 TS 与 Rust 两个驱动）。
    this.driveModelTransition(target, result.ok);
    return result;
  }

  /**
   * 驱动三维聚焦公共进度（design D6/D7）。
   *
   * 进入/切换 model/extension：起跑唯一进度，Rust 按进度求值，不再独立计时；退出（target 为
   * null）时保留刚聚焦的实体节点身份继续推进到终点。目标不可用或切换为非三维聚焦时取消在途进度
   * （旧请求不悬挂），交由底层内部计时/二维 adapter 处理。
   */
  private driveModelTransition(
    target: import("../../navigation/contracts.js").CanvasFocusTarget | null,
    ok: boolean
  ): void {
    if (!ok) {
      if (this.focusTransition.hasModelProgress()) this.focusTransition.cancel();
      return;
    }
    // 独立文件文档不是三维聚焦：取消任何在途三维进度（不为文件文档伪造节点相机）。
    if (target && "documentId" in target) {
      if (this.focusTransition.hasModelProgress()) this.focusTransition.cancel();
      return;
    }
    const modelKind = target?.kind === "model" || target?.kind === "extension";
    if (target && modelKind) {
      void this.focusTransition.runModel({
        nodeId: target.nodeId,
        kind: target.kind === "extension" ? "extension" : "model",
        onProgress: () => this.controllerInstance?.invalidate("focus-transition")
      });
      this.controllerInstance?.invalidate("focus-transition");
      return;
    }
    const inFlightModel = this.focusTransition.hasModelProgress();
    if (!target && inFlightModel) {
      // 退出：`model_focus` 已清空，但 Rust `rig.focus_node` 仍保留退出中的实体节点，沿用同一身份。
      const nodeId = this.focusTransition.currentModelNodeId();
      if (nodeId !== null) {
        void this.focusTransition.runModel({
          nodeId,
          kind: this.focusTransition.currentModelKind(),
          onProgress: () => this.controllerInstance?.invalidate("focus-transition")
        });
        this.controllerInstance?.invalidate("focus-transition");
      }
      return;
    }
    // 切到二维媒体聚焦或非三维目标：取消任何在途三维进度，避免两个驱动并存。
    if (inFlightModel) this.focusTransition.cancel();
  }

  // ── 模型历史聚焦 owner / content rect / 本地快照覆盖 ─────────────────────────

  /**
   * 当前聚焦编辑模式（change: 对齐 xyflow-bevy 历史只读浏览）。
   *
   * - 历史 owner 活跃（右侧历史面板打开同一模型）→ `"history"`：只读浏览，禁写；
   * - 否则 → `"edit"`。
   */
  modelFocusMode = (): "edit" | "history" => (this.historyFocus ? "history" : "edit");

  /** 投影右侧实际占用区域（CSS content rect）；0 表示无遮挡。 */
  setContentRect = (input: { right: number }): void => {
    if (!this.focusRectStore.setContentRight(input.right)) return;
    this.controllerInstance?.setContentRect({ right: this.focusRectStore.contentRectRight() });
  };

  /** 设置/清除本地已校验模型 Scene IR snapshot override。 */
  setModelSceneOverride = (input: { nodeId: string; override: { version: string; ops: readonly unknown[] } | null }): void => {
    this.modelSceneOverrides.set(input.nodeId, input.override);
    // 选择模型版本后按新 AABB 重新取景（任务 4.3）：替换内容与相机取景同步。
    if (this.modelFocus?.nodeId === input.nodeId) {
      this.controllerInstance?.reframeModelFocus(input.nodeId);
    }
    this.controllerInstance?.invalidate("model-scene-override");
  };

  /** 当前历史聚焦 owner（诊断/测试）。 */
  historyFocusNodeId = (): string | null => this.historyFocus?.nodeId ?? null;

  /** 当前本地模型 Scene IR override（供聚焦目标解析合并，任务 4.3）。 */
  modelSceneOverride = (nodeId: string): { version: string; ops: readonly unknown[] } | null =>
    this.modelSceneOverrides.get(nodeId);
  /**
   * 宿主推入当前可聚焦模型目标（由 canvas-shell plugin 从 model-scene provider 解析）。
   * 未显式推入时回落到 `options.getModelFocusTargets`。
   */
  setModelFocusTargets = (targets: readonly FocusTargetInput[]): void => {
    this.modelFocusTargetsOverride = [...targets];
    // 目标集合变化可能使当前聚焦目标失效：请求失效，由下一帧合并结算（design D2）。
    this.controllerInstance?.invalidate("model-focus-targets");
  };
  /** 当前模型目标快照（诊断用）。 */
  modelFocusTargets = (): readonly FocusTargetInput[] => this.resolveModelFocusTargets();

  // ── 模型编辑 gizmo / 镜头工具（change: add-model-editor-gizmo-shot-capture） ──

  /**
   * 宿主推入当前编辑 gizmo 瞬时态（由编辑会话 + 聚焦目标派生）。
   * 传 null 清除；payload 未变不失效，避免普通模型聚焦轨道每帧挡住 `set_observer`。
   */
  setModelEditor = (editor: BevyModelEditor | null): void => {
    const previous = this.modelEditor;
    if (editor?.toolMode === "camera" && previous?.nodeId === editor.nodeId && previous.cameraId === editor.cameraId && previous.cameraTool === editor.cameraTool && previous.toolMode === editor.toolMode && !editor.feedback) {
      editor = { ...editor, ...(previous.feedback ? { feedback: previous.feedback } : {}) };
    }
    if (JSON.stringify(this.modelEditor) === JSON.stringify(editor)) return;
    this.modelEditor = editor;
    this.controllerInstance?.invalidate("model-editor");
  };
  /** 当前编辑 gizmo 瞬时态；无编辑返回 null。 */
  modelEditorState = (): BevyModelEditor | null => this.modelEditor;

  // ── 动画节点播放（change: 2026-10-05-bind-model-animation-to-shots） ──

  private readonly animationPlaybackStore = new AnimationPlaybackStore();
  /** 当前挂载的片场媒体会话（change: 2026-10-08-make-film-set-model-only）。 */
  private compositeAssetMediaSessionsInstance: import("./composite-asset-media-session.js").CompositeAssetMediaSessions | null = null;
  /** 当前 attach 的页面级资源需求 owner（change: 2026-10-23-scale-canvas-media-residency）。 */
  private residencyInstance: import("./residency/index.js").CanvasResourceCoordinator | null = null;
  /** 当前资源协调器（诊断/测试；未挂载返回 null）。 */
  residency = (): import("./residency/index.js").CanvasResourceCoordinator | null => this.residencyInstance;

  /**
   * 当前必须优先驻留的节点（interactive 用途）。
   *
   * 只含聚焦/播放/捕获目标：选中上千节点只提升优先级，不把全部选中项变成不可淘汰 pin
   * （change: 2026-10-23 design D1/D3）。
   */
  private residencyInteractiveNodeIds(): readonly string[] {
    const ids = new Set<string>();
    const add = (nodeId: string | null | undefined) => { if (nodeId) ids.add(nodeId); };
    add(this.modelFocus?.nodeId);
    if (this.modelFocus) {
      const working = workingCanvasOf(woohaa3CanvasStore.getState());
      const projected = this.options.compositeAssets?.projectCanvas(this.options.projectHistoryCanvas?.(working) ?? working) ?? working;
      for (const id of compositeFocusContextIds(projected, this.options.compositeAssets, this.modelFocus.nodeId)) add(id);
    }
    add(this.imageFocusStore.getTargetId());
    add(this.videoFocusStore.getTargetId());
    add(this.animationPlaybackStore.current()?.nodeId);
    add(hoverNodeStore.getNodeId());
    add(this.videoFocusStore.getTexture()?.nodeId);
    add(this.imageFocusStore.getTexture()?.nodeId);
    return [...ids];
  }

  /**
   * 显式 pin（聚焦/捕获过渡期间保留目标卡片与过渡表示）。
   *
   * 有界：只包含当前聚焦目标，不随选择集增长；退出聚焦即自动释放。
   */
  private residencyPinnedNodeIds(): readonly string[] {
    const ids = new Set<string>();
    const add = (nodeId: string | null | undefined) => { if (nodeId) ids.add(nodeId); };
    add(this.modelFocus?.nodeId);
    add(this.imageFocusStore.getTargetId());
    add(this.videoFocusStore.getTargetId());
    return [...ids];
  }
  /** 宿主推入活动动画节点播放投影；传 null 清除。变化立即 flush 一次 scene。 */
  setAnimationPlayback = (playback: import("@woohaa3/contracts").BevyAnimationPlayback | null): void => {
    if (this.animationPlaybackStore.set(playback)) this.controllerInstance?.invalidate("animation-playback");
  };
  /**
   * 片场唯一播放头通知（change: 2026-10-08-make-film-set-model-only）。
   *
   * 由动画播放控制器每帧调用；不改变动画投影，只把时间转给片场媒体会话。
   */
  notifyAnimationTime = (input: { nodeId: string | null; time: number; playing: boolean }): void => {
    this.animationPlaybackStore.notify(input);
  };
  /** 当前片场媒体会话（供截图等待目标帧就绪；change: 2026-10-08-make-film-set-model-only）。 */
  compositeAssetMediaSessions = (): import("./composite-asset-media-session.js").CompositeAssetMediaSessions | null => this.compositeAssetMediaSessionsInstance;
  /** 当前活动动画播放投影；无返回 null。 */
  animationPlaybackState = (): import("@woohaa3/contracts").BevyAnimationPlayback | null =>
    this.animationPlaybackStore.current();

  /**
   * 模型编辑 gizmo 命中与轴拖动约束（Bevy WASM 相机/bounds 事实源）
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.4）。
   */
  queryGizmoHit = (
    input: import("../canvas-shell/model-gizmo-hit.js").GizmoQueryInput
  ): import("./bevy-runtime.js").GizmoHitResult | null =>
    this.runtimeInstance?.queryGizmoHit?.(input) ?? null;

  /** 宿主注入的模型编辑手势处理器（change: add-model-editor-gizmo-shot-capture 等）。 */
  private readonly modelEditorGestures = createModelEditorGestureRefs();
  setModelEditorShotGesture(handler: InteractionControllerOptions["shotGesture"] | null): void {
    applyModelEditorShotGesture(this.modelEditorGestures, this.controllerInstance, handler);
  }

  setModelEditorFocusGesture(handler: InteractionControllerOptions["focusGesture"] | null): void {
    applyModelEditorFocusGesture(this.modelEditorGestures, this.controllerInstance, handler);
  }

  setShotWheel(handler: InteractionControllerOptions["shotWheel"] | null): void {
    applyShotWheel(this.modelEditorGestures, this.controllerInstance, handler);
  }

  /** 宿主注入的片场对象模式手势处理器（change: 2026-10-09 片场对象编辑）。 */
  setFilmSetObjectGesture(handler: InteractionControllerOptions["filmSetObjectGesture"] | null): void {
    applyFilmSetObjectGesture(this.modelEditorGestures, this.controllerInstance, handler);
  }

  /** 宿主注入的片场对象局部键盘 action（change: 2026-10-10）。 */
  setFilmSetObjectAction(handler: InteractionControllerOptions["filmSetObjectAction"] | null): void {
    applyFilmSetObjectAction(this.modelEditorGestures, this.controllerInstance, handler);
  }

  /** 当前已接受的 interaction generation。 */
  interactionGeneration = (): number => this.runtimeInstance?.interactionGeneration?.() ?? 0;

  /** 片场对象 picking（聚焦透视相机 + 同帧组合几何）。 */
  queryCompositeAssetItemPick = (input: CompositeAssetPickInput) => queryCompositeAssetItemPick(this.runtimeInstance, input);

  /** 片场对象世界包围盒（选中反馈/gizmo 定位）。 */
  queryCompositeAssetItemBounds = (nodeId: string): Array<{ itemId: string; center: [number, number, number]; radius: number; unit: number; yaw: number; worldToLocal?: number[] }> =>
    this.runtimeInstance?.queryCompositeAssetItemBounds?.(nodeId) ?? [];

  /** 暂停活动动画播放头（对象编辑前调用；无播放时 no-op）。 */
  pauseAnimation?: () => void;
  /** 动画播放插件注册暂停钩子（change: 2026-10-09 片场对象编辑）。 */
  private animationPauseSink: (() => void) | null = null;
  setAnimationPauseSink = (sink: (() => void) | null): void => {
    this.animationPauseSink = sink;
    this.pauseAnimation = sink ? () => this.animationPauseSink?.() : undefined;
  };

  /** 解析当前目标：显式推入优先，否则询问宿主。 */
  private resolveModelFocusTargets = (): readonly FocusTargetInput[] =>
    this.modelFocusTargetsOverride ?? this.options.getModelFocusTargets?.() ?? [];

  /** 视口版本号；随本地 pan/zoom 递增。供 overlay 用 useSyncExternalStore 重排。 */
  viewportVersion = (): number => this.viewportRevision;
  subscribeViewport = (listener: () => void): (() => void) => {
    this.viewportListeners.add(listener);
    return () => {
      this.viewportListeners.delete(listener);
    };
  };
  subscribeFrame = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  /**
   * 单节点屏幕矩形（CSS px）（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
   * 转发到控制器；未挂载或节点不存在返回 null。
   */
  nodeScreenRect = (nodeId: string): import("@woohaa3/contracts").ScreenRect | null =>
    this.controllerInstance?.nodeScreenRect(nodeId) ?? null;
  nodePresentationScreenRect = (nodeId: string): import("@woohaa3/contracts").ScreenRect | null => {
    const card = this.nodeScreenRect(nodeId);
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
    const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
    // 普通 group 的执行面板跟随外部 3D 徽标，而不是跟随气泡主体。使用当前 screen rect
    // 保留拖动/缩放预览，再把同一份徽标几何投影到屏幕。
    //
    // 基准必须是**渲染矩形**而不是节点自身尺寸：Rust 把徽标画在渲染场景节点矩形的下缘，
    // 而 group 的渲染矩形是成员包围后的布局尺寸（`getGroupLayoutSizes`，可比节点自身高得多）。
    // 用节点尺寸推导会把徽标算高一整段，面板随之压回场景上。
    if (card && node?.type === "group" && this.controllerInstance) {
      const controller = this.controllerInstance;
      const data = canvas?.nodeData[nodeId];
      const layout = canvas ? getGroupLayoutSizes(canvas.document.nodes).get(nodeId) ?? null : null;
      return groupBadgePresentationScreenRect({
        card,
        zoom: controller.viewport().zoom,
        node,
        layout,
        collapsed: data?.groupCollapsed === true,
        scale: data?.groupBadgeScale
      }) ?? card;
    }
    const scopes = this.controllerInstance?.queryCompositeAssetScopes();
    if (!scopes?.ok) return card;
    const scope = scopes.value.find((entry) => entry.nodeId === nodeId);
    if (!scope) return card;
    const [worldLeft, worldTop, width, height] = scope.aabb;
    const start = this.worldToClient({ x: worldLeft, y: worldTop });
    const end = this.worldToClient({ x: worldLeft + width, y: worldTop + height });
    if (!start || !end) return card;
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const right = Math.max(start.x, end.x);
    const bottom = Math.max(start.y, end.y);
    const x = Math.min(card?.left ?? left, left);
    const y = Math.min(card?.top ?? top, top);
    return { left: x, top: y, width: right - x, height: bottom - y };
  };

  /** 上传中的幽灵节点（只渲染、不进规范状态）。 */
  ghostNodes = (): readonly GhostRenderNode[] => this.ghosts;
  setGhostNodes = (nodes: readonly GhostRenderNode[]): void => {
    this.ghosts = [...nodes];
    // E2E/排障镜像：观察当前幽灵节点（生产无副作用）。
    (globalThis as unknown as { __canvasGhosts?: unknown }).__canvasGhosts = this.ghosts.map((ghost) => ({ ...ghost }));
    // 请求失效：控制器在下一帧把 ghost 合并进快照（design D2 统一账本）。
    this.controllerInstance?.invalidate("ghost-nodes");
  };

  /** 幽灵节点本地预览 URL（nodeId → object URL）；由导入服务写入。 */
  previewUrls = (): ReadonlyMap<string, string> => this.previews;
  setPreviewUrls(urls: ReadonlyMap<string, string>): void {
    this.previews = new Map(urls);
    this.controllerInstance?.invalidate("preview-urls");
  }

  load(): Promise<BevyRuntime> {
    if (this.disposed) return Promise.reject(new Error("Canvas runtime host disposed"));
    return this.loadPromise ??= this.loadOnce().catch(error => {
      this.loadPromise = null;
      throw error;
    });
  }

  private async loadOnce(): Promise<BevyRuntime> {
    const loader = this.options.loadRuntime ?? (async () => {
      const { loadBevyRuntime } = await import("./bevy-runtime.js");
      return loadBevyRuntime({ signal: this.loadAbort.signal });
    });
    try {
      const runtime = await loader();
      if (this.disposed) { runtime.dispose(); return runtime; }
      this.runtimeInstance = runtime;
      this.publish({ phase: "ready", error: null });
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.disposed) this.publish({ phase: "error", error: message });
      throw error;
    }
  }

  /** 挂载 DOM canvas：创建 texture sync + video sessions + interaction controller，返回卸载函数。 */
  attach(canvas: HTMLCanvasElement): () => void {
    if (!this.runtimeInstance) throw new Error("Bevy 运行时尚未就绪，无法挂载画布");
    // 先清理旧挂载，保证重复 attach 不累积 listener（StrictMode 安全）。
    this.detach?.();
    const runtime = this.runtimeInstance;
    // 视口/surface/surface 尺寸由 controller 提供；attach 期间用转发器保存引用
    // （controller 需要 media 句柄，media 也需要 controller 的视口：单向解引用避免构造环）。
    const viewportRef: { current: (() => { x: number; y: number; zoom: number }) | null } = { current: null };
    const surfaceRef: {
      current: (() => { width: number; height: number; pixelRatio: number }) | null;
    } = { current: null };
    const {
      textureSync, videoSessions, compositeAssetMediaSessions, residency, projectResidency, dispose: disposeAttachedMedia
    } = createAttachedMedia({
      runtime,
      options: this.options,
      getPreviewUrls: () => this.previews,
      getFocusTexture: () => this.videoFocusStore.getTexture() ?? this.imageFocusStore.getTexture(),
      getFocusDetails: this.imageFocusStore.getDetails,
      isFocused: this.isFocused,
      playback: this.animationPlaybackStore,
      invalidate: (reason) => this.controllerInstance?.invalidate(reason),
      getViewport: () => viewportRef.current?.() ?? { x: 0, y: 0, zoom: 1 },
      getSurface: () => surfaceRef.current?.() ?? { width: 0, height: 0, pixelRatio: 1 },
      getInteractiveNodeIds: () => this.residencyInteractiveNodeIds(),
      getPinnedNodeIds: () => this.residencyPinnedNodeIds(),
      isPageVisible: () => (globalThis.document?.visibilityState ?? "visible") !== "hidden",
      getModelContentVersion: () => this.modelContentVersion
    });
    this.residencyInstance = residency;
    this.compositeAssetMediaSessionsInstance = compositeAssetMediaSessions;
    // E2E/排障镜像：观察视频会话/模型聚焦/图片聚焦/放置预览（生产无副作用）。
    installCanvasRuntimeMirrors({
      compositeAssetMediaSessions,
      videoSessions,
      modelFocus: () => this.modelFocus,
      imageFocus: () => this.imageFocusStore.get(),
      videoFocus: () => this.videoFocusStore.get(),
      videoFocusTargetId: () => this.videoFocusStore.getTargetId(),
      residency
    });
    const controller = installInteractionController(
      buildAttachInteractionOptions({
        canvas,
        options: this.options,
        onSceneSubmitted: this.sceneSubmitted,
        textureSync,
        videoSessions,
        compositeAssetMediaSessions,
        getRuntime: () => this.runtimeInstance,
        getModelResources: () => this.options.getModelResources?.() ?? new Map(),
        theme: () => this.options.getTheme?.() ?? defaultAppTheme(),
        getGhostNodes: () => this.ghosts,
        getNodeActionToolbars: () => readNodeActionToolbars(),
        onNodeAction: (hit) => activateNodeAction(hit),
        getSelectionActionToolbar: () => readSelectionActionToolbar(),
        onSelectionAction: (hit) => activateSelectionAction(hit),
        modelFocus: () => this.modelFocus,
        modelFocusMode: this.modelFocusMode,
        focusTargets: () => this.resolveModelFocusTargets(),
        hasFocusTarget: (nodeId) => this.modelFocusTargetsOverride !== null
          ? this.modelFocusTargetsOverride.some(target => target.nodeId === nodeId)
          : this.options.hasModelFocusTarget?.(nodeId)
            ?? this.resolveModelFocusTargets().some(target => target.nodeId === nodeId),
        imageFocusTargetId: () => this.imageFocusStore.getTargetId(),
        imageFocus: () => this.imageFocusStore.get(),
        imageFocusPending: () => this.imageFocusStore.isPending(),
        imageViewportTarget: this.imageFocusStore.getViewportTarget,
        videoFocusTargetId: () => this.videoFocusStore.getTargetId(),
        videoFocus: () => this.videoFocusStore.get(),
        modelSceneOverride: (nodeId) => this.modelSceneOverrides.get(nodeId),
        contentRectRight: () => this.focusRectStore.contentRectRight(),
        focusRect: () => this.focusRectStore.get(),
        modelEditor: () => this.modelEditor,
        onGizmoFeedback: feedback => {
          if (this.modelEditor?.toolMode === "camera") this.setModelEditor({ ...this.modelEditor, feedback });
        },
        projectResidency: () => { projectResidency(); },
        onSurface: (surface) => { surfaceRef.current = () => surface; },
        onViewportForResidency: (viewport) => { viewportRef.current = () => viewport; },
        animationPlayback: () => this.animationPlaybackStore.current(),
        focusTransition: () => this.focusTransition.modelProgress(),
        runState: () => this.options.getRunState?.() ?? null,
        gestures: this.modelEditorGestures,
        onModelFocusChange: (projection) => {
          this.modelFocus = projection;
          this.emitModelFocus();
          // 聚焦投影变化只请求失效；同一帧的输入/媒体 tick 会合并进一次提交（design D2）。
          this.controllerInstance?.invalidate("model-focus");
        },
        onViewportChange: () => {
          this.viewportRevision += 1;
          for (const listener of this.viewportListeners) listener();
          this.options.onViewportChange?.(this.controllerInstance?.viewport() ?? { x: 0, y: 0, zoom: 1 });
        },
        onFrame: () => {
          for (const listener of this.frameListeners) listener();
        }
      })
    );
    controller.start();
    this.controllerInstance = controller;
    // 帧窗口只在挂载后开：没有 DOM canvas 就没有帧，先开窗会让 fps 的分母包含等待时间
    // （change: 2026-10-25-enhance-telemetry-performance-collection，design D4）。
    this.frameWindow?.dispose();
    this.frameWindow = installPerfFrameWindow();
    const unsubscribe = this.options.subscribeModelScenes(() => {
      // prepared resource 就绪/替换不改变画布对象，但会改变内容身份与可准入性。
      this.modelContentVersion += 1;
      controller.invalidate("model-scenes");
    });
    const unsubscribeTheme = this.options.subscribeTheme?.(() => controller.invalidate("theme"));
    const unsubscribeRunState = this.options.subscribeRunState?.(() => controller.flush());
    const unsubscribeMediaContent = this.options.mediaContent?.subscribe(() => controller.invalidate("media-content"));
    // 规范画布变化（目标删除/失效）也触发一次重算（任务 3.4）。
    const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => controller.invalidate("canvas-store"));
    let attached = true;
    const teardown = () => {
      if (!attached) return;
      attached = false;
      unsubscribe();
      unsubscribeTheme?.();
      unsubscribeRunState?.();
      unsubscribeMediaContent?.();
      disposeAttachedMedia();
      unsubscribeCanvas();
      // 卸载即关闭窗口：残留的定时器会在没有画布时继续聚合，发出与用户所见无关的样本。
      this.frameWindow?.dispose();
      this.frameWindow = null;
      controller.dispose();
      textureSync.dispose();
      videoSessions.dispose();
      compositeAssetMediaSessions.dispose();
      residency.dispose();
      this.compositeAssetMediaSessionsInstance = null;
      this.residencyInstance = null;
      if (this.controllerInstance === controller) this.controllerInstance = null;
      this.sceneSubmitted();
      this.modelFocus = null;
      this.modelFocusTargetsOverride = null;
      this.modelEditor = null;
      this.animationPlaybackStore.set(null);
      this.imageFocusStore.set(null);
      this.imageFocusStore.setTargetId(null);
      this.videoFocusStore.set(null);
      this.videoFocusStore.setTargetId(null);
      this.detach = null;
    };
    this.detach = teardown;
    return teardown;
  }

  cancelTransientGesture(): void {
    this.controllerInstance?.cancelTransientGesture();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach?.();
    this.frameWindow?.dispose();
    this.frameWindow = null;
    this.loadAbort.abort();
    this.runtimeInstance?.dispose();
    this.controllerInstance = null;
    this.runtimeInstance = null;
    this.mediaResources.dispose();
    this.videoLeases.dispose();
    this.publish({ phase: "booting", error: null });
    this.listeners.clear();
    this.viewportListeners.clear();
    this.frameListeners.clear();
    this.sceneListeners.clear();
  }

  private publish(status: CanvasRuntimeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}
