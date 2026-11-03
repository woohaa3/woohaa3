/**
 * Canvas Runtime attach 的 interaction options 装配
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只读取宿主回调，返回可由 `installInteractionController` 消费的 options。
 */
import type { InteractionControllerOptions } from "../canvas-shell/interaction-controller.js";
import type { CompositeAssetMediaSessions } from "./composite-asset-media-session.js";
import type { VideoFrameSessions } from "./video-frame-session.js";
import type { TextureUploader } from "./texture-sync.js";
import type { ModelEditorGestureRefs } from "./model-editor-gestures.js";
import type { CanvasRuntimeOptions } from "./canvas-runtime-options.js";
import type { FocusTargetInput } from "../canvas-shell/model-focus-session.js";

export type AttachAssemblyDeps = {
  canvas: HTMLCanvasElement;
  options: CanvasRuntimeOptions;
  textureSync: TextureUploader;
  videoSessions: VideoFrameSessions;
  compositeAssetMediaSessions: CompositeAssetMediaSessions;
  getRuntime: InteractionControllerOptions["getRuntime"];
  getModelResources: InteractionControllerOptions["getModelResources"];
  theme: InteractionControllerOptions["getTheme"];
  getGhostNodes: () => readonly import("@woohaa3/contracts").GhostRenderNode[];
  getNodeActionToolbars?: NonNullable<InteractionControllerOptions["getNodeActionToolbars"]>;
  onNodeAction?: NonNullable<InteractionControllerOptions["onNodeAction"]>;
  getSelectionActionToolbar?: NonNullable<InteractionControllerOptions["getSelectionActionToolbar"]>;
  onSelectionAction?: NonNullable<InteractionControllerOptions["onSelectionAction"]>;
  modelFocus: () => import("@woohaa3/contracts").ModelFocusProjection | null;
  modelFocusMode: InteractionControllerOptions["getModelFocusMode"];
  focusTargets: () => readonly FocusTargetInput[];
  hasFocusTarget?: (nodeId: string) => boolean;
  imageFocusTargetId: () => string | null;
  imageFocus: () => import("@woohaa3/contracts").BevyImageFocus | null;
  imageFocusPending: () => boolean;
  imageViewportTarget?: () => import("../../focus/types.js").FocusViewportTarget | null;
  videoFocusTargetId: () => string | null;
  videoFocus: () => import("@woohaa3/contracts").BevyVideoFocus | null;
  modelSceneOverride: (nodeId: string) => { version: string; ops: readonly unknown[] } | null;
  contentRectRight: () => number;
  focusRect: () => import("../../focus/types.js").FocusContentRect | null;
  modelEditor: () => import("@woohaa3/contracts").BevyModelEditor | null;
  onGizmoFeedback?: InteractionControllerOptions["onGizmoFeedback"];
  animationPlayback: () => import("@woohaa3/contracts").BevyAnimationPlayback | null;
  focusTransition: () => import("@woohaa3/contracts").BevyFocusTransition | null;
  runState: () => import("../canvas-shell/interaction-types.js").RunStateProjectionInput | null;
  gestures: ModelEditorGestureRefs;
  /**
   * 拖动吸附策略读取器（内置插件 `alignment-guides` 注入）。
   * 每次拖动预览都会调用；返回 null 表示完全不吸附。
   */
  alignmentSnap?: () => import("../canvas-shell/alignment-snap.js").AlignmentSnapPolicy | null;
  onModelFocusChange: NonNullable<InteractionControllerOptions["onModelFocusChange"]>;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  onFrame?: () => void;
  projectResidency?: NonNullable<InteractionControllerOptions["projectResidency"]>;
  onSurface?: NonNullable<InteractionControllerOptions["onSurface"]>;
  onViewportForResidency?: NonNullable<InteractionControllerOptions["onViewportForResidency"]>;
  onSceneSubmitted?: () => void;
};

export function buildAttachInteractionOptions(deps: AttachAssemblyDeps): InteractionControllerOptions {
  const { options } = deps;
  return {
    canvas: deps.canvas,
    nodeCapabilities: options.nodeCapabilities,
    onSceneSubmitted: deps.onSceneSubmitted,
    ...(options.mediaContent ? { mediaContent: options.mediaContent } : {}),
    ...(options.compositeAssets ? { compositeAssets: options.compositeAssets } : {}),
    ...(options.canvasId ? { canvasId: options.canvasId } : {}),
    getRuntime: deps.getRuntime,
    getSession: () => options.getSession(),
    getModelResources: deps.getModelResources,
    ...(options.isModelLoading ? { isModelLoading: options.isModelLoading } : {}),
    ...(options.getModelLoading ? { getModelLoading: options.getModelLoading } : {}),
    getTheme: deps.theme,
    textureSync: deps.textureSync,
    videoSessions: deps.videoSessions,
    compositeAssetMediaSessions: deps.compositeAssetMediaSessions,
    ...(options.isModalActive ? { isModalActive: options.isModalActive } : {}),
    ...(options.isFocusInputBlocked ? { isFocusInputBlocked: options.isFocusInputBlocked } : {}),
    ...(options.onFindRequest ? { onFindRequest: options.onFindRequest } : {}),
    ...(options.onUndoRequest ? { onUndoRequest: options.onUndoRequest } : {}),
    ...(options.onRedoRequest ? { onRedoRequest: options.onRedoRequest } : {}),
    ...(options.onEditCommands ? { onEditCommands: options.onEditCommands } : {}),
    ...(options.onInteractionError ? { onInteractionError: options.onInteractionError } : {}),
    getGhostNodes: deps.getGhostNodes,
    ...(deps.getNodeActionToolbars ? { getNodeActionToolbars: deps.getNodeActionToolbars } : {}),
    ...(deps.onNodeAction ? { onNodeAction: deps.onNodeAction } : {}),
    ...(deps.getSelectionActionToolbar ? { getSelectionActionToolbar: deps.getSelectionActionToolbar } : {}),
    ...(deps.onSelectionAction ? { onSelectionAction: deps.onSelectionAction } : {}),
    getModelFocusTargets: deps.focusTargets,
    hasModelFocusTarget: deps.hasFocusTarget,
    getModelFocus: deps.modelFocus,
    getModelFocusMode: deps.modelFocusMode,
    isImageFocused: () => deps.imageFocusTargetId() !== null,
    getImageFocus: deps.imageFocus,
    isImageFocusPending: deps.imageFocusPending,
    getImageViewportTarget: deps.imageViewportTarget,
    isVideoFocused: () => deps.videoFocusTargetId() !== null,
    getVideoFocus: deps.videoFocus,
    getModelSceneOverride: deps.modelSceneOverride,
    getContentRect: () => ({ right: deps.contentRectRight() }),
    getFocusContentRect: deps.focusRect,
    getModelEditor: deps.modelEditor,
    onGizmoFeedback: deps.onGizmoFeedback,
    getAnimationPlayback: deps.animationPlayback,
    getFocusTransition: deps.focusTransition,
    getRunState: deps.runState,
    projectHistoryCanvas: options.projectHistoryCanvas,
    ...(deps.gestures.shot ? { shotGesture: deps.gestures.shot } : {}),
    ...(deps.gestures.focus ? { focusGesture: deps.gestures.focus } : {}),
    ...(deps.gestures.shotWheel ? { shotWheel: deps.gestures.shotWheel } : {}),
    ...(deps.gestures.object ? { filmSetObjectGesture: deps.gestures.object } : {}),
    // 片场对象局部键盘 action（Delete/Backspace/分层 Escape）随 controller 构造注入；
    // 缺省会丢失已注册的 action，导致真实浏览器按键路由失效（change: 2026-10-10 任务 4.1/5.1）。
    ...(deps.gestures.objectAction ? { filmSetObjectAction: deps.gestures.objectAction } : {}),
    ...(deps.alignmentSnap ? { alignmentSnap: deps.alignmentSnap } : {}),
    onModelFocusChange: deps.onModelFocusChange,
    onViewportChange: deps.onViewportChange,
    ...(deps.onFrame ? { onFrame: deps.onFrame } : {}),
    ...(deps.projectResidency ? { projectResidency: deps.projectResidency } : {}),
    ...(deps.onSurface ? { onSurface: deps.onSurface } : {}),
    ...(deps.onViewportForResidency ? { onViewportForResidency: deps.onViewportForResidency } : {}),
    onImagePreview: (request) => options.emit("ui.media-preview.open-requested", request as never),
    onTextPreviewIntent: (request) => options.emit("ui.text-preview.open-requested", request),
    ...(options.onImageFocusIntent ? { onImageFocusIntent: options.onImageFocusIntent } : {}),
    ...(options.onVideoFocusIntent ? { onVideoFocusIntent: options.onVideoFocusIntent } : {}),
    onVideoFrameCapture: (request) => options.emit("ui.video-frame-capture.open-requested", request as never),
    onNodeHistory: (request) => options.emit("ui.node-history.open-requested", request as never),
    onNodeHistorySelect: (request) => options.emit("ui.node-history.switch-requested", request),
    onContextMenu: ({ screen, world, node }) => {
      options.onMenuIntent?.({ screen, world, nodeId: node?.nodeId ?? null });
    },
    onConnectToEmpty: ({ screen, world, sourceNodeId, sourceNodeType }) => {
      options.onMenuIntent?.({
        screen,
        world,
        nodeId: null,
        connectFrom: { nodeId: sourceNodeId, nodeType: sourceNodeType }
      });
    },
    ...(options.onModelFocusIntent ? { onModelFocusIntent: options.onModelFocusIntent } : {}),
    ...(options.onShotPreviewEnterIntent ? { onShotPreviewEnterIntent: options.onShotPreviewEnterIntent } : {}),
    ...(options.onModelFocusInvalid ? { onModelFocusInvalid: options.onModelFocusInvalid } : {})
  };
}
