/**
 * 视频聚焦工作区 Plugin
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 1.4/2.x/3.x/4.x，design D1–D6）。
 *
 * 拥有一次视频聚焦会话：进入时解析节点自身 canonical ready 输出、创建 `VideoFocusSession`
 * （隐藏解码元素 + 二维取景）并推入瞬时投影；退出时释放媒体源、恢复 canonical 卡片纹理与
 * 进入前视口（观看不产生视频版本）。
 *
 * 复用共享 `canvas.overlay` 工作区布局与“视频截帧共享主体”：底部播放/进度/静音/首当前尾帧、
 * 右侧已截帧/历史互斥检查区。帧集合由 overlay 的会话持有，历史切换只换呈现、不卸载会话。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { resolveVideoFocusTarget, type VideoFocusTarget } from "./targets.js";
import { VideoFocusSession } from "./session.js";
import { VideoEditorWorkspace } from "./video-editor-overlay.js";
import { OpenCaptureFrames } from "../video-capture/capture-frames.js";
import { definePlugin } from "../../plugin.js";
import { VIDEO_FOCUS_SERVICE, type VideoFocusService } from "../service-keys.js";

export const VIDEO_EDITOR_PLUGIN_ID = "video-editor";
const VIDEO_EDITOR_WORKSPACE_ID = "video-editor-workspace";

export type VideoEditorPluginOptions = {};

export function videoEditorExtension(_options: VideoEditorPluginOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      let session: VideoFocusSession | null = null;
      let target: VideoFocusTarget | null = null;
      let generation = 0;
      const captureFrames = new OpenCaptureFrames({
        mediaRemote: ctx.mediaRemote,
        session: ctx.canvasSession,
        // 画布内截帧上传带画布提示（POST /api/media?canvas=<id>）。
        canvasId: () => ctx.canvasScope?.canvasId() ?? null,
        resolveNodePosition: (nodeId) => {
          const canvas = getCanvas();
          const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
          return node?.position ? { x: node.position.x, y: node.position.y } : null;
        }
      });

      const getCanvas = () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;

      /** 可用内容矩形：与 overlay DOM（铺满聚焦内容区）及 Bevy 取景共用同一表面。 */
      const workspaceRect = (): { x: number; y: number; width: number; height: number } => {
        const controller = ctx.canvasRuntime.controller();
        const surface = controller?.surface() ?? { width: 1, height: 1, pixelRatio: 1 };
        return ctx.canvasRuntime.focusContentRect?.() ?? { x: 0, y: 0, width: surface.width, height: surface.height };
      };

      const enter = (nodeId: string): boolean => {
        const resolved = resolveVideoFocusTarget(getCanvas(), nodeId);
        if (!resolved) return false;
        const entering = ++generation;
        session?.dispose();
        const controller = ctx.canvasRuntime.controller();
        const savedViewport = controller?.viewport() ?? { x: 0, y: 0, zoom: 1 };
        const controllerRef = controller;
        const current = new VideoFocusSession({
          nodeId,
          target: resolved,
          getCanvas,
          rect: workspaceRect(),
          runtime: ctx.canvasRuntime.runtime(),
          transition: ctx.canvasRuntime.focusTransitionPort(),
          setProjection: (projection) => ctx.canvasRuntime.setVideoFocus(projection),
          onTexture: (texture) => ctx.canvasRuntime.setVideoFocusTexture(texture),
          savedViewport,
          restoreViewport: (viewport) => controllerRef?.restoreViewport(viewport)
        });
        session = current;
        target = resolved;
        const started = current.start();
        if (entering !== generation || session !== current) return false;
        return started;
      };

      const exit = (): void => {
        generation += 1;
        session?.dispose();
        session = null;
        target = null;
      };

      // 聚焦投影变化：adapter 已按 kind 分派；这里驱动 session 的进入/退出。
      const unsubscribeNav = ctx.canvasNavigation.subscribe(() => {
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        if (mode.type !== "node-focus" || mode.kind !== "video") {
          if (session) exit();
          return;
        }
        if (!session || session.nodeId !== mode.nodeId) enter(mode.nodeId);
      });

      // 有效视频焦点目标推给 adapter（isTargetValid）。
      const syncTargets = () => {
        const canvas = getCanvas();
        const ids = canvas
          ? canvas.document.nodes
              .filter((node) => node.type === "video")
              .filter((node) => resolveVideoFocusTarget(canvas, node.id) !== null)
              .map((node) => node.id)
          : [];
        ctx.canvasRuntime.setVideoFocusTargets(ids);
        if (session && !ids.includes(session.nodeId)) {
          const mode = ctx.canvasNavigation.getSnapshot().mode;
          if (mode.type === "node-focus" && mode.kind === "video" && mode.nodeId === session.nodeId) {
            ctx.canvasNavigation.invalidateNodeFocus("video-target-removed");
          } else {
            exit();
          }
        }
      };
      syncTargets();
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(syncTargets);
      const unsubscribeRect = ctx.canvasRuntime.subscribeFocusContentRect(() => {
        if (!session) return;
        session.setRect(workspaceRect());
      });

      const removeOverlay = ctx.slots.register("canvas.focus-workspace", {
        id: VIDEO_EDITOR_WORKSPACE_ID,
        owner: VIDEO_EDITOR_PLUGIN_ID,
        kind: "video",
        available: () => session !== null,
        render: ({ writable }) => (
          <VideoEditorWorkspace
            getSession={() => session}
            getTarget={() => target}
            writable={writable}
            onAddFrames={({ targetNodeId, frames, signal }) => captureFrames.addFrames(frames, targetNodeId, signal)}
          />
        )
      });

      // 退出协调 participant：视频无未结算净变化，只在导航 dispatch 前播放取景缩回动画。
      const disposeParticipant = ctx.focusExit.register({
        id: VIDEO_EDITOR_PLUGIN_ID,
        hasUnsavedChanges: () => false,
        prepare: async () => ({ ok: true }),
        afterPrepare: async () => { await session?.animateExit(); }
      });

      const service: VideoFocusService = {
        isActive: () => session !== null,
        nodeId: () => session?.nodeId ?? null,
        setHistoryOverride: (override) => { session?.setHistoryOverride(override); },
        refreshFromCanonical: () => {
          // 当前 canonical 输出远端改变：保留帧与回执，但重新取景、暂停并显示来源已更新。
          const nodeId = session?.nodeId;
          if (!nodeId) return;
          const resolved = resolveVideoFocusTarget(getCanvas(), nodeId);
          if (!resolved) return;
          if (target && resolved.url === target.url) return;
          target = resolved;
          session?.setTarget(resolved);
        }
      };
      ctx.provide(VIDEO_FOCUS_SERVICE as never, service as never);

      // E2E/排障镜像（生产无副作用）。
      (globalThis as unknown as { __videoFocusDebug?: unknown }).__videoFocusDebug = () => ({
        active: session !== null,
        nodeId: session?.nodeId ?? null,
        state: session?.state() ?? null
      });

      ctx.effect(
        () => () => {
          unsubscribeNav();
          unsubscribeCanvas();
          unsubscribeRect();
          removeOverlay();
          disposeParticipant();
          captureFrames.dispose();
          exit();
        },
        "video-editor-lifecycle"
      );
    },
    {
      name: VIDEO_EDITOR_PLUGIN_ID,
      inject: ["slots", "canvasRuntime", "canvasNavigation", "canvasSession", "canvasScope", "mediaRemote", "focusExit"]
    }
  );
}
