import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
/**
 * 模型编辑 gizmo/镜头 Plugin 生命周期测试
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 2.3）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import {
  createEmptyWoohaa3ServerCanvas,
  decodeModelCameras,
  clampShotDistance,
  makeFocusProjector,
  mapFilmSetSceneCamera,
  resolveShotCamera,
  shotBoundingRadius,
  shotCameraPosition,
  shotFitDistance,
  type BevyModelEditor,
  type ModelCamera,
  type ServerCanvas
} from "@woohaa3/contracts";
import { startFrontendRuntime, type FrontendRuntime } from "../../kernel.js";
import { modelSceneStore } from "../model-scene/model-scene-store.js";
import { SlotRegistry } from "../../slots.js";
import { InputScopeService } from "../../services/input-scopes.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { MODEL_EDITOR_SERVICE } from "../service-keys.js";
import { FocusExitCoordinator } from "../../navigation/exit-coordinator.js";
import { modelEditorExtension, MODEL_EDITOR_PLUGIN_ID } from "./model-editor-plugin.js";
import type { InteractionController, InteractionControllerOptions } from "../canvas-shell/interaction-controller.js";
import { resolveTargets } from "./model-camera-store.js";
import {
  filmSetDisplayRotation,
  filmSetDisplayScale,
  filmSetSceneBounds,
  modelBounds
} from "../canvas-shell/model-focus-session.js";
import { hitShotGizmoHandle } from "../canvas-shell/model-gizmo-hit.js";
import { gizmoHitOracle } from "../canvas-shell/test-support/model-focus-harness.js";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let runtime: FrontendRuntime | null = null;

function modelCanvas(cameras: ModelCamera[] = []): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "m1", type: "model3d", position: { x: 200, y: 100 }, width: 196, height: 64 }] },
    nodeData: { m1: { title: "M", modelScript: "build(()=>{})", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", ...(cameras.length ? { modelCameras: cameras } : {}) } }
  } as ServerCanvas;
}

/** 片场节点（composite-asset + extensionId=film-set）：镜头工具仅在此保留。 */
function filmSetCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "m1", type: "composite-asset", position: { x: 200, y: 100 }, width: 196, height: 64 }] },
    nodeData: { m1: { extensionId: "film-set", title: "F", modelScript: "build(()=>{})", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" } }
  } as ServerCanvas;
}

type FocusState = { nodeId: string | null };
type GizmoState = BevyModelEditor | null;

function fakeCanvasRuntime(focus: FocusState, gizmo: GizmoState, mode: { value: "edit" | "history" }) {
  const listeners = new Set<() => void>();
  let focusGesture: InteractionControllerOptions["focusGesture"] | null = null;
  let shotGesture: InteractionControllerOptions["shotGesture"] | null = null;
  let controller: Pick<InteractionController, "focusProjection" | "surface" | "viewport"> | null = null;
  return {
    state: { focus, gizmo },
    modelFocusProjection: () => (focus.nodeId ? { nodeId: focus.nodeId } : null),
    subscribeModelFocus: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setModelEditor: (editor: BevyModelEditor | null) => {
      gizmo = editor;
    },
    modelEditorState: () => gizmo,
    setModelEditorShotGesture: (handler: InteractionControllerOptions["shotGesture"] | null) => { shotGesture = handler; },
    shotGesture: () => shotGesture,
    setController: (value: typeof controller) => { controller = value; },
    setModelEditorFocusGesture: (handler: InteractionControllerOptions["focusGesture"] | null) => { focusGesture = handler; },
    focusGesture: () => focusGesture,
    setShotWheel: () => undefined,
    controller: () => controller ? { ...controller, flush: () => undefined, invalidate: () => undefined } : null,
    modelFocusMode: () => mode.value,
    runtime: () => ({ isReady: () => true }),
    setContentRect: () => undefined,
    emitFocus: () => {
      for (const listener of listeners) listener();
    }
  };
}

async function harness(canvas: ServerCanvas, mode: { value: "edit" | "history" } = { value: "edit" }, filmSetCameras: ModelCamera[] = []) {
  const slots = new SlotRegistry();
  const focus: FocusState = { nodeId: null };
  let gizmo: GizmoState = null;
  const runtimeService = fakeCanvasRuntime(focus, gizmo, mode);
  const submitted: Array<{ nodeId: string; cameras: ModelCamera[] }> = [];
  // 片场 stub adapter：镜头 CRUD 只在片场检查器中保留
  // （change: 2026-10-18-simplify-model-focus-panel）。
  let cameras = [...filmSetCameras];
  const compositeAssets = new CompositeAssetRegistry();
  compositeAssets.register({
    extensionId: "film-set",
    owner: "film-set",
    executionKey: () => "film-set",
    prepare: () => null,
    readCameras: () => [...cameras],
    writeCameras: (nodeId, next) => {
      cameras = [...next];
      submitted.push({ nodeId, cameras: [...next] });
      return true;
    }
  });
  const focusExit = new FocusExitCoordinator();
  const editBeginCalls: Array<{ nodeId: string; kind: string }> = [];
  const instance = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("compositeAssets" as never, compositeAssets as never);
      ctx.provide("canvasState" as never, { getCanvas: () => woohaa3CanvasStore.getState().canvas, getWorkingCanvas: () => woohaa3CanvasStore.getState().canvas, subscribe: woohaa3CanvasStore.subscribe } as never);
      ctx.provide("slots" as never, slots as never);
      ctx.provide("inputScopes" as never, new InputScopeService() as never);
      ctx.provide("canvasSession" as never, {
        isWritable: () => true,
        subscribe: () => () => undefined,
        submitCommands: (commands: Array<{ nodeId?: string; value?: { modelCameras?: ModelCamera[] } }>) => {
          const patch = commands.find((command) => command.value?.modelCameras);
          if (patch?.nodeId && patch.value?.modelCameras) {
            submitted.push({ nodeId: patch.nodeId, cameras: patch.value.modelCameras });
          }
          return { ok: true };
        }
      } as never);
      ctx.provide("canvasRemote" as never, {
        editBegin: async (input: { nodeId: string; kind: string }) => {
          editBeginCalls.push({ nodeId: input.nodeId, kind: input.kind });
          return { ok: true, value: { baselineContentIdentity: "model-source:test" } };
        },
        editComplete: async () => ({ ok: true, receipt: { status: "completed" } })
      } as never);
      ctx.provide("mediaRemote" as never, {} as never);
      // 对象删除/变换经页面 CanvasEditService 受保护记录
      // （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 4.4）。
      ctx.provide("canvasEdit" as never, {
        record: async () => ({ ok: false, reason: "test: no canvas edit service" })
      } as never);
      ctx.provide("canvasRuntime" as never, runtimeService as never);
      ctx.provide("focusExit" as never, focusExit as never);
      // 模型工具栏 overlay 读取 Navigation panel 以在历史 drawer 打开时让位
      // （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D3）。
      ctx.provide("canvasNavigation" as never, {
        getSnapshot: () => ({ mode: { type: "overview" }, panel: null, menu: null }),
        subscribe: () => () => undefined
      } as never);
      woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    },
    plugins: [
      { id: MODEL_EDITOR_PLUGIN_ID, required: false, plugin: modelEditorExtension({ canvasId: "woohaa3-default-canvas" }) }
    ]
  });
  return { runtime: instance, slots, focus, getGizmo: () => runtimeService.modelEditorState(), runtimeService, submitted, focusExit, editBeginCalls };
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  modelSceneStore.delete("m1");
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

function registerScene(position: [number, number, number] = [0, 0, 0]) {
  modelSceneStore.put("m1", "woohaa-model-scene-ir-v2", [
    {
      t: "box",
      id: "b",
      parent: null,
      position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: null,
      color: "#ffffff",
      size: [1, 1, 1]
    }
  ] as never);
}

describe("ModelEditorPlugin", () => {
  it("激活后注册完整聚焦工作区贡献并提供 capability", async () => {
    registerScene();
    const h = await harness(modelCanvas());
    runtime = h.runtime;
    // change: 2026-10-12-unify-node-editors-and-focus-transitions（design D2/D3）：
    // model-editor 贡献完整 `canvas.focus-workspace`（kind=model），不再单独注册专用 overlay。
    // 工作区 `available` 依赖活动会话，故用未过滤的 owners() 断言注册本身。
    const workspaces = h.slots.owners().filter((entry) => entry.slot === "canvas.focus-workspace");
    expect(workspaces.map((entry) => entry.id)).toContain("model-editor-workspace");
    expect(h.slots.list("canvas.overlay")).toHaveLength(0);
    expect(h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never)).toBeDefined();
    // 片场扩展经 `modelWorkspace.renderGenerate` 渲染生成入口：宿主包裹 `authoring.generate`
    // 贡献并注入 MCP 指引与 Agent 会话能力（design D6/D8），扩展不得直接读 slot。
    const modelWorkspace = h.runtime.ctx.get("modelWorkspace" as never) as unknown as { renderGenerate?: unknown };
    expect(typeof modelWorkspace.renderGenerate).toBe("function");
  });

  it("普通 model3d 聚焦不再推入镜头 gizmo（含历史残留 modelCameras）", async () => {
    registerScene();
    // 旧画布可能残留 modelCameras：普通模型聚焦也不得自动套用拍摄镜头。
    const h = await harness(modelCanvas([{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 6, aspect: "16:9" }]));
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    expect(service.session.getState().nodeId).toBe("m1");
    // change: 2026-10-18-simplify-model-focus-panel —— 普通模型只保留 AI 修改与信息面板。
    expect(h.getGizmo()).toBeNull();
  });

  it("片场聚焦仍推入镜头 gizmo（默认镜头模式）", async () => {
    registerScene();
    // 预置一条镜头：enter 会自动选中，从而立即推入 shot gizmo。
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 6, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    expect(service.session.getState().nodeId).toBe("m1");
    expect(service.session.getState().toolMode).toBe("camera");
    expect(service.session.getState().selectedCameraId).toBe("cam-a");

    const gizmo = h.getGizmo();
    expect(gizmo?.nodeId).toBe("m1");
    expect(gizmo?.toolMode).toBe("camera");
    expect(gizmo?.radius).toBeGreaterThan(0);
    expect(gizmo?.shot).toBeTruthy();
  });

  it.each([0, 65])("片场：偏心场景的聚焦取景与保存镜头一致（显示旋转 %s°）", async (yaw) => {
    registerScene([4, 3, -2]);
    const canvas = filmSetCanvas();
    canvas.nodeData.m1!.modelPlacement = { scale: 0.7, yaw, offset: { x: 0, y: 0, z: 0 } };
    const camera: ModelCamera = { id: "cam-a", name: "镜头", order: 0, azimuth: 0.4, elevation: 0.6,
      distance: 3, aspect: "16:9", focusOffset: { x: 0.3, y: -0.2, z: 0.5 } };
    const h = await harness(canvas, undefined, [camera]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();

    const target = resolveTargets()[0]!;
    const scene = filmSetSceneBounds(target)!;
    expect(Math.hypot(...scene.center)).toBeGreaterThan(1);
    const bounds = modelBounds(target)!;
    const scale = filmSetDisplayScale(target);
    const angle = yaw * Math.PI / 180;
    const offset = camera.focusOffset!;
    // Saved camera offsets are relative to the content center, as in the card rig.
    const focus: [number, number, number] = [
      bounds.center[0] + scale * (Math.cos(angle) * offset.x + Math.sin(angle) * offset.z),
      bounds.center[1] + scale * offset.y,
      bounds.center[2] + scale * (-Math.sin(angle) * offset.x + Math.cos(angle) * offset.z)
    ];
    const distance = clampShotDistance(camera.distance, shotFitDistance(shotBoundingRadius(scene.aabb), 16 / 9)) * scale;
    const azimuth = camera.azimuth + angle;
    const position = shotCameraPosition(focus, azimuth, distance, camera.elevation!);
    const shot = h.getGizmo()!.shot!;
    for (let axis = 0; axis < 3; axis++) {
      expect(shot.focus[axis]).toBeCloseTo(focus[axis]!, 4);
      expect(shot.position[axis]).toBeCloseTo(position[axis]!, 4);
    }
    expect(shot.azimuth).toBeCloseTo(azimuth);
    expect(shot.distance).toBeCloseTo(distance);
    expect(h.submitted).toHaveLength(0);
  });

  it("片场：拖相机沿径向改变距离，拖环改变方位，松开才提交", async () => {
    registerScene();
    // 距离取合法区间的中段，两个方向都有余量（上限为 fit × 2.2）。
    // 镜头距离是**场景单位**（片场内容脚本尺度），不是画布世界单位
    // （change: 2026-10-23-isolate-film-set-camera-space）。
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 3, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const { session } = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    h.runtimeService.setController({
      viewport: () => ({ x: 0, y: 0, zoom: 1 }),
      surface: () => ({ width: 1000, height: 800, pixelRatio: 1 }),
      focusProjection: () => ({
        version: "woohaa-model-focus-v1", nodeId: "m1", target: h.getGizmo()!.shot!.focus,
        yaw: 0, pitch: -0.4, distance: 2000, fov: 0.87, radius: 1
      })
    });
    const gesture = h.runtimeService.shotGesture()!;
    // 距离手势：纵向拖动，向上放大轨道、向下缩小；起始值可能已在钳制边界，只断言方向。
    gesture.begin("distance", { x: 500, y: 400 });
    const startDistance = session.getState().posePreview!.distance;
    gesture.move("distance", { x: 500, y: 300 });
    expect(session.getState().posePreview!.distance).toBeGreaterThanOrEqual(startDistance);
    expect(session.getState().posePreview!.azimuth).toBe(0);
    expect(h.submitted).toHaveLength(0);
    gesture.move("distance", { x: 500, y: 700 });
    expect(session.getState().posePreview!.distance).toBeLessThanOrEqual(startDistance);
    gesture.end();
    expect(h.submitted).toHaveLength(1);
    const distance = session.selectedCamera()!.distance;
    gesture.begin("orbit-ring", { x: 700, y: 300 });
    gesture.move("orbit-ring", { x: 800, y: 300 });
    expect(session.getState().posePreview!.azimuth).not.toBe(0);
    expect(session.getState().posePreview!.distance).toBe(distance);
    gesture.cancel();
    expect(session.getState().posePreview).toBeNull();
    expect(h.submitted).toHaveLength(1);
  });

  it("片场：真实画布平移缩放下，rig 显示坐标与点击坐标一致", async () => {
    registerScene();
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 1, elevation: Math.PI / 4, distance: 240, aspect: "16:9" }]);
    runtime = h.runtime;
    const viewport = { x: 230, y: -80, zoom: 0.75 };
    const surface = { width: 1440, height: 900, pixelRatio: 2 };
    // 从模型及真实画布独立计算渲染器使用的世界包围盒。
    const target = resolveTargets()[0]!;
    const bounds = modelBounds({ ...target, viewport, surface })!;
    const projection = {
      version: "woohaa-model-focus-v1" as const, nodeId: "m1", target: bounds.center,
      yaw: 0, pitch: -0.4, distance: 700, fov: 0.87, radius: bounds.radius
    };
    h.runtimeService.setController({ viewport: () => viewport, surface: () => surface, focusProjection: () => projection });
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const editor = h.getGizmo()!;
    // 镜头以**场景单位**求值，再经与内容同一显示变换映射到画布世界
    // （change: 2026-10-23-isolate-film-set-camera-space，D2）。
    const scene = filmSetSceneBounds(target)!;
    const displayScale = filmSetDisplayScale(target);
    const displayYaw = filmSetDisplayRotation(target);
    expect(displayYaw).toBe(0);
    const sceneFit = shotFitDistance(shotBoundingRadius(scene.aabb), 16 / 9);
    // 与生产同一 clamp：镜头保存 240 场景单位，超出 fit 上限即钳到 fit×2.2。
    const sceneDistance = clampShotDistance(240, sceneFit);
    const sceneShot = resolveShotCamera(scene.aabb, { azimuth: 1, distance: sceneDistance, aspect: "16:9" })!;
    const mapped = mapFilmSetSceneCamera(
      { scale: displayScale, yaw: displayYaw },
      bounds.center,
      { azimuth: sceneShot.azimuth, elevation: sceneShot.elevation, distance: sceneShot.distance, focusOffset: { x: 0, y: 0, z: 0 } }
    )!;
    const worldFocus: [number, number, number] = [
      bounds.center[0] + mapped.focusOffset[0],
      bounds.center[1] + mapped.focusOffset[1],
      bounds.center[2] + mapped.focusOffset[2]
    ];
    const renderedShot = { ...sceneShot, focus: worldFocus, position: shotCameraPosition(worldFocus, sceneShot.azimuth, mapped.distance, sceneShot.elevation) };
    for (let axis = 0; axis < 3; axis += 1) {
      expect(editor.shot!.focus[axis]).toBeCloseTo(renderedShot.focus[axis]!, 4);
      expect(editor.shot!.position[axis]).toBeCloseTo(renderedShot.position[axis]!, 4);
    }
    expect(editor.radius).toBeCloseTo(bounds.radius);
    const project = makeFocusProjector({ camera: { ...projection, flySpeed: 6 }, surface, fov: projection.fov });
    expect(hitShotGizmoHandle({ editor, projection, surface, point: project(renderedShot.position)!, query: gizmoHitOracle })).toBe("distance");
    // 球笼半径 = 相机到焦点的完整距离；赤道环半径为完整距离在水平面的投影。
    const r = Math.hypot(
      renderedShot.position[0] - bounds.center[0],
      renderedShot.position[1] - bounds.center[1],
      renderedShot.position[2] - bounds.center[2]
    );
    const ringPoint = project([bounds.center[0] - r, bounds.center[1], bounds.center[2]])!;
    expect(hitShotGizmoHandle({ editor, projection, surface, point: ringPoint, query: gizmoHitOracle })).toBe("orbit-ring");
  });

  it("片场：注视点偏移传到镜头与 gizmo，拖动预览可取消", async () => {
    registerScene();
    const offset = { x: 10, y: -5, z: 3 };
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 3, aspect: "16:9", focusOffset: offset }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const { session } = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    // focusOffset 是**场景单位**：显示时按同一倍率缩放（D2）。
    const target = resolveTargets()[0]!;
    const scale = filmSetDisplayScale(target);
    const base = h.getGizmo()!.focus;
    const expectFocus = (value: { x: number; y: number; z: number }) => {
      const focus = h.getGizmo()!.shot!.focus;
      expect(focus[0]).toBeCloseTo(base[0] + value.x * scale, 4);
      expect(focus[1]).toBeCloseTo(base[1] + value.y * scale, 4);
      expect(focus[2]).toBeCloseTo(base[2] + value.z * scale, 4);
    };
    expectFocus(offset);
    session.beginFocus();
    session.updateFocus({ x: 20, y: 0, z: -4 });
    expectFocus({ x: 20, y: 0, z: -4 });
    expect(h.submitted).toHaveLength(0);
    session.cancelFocus();
    expectFocus(offset);
  });

  it("片场：中心拖动跟随屏幕平面，支持取消且松开只提交一次", async () => {
    registerScene();
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 240, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const { session } = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    const target = h.getGizmo()!.shot!.focus;
    const projection = { version: "woohaa-model-focus-v1" as const, nodeId: "m1", target, yaw: 0.7, pitch: -0.4, distance: 1000, fov: 0.87, radius: 100 };
    const surface = { width: 1000, height: 800, pixelRatio: 1 };
    h.runtimeService.setController({ viewport: () => ({ x: 0, y: 0, zoom: 1 }), surface: () => surface, focusProjection: () => projection });
    h.runtimeService.emitFocus();
    projection.target = h.getGizmo()!.shot!.focus;
    const project = makeFocusProjector({ camera: { ...projection, flySpeed: 6 }, surface, fov: projection.fov });
    const gesture = h.runtimeService.focusGesture()!;
    expect(gesture.begin("center", { x: 500, y: 400 })).toBe(true);
    gesture.move("center", { x: 550, y: 430 });
    const screen = project(h.getGizmo()!.shot!.focus)!;
    expect(screen.x).toBeCloseTo(550);
    expect(screen.y).toBeCloseTo(430);
    expect(h.submitted).toHaveLength(0);
    gesture.move("center", { x: 500, y: 400 });
    expect(session.getState().focusPreview).toEqual({ x: 0, y: 0, z: 0 });
    gesture.cancel();
    expect(h.submitted).toHaveLength(0);
    gesture.begin("center", { x: 500, y: 400 });
    gesture.move("center", { x: 540, y: 420 });
    gesture.end();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras[0]!.focusOffset).toBeDefined();
  });

  it("聚焦退出时关闭会话并清除 gizmo", async () => {
    registerScene();
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 6, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    expect(h.getGizmo()).not.toBeNull();
    h.focus.nodeId = null;
    h.runtimeService.emitFocus();
    expect(h.getGizmo()).toBeNull();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { getState: () => { nodeId: string | null } };
    expect(service.getState().nodeId).toBeNull();
  });

  it("后退退出聚焦前提交尚未结束的镜头拖动", async () => {
    registerScene();
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 6, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    service.session.beginPose();
    service.session.updatePose({ distance: 9 });
    await expect(h.focusExit.prepare()).resolves.toMatchObject({ ok: true });
    expect(h.submitted.at(-1)?.cameras[0]?.distance).toBe(9);
    expect(service.session.getState().posePreview).toBeNull();
  });

  it("片场：添加镜头提交一次规范化 modelCameras patch 并进入镜头模式", async () => {
    registerScene();
    const h = await harness(filmSetCanvas());
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    service.session.addCamera({ azimuth: 0, distance: 5, seed: "s" });
    const submitted = h.submitted.at(-1);
    expect(submitted?.nodeId).toBe("m1");
    expect(submitted?.cameras).toHaveLength(1);
    // 规范化结果合法。
    expect(decodeModelCameras(submitted!.cameras).ok).toBe(true);
  });

  it("普通 model3d：addCamera 镜像不再写入镜头（change: 2026-10-18-simplify-model-focus-panel）", async () => {
    registerScene();
    const h = await harness(modelCanvas());
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    (globalThis as unknown as { __modelEditor?: { addCamera?: () => void } }).__modelEditor?.addCamera?.();
    expect(h.submitted).toHaveLength(0);
  });

  it("片场：选中镜头后 gizmo 切换为 shot 相机", async () => {
    registerScene();
    const existing: ModelCamera[] = [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0.4, elevation: Math.PI / 4, distance: 5, aspect: "16:9" }];
    const h = await harness(filmSetCanvas(), undefined, existing);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    service.session.setToolMode("camera");
    service.session.selectCamera("cam-a");
    const gizmo = h.getGizmo();
    expect(gizmo?.toolMode).toBe("camera");
    expect(gizmo?.cameraTool).toBe("orbit");
    expect(gizmo?.cameraId).toBe("cam-a");
    expect(gizmo?.shot?.fov).toBeGreaterThan(0);
    expect(gizmo?.shot?.aspect).toBe("16:9");
    expect(gizmo?.shot?.elevation).toBeCloseTo(Math.PI / 4, 6);
  });

  it("片场：切换镜头工具推入 cameraTool（change: fix-model-focus-navigation-and-camera-parity，task 4.4）", async () => {
    registerScene();
    const h = await harness(filmSetCanvas(), undefined, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 5, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    const service = h.runtime.ctx.get(MODEL_EDITOR_SERVICE as never) as unknown as { session: ModelEditorSession };
    service.session.setCameraTool("distance");
    expect(h.getGizmo()?.cameraTool).toBe("distance");
    service.session.setCameraTool("focus");
    expect(h.getGizmo()?.cameraTool).toBe("focus");
  });

  it("dispose 后撤销 overlay、capability 与 gizmo", async () => {
    registerScene();
    const h = await harness(modelCanvas());
    const instance = h.runtime;
    runtime = null;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    await instance.dispose();
    expect(h.slots.list("canvas.overlay")).toHaveLength(0);
  });

  it("同一片场切换编辑/历史模式时清除并恢复投影，普通观察更新不重推", async () => {
    registerScene();
    const mode: { value: "edit" | "history" } = { value: "edit" };
    const h = await harness(filmSetCanvas(), mode, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 5, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    expect(h.getGizmo()?.shot).toBeTruthy();
    const publish = vi.spyOn(h.runtimeService, "setModelEditor");
    h.runtimeService.emitFocus();
    expect(publish).not.toHaveBeenCalled();
    mode.value = "history";
    h.runtimeService.emitFocus();
    expect(h.getGizmo()).toBeNull();
    mode.value = "edit";
    h.runtimeService.emitFocus();
    expect(h.getGizmo()?.shot).toBeTruthy();
    publish.mockClear();
    h.runtimeService.emitFocus();
    expect(publish).not.toHaveBeenCalled();
  });

  it("历史只读：不推编辑 gizmo，且 addCamera 不提交镜头 patch（change: 对齐 xyflow-bevy 历史只读浏览）", async () => {
    registerScene();
    const mode: { value: "edit" | "history" } = { value: "history" };
    const h = await harness(filmSetCanvas(), mode, [{ id: "cam-a", name: "镜头 1", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 5, aspect: "16:9" }]);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    // 历史模式：不显示任何编辑 gizmo。
    expect(h.getGizmo()).toBeNull();
    // 镜像 addCamera 在历史模式下不提交。
    (globalThis as unknown as { __modelEditor?: { addCamera?: () => void } }).__modelEditor?.addCamera?.();
    expect(h.submitted).toHaveLength(0);
  });

  it("空模型脚本片场：不建立无内容的模型归档会话，退出协调可直接结算（change: 2026-10-10，design D4）", async () => {
    registerScene();
    const base = createEmptyWoohaa3ServerCanvas("woohaa3-default-canvas", "2026-09-27T00:00:00.000Z");
    const compositeAsset: ServerCanvas = {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [{ id: "m1", type: "composite-asset", position: { x: 200, y: 100 }, width: 196, height: 64 }] },
      nodeData: { m1: { extensionId: "film-set", title: "空片场", modelScript: "", modelScriptLanguage: "", modelScriptVersion: "woohaa-model-js-v2", filmSetContent: { schemaVersion: 2, items: [] } } }
    } as ServerCanvas;
    const h = await harness(compositeAsset);
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    // 进入聚焦但无可归档模型内容：不得发起 editBegin，也不得标记未结算变化。
    expect(h.editBeginCalls).toEqual([]);
    expect(h.focusExit.hasUnsavedChanges()).toBe(false);
    // 受控退出协调可直接成功（blocker 曾是「节点当前无可归档内容」）。
    await expect(h.focusExit.prepare()).resolves.toMatchObject({ ok: true });
  });

  it("有模型脚本的节点：建立归档会话并报告未结算变化（与片场空内容区分）", async () => {
    registerScene();
    const h = await harness(modelCanvas());
    runtime = h.runtime;
    h.focus.nodeId = "m1";
    h.runtimeService.emitFocus();
    expect(h.editBeginCalls).toEqual([{ nodeId: "m1", kind: "model" }]);
    expect(h.focusExit.hasUnsavedChanges()).toBe(true);
  });
});
