/**
 * 交互控制器类型契约
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-controller 拆出）。
 */
import type {
  BevyModelEditor,
  CanvasRenderScene,
  ModelFocusProjection,
  AppThemeSnapshot,
  CanvasCommand
} from "@woohaa3/contracts";
import type { Point } from "./hit-test.js";
import type { TextureUploader } from "../canvas-runtime/texture-sync.js";
import type { VideoFrameSessions } from "../canvas-runtime/video-frame-session.js";
import type { CanvasSession } from "../../services/canvas-session.js";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";

/**
 * 运行状态投影输入
 * （change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
 *
 * 有界：`summaries` 每节点一条；`records` 是有界操作记录集合；`currentOperationByNode` 把
 * “当前生效版本”对应的操作身份映射到圆点装饰（由 node-history 插件提供，缺失时不装饰）。
 */
export type RunStateProjectionInput = import("./run-state-projection.js").NodeRunStateProjection;

export type InteractionControllerOptions = {
  nodeCapabilities?: import("../../../extension-api/node-implementations.js").NodeImplementationRegistry;
  mediaContent?: import("../../../extension-api/media-content.js").MediaContentService;
  canvas: HTMLCanvasElement;
  getRuntime: () => BevyRuntime | null;
  getSession: () => CanvasSession | null;
  /**
   * 每节点不可变 prepared model resource（change: optimize-model-scene-snapshot-hot-path）。
   * 快照只引用 resourceKey；controller 把它交给 runtime 先注册后提交。
   */
  getModelResources?: () => ReadonlyMap<string, import("@woohaa3/contracts").PreparedModelResource>;
  isModelLoading?: (nodeId: string) => boolean;
  /** Resolve the current loading provider once per scene build, allowing late registration/reload. */
  getModelLoading?: () => ((nodeId: string) => boolean) | undefined;
  /**
   * 当前主题 snapshot（change: unify-application-theme-tokens，design D4）。
   * 缺省用内置默认主题；非法值由 buildCanvasRenderScene 拒绝。
   */
  getTheme?: () => AppThemeSnapshot;
  onScene?: (scene: CanvasRenderScene) => void;
  onSceneSubmitted?: () => void;
  target?: Window & typeof globalThis;
  isWritable?: () => boolean;
  /**
   * 结构动作经页面编辑历史（可撤销）
   * （change: 2026-10-09-improve-canvas-workflow，任务 1.5）。
   * 缺省时回退到直接提交（保持单测/最小 fixture 可用）。
   */
  onEditCommands?: (commands: readonly CanvasCommand[], label: string) => void | Promise<void | { ok: boolean; entry?: { state: string } }>;
  /**
   * 指针手势派发错误出口（提交/回调失败时）。缺省静默；输入层始终复位手势，绝不卡死。
   * （change: 2026-10-09-improve-canvas-workflow）
   */
  onInteractionError?: (error: unknown) => void;
  /**
   * 采用过渡动画的视口平移时长（毫秒）；0 或负值表示瞬时。
   * change: 2026-10-09-improve-canvas-workflow，任务 4.1：定位作品平滑居中。
   */
  viewportTransitionMs?: number;
  /**
   * Ctrl/⌘+F：主画布拥有输入且无编辑器/模态/菜单阻止时请求打开「查找作品」
   * （change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
   */
  onFindRequest?: () => void;
  /**
   * 撤销/重做快捷键路由（change: 2026-10-09，任务 1.7）。输入框/聚焦编辑器优先，
   * 只有主画布拥有输入时到达这里。
   */
  onUndoRequest?: () => void;
  onRedoRequest?: () => void;
  /** 可注入的纹理上传器（测试用）；缺省从 runtime 创建。 */
  textureSync?: TextureUploader;
  /**
   * 每帧资源需求投影（change: 2026-10-23-scale-canvas-media-residency，design D1/D2）。
   *
   * 必须在纹理/视频/片场媒体 `sync()` **之前**执行：先准入再创建。
   */
  projectResidency?: () => void;
  /** 本帧 surface 尺寸变化（供资源协调器按物理尺寸选缩略图档）；缺省不通知。 */
  onSurface?: (surface: { width: number; height: number; pixelRatio: number }) => void;
  /** 本帧已接受视口（资源需求投影与缩略图档位用）；缺省不通知。 */
  onViewportForResidency?: (viewport: { x: number; y: number; zoom: number }) => void;
  /** 画布 ID；本地视口按它记忆（各浏览器独立）。 */
  canvasId?: string;
  /**
   * 双击携带图片的节点时请求 media-preview。
   *
   * change: add-frontend-dialog-system —— 只报告 canonical 命中的资产身份，由宿主通过
   * Dialog Host 打开；控制器不再直接传 URL 或渲染弹窗（design D8）。
   */
  onImagePreview?: (request: { assetId: string; nodeId: string; title: string }) => void;
  /** 双击文本节点时请求宿主按当前 canonical 内容打开 Markdown 预览。 */
  onTextPreviewIntent?: (request: { nodeId: string }) => void;
  /**
   * 双击命中 canonical ready 图片节点时请求进入**图片聚焦工作区**
   * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D1/D2）。
   *
   * 只传稳定 canonical nodeId；建立 focus identity 由 Canvas Navigation 负责。缺省时回落到
   * `onImagePreview`（保持既有媒体 Dialog 行为，测试用）。
   */
  onImageFocusIntent?: (request: { nodeId: string }) => void;
  /**
   * 双击命中 canonical ready 视频节点时请求进入**视频聚焦工作区**
   * （change: 2026-10-10-add-video-node-focus-workspace）。
   *
   * 只传稳定 canonical nodeId；建立 focus identity 由 Canvas Navigation 负责。缺省时回落到
   * `onVideoFrameCapture`（保持既有截帧 Dialog 行为，测试用）。
   */
  onVideoFocusIntent?: (request: { nodeId: string }) => void;
  /**
   * 双击命中 video 节点时请求截帧（change: enable-video-node-live-preview，design D6）。
   * 只传 `nodeId`；解析节点自身 ready 输出与打开 Dialog 由 Task Execution Plugin 负责。
   */
  onVideoFrameCapture?: (request: { nodeId: string }) => void;
  /**
   * 视频帧会话（change: enable-video-node-live-preview，design D3）。
   * 缺省为 null 时不驱动 hover 播放。
   */
  videoSessions?: VideoFrameSessions | null;
  /**
   * modal 门禁（design D6）：返回 true 时画布不开始任何手势、快捷键、paste 或 wheel 缩放。
   * 缺省恒为 false（无弹窗），保持既有行为。
   */
  isModalActive?: () => boolean;
  /**
   * 聚焦相机输入门禁（change: fix-model-focus-navigation-and-camera-parity，design D6）。
   *
   * 聚焦期间只有真正的 modal Dialog 才阻断主观察相机缩放/观察；非模态 editor/history panel
   * 与菜单不阻断。缺省回退到 `isModalActive`（保持既有行为）。
   */
  isFocusInputBlocked?: () => boolean;
  /**
   * 右键短点击（位移 < 10 CSS px）时打开上下文菜单；右键拖拽（≥ 10px）改为平移，
   * 不回调。`node` 为命中的规范节点（命中空白/边时为 `null`）。
   */
  onContextMenu?: (request: { screen: Point; world: Point; node: { nodeId: string } | null }) => void;
  /**
   * 从输出端口拉线释放到空白处：打开「生成 X」菜单。`sourceNodeId` 是拉线起点，
   * `world` 是释放位置的世界坐标（新节点插入处）。
   */
  onConnectToEmpty?: (request: {
    screen: Point;
    world: Point;
    sourceNodeId: string;
    sourceNodeType: string;
  }) => void;
  /**
   * 本地视口变化回调（pan/zoom/commit）。供瞬时 DOM overlay（导入预览）重新定位；
   * 不写服务端 viewport。按帧节流，只在视口实际变化时触发。
   */
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  /** 每次画布刷新帧回调；供与渲染节奏同步的瞬时 overlay 使用。 */
  onFrame?: () => void;
  /**
   * 上传中的幽灵节点（只渲染，不进规范状态；change: add-paste-import-workflows）。
   * 由 canvasRuntime 持有，buildScene 每帧读取并合并。
   */
  getGhostNodes?: () => readonly import("@woohaa3/contracts").GhostRenderNode[];
  /**
   * 点击节点右上角历史动作（change: add-canvas-node-generation-history，任务 3.1）。
   * 只传 canonical nodeId；打开历史面板不改变 selection、不提交 Canvas 命令。
   */
  onNodeHistory?: (request: { nodeId: string }) => void;
  onNodeHistorySelect?: (request: { nodeId: string; index?: number; step?: number; presentationId?: string; entryId?: string; operationId?: string; viewOnly?: boolean }) => void;
  /**
   * 顶部操作横条动作命中（change: 2026-10-13-add-node-to-film-set-shortcut）。
   * 横条由 Bevy 绘制、Rust 命中；宿主据 `actionId`（= 贡献 id）派发，`menu` 为设置箭头。
   */
  onNodeAction?: (request: { nodeId: string; actionId: string; menu: boolean }) => void;
  /**
   * 每帧下发给 render scene 的节点横条描述（change: 2026-10-13-add-node-to-film-set-shortcut）。
   * 缺省/空表示本帧不绘制任何横条；由宿主从 `canvas.node-action` 贡献的 `describe` 聚合。
   */
  getNodeActionToolbars?: () => ReadonlyMap<string, import("@woohaa3/contracts").BevyNodeActionsPresentation>;
  /**
   * 当前所有可聚焦模型目标（change: add-model-focus-viewing，任务 3.1；design D1/D3）。
   * 由宿主从 model-scene provider + canonical/working 画布解析；空数组表示无模型。
   */
  getModelFocusTargets?: () => readonly import("./model-focus-session.js").FocusTargetInput[];
  hasModelFocusTarget?: (nodeId: string) => boolean;
  /**
   * 模型聚焦变化（进入 / 相机更新 / 退出）。回调收到的 `null` 表示回到普通正交画布。
   * 控制器只上报浏览器本地状态；宿主据此 flush 渲染快照。
   */
  onModelFocusChange?: (projection: ModelFocusProjection | null) => void;
  /**
   * 模型聚焦入口 intent（change: unify-canvas-presentation-navigation，design D7）。
   * 双击进入 / Escape 退出统一走 Canvas Navigation；缺省时回落到直接控制器调用（测试）。
   */
  onModelFocusIntent?: (intent: { type: "enter"; nodeId: string; kind?: "model" | "extension" } | { type: "exit" }) => void;
  /**
   * 聚焦目标/runtime projection 失效上报（change: fix-model-focus-navigation-and-camera-parity，D5）。
   * runtime/host 据此请求 Canvas Navigation 原子收敛（不再由 selection 直接退出）。
   */
  onModelFocusInvalid?: (reason: string) => void;
  /**
   * 当前聚焦投影（供宿主在 buildScene 时读取）；缺省恒为 `null`（普通画布）。
   */
  getModelFocus?: () => ModelFocusProjection | null;
  getModelFocusMode?: () => "edit" | "history";
  /**
   * 当前图片聚焦投影（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
   * 缺省恒为 `null`（普通画布）。
   */
  isImageFocused?: () => boolean;
  getImageFocus?: () => import("@woohaa3/contracts").BevyImageFocus | null;
  /**
   * 图片聚焦已进入、编辑器却还没接管画面（引擎/首帧未就绪）。
   * 此时没有编辑面消费输入，滚轮与 Space 平移按普通画布处理，画布不会被"聚焦取景目标缺失"吃掉。
   */
  isImageFocusPending?: () => boolean;
  getImageViewportTarget?: () => import("../../focus/types.js").FocusViewportTarget | null;
  /**
   * 当前视频聚焦投影（change: 2026-10-10-add-video-node-focus-workspace）。
   * 缺省恒为 `null`（普通画布）。
   */
  isVideoFocused?: () => boolean;
  getVideoFocus?: () => import("@woohaa3/contracts").BevyVideoFocus | null;
  /**
   * 当前节点本地已校验模型 Scene IR snapshot override
   * （change: add-canvas-node-generation-history，任务 4.3）。
   */
  getModelSceneOverride?: (nodeId: string) => { version: string; ops: readonly unknown[] } | null;
  /**
   * 右侧实际占用区域（CSS content rect）；`right` 为 0 表示无遮挡。
   * 用于按未遮挡左侧区域取景（design D7）。
   */
  getContentRect?: () => { right: number };
  getFocusContentRect?: () => import("../../focus/types.js").FocusContentRect | null;
  /**
   * 统一生成运行状态快照（change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
   *
   * 返回按 `(canvasId,nodeId)` 索引的已归约运行摘要、有界操作记录集合，以及可选“当前版本”
   * 操作身份映射（`nodeId -> operationId`，由 node-history 插件提供）。缺省时不投影历史条与
   * 聚合遮罩。全部为浏览器本地派生状态，不进入 ServerCanvas / Y.Doc。
   */
  getRunState?: () => RunStateProjectionInput | null;
  projectHistoryCanvas?: (canvas: import("@woohaa3/contracts").ServerCanvas | null) => import("@woohaa3/contracts").ServerCanvas | null;
  /**
   * 模型编辑 gizmo/镜头工具瞬时态（change: add-model-editor-gizmo-shot-capture）。
   * 缺省/返回 null 时不绘制编辑 gizmo。由宿主从编辑会话与聚焦目标派生。
   */
  getModelEditor?: () => BevyModelEditor | null;
  onGizmoFeedback?: (feedback: import("@woohaa3/contracts").GizmoFeedback) => void;
  /**
   * 活动动画节点播放瞬时投影
   * （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
   *
   * 由持有动画播放会话的宿主提供；缺省/返回 null 时表示当前无活动动画节点。控制器只把它
   * 投影进快照，不持有播放时钟。
   */
  getAnimationPlayback?: () => import("@woohaa3/contracts").BevyAnimationPlayback | null;
  /**
   * 公共聚焦过渡进度
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
   *
   * 由 Canvas Runtime coordinator 提供；携带时 Rust 三维聚焦相机按该进度求值，不再独立计时。
   * 缺省/返回 null 时不发送（Rust 回退既有内部计时）。只承载浏览器本地呈现态。
   */
  getFocusTransition?: () => import("@woohaa3/contracts").BevyFocusTransition | null;
  /**
   * 镜头 pose gizmo 手势（change: add-model-editor-gizmo-shot-capture，任务 3.2）。
   *
   * 命中 shot gizmo 时由控制器读取/推进/结束镜头 pose；实际提交由宿主的编辑会话负责。
   * 缺省时不处理镜头手势。
   */
  shotGesture?: {
    /** 命中 handle 时开始手势；返回是否已开始。 */
    begin(handle: "orbit-ring" | "elevation-ring" | "distance", point: { x: number; y: number }): boolean;
    /** 推进手势。 */
    move(handle: "orbit-ring" | "elevation-ring" | "distance", point: { x: number; y: number }): void;
    /** 结束手势（提交净变化）。 */
    end(): void;
    /** 取消手势（丢弃 preview，不提交）。 */
    cancel(): void;
  };
  /**
   * 镜头焦点三轴位移 gizmo 手势（change: 模型编辑 gizmo 焦点 / replace-model-node-focus-interactions）。
   *
   * 命中焦点 gizmo 的 X/Y/Z 轴时由控制器读取/推进/结束 `focusOffset`；实际 preview 与提交由
   * 宿主的编辑会话负责。缺省时不处理焦点手势。
   */
  focusGesture?: {
    /** 命中轴时开始手势；返回是否已开始。 */
    begin(axis: "x" | "y" | "z" | "center", point: { x: number; y: number }): boolean;
    /** 推进手势（当前指针屏幕坐标）。 */
    move(axis: "x" | "y" | "z" | "center", point: { x: number; y: number }): void;
    /** 结束手势（提交净变化）。 */
    end(): void;
    /** 取消手势（丢弃 preview，不提交）。 */
    cancel(): void;
  };
  /**
   * 选中镜头占主画面时的滚轮与捏合（change: drive-focus-view-from-shot-rig）。
   * 只改当前镜头 distance；不改聚焦相机。
   */
  shotWheel?: {
    wheel(deltaY: number, deltaMode: number): void;
    scaleBegin(): void;
    scale(scale: number): void;
    scaleEnd(): void;
  };
};

export type InteractionController = {
  start(): void;
  dispose(): void;
  flush(): void;
  /**
   * 请求失效（唯一调度账本入口，change: 2026-10-10-optimize-canvas-interaction-hot-path，D2）。
   * Store/模型/主题/媒体/资源/输入只合并 dirty flags，不强制同步构建；由下一帧统一结算。
   */
  invalidate(reason?: string): void;
  surface(): { width: number; height: number; pixelRatio: number; originX?: number; originY?: number };
  /** 在当前基础上按因子缩放（以画布中心为锚点）并提交。 */
  zoomBy(factor: number): void;
  /** 缩放到指定 zoom（以画布中心为锚点）并提交。 */
  zoomTo(zoom: number): void;
  /** 缩放到适合内容（节点包围盒），无节点时回到 100%。 */
  zoomToFit(): void;
  /** 当前规范视口。 */
  viewport(): { x: number; y: number; zoom: number };
  /**
   * 最近一次有效画布指针的世界坐标（change: add-paste-import-workflows，design D6）。
   * 缺失（从未在画布上移动指针）时返回 null。
   */
  lastPointerWorld(): { x: number; y: number } | null;
  /**
   * 最近一次快照提交失败原因；成功或未失败时为 null
   * （change: fix-viewport-zoom-range）。单帧失败不影响后续帧与输入。
   */
  renderError(): string | null;
  /**
   * 订阅本地视口变化（捏合/滚轮/平移/按钮）；返回退订函数
   * （change: fix-viewport-zoom-range）。宿主缩放读数据此跟进。
   */
  subscribeViewport(listener: () => void): () => void;
  /**
   * client 坐标 → 世界坐标（与 pointerWorld 同一换算：减去 canvas 外框偏移，再按本地视口缩放）。
   * 供 drop/paste 锚点使用，不读写服务端 viewport。
   */
  clientToWorld(client: { x: number; y: number }): { x: number; y: number };
  /**
   * 世界坐标 → client 坐标（含 canvas 外框偏移）。供导入预览等瞬时 DOM overlay 定位，
   * 不读写服务端 viewport。
   */
  worldToClient(world: { x: number; y: number }): { x: number; y: number };
  historyDotScreenPoint?(nodeId: string, operationId: string): { x: number; y: number; generation: number } | null;
  /**
   * 通用 drop target 查询（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
   * 按 accepted snapshot 固定最上层实际节点（排除来源）；`ok:false` 时调用方 MUST NOT 回退
   * TS 矩形几何或提交移动。
   */
  queryDropTarget(point: { x: number; y: number }, excludedIds?: readonly string[]): import("./interaction-core.js").InteractionQuery<string | null>;
  /**
   * 取消尚未提交的瞬时画布交互（modal 从空变非空时由宿主调用，design D6）。
   */
  cancelTransientGesture(): void;
  /** 当前模型聚焦投影；未聚焦返回 null（change: add-model-focus-viewing，任务 3.4）。 */
  focusProjection(): ModelFocusProjection | null;
  /** 退出模型聚焦并恢复进入前的 2D 视口（无聚焦时为 no-op）。 */
  exitModelFocus(): void;
  /** 是否处于模型聚焦查看。 */
  isModelFocused(): boolean;
  /**
   * 以 canonical nodeId 请求进入聚焦（历史 owner 用）
   * （change: add-canvas-node-generation-history，任务 4.1）。目标不合法返回 false。
   */
  enterModelFocusForNode(nodeId: string): boolean;
  /** 更新右侧遮挡宽度，按未遮挡左侧区域重新取景（任务 4.2）。 */
  setContentRect(rect: { right: number; left?: number; top?: number; bottom?: number }): void;
  restoreViewport(viewport: { x: number; y: number; zoom: number }): void;
  /**
   * 带动画地平移到目标视口（保持传入 zoom）。尊重减少动态效果偏好；duration 为 0 时瞬时。
   * change: 2026-10-09-improve-canvas-workflow，任务 4.1。
   */
  panViewportTo(viewport: { x: number; y: number; zoom: number }, options?: { durationMs?: number }): void;
  /**
   * 按当前本地 Scene IR override 重新取景聚焦目标
   * （change: add-canvas-node-generation-history，任务 4.3）。
   */
  reframeModelFocus(nodeId: string): void;
  setFocusedModelView(view: "perspective" | "front" | "top" | "right"): void;
  zoomFocusedModel(factor: number): void;
  /**
   * 注入/替换镜头 pose 手势处理器（change: add-model-editor-gizmo-shot-capture）。
   */
  setShotGesture(handler: InteractionControllerOptions["shotGesture"] | null): void;
  /**
   * 注入/替换镜头焦点三轴位移手势处理器（change: 模型编辑 gizmo 焦点）。
   */
  setFocusGesture(handler: InteractionControllerOptions["focusGesture"] | null): void;
  /**
   * 注入/替换主画面滚轮与捏合对镜头 distance 的处理。
   */
  setShotWheel(handler: InteractionControllerOptions["shotWheel"] | null): void;
  /**
   * 应用完整 focus target transition（Canvas Navigation focus adapter）
   * （change: fix-model-focus-navigation-and-camera-parity，design D2）。
   */
  applyFocusTarget(
    target: import("../../navigation/contracts.js").CanvasFocusTarget | null,
    transition: { preserveSession: boolean; restoreDirectCamera?: boolean }
  ): { ok: true } | { ok: false; reason: string };
  /**
   * 把某个 canonical 节点设为唯一 selection（供活动栈「定位节点」等宿主入口）
   * （change: 2026-09-29-add-canvas-task-activity-feed，任务 3.2）。
   * 只改本地 selection，不写 Y.Doc；节点不存在时返回 false。
   */
  selectNode(nodeId: string): boolean;
  /**
   * 节点当前**屏幕矩形**（CSS px，含 canvas 外框偏移）
   * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
   *
   * 优先使用 working 拖动/改尺寸预览，其次规范绝对坐标与节点尺寸，经唯一本地视口换算；
   * 不写状态、不建第二套相机。节点不存在时返回 null。供节点顶部操作横条锚定。
   */
  nodeScreenRect(nodeId: string): import("@woohaa3/contracts").ScreenRect | null;
};

export type Gesture =
  | { kind: "none" }
  | { kind: "history-press"; pointerId: number; nodeId: string; presentationId: string; startScreen: Point }
  | { kind: "model-preview"; pointerId: number; nodeId: string; last: Point }
  | { kind: "pan"; pointerId: number; last: Point }
  | { kind: "right-press"; pointerId: number; start: Point; startScreen: Point; nodeId: string | null; moved: boolean }
  | {
      kind: "drag";
      pointerId: number;
      start: Point;
      origins: Map<string, { x: number; y: number }>;
      moved: boolean;
      /**
       * 单节点拖动中的 Q/E 触碰粘连子状态
       * （change: add-drag-touch-connections，design D1）。
       * 只有开始时活动选择恰为一个可连接非 group 节点且会话可写才创建。
       */
      attach?: import("./drag-attach.js").DragAttachState;
    }
  | {
      kind: "resize";
      pointerId: number;
      nodeId: string;
      start: Point;
      originWidth: number;
      originHeight: number;
      moved: boolean;
    }
  | { kind: "connect"; pointerId: number; source: string; side: "input" | "output" }
  | {
      kind: "aggregate-connect";
      pointerId: number;
      direction: "input" | "output";
      /** 展开后的成员节点 id。 */
      members: string[];
      /** 拖拽中的指针世界坐标。 */
      cursor: Point;
      /** 拖拽中命中的待提交边预览。 */
      pendingEdges: Array<{ id: string; source: string; target: string }>;
    }
  | { kind: "marquee"; pointerId: number; start: Point; current: Point };
