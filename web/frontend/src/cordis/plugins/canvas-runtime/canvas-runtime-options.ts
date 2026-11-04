/**
 * Canvas Runtime 宿主装配契约（从 `host.ts` 抽出以保持文件体积守卫；
 * change: 2026-10-08-integrate-render-performance-and-model-preview 合并后 host 增长）。
 *
 * 只承载宿主注入选项与空场景兜底；`CanvasRuntimeHost` 的实现仍在 `host.ts`。
 */
import type { BevyRuntime } from "./bevy-runtime.js";
import { type FocusTargetInput } from "../canvas-shell/model-focus-session.js";
import { type AppThemeSnapshot } from "@woohaa3/contracts";

export type CanvasRuntimeOptions = {
  projectHistoryCanvas?: (canvas: import("@woohaa3/contracts").ServerCanvas | null) => import("@woohaa3/contracts").ServerCanvas | null;
  canvasId: string;
  nodeCapabilities?: import("../../../extension-api/node-implementations.js").NodeImplementationRegistry;
  mediaContent?: import("../../../extension-api/media-content.js").MediaContentService;
  getSession: () => import("../../contracts.js").CanvasSession | null;
  /** 每节点不可变 prepared model resource（change: optimize-model-scene-snapshot-hot-path）。 */
  getModelResources?: () => ReadonlyMap<string, import("@woohaa3/contracts").PreparedModelResource>;
  isModelLoading?: (nodeId: string) => boolean;
  /** Resolve the current loading provider once per scene build, allowing late registration/reload. */
  getModelLoading?: () => ((nodeId: string) => boolean) | undefined;
  /**
   * 当前可聚焦模型目标（change: add-model-focus-viewing，任务 3.1）。
   * 由宿主从 model-scene provider + canonical/working 画布解析；缺省无模型。
   */
  getModelFocusTargets?: () => readonly FocusTargetInput[];
  hasModelFocusTarget?: (nodeId: string) => boolean;
  /** 订阅 model scene 变化；返回退订函数（控制器据此 flush）。 */
  subscribeModelScenes: (listener: () => void) => () => void;
  /** 当前主题 snapshot（change: unify-application-theme-tokens）。 */
  getTheme?: () => AppThemeSnapshot;
  /** 订阅主题变化；控制器据此在仅主题变化时重新 flush scene。 */
  subscribeTheme?: (listener: () => void) => () => void;
  /**
   * Ctrl/⌘+F：主画布请求打开「查找作品」
   * （change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
   */
  onFindRequest?: () => void;
  /** 撤销/重做快捷键路由（change: 2026-10-09，任务 1.7）。 */
  onUndoRequest?: () => void;
  onRedoRequest?: () => void;
  /**
   * 结构动作经页面编辑历史（可撤销）
   * （change: 2026-10-09-improve-canvas-workflow，任务 1.5）。
   */
  onEditCommands?: (commands: readonly import("@woohaa3/contracts").CanvasCommand[], label: string) => void | Promise<void>;
  /**
   * 共享世界镜头的权威保存端口，供视锥拖动释放时提交位姿（见 `world-camera-drag.ts`）。
   * 缺省时镜头仍可选中、可看视锥，但不能拖动位姿。
   */
  saveWorldCamera?: import("../canvas-shell/world-camera-gesture.js").WorldCameraSavePort["save"];
  /** 镜头拖动时同步移动卡片。 */
  moveWorldCameraCard?: import("../canvas-shell/world-camera-gesture.js").WorldCameraGestureDeps["moveCard"];
  /** 页面编辑历史的 `recordExternal` 入口（镜头位姿撤销/重做）。 */
  recordExternal?: NonNullable<import("../canvas-shell/interaction-types.js").InteractionControllerOptions["recordExternal"]>;
  /** 指针手势提交/回调错误出口（输入层仍复位手势，不卡死）。 */
  onInteractionError?: (error: unknown) => void;
  isModalActive: () => boolean;
  /** 聚焦相机输入门禁（只有真正 modal 阻断；change: fix-model-focus-navigation-and-camera-parity）。 */
  isFocusInputBlocked?: () => boolean;
  /**
   * 每帧节点顶部操作横条描述（change: 2026-10-13-add-node-to-film-set-shortcut）。
   * 由宿主从 `canvas.node-action` 贡献聚合；缺省/空则不绘制横条。
   */
  getNodeActionToolbars?: () => ReadonlyMap<string, import("@woohaa3/contracts").BevyNodeActionsPresentation>;
  /** 顶部操作横条命中回传（`actionId` = 贡献 id；`menu` 为独立设置箭头）。 */
  onNodeAction?: (hit: { nodeId: string; actionId: string; menu: boolean }) => void;
  /** 本地视口变化（pan/zoom）；供瞬时 overlay 重排。 */
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  /**
   * 上下文菜单 intent（change: unify-canvas-presentation-navigation，design D6）。
   * 由 canvas-runtime 转发给 Canvas Navigation；不再由 runtime 保存 menuState。
   */
  onMenuIntent?: (intent: { screen: { x: number; y: number }; world: { x: number; y: number; z?: number }; nodeId: string | null; connectFrom?: { nodeId: string; nodeType: string } }) => void;
  /**
   * 模型聚焦入口/退出 intent（change: unify-canvas-presentation-navigation，design D7）。
   * 双击、返回按钮与 Escape 统一经 Canvas Navigation；目标校验由 adapter 完成。
   */
  onModelFocusIntent?: (intent: { type: "enter"; nodeId: string; kind?: "model" | "extension" } | { type: "exit" }) => void;
  /**
   * 聚焦目标/runtime projection 失效（change: fix-model-focus-navigation-and-camera-parity，D5）。
   * 由 Canvas Navigation 原子收敛（不再由 selection 直接退出）。
   */
  onModelFocusInvalid?: (reason: string) => void;
  /**
   * 双击图片节点进入图片聚焦入口
   * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
   */
  onImageFocusIntent?: (request: { nodeId: string }) => void;
  /**
   * 双击视频节点进入视频聚焦入口
   * （change: 2026-10-10-add-video-node-focus-workspace）。
   */
  onVideoFocusIntent?: (request: { nodeId: string }) => void;
  /** typed event 出口（Cordis `ctx.emit`）。 */
  emit: (
    name:
      | "ui.media-preview.open-requested"
      | "ui.text-preview.open-requested"
      | "ui.video-frame-capture.open-requested"
      | "ui.node-history.open-requested"
      | "ui.node-history.switch-requested",
    payload: unknown
  ) => void;
  /** 用户是否偏好减少动态效果（change: enable-video-node-live-preview）。 */
  prefersReducedMotion?: () => boolean;
  /** 视频帧会话（测试可注入）。 */
  createVideoSessions?: (runtime: BevyRuntime) => import("./video-frame-session.js").VideoFrameSessions;
  /**
   * 媒体解码实现（测试可注入；change: 2026-10-12-unify-node-editors-and-focus-transitions）。
   * 缺省按来源 key（受控同源 URL）解码原图；供有界媒体资源 store 共享 CPU 位图。
   */
  decodeMediaBitmap?: import("./media-resource-store.js").MediaDecoder;
  /**
   * 统一生成运行状态投影（change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
   *
   * 返回有界的节点运行摘要、操作记录与“当前版本”身份映射；缺省时不绘制历史条与聚合遮罩。
   */
  getRunState?: () => import("../canvas-shell/interaction-types.js").RunStateProjectionInput | null;
  /** 订阅运行状态变化；控制器据此重新 flush scene。 */
  subscribeRunState?: (listener: () => void) => () => void;
  /** 装载 Bevy（测试可注入）。 */
  loadRuntime?: () => Promise<BevyRuntime>;
};
