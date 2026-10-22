/**
 * 模型镜头存取、目标解析与 gizmo 派生
 * （change: 2026-09-28-split-frontend-god-plugins，task 4.5；从 model-editor-plugin 拆出）。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  MODEL_EDITOR_VERSION,
  clampShotDistance,
  isFilmSetNode,
  modelCameraAspectRatio,
  resolveShotCamera,
  shotBoundingRadius,
  shotFitDistance,
  type Aabb,
  type BevyModelEditor,
  type ModelCamera
} from "@woohaa3/contracts";
import { modelBounds, type FocusTargetInput } from "../canvas-shell/model-focus-session.js";
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

export function submitCameras(ctx: Context, nodeId: string, cameras: readonly ModelCamera[]): boolean {
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
  const bounds = target ? modelBounds(target) : null;
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
  return isFilmSetNode(node?.type, canvas?.nodeData?.[nodeId]);
}

/** 当前节点的模型 AABB（供镜头 fit/span 计算）；缺失返回 null。 */
export function shotModelForNode(nodeId: string | null, ctx?: Context): { aabb: Aabb } | null {
  if (!nodeId) return null;
  const target = resolveTargets(ctx).find((entry) => entry.nodeId === nodeId);
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
  const objectOverride = ctx.compositeAssets.resolve(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), nodeId)?.gizmo?.(nodeId);
  if (objectOverride) {
    ctx.canvasRuntime.setModelEditor(objectOverride);
    return;
  }
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
  const base: BevyModelEditor = {
    version: MODEL_EDITOR_VERSION,
    nodeId,
    toolMode: state.toolMode,
    cameraTool: state.cameraTool,
    focus: bounds.center,
    radius
  };
  if (state.toolMode === "camera") {
    const selected = session.selectedCamera();
    if (selected) {
      const pose = session.effectivePose(selected);
      const fit = shotFitDistance(radius, modelCameraAspectRatio(pose.aspect));
      const distance = clampShotDistance(pose.distance, fit);
      // Inspector 与 gizmo 共用当前有效偏移（包含未提交的拖动预览）。
      const shot = resolveShotCamera(aabb, {
        azimuth: pose.azimuth,
        elevation: pose.elevation,
        distance,
        aspect: pose.aspect,
        focusOffset: session.effectiveFocus(selected)
      });
      if (shot) {
        base.cameraId = selected.id;
        base.shot = {
          position: shot.position,
          focus: shot.focus,
          fov: shot.fov,
          azimuth: shot.azimuth,
          elevation: shot.elevation,
          distance: shot.distance,
          aspect: pose.aspect
        };
      }
    }
  }
  ctx.canvasRuntime.setModelEditor(base);
}
