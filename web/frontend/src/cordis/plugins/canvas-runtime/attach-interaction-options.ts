/**
 * Canvas Runtime attach 的 interaction options 装配
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只读取宿主回调，返回可由 `installInteractionController` 消费的 options。
 */
import type { InteractionControllerOptions } from "../canvas-shell/interaction-controller.js";
import type { VideoFrameSessions } from "./video-frame-session.js";
import type { TextureUploader } from "./texture-sync.js";
import type { ModelEditorGestureRefs } from "./model-editor-gestures.js";
import type { CanvasRuntimeOptions } from "./canvas-runtime-options.js";
import type { FocusTargetInput } from "../canvas-shell/model-focus-session.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";

export type AttachAssemblyDeps = {
  canvas: HTMLCanvasElement;
  options: CanvasRuntimeOptions;
  textureSync: TextureUploader;
  videoSessions: VideoFrameSessions;
  getRuntime: InteractionControllerOptions["getRuntime"];
  getModelResources: InteractionControllerOptions["getModelResources"];
  theme: InteractionControllerOptions["getTheme"];
  getGhostNodes: () => readonly import("@woohaa3/contracts").GhostRenderNode[];
  onNodeAction?: NonNullable<InteractionControllerOptions["onNodeAction"]>;
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
  worldAnimationTimes: () => ReadonlyMap<string, number>;
  worldAnimationPlayheads?: () => ReadonlyMap<string, number>;
  worldAnimationPlayer?: () => { nodeId: string | null; playing: boolean };
  worldAnimationLoop?: (nodeId: string) => boolean;
  focusTransition: () => import("@woohaa3/contracts").BevyFocusTransition | null;
  runState: () => import("../canvas-shell/interaction-types.js").RunStateProjectionInput | null;
  gestures: ModelEditorGestureRefs;
  /**
   * 拖动吸附策略（内置插件 `alignment-guides` 提供）。
   * 缺省不吸附；插件可在画布挂载前后启停。
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
    ...(options.canvasId ? { canvasId: options.canvasId } : {}),
    getRuntime: deps.getRuntime,
    getSession: () => options.getSession(),
    getModelResources: deps.getModelResources,
    ...(options.isModelLoading ? { isModelLoading: options.isModelLoading } : {}),
    ...(options.getModelLoading ? { getModelLoading: options.getModelLoading } : {}),
    getTheme: deps.theme,
    textureSync: deps.textureSync,
    videoSessions: deps.videoSessions,
    ...(options.isModalActive ? { isModalActive: options.isModalActive } : {}),
    ...(options.isFocusInputBlocked ? { isFocusInputBlocked: options.isFocusInputBlocked } : {}),
    ...(options.onFindRequest ? { onFindRequest: options.onFindRequest } : {}),
    ...(options.onUndoRequest ? { onUndoRequest: options.onUndoRequest } : {}),
    ...(options.onRedoRequest ? { onRedoRequest: options.onRedoRequest } : {}),
    ...(options.onEditCommands ? { onEditCommands: options.onEditCommands } : {}),
    ...(options.saveWorldCamera ? { saveWorldCamera: options.saveWorldCamera } : {}),
    ...(options.moveWorldCameraCard ? { moveWorldCameraCard: options.moveWorldCameraCard } : {}),
    ...(options.recordExternal ? { recordExternal: options.recordExternal } : {}),
    ...(options.onInteractionError ? { onInteractionError: options.onInteractionError } : {}),
    getGhostNodes: deps.getGhostNodes,
    ...(deps.onNodeAction ? { onNodeAction: deps.onNodeAction } : {}),
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
    getWorldAnimationTimes: deps.worldAnimationTimes,
    getWorldAnimationPlayheads: deps.worldAnimationPlayheads,
    getWorldAnimationPlayer: deps.worldAnimationPlayer,
    getWorldAnimationLoop: deps.worldAnimationLoop,
    getFocusTransition: deps.focusTransition,
    getRunState: deps.runState,
    projectHistoryCanvas: options.projectHistoryCanvas,
    ...(deps.gestures.shot ? { shotGesture: deps.gestures.shot } : {}),
    ...(deps.gestures.focus ? { focusGesture: deps.gestures.focus } : {}),
    ...(deps.gestures.shotWheel ? { shotWheel: deps.gestures.shotWheel } : {}),
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
      // 2D 组不是作品节点：右键直接走空白画布菜单（共用同一套菜单代码），
      // 组成员卡片仍保持自己的节点菜单。
      let nodeId = node?.nodeId ?? null;
      if (nodeId) {
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
        const type = canvas?.document.nodes.find((entry) => entry.id === nodeId)?.type;
        if (type === "workflow-group-2d") nodeId = null;
      }
      options.onMenuIntent?.({ screen, world, nodeId });
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
    ...(options.onModelFocusInvalid ? { onModelFocusInvalid: options.onModelFocusInvalid } : {})
  };
}
