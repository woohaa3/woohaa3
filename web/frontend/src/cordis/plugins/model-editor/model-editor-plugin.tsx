import { lazy, Suspense } from "react";
/**
 * 模型编辑 gizmo 与镜头工具栏 Plugin
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 2.3 / 3.2 / 4.x）。
 *
 * 拥有模型聚焦编辑期间的编辑会话（工具模式、镜头 CRUD/pose preview、截图状态）：
 * - 进入/退出聚焦时开合会话；
 * - 把 `BevyModelEditor`（模型 gizmo 或选中镜头的 shot gizmo）推给 canvas runtime；
 * - 贡献完整聚焦工作区（`canvas.focus-workspace`，kind=model）：专用镜头工具/取景控件 + 检查器；
 * - 截图：`captureSink`（Bevy/测试注入）→ Media 上传 → 原子 `asset.upsert + node.add`。
 *
 * 只持有浏览器本地状态；canonical `modelCameras` 由画布命令写入，绝不进 Y.Doc 之外的
 * 第二份持久状态。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import type { BevyModelEditor, ModelCamera } from "@woohaa3/contracts";
import {
  hashModelScript,
  modelContentIdentity,
  decodeModelPlacement,
  azimuthFromHorizontalDrag,
  clampShotDistance,
  distanceFromDrag,
  elevationFromVerticalDrag,
  focusRay,
  rayPlanePoint,
  makeFocusProjector,
  modelCameraFocusOffset,
  shotBoundingRadius,
  shotFitDistance,
  unmapFilmSetSceneVector,
} from "@woohaa3/contracts";
import { shotDragDirection } from "./shot-drag-direction.js";
import { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import { AuthoringGenerateHost } from "../../host.js";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import { ModelShotCaptureSession } from "./model-shot-capture.js";
import {
  addCamera,
  defaultDistanceForNode,
  pushEditor,
  readCameras,
  resolveTargets,
  shotModelForNode,
  submitCameras
} from "./model-camera-store.js";
import { captureSelected, renderWithBevy, acquireCaptureLock } from "./model-shot-capture-run.js";
import type { InteractionControllerOptions } from "../canvas-shell/interaction-controller.js";
import { filmSetDisplayRotation, filmSetDisplayScale } from "../canvas-shell/model-focus-session.js";
import { isModelEditorNodeType } from "../canvas-shell/model-focus-targets.js";

type ShotGestureHandler = NonNullable<InteractionControllerOptions["shotGesture"]>;
type ShotFocusGestureHandler = NonNullable<InteractionControllerOptions["focusGesture"]>;
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { MODEL_EDITOR_SERVICE, type ModelEditorService } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";

// Camera controls and the focused workspace load when their renderer is opened.
const ModelEditorToolbar = lazy(() => import("./model-editor-toolbar.js").then(module => ({ default: module.ModelEditorToolbar })));
const ModelCameraPreview = lazy(() => import("./model-camera-preview.js").then(module => ({ default: module.ModelCameraPreview })));
const ModelEditorWorkspace = lazy(() => import("./model-editor-workspace.js").then(module => ({ default: module.ModelEditorWorkspace })));

export const MODEL_EDITOR_PLUGIN_ID = "model-editor";
const MODEL_EDITOR_WORKSPACE_ID = "model-editor-workspace";

export type ModelEditorPluginOptions = {
  canvasId?: string;
  /** 截图实现（Bevy/测试注入）；缺省提示「截图不可用」。 */
  captureSink?: (input: { nodeId: string; camera: ModelCamera; shot: NonNullable<BevyModelEditor["shot"]> }) => Promise<{ ok: true; blob: Blob } | { ok: false; code: string; message: string }>;
  /** 镜头 ID 生成熵（测试确定性）。 */
  cameraSeed?: () => string;
};

export function modelEditorExtension(options: ModelEditorPluginOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const session = new ModelEditorSession({
        readCameras: (nodeId) => readCameras(nodeId, ctx),
        isWritable: () => ctx.canvasSession.isWritable(),
        submitCameras: (nodeId, cameras) => submitCameras(ctx, nodeId, cameras),
        revokeObjectUrl: (url) => URL.revokeObjectURL?.(url)
      });

      /**
       * 当前是否历史只读浏览（change: 对齐 xyflow-bevy 历史只读浏览）。
       * 历史 owner 活跃时禁止一切模型/镜头写入：不推 gizmo、禁镜头 CRUD/pose/焦点手势、禁截图。
       */
      const isHistoryMode = (): boolean => ctx.canvasRuntime.modelFocusMode() === "history";

      // 聚焦投影变化：进入时开会话，退出时关会话并清除 gizmo。
      // 同一节点、同一 owner 的朝向/距离变化不重推 gizmo；历史切换仍需清除/恢复投影。
      let previousHistoryMode = isHistoryMode();
      const unsubscribeFocus = ctx.canvasRuntime.subscribeModelFocus(() => {
        const historyMode = isHistoryMode();
        const ownerChanged = historyMode !== previousHistoryMode;
        previousHistoryMode = historyMode;
        const candidate = ctx.canvasRuntime.modelFocusProjection()?.nodeId ?? null;
        const currentCanvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const focused = currentCanvas?.document.nodes.some(node => node.id === candidate && isModelEditorNodeType(node.type, currentCanvas?.nodeData?.[node.id])) ? candidate : null;
        const current = session.getState().nodeId;
        if (focused && focused !== current) {
          session.enter(focused);
          beginModelSession(focused);
          pushEditor(ctx, session);
          return;
        }
        if (focused && ownerChanged) {
          pushEditor(ctx, session);
        }
        if (!focused && current) {
          session.exit();
          ctx.canvasRuntime.setModelEditor(null);
        }
      });
      ctx.effect(() => () => unsubscribeFocus(), "model-editor-focus");

      // 镜头 pose 手势：命中 shot gizmo 时由控制器回调；实际 preview/commit 走会话。
      //
      // 片场镜头是**场景单位**：手势按下时冻结当前容器显示变换（倍率 + 旋转），所有世界位移
      // 都逆映射回场景后提交；容器 resize / owner 切换立即取消手势，绝不把混合坐标写入作品
      // （change: 2026-10-23-isolate-film-set-camera-space，design D3）。
      let activeShotHandle: "orbit-ring" | "elevation-ring" | "distance" | null = null;
      type ShotGestureStart = {
        azimuth: number;
        elevation: number;
        /** 场景单位距离（提交值）。 */
        distance: number;
        aspect: import("@woohaa3/contracts").ModelCameraAspect;
        x: number;
        y: number;
        orbitDirection: number;
        radial: { x: number; y: number; length: number } | null;
        /** 场景 → 画布世界的显示变换（按下时冻结；非法即不开始手势）。 */
        display: { scale: number; yaw: number };
        /** 场景单位 fit 距离（合法范围基准）。 */
        sceneFit: number;
        nodeId: string;
      };
      let shotStart: ShotGestureStart | null = null;

      /** 当前节点的显示变换与场景 fit；非法/非片场返回 null。 */
      const shotDisplayFor = (nodeId: string | null): { display: { scale: number; yaw: number }; sceneFit: number } | null => {
        const target = nodeId ? resolveTargets(ctx).find((entry) => entry.nodeId === nodeId) : null;
        if (!target) return null;
        const scale = filmSetDisplayScale(target);
        const yaw = filmSetDisplayRotation(target);
        if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(yaw)) return null;
        const model = shotModelForNode(nodeId, ctx);
        const sceneFit = model ? shotFitDistance(shotBoundingRadius(model.aabb)) : 1;
        return { display: { scale, yaw }, sceneFit };
      };

      const cancelShotGesture = () => {
        activeShotHandle = null;
        shotStart = null;
        session.cancelPose();
      };
      const shotGesture: ShotGestureHandler = {
        begin: (handle, point) => {
          if (isHistoryMode()) return false;
          const selected = session.selectedCamera();
          if (!selected) return false;
          const nodeId = session.getState().nodeId;
          if (!nodeId) return false;
          // 显示变换缺失/非法时拒绝开始：不构造混合坐标的预览。
          const mapping = shotDisplayFor(nodeId);
          if (!mapping) return false;
          activeShotHandle = handle;
          const projection = ctx.canvasRuntime.controller()?.focusProjection();
          const editor = ctx.canvasRuntime.modelEditorState();
          const surface = ctx.canvasRuntime.controller()?.surface();
          const project = projection && surface
            ? makeFocusProjector({ camera: { ...projection, flySpeed: 6 }, surface, fov: projection.fov })
            : null;
          const center = project && editor?.shot ? project(editor.shot.focus) : null;
          const orbitDirection = project && editor?.shot
            ? shotDragDirection(editor.shot.focus, editor.shot.position, project) : 1;
          const length = center ? Math.hypot(point.x - center.x, point.y - center.y) : 0;
          const radial = center && length > 1
            ? { x: (point.x - center.x) / length, y: (point.y - center.y) / length, length }
            : null;
          // 手势起点始终使用**场景单位**规范值（不是映射后的世界距离），保证“按下一屏推拉”换算与
          // 保存值一致。
          const pose = session.effectivePose(selected);
          shotStart = {
            ...pose,
            distance: pose.distance,
            x: point.x,
            y: point.y,
            orbitDirection,
            radial,
            display: mapping.display,
            sceneFit: mapping.sceneFit,
            nodeId
          };
          session.beginPose();
          return true;
        },
        move: (handle, point) => {
          if (!shotStart) return;
          // 手势期间容器/内容映射必须仍然成立：任何变化都取消手势，不提交混合坐标。
          const current = shotDisplayFor(shotStart.nodeId);
          if (!current
            || Math.abs(current.display.scale - shotStart.display.scale) > 1e-9
            || Math.abs(current.display.yaw - shotStart.display.yaw) > 1e-9) {
            cancelShotGesture();
            return;
          }
          const surface = ctx.canvasRuntime.controller()?.surface() ?? { width: 1, height: 1, pixelRatio: 1 };
          const fit = shotStart.sceneFit;
          if (handle === "orbit-ring") {
            const azimuth = azimuthFromHorizontalDrag(shotStart.azimuth, (point.x - shotStart.x) * shotStart.orbitDirection, surface.width);
            session.updatePose({ azimuth, distance: shotStart.distance });
            return;
          }
          if (handle === "elevation-ring") {
            // 竖直半圆：纵向拖动改变仰角，一屏 180°，并钳入奇点容差。
            const elevation = elevationFromVerticalDrag(shotStart.elevation, point.y - shotStart.y, surface.height);
            session.updatePose({ azimuth: shotStart.azimuth, elevation, distance: shotStart.distance });
            return;
          }
          // 推拉：屏幕位移先按显示倍率还原成**场景单位**距离变化，再做场景单位 clamp。
          // 沿按下点到焦点的屏幕径向缩放；向外拖放大轨道，向内拖缩小。
          const radial = shotStart.radial;
          const outward = radial
            ? (point.x - shotStart.x) * radial.x + (point.y - shotStart.y) * radial.y
            : 0;
          const sceneStart = shotStart.distance;
          let distance: number;
          if (radial) {
            const worldDelta = sceneStart * (1 + outward / radial.length);
            distance = clampShotDistance(worldDelta, fit);
          } else {
            const worldDistance = distanceFromDrag({
              startDistance: sceneStart,
              deltaPixels: point.y - shotStart.y,
              surfaceHeight: surface.height,
              fitDistance: fit
            });
            distance = clampShotDistance(worldDistance, fit);
          }
          session.updatePose({ azimuth: shotStart.azimuth, distance });
        },
        end: () => {
          activeShotHandle = null;
          shotStart = null;
          session.endPose();
        },
        cancel: cancelShotGesture
      };
      void activeShotHandle;
      ctx.canvasRuntime.setModelEditorShotGesture(shotGesture);
      ctx.effect(() => () => ctx.canvasRuntime.setModelEditorShotGesture(null), "model-editor-shot-gesture");

      // 焦点三轴/中心位移手势（change: 模型编辑 gizmo 焦点）：命中轴后在起始焦点处冻结；
      // 屏幕轴约束由 Rust 用同一相机/bounds/gizmo 投影派生（design D5：约束来自同一 query
      // generation，不重建相机矩阵）；中心拖动在按下时固定经过注视点的屏幕平面。
      //
      // 片场焦点偏移是**场景单位**：世界位移必须经按下时冻结的显示变换逆映射后提交
      // （change: 2026-10-23-isolate-film-set-camera-space，design D3）。
      let focusStart:
        | { axis: "x" | "y" | "z" | "center"; planePoint?: (point: { x: number; y: number }) => import("@woohaa3/contracts").Vec3 | null; startWorld?: import("@woohaa3/contracts").Vec3; point: { x: number; y: number }; offset: { x: number; y: number; z: number }; direction?: [number, number]; worldPerPixel?: number; display: { scale: number; yaw: number }; nodeId: string }
        | null = null;
      /** 焦点手势逆映射：世界位移 → 场景位移（identity 表示非片场节点，保持原语义）。 */
      const focusDisplayFor = (nodeId: string | null): { scale: number; yaw: number } | null => {
        const target = nodeId ? resolveTargets(ctx).find((entry) => entry.nodeId === nodeId) : null;
        if (!target) return { scale: 1, yaw: 0 };
        const scale = filmSetDisplayScale(target);
        const yaw = filmSetDisplayRotation(target);
        if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(yaw)) return null;
        return { scale, yaw };
      };
      const unmapFocusDelta = (display: { scale: number; yaw: number }, delta: import("@woohaa3/contracts").Vec3): import("@woohaa3/contracts").Vec3 | null =>
        unmapFilmSetSceneVector({ scale: display.scale, yaw: display.yaw }, delta);
      const cancelFocusGesture = () => {
        focusStart = null;
        session.cancelFocus();
        pushEditor(ctx, session);
      };
      const focusGesture: ShotFocusGestureHandler = {
        begin: (axis, point) => {
          if (isHistoryMode()) return false;
          const selected = session.selectedCamera();
          if (!selected) return false;
          const editor = ctx.canvasRuntime.modelEditorState();
          if (!editor?.shot) return false;
          const nodeId = session.getState().nodeId;
          if (!nodeId) return false;
          const display = focusDisplayFor(nodeId);
          if (!display) return false;
          const projection = ctx.canvasRuntime.controller()?.focusProjection() ?? null;
          const surface = ctx.canvasRuntime.controller()?.surface() ?? { width: 1, height: 1, pixelRatio: 1 };
          if (!projection) return false;
          const camera = {
            target: projection.target,
            yaw: projection.yaw,
            pitch: projection.pitch,
            distance: projection.distance,
            flySpeed: 6
          };
          if (axis === "center") {
            // 中心拖动：固定按下时的观察相机与经过注视点的屏幕平面，避免预览更新造成漂移。
            const normal = focusRay({
              point: { x: surface.width / 2, y: surface.height / 2 },
              size: surface,
              camera,
              fov: projection.fov
            }).direction;
            const planeOrigin: import("@woohaa3/contracts").Vec3 = [...editor.shot.focus];
            const planePoint = (at: { x: number; y: number }) =>
              rayPlanePoint(focusRay({ point: at, size: surface, camera, fov: projection.fov }), planeOrigin, normal);
            const startWorld = planePoint(point);
            if (!startWorld || !session.beginFocus()) return false;
            focusStart = { axis, planePoint, startWorld, point, offset: modelCameraFocusOffset(selected), display, nodeId };
            return true;
          }
          // 轴拖动约束由 Rust 用同一相机/bounds/gizmo 投影派生。
          const result = ctx.canvasRuntime.queryGizmoHit({
            kind: "focus",
            editor,
            projection,
            surface,
            point
          });
          const constraint = result?.available ? result.constraint : null;
          if (!constraint) return false;
          if (!session.beginFocus()) return false;
          focusStart = {
            axis,
            point,
            offset: modelCameraFocusOffset(selected),
            direction: constraint.direction,
            worldPerPixel: constraint.worldPerPixel,
            display,
            nodeId
          };
          return true;
        },
        move: (axis, point) => {
          if (!focusStart || focusStart.axis !== axis) return;
          // 手势期间显示映射必须仍然成立：容器 resize / owner 切换立即取消，不提交混合坐标。
          const current = focusDisplayFor(focusStart.nodeId);
          if (!current
            || Math.abs(current.scale - focusStart.display.scale) > 1e-9
            || Math.abs(current.yaw - focusStart.display.yaw) > 1e-9) {
            cancelFocusGesture();
            return;
          }
          if (axis === "center") {
            const world = focusStart.planePoint?.(point);
            if (!world || !focusStart.startWorld) return;
            const delta = unmapFocusDelta(focusStart.display, [
              world[0] - focusStart.startWorld[0],
              world[1] - focusStart.startWorld[1],
              world[2] - focusStart.startWorld[2]
            ]);
            if (!delta) return;
            session.updateFocus({
              x: focusStart.offset.x + delta[0],
              y: focusStart.offset.y + delta[1],
              z: focusStart.offset.z + delta[2]
            });
            return;
          }
          // 轴坐标沿该轴方向投影：世界位移 = 投影像素 × worldPerPixel；
          // 再按同一显示变换逆映射回场景单位（含容器旋转）。
          const direction = focusStart.direction;
          const worldPerPixel = focusStart.worldPerPixel;
          if (!direction || worldPerPixel === undefined) return;
          const projected =
            (point.x - focusStart.point.x) * direction[0]
            + (point.y - focusStart.point.y) * direction[1];
          const deltaWorld = projected * worldPerPixel;
          if (!Number.isFinite(deltaWorld)) return;
          const axisUnit: import("@woohaa3/contracts").Vec3 =
            axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
          const delta = unmapFocusDelta(focusStart.display, [
            axisUnit[0] * deltaWorld,
            axisUnit[1] * deltaWorld,
            axisUnit[2] * deltaWorld
          ]);
          if (!delta) return;
          session.updateFocus({
            x: focusStart.offset.x + delta[0],
            y: focusStart.offset.y + delta[1],
            z: focusStart.offset.z + delta[2]
          });
        },
        end: () => {
          focusStart = null;
          session.endFocus();
          pushEditor(ctx, session);
        },
        cancel: cancelFocusGesture
      };
      ctx.canvasRuntime.setModelEditorFocusGesture(focusGesture);
      ctx.effect(() => () => ctx.canvasRuntime.setModelEditorFocusGesture(null), "model-editor-focus-gesture");

      // 权威画布/模型内容变化 → 镜头列表与 gizmo 取景同步。
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => pushEditor(ctx, session));
      ctx.effect(() => () => unsubscribeCanvas(), "model-editor-canvas");

      // 截图会话：capture → Media 上传 → 原子 asset.upsert + node.add + edge.add（任务 4.1–4.3）。
      const captureSession = new ModelShotCaptureSession({
        render: async ({ nodeId, cameraId, captureId }) => {
          const playback = ctx.canvasRuntime.animationPlaybackState();
          if (cameraId.startsWith("clip:") && playback?.nodeId === nodeId && playback.viewMode === "focus-preview") {
            return renderWithBevy(ctx, { captureId, nodeId, shot: { ...playback.initialCamera, focus: playback.initialCamera.focusOffset, aspect: playback.initialCamera.aspect ?? "16:9" } as never });
          }
          const editor = ctx.canvasRuntime.modelEditorState();
          const selected = session.cameras().find((camera) => camera.id === cameraId);
          if (!editor?.shot || !selected) return { ok: false as const, code: "invalid-target", message: "镜头不可用" };
          if (options.captureSink) {
            return options.captureSink({ nodeId, camera: selected, shot: editor.shot });
          }
          // 缺省走同一 Bevy renderer 的离屏目标（任务 3.3/3.4）。
          return renderWithBevy(ctx, { captureId, nodeId, shot: editor.shot });
        },
        upload: async (blob) => {
          const file = new File([blob], "model-shot.png", { type: "image/png" });
          // 截图会成为画布资产：必须带画布提示，否则远端画布的字节会落到本机主存储，
          // 其他协作者（以及本机之外的任何设备）都读不到这张图。
          const canvasId = (workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas)?.id;
          const result = await ctx.mediaRemote.upload({ file, ...(canvasId ? { canvasId } : {}) });
          return result.ok ? { ok: true as const, media: result.media } : { ok: false as const, message: result.error };
        },
        readSource: (nodeId) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
          const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
          return node ? { position: { x: node.position.x, y: node.position.y }, width: node.width ?? 248 } : null;
        },
        findNode: (nodeId) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
          return canvas?.document.nodes.some((entry) => entry.id === nodeId) ?? false;
        },
        submit: (commands, commandId) => {
          const result = ctx.canvasSession.submitCommands(commands, commandId);
          return result.ok ? { ok: true, settled: result.handle.settled } : { ok: false, message: result.reason };
        },
        captureOrigin: (nodeId, cameraId) => ctx.compositeAssets.resolve(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), nodeId)?.captureOrigin?.(nodeId, cameraId) ?? null,
        awaitCompositeAssetMediaReady: nodeId => ctx.compositeAssets.resolve(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), nodeId)?.awaitCaptureReady?.(nodeId) ?? Promise.resolve(true),
        isWritable: () => ctx.canvasSession.isWritable()
      });

      ctx.provide("modelWorkspace" as never, {
        session, captureSession,
        defaultDistance: (nodeId: string) => defaultDistanceForNode(nodeId, ctx),
        addCamera: () => addCamera(ctx, session),
        capture: () => captureSelected(ctx, session, captureSession),
        acquireCapture: acquireCaptureLock,
        refreshGizmo: () => pushEditor(ctx, session),
        // 扩展（如片场检查器）拥有布局时经此渲染生成入口：宿主包裹 `authoring.generate`
        // 贡献并注入目标身份、MCP 指引与 Agent 会话能力（design D6/D8），避免扩展直接读 slot
        // 而漏掉会话注入、看不到详情入口。
        renderGenerate: (input: AuthoringGenerationProps) => <AuthoringGenerateHost {...input} />,
        renderCameraPanel: (input: Parameters<import("../../../extension-api/model-workspace.js").ModelWorkspaceService["renderCameraPanel"]>[0]) => <Suspense fallback={null}><ModelEditorToolbar session={session}
          {...input} rendererReady={ctx.canvasRuntime.runtime()?.isReady() ?? false}
          defaultDistance={defaultDistanceForNode(session.getState().nodeId ?? "", ctx)} onAddCamera={() => addCamera(ctx, session)}
          onCapture={() => void captureSelected(ctx, session, captureSession)} onRetryCapture={() => void captureSelected(ctx, session, captureSession)} /></Suspense>,
        renderCameraPreview: (readOnly: boolean) => <Suspense fallback={null}><ModelCameraPreview session={session} readOnly={readOnly} /></Suspense>
      } as never);

      // 完整聚焦工作区（change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D3）：
      // model-editor 拥有完整界面（公共顶部栏 + 检查器），kind=model；普通模型只保留 AI 修改与
      // 模型信息，片场仍由扩展检查器承载对象/镜头/动画（change: 2026-10-18-simplify-model-focus-panel）。
      const removeWorkspace = ctx.slots.register("canvas.focus-workspace", {
        id: MODEL_EDITOR_WORKSPACE_ID,
        owner: MODEL_EDITOR_PLUGIN_ID,
        kind: "model",
        available: () => session.getState().nodeId !== null,
        render: ({ writable }) => <Suspense fallback={null}><ModelEditorWorkspace ctx={ctx} session={session} writable={writable} {...(options.canvasId ? { canvasId: options.canvasId } : {})} /></Suspense>
      });
      ctx.effect(() => () => removeWorkspace(), "model-editor-workspace");

      // 编辑态变化更新 shot rig；有选中镜头时它就是主画面。
      const unsubscribeEditor = session.subscribe(() => {
        pushEditor(ctx, session);
      });
      ctx.effect(() => () => unsubscribeEditor(), "model-editor-projection");

      // feature capability：供测试/其它 feature 读取状态与关闭。
      ctx.provide(MODEL_EDITOR_SERVICE as never, {
        session,
        close: () => {
          session.exit();
          ctx.canvasRuntime.setModelEditor(null);
        },
        getState: () => session.getState()
      } as ModelEditorService as never);

      // ── 会话级最终归档（change: 图片聚焦编辑，design D5/D6） ──────────────────────
      // 进入模型聚焦时 lazily begin 编辑会话；退出经统一退出协调在返回时归档一次最终版本。
      // 会话内 placement/camera 手势仍及时 durable 提交 canonical（下一帧 flush），此处只登记
      // 会话关联，不推进 revision。
      const canvasId = options.canvasId ?? "default";
      let modelSessionId: string | null = null;
      let modelRequestId: string | null = null;
      let modelBegin: ReturnType<typeof ctx.canvasRemote.editBegin> | null = null;
      let baselineSourceHash = "";

      const beginModelSession = (nodeId: string) => {
        if (isHistoryMode()) return;
        if (modelSessionId && session.getState().nodeId === nodeId) return;
        modelSessionId = `model-session-${globalThis.crypto?.randomUUID?.() ?? `${nodeId}-${Date.now().toString(36)}`}`;
        modelRequestId = null;
        const data = (workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas)?.nodeData[nodeId] as Record<string, unknown> | undefined;
        const source = typeof data?.modelScript === "string" ? data.modelScript : "";
        baselineSourceHash = hashModelScript(source);
        // 无可归档模型内容（如模型脚本为空的片场：对象/镜头编辑走各自的受保护命令）时不建立
        // 归档会话：否则聚焦退出会被无意义的「模型编辑会话」永久占据、无法结算
        // （change: 2026-10-10-improve-film-set-editing-and-inspector，design D4）。
        if (source === "") {
          modelSessionId = null;
          modelBegin = null;
          return;
        }
        modelBegin = ctx.canvasRemote
          .editBegin({
            canvasId,
            nodeId,
            sessionId: modelSessionId,
            requestId: `begin:${modelSessionId}`,
            kind: "model",
            baselineContentIdentity: modelContentIdentity(baselineSourceHash, decodeModelPlacement(data?.modelPlacement) ?? undefined)
          });
        void modelBegin.catch(() => undefined);
      };

      const modelExitParticipant = ctx.focusExit.register({
        id: `${MODEL_EDITOR_PLUGIN_ID}-session`,
        hasUnsavedChanges: () => modelSessionId !== null && session.getState().nodeId !== null,
        prepare: async () => {
          const nodeId = session.getState().nodeId;
          const sessionId = modelSessionId;
          if (!nodeId || !sessionId) return { ok: true };
          const begun = await modelBegin;
          if (!begun?.ok) return { ok: false, reason: begun && !begun.ok ? begun.error : "编辑会话尚未就绪" };
          const data = (workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas)?.nodeData[nodeId] as Record<string, unknown> | undefined;
          const finalSourceHash = hashModelScript(typeof data?.modelScript === "string" ? data.modelScript : "");
          modelRequestId = modelRequestId ?? `model-complete-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
          const result = await ctx.canvasRemote.editComplete?.({
            canvasId,
            nodeId,
            sessionId,
            requestId: modelRequestId,
            kind: "model",
            baselineContentIdentity: begun.value.baselineContentIdentity,
            model: { baselineSourceHash, finalSourceHash }
          });
          if (result && !result.ok) return { ok: false, reason: result.error };
          modelSessionId = null;
          modelRequestId = null;
          return { ok: true };
        },
        abandon: () => {
          modelSessionId = null;
          modelRequestId = null;
        }
      });

      // E2E/排障镜像（生产无副作用）。
      (globalThis as unknown as { __modelEditorState?: unknown }).__modelEditorState = () => session.getState();
      (globalThis as unknown as { __modelEditorGizmo?: unknown }).__modelEditorGizmo = () =>
        ctx.canvasRuntime.modelEditorState();
      (globalThis as unknown as { __modelEditor?: unknown }).__modelEditor = {
        state: () => session.getState(),
        gizmo: () => ctx.canvasRuntime.modelEditorState(),
        cameras: () => session.cameras(),
        mode: () => ctx.canvasRuntime.modelFocusMode(),
        addCamera: () => addCamera(ctx, session),
        selectCamera: (id: string) => session.selectCamera(id),
        removeCamera: (id: string) => session.removeCamera(id),
        setToolMode: (mode: "model" | "camera") => session.setToolMode(mode),
        capture: () => captureSelected(ctx, session, captureSession, options.canvasId)
      };

      return () => {
        modelExitParticipant();
        removeWorkspace();
        unsubscribeFocus();
        unsubscribeEditor();
        unsubscribeCanvas();
        session.exit();
      };
    },
    { name: MODEL_EDITOR_PLUGIN_ID, inject: ["canvasState", "compositeAssets", "slots", "canvasRuntime", "canvasRemote", "canvasSession", "canvasEdit", "mediaRemote", "focusExit", "canvasNavigation"] }
  );
}

// 镜头存取/目标解析/gizmo 派生与截图实现见同目录模块
// （change: 2026-09-28-split-frontend-god-plugins，task 4.5）。
