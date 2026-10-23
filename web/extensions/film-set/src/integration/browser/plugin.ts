import "../../authoring/browser/styles.css";
import { createElement } from "react";
import { defineExtensionFrontend, defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { CANVAS_MENU_SECTION, COMPOSITE_ASSET_NODE_TYPE, FILM_SET_SHOT_PREVIEW_NODE_TYPE, MODEL_EDITOR_VERSION, decodeFilmSetNodeData, filmSetAnimationsOf, shotPreviewOwnershipOf } from "@woohaa3/contracts";
import { installShotImageReferences } from "../../authoring/browser/shot-image-reference.js";
import { FILM_SET_EXTENSION_ID, FILM_SET_LABEL } from "../../state/shared/identity.js";
import { FILM_SET_FRONTEND_METADATA } from "./metadata.js";
import { HistoryFilmSetSnapshots } from "../../preview/browser/history-preview.js";
import { installShotReferenceRecording } from "../../authoring/browser/shot-reference-recording-controller.js";
import { startRecordingActivityMirror } from "./recording-activity-mirror.js";
import { nativeRecordingAvailable } from "../../authoring/browser/native-recording-availability.js";
import { createFilmSetModelAdapter } from "../../preview/browser/model-adapter.js";
import { FilmSetPlaybackService } from "../../preview/browser/playback-service.js";
import { animationPlaybackExtension } from "./playback-plugin.js";
import { installFilmSetObjectFeature } from "./film-set-object-feature.js";
import { FilmSetInspector } from "../../authoring/browser/inspector.js";
import { extendFilmSetDrop } from "./drop.js";
import { installFilmSetConversionEntries } from "./film-set-conversion/registration.js";
import type { FilmSetContext } from "./context.js";
import { projectObjectPresentation } from "../../preview/browser/object-presentation.js";
import { filmSetEditorCameras, sceneCameraWriter } from "../../authoring/browser/scene-camera.js";
import { contributionLifetime } from "./contributions.js";
import { createFilmSetNodeData } from "../../state/shared/node.js";
import { gizmoParentBasis } from "../../authoring/browser/gizmo-constraint.js";

export function filmSetExtension() {
  return defineExtensionPlugin<FilmSetContext>(ctx => {
    const lifetime = contributionLifetime();
    ctx.effect(() => () => lifetime.dispose(), "film-set-contributions");
    try {
      const history = new HistoryFilmSetSnapshots();
      const preview = new Map<string, { itemId: string; transform: import("@woohaa3/contracts").FilmSetLocalTransform }>();
      const playback = new FilmSetPlaybackService();
      ctx.provide("filmSetPlayback" as never, playback as never);
      const feature = installFilmSetObjectFeature(ctx, () => ctx.canvasRuntime.modelFocusMode() === "history", preview);
      lifetime.own(() => feature.dispose());
      lifetime.own(() => preview.clear());
      lifetime.own(history.subscribe(() => { ctx.compositeAssets.invalidate(); feature.session.reconcile(); }));
      lifetime.own(playback.subscribe(() => {
        ctx.compositeAssets.invalidate();
        const nodeId = ctx.modelWorkspace.session.getState().nodeId;
        if (!nodeId) return;
        const selected = playback.getSnapshot();
        const data = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas())?.nodeData[nodeId];
        const camera = filmSetEditorCameras(data, selected.nodeId === nodeId ? selected.clipId : null)[0];
        if (camera && ctx.modelWorkspace.session.getState().selectedCameraId !== camera.id) {
          const toolMode = ctx.modelWorkspace.session.getState().toolMode;
          ctx.modelWorkspace.session.enter(nodeId);
          ctx.modelWorkspace.session.setToolMode(toolMode);
        }
        ctx.modelWorkspace.refreshGizmo();
      }));
      lifetime.own(feature.session.subscribe(() => ctx.modelWorkspace.refreshGizmo()));
      let previous = ctx.modelWorkspace.session.getState();
      lifetime.own(ctx.modelWorkspace.session.subscribe(() => {
        const next = ctx.modelWorkspace.session.getState();
        if (next.selectedCameraId !== previous.selectedCameraId || next.toolMode !== previous.toolMode || next.cameraTool !== previous.cameraTool) feature.session.select(null);
        previous = next;
      }));
      const adapter = createFilmSetModelAdapter(history);
      lifetime.own(ctx.compositeAssets.register({
        ...adapter,
        // 业务类型显示名：浮动名称面板据此标注聚合节点业务类型（change:
        // 2026-10-12-align-film-set-scope-with-isometric-grid）。范围形状仍是复合资产类别默认
        // （等距地面范围），无需按业务显式声明；通用宿主与 Rust 只消费声明，不按 film-set 业务 ID 分支。
        label: FILM_SET_LABEL,
        projectPresentation: projectObjectPresentation(preview),
        objectPreview: nodeId => preview.get(nodeId) ?? null,
        blocksFocusInput: () => playback.getSnapshot().preview,
        keydown(event) {
          const state = playback.getSnapshot();
          if (!state.preview) return false;
          if (event.code === "Space") { event.preventDefault(); state.playing ? playback.pause() : playback.play(); }
          else if (event.key === "Escape") { event.preventDefault(); playback.edit(); }
          return true;
        },
        gizmo(nodeId) {
          const state = feature.session.getState();
          if (state.nodeId !== nodeId || !state.selectedItemId || playback.getSnapshot().preview || ctx.canvasRuntime.modelFocusMode() === "history" || !ctx.canvasSession.isWritable()) return null;
          const entry = ctx.canvasRuntime.queryCompositeAssetItemBounds(nodeId).find(item => item.itemId === state.selectedItemId);
          return entry ? { version: MODEL_EDITOR_VERSION, nodeId, toolMode: "object", objectTool: state.tool, itemId: state.selectedItemId,
            parentBasis: gizmoParentBasis(entry.worldToLocal, entry.yaw, entry.unit), feedback: state.feedback, focus: entry.center, radius: entry.radius } : null;
        },
        readCameras(nodeId, data) {
          const selected = playback.getSnapshot();
          return filmSetEditorCameras(data, selected.nodeId === nodeId ? selected.clipId : null);
        },
        writeCameras: sceneCameraWriter((...args) => ctx.canvasSession.submitCommands(...args), nodeId => (ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas())?.nodeData[nodeId]),
        captureEnabled: (nodeId, cameraId) => {
          const data = decodeFilmSetNodeData(ctx.canvasState.getCanvas()?.nodeData[nodeId]);
          if (!data.ok) return false;
          const collection = filmSetAnimationsOf(data.value);
          const selected = playback.getSnapshot();
          const clipId = cameraId?.startsWith("clip:") ? cameraId.slice(5) : selected.nodeId === nodeId ? selected.clipId : collection.defaultClipId;
          const clip = collection.clips.find(clip => clip.id === clipId);
          return clip?.kind === "dynamic";
        },
        captureOrigin: (nodeId, cameraId) => ({ nodeData: { filmSetShotOrigin: { filmSetNodeId: nodeId, cameraId, capturedAt: new Date().toISOString() } } as never }),
        awaitCaptureReady: nodeId => ctx.canvasRuntime.compositeAssetMediaSessions?.()?.waitForTime(nodeId, ctx.canvasRuntime.animationPlaybackState()?.time ?? 0, 2500) ?? Promise.resolve(true)
      }));
      lifetime.own(ctx.slots.register("canvas.node-template", {
        id: "film-set-node", owner: FILM_SET_EXTENSION_ID, nodeType: COMPOSITE_ASSET_NODE_TYPE,
        label: FILM_SET_LABEL, section: CANVAS_MENU_SECTION.creationTools, order: 0,
        createNodeData: () => createFilmSetNodeData() as never
      }));
      lifetime.own(extendFilmSetDrop(ctx));
      // 直接传递 Cordis `ctx`：它已注入 canvasScope/canvasRemote/canvasLocate/canvasRuntime。
      // MUST NOT 展开（`{ ...ctx }`）——展开只复制自有可枚举属性，会丢掉 ctx 的 service 访问器，
      // 使注册模块读到 undefined 的 canvasScope（此前导致 required film-set 启动失败 → 白屏）。
      lifetime.own(installFilmSetConversionEntries(ctx));
      const images = installShotImageReferences(ctx, playback);
      lifetime.own(() => images.dispose());
      const imageOwner = (nodeId: string) => shotPreviewOwnershipOf(ctx.canvasState.getCanvas()?.nodeData[nodeId]);
      lifetime.own(ctx.slots.register("canvas.node-action", {
        id: "film-set-image-download", owner: FILM_SET_EXTENSION_ID, order: 0,
        available: ({ nodeId, nodeType }) => {
          const owner = imageOwner(nodeId);
          return nodeType === FILM_SET_SHOT_PREVIEW_NODE_TYPE && !!owner && images.isStatic(owner.filmSetNodeId, owner.clipId);
        },
        describe: ({ nodeId }) => {
          const owner = imageOwner(nodeId);
          const state = owner ? images.state(owner.filmSetNodeId, owner.clipId) : null;
          return { label: "下载图片参考", enabled: state?.status === "ready", reason: state?.status === "ready" ? undefined : "静态图片参考尚未就绪" };
        },
        activate: ({ nodeId }) => { const owner = imageOwner(nodeId); if (owner) void images.download(owner.filmSetNodeId, owner.clipId); }
      }));
      lifetime.own(ctx.slots.register("canvas.context-menu", {
        id: "film-set-image-download-menu", owner: FILM_SET_EXTENSION_ID, priority: 15,
        items: ({ nodeId, connectFrom }) => {
          if (!nodeId || connectFrom) return [];
          const owner = imageOwner(nodeId);
          if (!owner || !images.isStatic(owner.filmSetNodeId, owner.clipId)) return [];
          return [{ id: "film-set-image-download", label: "下载图片参考", disabled: images.state(owner.filmSetNodeId, owner.clipId).status !== "ready" }];
        },
        onSelect: (id, { nodeId }) => { const owner = nodeId && imageOwner(nodeId); if (id === "film-set-image-download" && owner) void images.download(owner.filmSetNodeId, owner.clipId); }
      }));
      lifetime.own(ctx.slots.register("canvas.overlay", {
        id: "film-set-inspector", owner: FILM_SET_EXTENSION_ID, priority: 20,
        render: ({ writable }) => createElement(FilmSetInspector, { ctx, session: ctx.modelWorkspace.session, captureSession: ctx.modelWorkspace.captureSession,
          objectSession: feature.session, objectAction: feature.action, images, writable, canvasId: ctx.canvasState.getCanvas()?.id ?? "" })
      }));
      ctx.plugin(animationPlaybackExtension());
      // 镜头参考录制调度（任务 8.3）：只维护 dirty 集与触发边界；真实录制由 8.4 注入。
      // 播放时钟显式传入：本插件未声明 `filmSetPlayback` 的 inject，走服务解析会在装配时抛错。
      const shotReferenceRecording = installShotReferenceRecording(ctx, { playback });
      lifetime.own(() => shotReferenceRecording.dispose());
      // 原生录制任务 → 活动浮层（任务 5.5）。宿主只提供权威状态；事件属于页面 scope，
      // 因此由前端轮询并投影。断开只停止观察，不取消原生任务。
      const recordingActivity = nativeRecordingAvailable()
        ? startRecordingActivityMirror({
            canvasId: () => ctx.canvasState.getCanvas()?.id ?? "",
            list: async canvasId => {
              const result = await ctx.canvasRemote.recordingList({ canvasId });
              return result.ok ? result.value.jobs : [];
            },
            emit: job => ctx.emit("extension.activity.updated", { job })
          })
        : null;
      if (recordingActivity) lifetime.own(() => recordingActivity.stop());
    } catch (error) {
      lifetime.dispose();
      throw error;
    }
  }, { name: FILM_SET_EXTENSION_ID, inject: ["theme", "dialogs", "slots", "compositeAssets", "canvasState", "canvasSession", "canvasRuntime", "canvasEdit", "canvasNavigation", "mediaRemote", "modelWorkspace", "hoverState", "canvasScope", "canvasRemote", "canvasLocate"] });
}
export const descriptor = defineExtensionFrontend({ ...FILM_SET_FRONTEND_METADATA, plugin: filmSetExtension });

export { FilmSetInspector } from "../../authoring/browser/inspector.js";
export { FILM_SET_FRONTEND_METADATA } from "./metadata.js";
export { FilmSetAdaptationConfirm, resolveAdaptation } from "../../authoring/browser/film-set-adaptation.js";
export { FilmSetPlaybackService } from "../../preview/browser/playback-service.js";
export type { FilmSetContext } from "./context.js";
