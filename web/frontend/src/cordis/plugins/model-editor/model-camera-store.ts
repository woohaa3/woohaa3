import { isFilmSetGroupNode } from "@woohaa3/contracts";
/**
 * 模型镜头存取、目标解析与 gizmo 派生
 * （change: 2026-09-28-split-frontend-god-plugins，task 4.5；从 model-editor-plugin 拆出）。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  MODEL_EDITOR_VERSION,
  clampShotDistance,
  filmSetDisplayTransform,
  mapFilmSetSceneCamera,
  shotCameraPosition,
  modelCameraAspectRatio,
  resolveShotCamera,
  shotBoundingRadius,
  shotFitDistance,
  type Aabb,
  type BevyModelEditor,
  type ModelCamera,
  type Vec3
} from "@woohaa3/contracts";
import {
  filmSetDisplayRotation,
  filmSetDisplayScale,
  filmSetSceneBounds,
  modelBounds,
  type FocusTargetInput,
  type ModelBounds
} from "../canvas-shell/model-focus-session.js";
import { resolveModelFocusTargets } from "../canvas-shell/model-focus-targets.js";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";
import { modelSceneStore } from "../model-scene/model-scene-store.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";

let cameraSeq = 0;

export function readCameras(nodeId: string, ctx?: Context): ModelCamera[] {
  const liveCanvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  const canvas = ctx?.compositeAssets.projectCanvas(liveCanvas) ?? liveCanvas;
  const adapter = ctx?.compositeAssets.resolve(canvas, nodeId);
  if (adapter?.readCameras && canvas?.nodeData[nodeId]) return adapter.readCameras(nodeId, canvas.nodeData[nodeId]);
  if (canvas?.document.nodes.find(node => node.id === nodeId)?.type === "composite-asset") return [];
  const data = canvas?.nodeData[nodeId] as { modelCameras?: unknown } | undefined;
  return Array.isArray(data?.modelCameras) ? (data.modelCameras as ModelCamera[]) : [];
}

export function submitCameras(ctx: Context, nodeId: string, cameras: readonly ModelCamera[]): boolean | Promise<boolean> {
  if (!ctx.canvasSession.isWritable()) return false;
  const adapter = ctx.compositeAssets.resolve(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), nodeId);
  if (adapter?.writeCameras) return adapter.writeCameras(nodeId, cameras);
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (canvas?.document.nodes.find(node => node.id === nodeId)?.type !== "model3d") return false;
  const result = ctx.canvasSession.submitCommands(
    [{ type: "nodeData.patch", nodeId, value: { modelCameras: [...cameras] } as never }],
    `web-model-cameras-${Date.now().toString(36)}-${cameraSeq++}`
  );
  return result.ok;
}

export function resolveTargets(ctx?: Context): FocusTargetInput[] {
  const controller = ctx?.canvasRuntime.controller();
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  if (!canvas) return [];
  return resolveModelFocusTargets({
    canvas,
    viewport: controller?.viewport() ?? { x: 0, y: 0, zoom: 1 },
    surface: controller?.surface() ?? { width: 1, height: 1 },
    resources: (ctx?.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined)?.getResources() ?? modelSceneStore.snapshot()
  });
}

export function defaultDistanceForNode(nodeId: string, ctx?: Context): number {
  const target = resolveTargets(ctx).find((entry) => entry.nodeId === nodeId);
  if (!target) return shotFitDistance(1);
  // 片场：默认取景按**场景单位**包围球派生，不读节点矩形
  // （change: 2026-10-23-isolate-film-set-camera-space，design D3）。
  const scene = filmSetSceneBounds(target);
  if (scene) return shotFitDistance(shotBoundingRadius(scene.aabb));
  const bounds = modelBounds(target);
  const radius = bounds ? shotBoundingRadius(bounds.aabb) : 1;
  return shotFitDistance(radius);
}

/**
 * 是否为片场业务节点（`composite-asset` + `extensionId="film-set"`）。
 *
 * 普通 `model3d` 已移除镜头控制（change: 2026-10-18-simplify-model-focus-panel）：gizmo、
 * 镜头列表与截图只在片场检查器中保留。
 */
export function isFilmSetNodeId(ctx: Context, nodeId: string): boolean {
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return isFilmSetGroupNode(node, canvas?.nodeData?.[nodeId]);
}

/** 当前节点的模型 AABB（供镜头 fit/span 计算）；缺失返回 null。 */
export function shotModelForNode(nodeId: string | null, ctx?: Context): { aabb: Aabb } | null {
  if (!nodeId) return null;
  const target = resolveTargets(ctx).find((entry) => entry.nodeId === nodeId);
  // 片场镜头按场景单位取景（节点矩形只影响呈现）：与 `defaultDistanceForNode` 同源。
  const scene = target ? filmSetSceneBounds(target) : null;
  if (scene) return { aabb: scene.aabb };
  const bounds = target ? modelBounds(target) : null;
  return bounds ? { aabb: bounds.aabb } : null;
}

/** 添加镜头：默认 auto-fit pose 由当前模型 AABB 计算。历史只读模式禁用。 */
export function addCamera(ctx: Context, session: ModelEditorSession): void {
  if (ctx.canvasRuntime.modelFocusMode() === "history") return;
  const nodeId = session.getState().nodeId;
  if (!nodeId) return;
  // 普通 model3d 聚焦已移除镜头控制：只有片场检查器仍可管理镜头。
  if (!isFilmSetNodeId(ctx, nodeId)) return;
  session.addCamera({ azimuth: 0, distance: defaultDistanceForNode(nodeId, ctx) });
}

/** 重新计算当前编辑 gizmo 并推给 canvas runtime。 */
export function pushEditor(ctx: Context, session: ModelEditorSession): void {
  const state = session.getState();
  const nodeId = state.nodeId;
  const focused = ctx.canvasRuntime.modelFocusProjection()?.nodeId ?? null;
  // 历史只读浏览：不显示任何编辑 gizmo，只保留查看相机。
  if (ctx.canvasRuntime.modelFocusMode() === "history") {
    ctx.canvasRuntime.setModelEditor(null);
    return;
  }
  if (!nodeId || focused !== nodeId) {
    ctx.canvasRuntime.setModelEditor(null);
    return;
  }
  // 普通 model3d 聚焦已移除镜头控制与 gizmo（change: 2026-10-18-simplify-model-focus-panel）：
  // 即使节点残留历史 `modelCameras`，也不得自动套用拍摄镜头或绘制 shot/focus gizmo。
  if (!isFilmSetNodeId(ctx, nodeId)) {
    ctx.canvasRuntime.setModelEditor(null);
    return;
  }
  // 片场对象模式且已选中对象：在选中对象的世界包围球处显示模型位移/yaw gizmo
  // （change: 2026-10-09-add-film-set-object-motion-and-editing）。
  const adapter = ctx.compositeAssets.resolve(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), nodeId);
  const shotPreview = adapter?.readonlyShotPreview?.(nodeId) === true;
  const objectOverride = shotPreview ? null : adapter?.gizmo?.(nodeId);
  const target = resolveTargets(ctx).find((entry) => entry.nodeId === nodeId);
  if (!target) {
    ctx.canvasRuntime.setModelEditor(null);
    return;
  }
  const bounds = modelBounds(target);
  if (!bounds) {
    ctx.canvasRuntime.setModelEditor(null);
    return;
  }
  const aabb: Aabb = bounds.aabb;
  const radius = shotBoundingRadius(aabb);
  const grid = adapter?.showFocusGrid?.(nodeId) ? {
    origin: [bounds.center[0], aabb.min[1], bounds.center[2]] as Vec3,
    spacing: filmSetDisplayScale(target)
  } : undefined;
  if (objectOverride) {
    ctx.canvasRuntime.setModelEditor({ ...objectOverride, ...(grid ? { grid } : {}) });
    return;
  }
  const base: BevyModelEditor = {
    version: MODEL_EDITOR_VERSION,
    nodeId,
    ...(grid ? { grid } : {}),
    toolMode: shotPreview ? "camera" : state.toolMode,
    ...(shotPreview ? { shotPreview: true } : {}),
    cameraTool: state.cameraTool,
    focus: bounds.center,
    radius
  };
  if (state.toolMode === "camera" || shotPreview) {
    const selected = session.selectedCamera();
    if (selected) {
      const pose = session.effectivePose(selected);
      // 片场镜头是**场景单位**：自动 fit 与 clamp 用场景包围球，派生后再经同一显示变换映射到
      // 画布世界供 gizmo/预览渲染（change: 2026-10-23-isolate-film-set-camera-space，D2/D3）。
      // 这样节点矩形只改变显示倍率，不改变保存值，也不改变构图比例。
      const sceneBounds = filmSetSceneBounds(target);
      const fitAabb = sceneBounds?.aabb ?? aabb;
      const fit = shotFitDistance(shotBoundingRadius(fitAabb), modelCameraAspectRatio(pose.aspect));
      const distance = clampShotDistance(pose.distance, fit);
      // Inspector 与 gizmo 共用当前有效偏移（包含未提交的拖动预览）。
      const shot = resolveShotCamera(fitAabb, {
        azimuth: pose.azimuth,
        elevation: pose.elevation,
        distance,
        aspect: pose.aspect,
        focusOffset: session.effectiveFocus(selected)
      });
      const mapped = shot && sceneBounds ? projectShotToDisplay(target, bounds, sceneBounds.center, shot) : shot;
      if (mapped) {
        base.cameraId = selected.id;
        base.shot = {
          position: mapped.position,
          focus: mapped.focus,
          fov: mapped.fov,
          azimuth: mapped.azimuth,
          elevation: mapped.elevation,
          distance: mapped.distance,
          aspect: pose.aspect
        };
      }
    }
  }
  ctx.canvasRuntime.setModelEditor(base);
}

/**
 * 场景空间镜头 → 画布显示姿态（同一相似变换）
 * （change: 2026-10-23-isolate-film-set-camera-space，design D2）。
 *
 * 与 Rust `sampled_camera_pose` 同式：世界焦点 = 世界包围球中心 + `D(focusOffset)`，世界距离 =
 * `s × 场景距离`，再复用 shot 轨道公式。非法映射返回 `null`，调用方不写入猜测姿态。
 */
function projectShotToDisplay(
  target: FocusTargetInput,
  bounds: ModelBounds,
  sceneCenter: Vec3,
  shot: { position: Vec3; focus: Vec3; fov: number; azimuth: number; elevation: number; distance: number }
): typeof shot | null {
  const transform = filmSetDisplayTransform({
    scale: filmSetDisplayScale(target),
    yaw: filmSetDisplayRotation(target)
  });
  if (!transform.ok) return null;
  const mapped = mapFilmSetSceneCamera(transform.value, bounds.center, {
    azimuth: shot.azimuth,
    elevation: shot.elevation,
    distance: shot.distance,
    // resolveShotCamera already added the scene center. Only transform its relative offset.
    focusOffset: {
      x: shot.focus[0] - sceneCenter[0],
      y: shot.focus[1] - sceneCenter[1],
      z: shot.focus[2] - sceneCenter[2]
    }
  });
  if (!mapped) return null;
  const focus: Vec3 = [
    bounds.center[0] + mapped.focusOffset[0],
    bounds.center[1] + mapped.focusOffset[1],
    bounds.center[2] + mapped.focusOffset[2]
  ];
  const position = shotCameraPosition(focus, mapped.azimuth, mapped.distance, shot.elevation);
  if (![...focus, ...position].every((value) => Number.isFinite(value))) return null;
  return { ...shot, position, focus, azimuth: mapped.azimuth, distance: mapped.distance };
}
