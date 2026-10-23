import "../../authoring/browser/styles.css";
import { createElement } from "react";
import { defineExtensionFrontend, defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { CANVAS_MENU_SECTION, COMPOSITE_ASSET_NODE_TYPE, MODEL_EDITOR_VERSION, decodeFilmSetNodeData } from "@woohaa3/contracts";
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
import { sceneCameraWriter } from "../../authoring/browser/scene-camera.js";
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
      lifetime.own(playback.subscribe(ctx.compositeAssets.invalidate));
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
        readCameras(_nodeId, data) {
          const decoded = decodeFilmSetNodeData(data);
          if (!decoded.ok) return [];
          return [{ ...decoded.value.sceneCamera, id: "scene-camera", name: "场景镜头", order: 0, elevation: decoded.value.sceneCamera.elevation ?? 0, aspect: decoded.value.sceneCamera.aspect ?? "16:9" }];
        },
        writeCameras: sceneCameraWriter((...args) => ctx.canvasSession.submitCommands(...args)),
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
      lifetime.own(ctx.slots.register("canvas.overlay", {
        id: "film-set-inspector", owner: FILM_SET_EXTENSION_ID, priority: 20,
        render: ({ writable }) => createElement(FilmSetInspector, { ctx, session: ctx.modelWorkspace.session, captureSession: ctx.modelWorkspace.captureSession,
          objectSession: feature.session, objectAction: feature.action, writable, canvasId: ctx.canvasState.getCanvas()?.id ?? "" })
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
  }, { name: FILM_SET_EXTENSION_ID, inject: ["dialogs", "slots", "compositeAssets", "canvasState", "canvasSession", "canvasRuntime", "canvasEdit", "canvasNavigation", "mediaRemote", "modelWorkspace", "hoverState", "canvasScope", "canvasRemote", "canvasLocate"] });
}
export const descriptor = defineExtensionFrontend({ ...FILM_SET_FRONTEND_METADATA, plugin: filmSetExtension });

export { FilmSetInspector } from "../../authoring/browser/inspector.js";
export { FILM_SET_FRONTEND_METADATA } from "./metadata.js";
export { FilmSetAdaptationConfirm, resolveAdaptation } from "../../authoring/browser/film-set-adaptation.js";
export { FilmSetPlaybackService } from "../../preview/browser/playback-service.js";
export type { FilmSetContext } from "./context.js";
