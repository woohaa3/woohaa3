import "./styles.css";
import { createElement } from "react";
import { defineExtensionFrontend, defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { CANVAS_MENU_SECTION, COMPOSITE_ASSET_NODE_TYPE, canonicalFilmSetFields, createFilmSetSnapshot, MODEL_EDITOR_VERSION, decodeFilmSetNodeData, filmSetMediaPlanesForNode, encodeFilmSetPartId } from "@woohaa3/contracts";
import { FILM_SET_EXTENSION_ID, FILM_SET_LABEL } from "../shared/identity.js";
import { FILM_SET_FRONTEND_METADATA } from "./metadata.js";
import { HistoryFilmSetSnapshots } from "./history-preview.js";
import { installShotReferenceRecording } from "./shot-reference-recording-controller.js";
import { startRecordingActivityMirror } from "./recording-activity-mirror.js";
import { nativeRecordingAvailable } from "./native-recording-availability.js";
import { createFilmSetModelAdapter } from "./model-adapter.js";
import { FilmSetPlaybackService } from "./playback-service.js";
import { animationPlaybackExtension } from "./playback-plugin.js";
import { installFilmSetObjectFeature } from "./film-set-object-feature.js";
import { FilmSetInspector } from "./inspector.js";
import { extendFilmSetDrop } from "./drop.js";
import { installFilmSetConversionEntries } from "./film-set-conversion/registration.js";
import type { FilmSetContext } from "./context.js";
export function filmSetExtension() {
  return defineExtensionPlugin<FilmSetContext>(ctx => {
    const history = new HistoryFilmSetSnapshots();
    const preview = new Map<string, { itemId: string; transform: import("@woohaa3/contracts").FilmSetLocalTransform }>();
    const playback = new FilmSetPlaybackService();
    ctx.provide("filmSetPlayback" as never, playback as never);
    const feature = installFilmSetObjectFeature(ctx, () => ctx.canvasRuntime.modelFocusMode() === "history", preview);
    const stopHistory = history.subscribe(() => { ctx.compositeAssets.invalidate(); feature.session.reconcile(); });
    const stopPlayback = playback.subscribe(ctx.compositeAssets.invalidate);
    const stopObjects = feature.session.subscribe(() => ctx.modelWorkspace.refreshGizmo());
    let previous = ctx.modelWorkspace.session.getState();
    const stopCameras = ctx.modelWorkspace.session.subscribe(() => {
      const next = ctx.modelWorkspace.session.getState();
      if (next.selectedCameraId !== previous.selectedCameraId || next.toolMode !== previous.toolMode || next.cameraTool !== previous.cameraTool) feature.session.select(null);
      previous = next;
    });
    const adapter = createFilmSetModelAdapter(history);
    const disposeAdapter = ctx.compositeAssets.register({
      ...adapter,
      // 业务类型显示名：浮动名称面板据此标注聚合节点业务类型（change:
      // 2026-10-12-align-film-set-scope-with-isometric-grid）。范围形状仍是复合资产类别默认
      // （等距地面范围），无需按业务显式声明；通用宿主与 Rust 只消费声明，不按 film-set 业务 ID 分支。
      label: FILM_SET_LABEL,
      projectPresentation(node, data, resource) {
        const object = preview.get(node.id);
        if (!object || !node.compositeAsset) return;
        const decoded = decodeFilmSetNodeData(data);
        if (!decoded.ok) return;
        if (node.compositeAsset.media?.some(plane => plane.itemId === object.itemId)) {
          const content = decoded.value.filmSetContent;
          node.compositeAsset.media = filmSetMediaPlanesForNode({ nodeId: node.id,
            data: { ...data, filmSetContent: { ...content, items: content.items.map(item => item.id === object.itemId ? { ...item, localTransform: object.transform } : item) } } as never,
            contentExtent: resource?.extent,
            readyPlaneIds: new Set(node.compositeAsset.media.filter(plane => plane.hasTexture).map(plane => plane.id))
          });
        }
        if (node.compositeAsset.itemPlacements) {
          const transform = object.transform;
          node.compositeAsset.itemPlacements[encodeFilmSetPartId(object.itemId, "")] = { offset: { ...transform.offset }, scale: transform.scale, yaw: transform.yaw * 180 / Math.PI };
        }
      },
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
        if (state.nodeId !== nodeId || !state.selectedItemId) return null;
        const entry = ctx.canvasRuntime.queryCompositeAssetItemBounds(nodeId).find(item => item.itemId === state.selectedItemId);
        return entry ? { version: MODEL_EDITOR_VERSION, nodeId, toolMode: "object", focus: entry.center, radius: Math.max(0.5, entry.radius) } : null;
      },
      readCameras(_nodeId, data) {
        const decoded = decodeFilmSetNodeData(data);
        if (!decoded.ok) return [];
        return [{ ...decoded.value.sceneCamera, id: "scene-camera", name: "场景镜头", order: 0, elevation: decoded.value.sceneCamera.elevation ?? 0, aspect: decoded.value.sceneCamera.aspect ?? "16:9" }];
      },
      writeCameras(nodeId, cameras) {
        if (cameras.length !== 1 || cameras[0]?.id !== "scene-camera") return false;
        const camera = cameras[0];
        if (!camera) return false;
        const { azimuth, elevation, distance, aspect, focusOffset } = camera;
        return ctx.canvasSession.submitCommands([{ type: "nodeData.patch", nodeId, value: { sceneCamera: { azimuth, elevation, distance, aspect, ...(focusOffset ? { focusOffset } : {}) } } as never }], `film-set-camera-${crypto.randomUUID()}`).ok;
      },
      captureOrigin: (nodeId, cameraId) => ({ nodeData: { filmSetShotOrigin: { filmSetNodeId: nodeId, cameraId, capturedAt: new Date().toISOString() } } as never }),
      awaitCaptureReady: nodeId => ctx.canvasRuntime.compositeAssetMediaSessions?.()?.waitForTime(nodeId, ctx.canvasRuntime.animationPlaybackState()?.time ?? 0, 2500) ?? Promise.resolve(true)
    });
    const disposeTemplate = ctx.slots.register("canvas.node-template", {
      id: "film-set-node", owner: FILM_SET_EXTENSION_ID, nodeType: COMPOSITE_ASSET_NODE_TYPE,
      label: FILM_SET_LABEL, section: CANVAS_MENU_SECTION.creationTools, order: 0,
      createNodeData: () => canonicalFilmSetFields(createFilmSetSnapshot({ title: FILM_SET_LABEL, timeline: { duration: 0, loop: false } })) as never
    });
    const disposeDrop = extendFilmSetDrop(ctx);
    // 直接传递 Cordis `ctx`：它已注入 canvasScope/canvasRemote/canvasLocate/canvasRuntime。
    // MUST NOT 展开（`{ ...ctx }`）——展开只复制自有可枚举属性，会丢掉 ctx 的 service 访问器，
    // 使注册模块读到 undefined 的 canvasScope（此前导致 required film-set 启动失败 → 白屏）。
    const disposeConversion = installFilmSetConversionEntries(ctx);
    const disposeInspector = ctx.slots.register("canvas.overlay", {
      id: "film-set-inspector", owner: FILM_SET_EXTENSION_ID, priority: 20,
      render: ({ writable }) => createElement(FilmSetInspector, { ctx, session: ctx.modelWorkspace.session, captureSession: ctx.modelWorkspace.captureSession,
        objectSession: feature.session, objectAction: feature.action, writable, canvasId: ctx.canvasState.getCanvas()?.id ?? "" })
    });
    ctx.plugin(animationPlaybackExtension());
    // 镜头参考录制调度（任务 8.3）：只维护 dirty 集与触发边界；真实录制由 8.4 注入。
    // 播放时钟显式传入：本插件未声明 `filmSetPlayback` 的 inject，走服务解析会在装配时抛错。
    const shotReferenceRecording = installShotReferenceRecording(ctx, { playback });
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
    ctx.effect(() => () => {
      disposeInspector(); disposeDrop(); disposeConversion(); disposeTemplate(); disposeAdapter();
      stopCameras(); stopObjects(); stopPlayback(); stopHistory(); feature.dispose(); preview.clear();
      shotReferenceRecording.dispose();
      recordingActivity?.stop();
    }, "film-set-contributions");
  }, { name: FILM_SET_EXTENSION_ID, inject: ["dialogs", "slots", "compositeAssets", "canvasState", "canvasSession", "canvasRuntime", "canvasEdit", "canvasNavigation", "mediaRemote", "modelWorkspace", "hoverState", "canvasScope", "canvasRemote", "canvasLocate"] });
}
export const descriptor = defineExtensionFrontend({ ...FILM_SET_FRONTEND_METADATA, plugin: filmSetExtension });

export { FilmSetInspector } from "./inspector.js";
export { FILM_SET_FRONTEND_METADATA } from "./metadata.js";
export { FilmSetAdaptationConfirm, resolveAdaptation } from "./film-set-adaptation.js";
export { FilmSetPlaybackService } from "./playback-service.js";
export type { FilmSetContext } from "./context.js";
