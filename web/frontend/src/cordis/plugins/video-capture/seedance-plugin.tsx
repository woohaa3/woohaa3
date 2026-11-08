/**
 * Seedance Video Interaction Plugin
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 5.2–5.4 / design D9）。
 *
 * 把视频编辑能力整体迁入 Model Interaction Plugin：
 * - 在 activation 中注册 `seedance-video@1` React Panel（通过 page-scoped registry）；
 * - 拥有视频编辑 / 时间轴标记 / 截帧 Dialog 的注册（复用既有 `video-capture` 模块）；
 * - 双击视频节点的截帧入口仍由本 Plugin 独占订阅；
 * - Panel 的编辑入口 / 删除 / 截帧 / intent 摘要通过 definition.bindings 交给 Host 转发。
 *
 * Core Task Execution 不再判断 `edit_video`、不读取 `videoEditIntents`、也不接收 video-specific props。
 * Dialog 继续走共享 Dialog Host、focus / busy / Escape / pre-open cleanup contract。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { definePlugin } from "../../plugin.js";
import { createVideoDialogsController, resolveOwnReadyVideo, type VideoDialogsController } from "./controller.js";
import { SeedanceVideoPanel } from "./seedance-panel.js";
import type { ModelPanelBinding } from "../../contract/model-interaction.js";
import type { CanvasNodeData, ServerCanvas, VideoEditIntent } from "@woohaa3/contracts";
import { decodeWorldCamera, worldCameraShotContext } from "@woohaa3/contracts";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";
import { mediaUrlFor } from "../../services/paths.js";
import type { VideoDialogPayload } from "./types.js";

export const SEEDANCE_INTERACTION_PLUGIN_ID = "seedance-video-interaction";
export const SEEDANCE_VIDEO_INTERACTION_ID = "seedance-video";
export const SEEDANCE_VIDEO_INTERACTION_VERSION = 1;

export function seedanceVideoInteractionExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx) => {
      const videoDialogs: VideoDialogsController = createVideoDialogsController({
        dialogs: ctx.dialogs,
        mediaRemote: ctx.mediaRemote,
        session: ctx.canvasSession,
        readNodeIntents: (nodeId) => readCanonicalIntents(nodeId),
        resolveNodePosition: (nodeId) => readNodePosition(nodeId),
        // 画布内截帧/标记图上传与视频预览都按当前画布路由到远端存储。
        canvasId: () => ctx.get("canvasScope")?.canvasId() ?? null
      });

      // 双击视频节点 → 打开截帧 Dialog（事件只带 nodeId；此处重新解析 canonical）。
      const offFrameCapture = ctx.on("ui.video-frame-capture.open-requested", (payload) => {
        const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
        if (!nodeId) return;
        const canvas = woohaa3CanvasStore.getState().canvas;
        videoDialogs.openOwnOutputFrameCapture({ canvas, nodeId });
      });

      const resolveEditEntry = (nodeId: string, writable: boolean) => {
        const canvas = woohaa3CanvasStore.getState().canvas;
        if (!resolveOwnReadyVideo(canvas, nodeId).ok) return null;
        const status = canvas?.nodeData[nodeId]?.taskStatus;
        return videoDialogs.controller.resolveEntry({
          canvas,
          nodeId,
          writable: writable && ctx.canvasSession.isWritable(),
          pending: ctx.canvasSession.getStatus().remote.pendingCount > 0,
          taskPending: status === "pending" || status === "processing"
        });
      };
      // 普通已就绪视频也可整理区间与标注，不依赖所选生成模型的交互面板。
      const removeEditAction = ctx.slots.register("canvas.node-action", {
        id: "video-edit-annotations",
        owner: SEEDANCE_INTERACTION_PLUGIN_ID,
        order: -10,
        describe: ({ nodeId, writable }) => {
          const entry = resolveEditEntry(nodeId, writable);
          return entry ? {
            label: "编辑视频标注",
            icon: "edit",
            enabled: entry.ok,
            ...(!entry.ok ? { reason: entry.reason } : {})
          } : null;
        },
        activate: ({ nodeId, writable }) => {
          if (!resolveEditEntry(nodeId, writable)?.ok) return;
          videoDialogs.controller.openEdit({ canvas: woohaa3CanvasStore.getState().canvas, nodeId, ownOutput: true });
        }
      });

      // Panel + Dialog 的 disposer 由同一 scope 收集；部分激活失败时 Cordis 反序回滚。
      const disposePanel = ctx.modelInteractions.register({
        id: SEEDANCE_VIDEO_INTERACTION_ID,
        version: SEEDANCE_VIDEO_INTERACTION_VERSION,
        owner: SEEDANCE_INTERACTION_PLUGIN_ID,
        Panel: SeedanceVideoPanel,
        bindings: ({ nodeId }): ModelPanelBinding => ({
          actions: {
            openVideoEdit: (intentId?: string) => {
              const canvas = woohaa3CanvasStore.getState().canvas;
              videoDialogs.controller.openEdit({
                canvas,
                nodeId,
                ...(typeof intentId === "string" && intentId !== "" ? { intentId } : {})
              });
            },
            openFrameCapture: () => {
              const canvas = woohaa3CanvasStore.getState().canvas;
              videoDialogs.controller.openFrameCapture({ canvas, nodeId });
            },
            removeIntent: (intentId?: string) => {
              if (typeof intentId !== "string" || intentId === "") return;
              const canvas = woohaa3CanvasStore.getState().canvas;
              videoDialogs.controller.removeIntent({ canvas, nodeId, intentId });
            }
          },
          statusSummary: summarizeIntents(videoDialogs, nodeId)
        })
      });

      ctx.effect(
        () => () => {
          offFrameCapture();
          removeEditAction();
          videoDialogs.dispose();
          disposePanel();
        },
        "seedance-video-interaction"
      );
    },
    {
      name: SEEDANCE_INTERACTION_PLUGIN_ID,
      inject: ["dialogs", "mediaRemote", "canvasSession", "canvasScope", "modelInteractions", "slots"]
    }
  );
}

/** The chosen source remains an immutable video even if the live camera changes. */
export function cameraFramePayload(canvas: ServerCanvas | null, nodeId: string): VideoDialogPayload | null {
  if (!canvas) return null;
  const camera = decodeWorldCamera(canvas.nodeData[nodeId]?.worldCamera);
  if (!camera.ok) return null;
  const status = worldCameraShotStore.get(camera.value.cameraId);
  const shot = worldCameraShotContext(canvas, camera.value);
  if (!status || status.canvasId !== canvas.id || status.phase !== "ready" || status.stale
    || status.key?.cameraSettingsVersion !== camera.value.settingsVersion || !status.video || !status.dynamicKey
    || shot?.kind !== "dynamic" || !shot.animation || status.dynamicKey.animation.areaId !== shot.animation.areaId
    || status.dynamicKey.animation.scriptRevision !== shot.animation.scriptRevision
    || status.dynamicKey.animation.sourceHash !== shot.animation.sourceHash) return null;
  return {
    videoAssetId: status.video.mediaId,
    videoStorageKey: status.video.storageKey,
    videoUrl: mediaUrlFor(status.video.storageKey, canvas.id),
    targetNodeId: nodeId,
    title: "镜头取静帧",
    cameraSource: { cameraId: camera.value.cameraId, versionKey: structuredClone(status.dynamicKey) }
  };
}

function summarizeIntents(videoDialogs: VideoDialogsController, nodeId: string): readonly string[] {
  const canvas = woohaa3CanvasStore.getState().canvas;
  return videoDialogs.controller.projectIntents(canvas, nodeId).map((intent) => {
    const range =
      intent.endSeconds !== undefined
        ? `${intent.startSeconds}-${intent.endSeconds}s`
        : `${intent.startSeconds}s`;
    return `${range} ${intent.prompt}`;
  });
}

/** 读取节点 canonical intents（Plugin 入口，避免 Panel import store 单例）。 */
export function readCanonicalIntents(nodeId: string): readonly VideoEditIntent[] {
  const canvas = woohaa3CanvasStore.getState().canvas;
  const nodeData = canvas?.nodeData as Record<string, CanvasNodeData | undefined> | undefined;
  const intents = nodeData?.[nodeId]?.videoEditIntents;
  return Array.isArray(intents) ? intents : [];
}

/** 读取节点位置（帧节点落点参照）。 */
export function readNodePosition(nodeId: string): { x: number; y: number } | null {
  const canvas: ServerCanvas | null = woohaa3CanvasStore.getState().canvas;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return node?.position ? { x: node.position.x, y: node.position.y } : null;
}
