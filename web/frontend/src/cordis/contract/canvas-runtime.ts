/**
 * Canvas Runtime Service 契约（页面级渲染运行时句柄）。
 * 从 `contracts.ts` façade 拆分（change: 2026-09-28-split-frontend-god-plugins，task 1.5）。
 */
import type { BevyModelEditor, GhostRenderNode, ModelFocusProjection } from "@woohaa3/contracts";
import type { InteractionController } from "../plugins/canvas-shell/interaction-controller.js";
import type { BevyRuntime } from "../plugins/canvas-runtime/bevy-runtime.js";

export type WorldAnimationState = {
  nodeId: string | null;
  time: number;
  duration: number;
  playing: boolean;
  loop: boolean;
};

export type CanvasRuntimeStatus = { phase: "booting" | "ready" | "error"; error: string | null };

/** 上下文菜单瞬时状态（change: unify-canvas-presentation-navigation 后由 Canvas Navigation 持有）。 */
export type CanvasMenuState =
  | {
      screen: { x: number; y: number };
      world: { x: number; y: number; z?: number };
      nodeId: string | null;
      connectFrom?: { nodeId: string; nodeType: string };
    }
  | null;

export interface CanvasRuntimeService {
  getStatus(): CanvasRuntimeStatus;
  subscribe(listener: () => void): () => void;
  /** 装载 Bevy 运行时（幂等）。 */
  load(): Promise<BevyRuntime>;
  /** 挂载 DOM canvas：创建 interaction controller + texture sync；返回卸载函数。 */
  attach(canvas: HTMLCanvasElement): () => void;
  controller(): InteractionController | null;
  runtime(): BevyRuntime | null;
  /**
   * 页面内共享世界镜头捕获：按当前 canonical 输出尺寸在页面 Bevy App 内离屏渲染，返回 PNG。
   *
   * 与截图/历史缩略图共用 latest-wins 回读通道，内部串行；运行时未装载或渲染失败返回稳定 code。
   */
  captureWorldCamera?(input: {
    cameraId: string;
    width: number;
    height: number;
  }): Promise<{ ok: true; png: Uint8Array } | { ok: false; code: string }>;
  resourceResidencyDiagnostics?(): unknown;
  cancelTransientGesture(): void;
  /**
   * 最近一次有效画布指针的世界坐标（change: add-paste-import-workflows，design D6）。
   * 缺失时返回 null，调用方回退到本地视口中心。
   */
  lastPointerWorld(): { x: number; y: number } | null;
  /**
   * 把 client 坐标（`clientX/clientY`）换算成画布世界坐标。
   * 未挂载控制器时返回 null；不读写服务端 viewport。
   */
  clientToWorld(client: { x: number; y: number }): { x: number; y: number } | null;
  /**
   * 把世界坐标换算成 client 坐标（含 canvas 外框偏移）。
   * 供导入预览等瞬时 DOM overlay 定位；未挂载控制器时返回 null。
   */
  worldToClient(world: { x: number; y: number }): { x: number; y: number } | null;
  historyDotScreenPoint?(nodeId: string, operationId: string): { x: number; y: number; generation: number } | null;
  /**
   * 通用 drop target 查询（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
   * 未挂载控制器时返回 `unavailable`；调用方 MUST NOT 回退 TS 矩形几何。
   */
  queryDropTarget(point: { x: number; y: number }, excludedIds?: readonly string[]): import("../plugins/canvas-shell/interaction-core.js").InteractionQuery<string | null>;
  /** 本地视口版本号；随 pan/zoom 递增（供 overlay 用 useSyncExternalStore 重排）。 */
  viewportVersion(): number;
  subscribeViewport(listener: () => void): () => void;
  /** 每个画布刷新帧通知；用于需要跟随画布拖动的瞬时 DOM overlay。 */
  subscribeFrame?(listener: () => void): () => void;
  /** Read-only geometry invalidation after scene/position/view submission; no frame heartbeat. */
  sceneVersion?(): number;
  subscribeScene?(listener: () => void): () => void;
  /**
   * 单节点当前**屏幕矩形**（CSS px，含 canvas 外框偏移）
   * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
   *
   * 使用唯一本地视口与 working 拖动/改尺寸预览；未挂载控制器或节点不存在返回 null。
   * `part: "action-toolbar"` 返回 accepted 卡片矩形，世界对象/隐藏节点为空；
   * Web 动作栏据此锚定，不持久化横条位置、不建第二相机。
   */
  nodeScreenRect(nodeId: string, part?: "scope-title" | "panel" | "action-toolbar"): import("@woohaa3/contracts").ScreenRect | null;
  /** Accepted renderer presentation bounds, including collapse, ancestor drag previews and composite scopes. Hidden nodes return null. */
  nodePresentationScreenRect?(nodeId: string): import("@woohaa3/contracts").ScreenRect | null;
  /**
   * 上传中导入的幽灵节点（只渲染、不进规范状态；change: add-paste-import-workflows，design D7）。
   * 设为空数组即清除。实现负责触发一次 scene flush。
   */
  setGhostNodes(nodes: readonly GhostRenderNode[]): void;
  ghostNodes(): readonly GhostRenderNode[];
  /** 幽灵节点本地预览 URL（nodeId → object URL）；由导入服务写入，供纹理同步使用。 */
  setPreviewUrls(urls: ReadonlyMap<string, string>): void;
  /**
   * 以 canonical nodeId 直接进入聚焦（Canvas Navigation focus adapter 调用）
   * （change: unify-canvas-presentation-navigation）。
   */
  enterDirectFocus(nodeId: string): boolean;
  /** 是否仍有活动模型聚焦（Canvas Navigation focus adapter 用）。 */
  isFocused(): boolean;
  /**
   * 当前模型聚焦瞬时投影；未聚焦返回 null（change: add-model-focus-viewing，任务 3.4）。
   * 该投影不进入 ServerCanvas / CanvasCommand / Y.Doc。
   */
  modelFocusProjection(): ModelFocusProjection | null;
  /**
   * 订阅模型聚焦投影变化（进入/退出/相机移动）；供 overlay UI（如「返回」按钮与
   * 历史面板随聚焦关闭）用 `useSyncExternalStore` 重排。返回退订函数。
   */
  subscribeModelFocus(listener: () => void): () => void;
  /** 退出模型聚焦并恢复进入前的 2D 视口（无聚焦时 no-op）。 */
  exitModelFocus(): void;

  // --- 模型历史聚焦 owner / content rect / 本地快照覆盖（change: add-canvas-node-generation-history） ---
  /**
   * 应用完整 focus target transition（Canvas Navigation focus adapter）
   * （change: fix-model-focus-navigation-and-camera-parity，design D2）。
   */
  applyFocusTarget(
    target: import("../navigation/contracts.js").CanvasFocusTarget | null,
    transition: { preserveSession: boolean; restoreDirectCamera?: boolean }
  ): { ok: true } | { ok: false; reason: string };
  /** 有效图片焦点目标（adapter 目标校验；change: 图片聚焦编辑）。 */
  isImageFocusTargetValid(nodeId: string): boolean;
  /** 宿主推入有效图片焦点目标集合（change: 图片聚焦编辑）。 */
  setImageFocusTargets(nodeIds: readonly string[]): void;
  /** 当前图片聚焦投影；未聚焦返回 null（change: 图片聚焦编辑）。 */
  imageFocusProjection(): import("@woohaa3/contracts").BevyImageFocus | null;
  /** 由图片编辑 feature 推入/清除图片聚焦投影（change: 图片聚焦编辑）。 */
  setImageFocus(projection: import("@woohaa3/contracts").BevyImageFocus | null): void;
  /** 把图片取景作为画布输入的当前目标；返回注销函数。 */
  registerImageViewportTarget(target: import("../focus/types.js").FocusViewportTarget): () => void;
  setImageFocusTexture(texture: { nodeId: string; width: number; height: number; pixels: import("@woohaa3/contracts").ImagePixelSource } | null): void;
  setImageFocusDetails(frame:import("../plugins/canvas-runtime/focus-details.js").ImageFocusDetails|null):void;
  /**
   * 图片聚焦已进入、但编辑器还没接管画面（引擎或首帧未就绪）。
   *
   * 这段时间没有任何编辑面消费输入，画布仍必须可滚动/平移，因此滚轮与 Space 平移按普通
   * 画布处理（否则图片聚焦的“取景目标缺失”分支会把滚轮吃掉，表现为画布卡死）。
   * 首帧提交、退出聚焦或覆盖层卸载时清除。
   */
  setImageFocusPending(pending: boolean): void;
  /** 订阅图片聚焦投影变化（change: 图片聚焦编辑）。 */
  subscribeImageFocus(listener: () => void): () => void;
  /** 有效视频焦点目标（adapter 目标校验；change: 2026-10-10-add-video-node-focus-workspace）。 */
  isVideoFocusTargetValid(nodeId: string): boolean;
  /** 宿主推入有效视频焦点目标集合（change: 2026-10-10-add-video-node-focus-workspace）。 */
  setVideoFocusTargets(nodeIds: readonly string[]): void;
  /** 当前视频聚焦投影；未聚焦返回 null（change: 2026-10-10-add-video-node-focus-workspace）。 */
  videoFocusProjection(): import("@woohaa3/contracts").BevyVideoFocus | null;
  /** 由视频聚焦 feature 推入/清除视频聚焦投影（change: 2026-10-10-add-video-node-focus-workspace）。 */
  setVideoFocus(projection: import("@woohaa3/contracts").BevyVideoFocus | null): void;
  setVideoFocusTexture(texture: { nodeId: string; width: number; height: number; pixels: Uint8Array } | null): void;
  /** 订阅视频聚焦投影变化（change: 2026-10-10-add-video-node-focus-workspace）。 */
  subscribeVideoFocus(listener: () => void): () => void;
  /** 投影右侧实际占用区域（CSS content rect）；0 表示无遮挡。 */
  setContentRect(input: { right: number }): void;
  /**
   * Complete focus content rectangle; owned by the shared workspace
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D4：类型来自独立
   * 公共纯类型模块，runtime 服务契约不反向 import shell React 实现）。
   */
  setFocusContentRect(rect: import("../focus/types.js").FocusContentRect | null): void;
  focusContentRect(): import("../focus/types.js").FocusContentRect | null;
  subscribeFocusContentRect(listener: () => void): () => void;
  /**
   * Canvas Runtime scope 的**唯一**聚焦过渡时间源
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
   *
   * feature 通过该端口申请二维取景过渡；MUST NOT 自带独立 rAF/计时器。
   */
  focusTransitionPort(): import("../focus/media-transition.js").FocusTransitionPort;
  /**
   * 当前三维聚焦过渡公共进度快照
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
   *
   * 无活动三维过渡返回 null；由 Canvas Runtime 每帧投影进渲染快照，Rust 据此求值相机姿态，
   * 不再独立计时。图片/视频二维聚焦不经此通道（保持单一驱动）。
   */
  focusTransitionProgress(): import("@woohaa3/contracts").BevyFocusTransition | null;
  /**
   * 有界媒体资源 store：以稳定来源 identity 取得共享 CPU 位图 lease
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D8/D9，任务 4.1）。
   *
   * 由 Canvas Runtime scope 唯一持有；feature（图片/视频 editor）通过 lease 复用已解码位图，
   * 不各自持有解码器。MUST NOT 暴露 store 内部缓存结构（仅返回 lease 句柄）。
   * 未挂载/解码失败返回 null；调用方保留上一合法表示。
   */
  acquireMediaBitmap(
    source: import("../focus/media-resources.js").FocusMediaSource,
    pin?: string
  ): Promise<import("../focus/media-resources.js").FocusMediaLease | null>;
  /** 丢弃某来源缓存（换源/设备恢复）；无引用时关闭位图。 */
  invalidateMediaSource(key: string): void;
  /**
   * 取得某视频来源的独占 consumer lease
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D10，任务 5.1）。
   *
   * canonical direct/history 来源的隐藏解码元素由 Canvas Runtime 唯一持有；卡片与聚焦通过该
   * lease 接管同一来源，不各自创建第二个解码器。已有 consumer 持有时返回 null（不抢占）；
   * 片场内部视频不进入本 registry。
   */
  acquireVideoLease(
    identity: import("../plugins/canvas-runtime/video-lease-registry.js").VideoSourceIdentity,
    quality?: import("../plugins/canvas-runtime/video-lease-registry.js").VideoQuality,
    pin?: string
  ): import("../plugins/canvas-runtime/video-lease-registry.js").VideoLease | null;
  /** 丢弃某视频来源（删除/换源/设备恢复）。 */
  invalidateVideoSource(identity: import("../plugins/canvas-runtime/video-lease-registry.js").VideoSourceIdentity): void;
  /** 设置/清除本地已校验模型 Scene IR snapshot override（只影响聚焦 ModelRoot，不写规范状态）。 */
  setModelSceneOverride(input: { nodeId: string; override: { version: string; ops: readonly unknown[] } | null }): void;
  /** 读取本地已校验模型 Scene IR override（供聚焦目标解析合并）。 */
  modelSceneOverride(nodeId: string): { version: string; ops: readonly unknown[] } | null;
  /** 当前模型历史聚焦 owner 的 nodeId；无则 null。 */
  historyFocusNodeId(): string | null;
  /**
   * 当前聚焦编辑模式（change: 对齐 xyflow-bevy 历史只读浏览）。
   * 历史 owner 活跃返回 `"history"`（只读），否则 `"edit"`。
   */
  modelFocusMode(): "edit" | "history";
  /**
   * 推入/清除当前模型编辑 gizmo 与镜头工具瞬时态
   * （change: add-model-editor-gizmo-shot-capture）。
   */
  setModelEditor(editor: BevyModelEditor | null): void;
  /** 当前编辑 gizmo 瞬时态；无编辑返回 null。 */
  modelEditorState(): BevyModelEditor | null;
  /**
   * 推入/清除活动动画节点播放瞬时投影
   * （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
   *
   * 由持有动画播放会话的插件提供；传 null 表示无活动动画节点。实现负责触发一次 scene flush。
   */
  setAnimationPlayback(playback: import("@woohaa3/contracts").BevyAnimationPlayback | null): void;
  /** Selected director playback, browser-local and independent of assistant execution. */
  worldAnimationState(): WorldAnimationState;
  subscribeWorldAnimation(listener: () => void): () => void;
  playWorldAnimation(): void;
  pauseWorldAnimation(): void;
  seekWorldAnimation(time: number): void;
  setWorldAnimationLoop(loop: boolean): void;
  /** 当前活动动画节点播放投影；无则 null。 */
  animationPlaybackState(): import("@woohaa3/contracts").BevyAnimationPlayback | null;
  /**
   * 片场唯一播放头通知（change: 2026-10-08-make-film-set-model-only）。
   *
   * 由动画播放控制器每帧调用；只把时间转给片场媒体会话，不改变动画投影。
   */
  notifyAnimationTime?(input: { nodeId: string | null; time: number; playing: boolean }): void;
  /**
   * 模型编辑 gizmo 命中与轴拖动约束（Bevy WASM 相机/bounds 事实源）
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.4）。
   */
  queryGizmoHit(
    input: import("../plugins/canvas-shell/model-gizmo-hit.js").GizmoQueryInput
  ): import("../plugins/canvas-runtime/bevy-runtime.js").GizmoHitResult | null;
  /**
   * 注入/替换镜头 pose 手势处理器
   * （change: add-model-editor-gizmo-shot-capture）。
   */
  setModelEditorShotGesture(
    handler: import("../plugins/canvas-shell/interaction-controller.js").InteractionControllerOptions["shotGesture"] | null
  ): void;
  /**
   * 注入/替换镜头焦点三轴位移手势处理器
   * （change: 模型编辑 gizmo 焦点 / replace-model-node-focus-interactions）。
   */
  setModelEditorFocusGesture(
    handler: import("../plugins/canvas-shell/interaction-controller.js").InteractionControllerOptions["focusGesture"] | null
  ): void;
  /**
   * 注入主画面滚轮/捏合：直接编辑且有选中镜头时改镜头 distance。
   */
  setShotWheel(
    handler: import("../plugins/canvas-shell/interaction-controller.js").InteractionControllerOptions["shotWheel"] | null
  ): void;
  /**
   * 注入/替换拖动吸附策略（内置插件 `alignment-guides`；传 null 关闭吸附）。
   *
   * 策略只做几何求解，宿主负责在拖动预览里叠加位移与绘制参考线。
   */
  setAlignmentSnapPolicy?(policy: import("./alignment-snap.js").AlignmentSnapPolicy | null): void;
  /** 当前拖动的辅助对齐线（世界坐标）；未挂载或不在拖动中时为空。 */
  alignmentGuides?(): readonly import("./alignment-snap.js").AlignmentGuide[];
  /** 参考线版本号；内容变化才递增（供覆盖层决定是否重绘）。 */
  alignmentGuidesVersion?(): number;
  /** 当前已接受的 interaction generation（供对象 picking 的 generation 守卫）。 */
  interactionGeneration(): number;
  /**
   * 暂停活动动画播放头（编辑对象前调用；change: 2026-10-09-add-film-set-object-motion-and-editing）。
   * 无活动播放或未接线时为 no-op。
   */
  pauseAnimation?(): void;
  /** 动画播放插件注册暂停钩子（对象编辑前暂停）。 */
  setAnimationPauseSink(sink: (() => void) | null): void;
}
