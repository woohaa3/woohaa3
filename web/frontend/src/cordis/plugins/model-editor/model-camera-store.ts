/**
 * 模型镜头存取、目标解析与 gizmo 派生
 * （change: 2026-09-28-split-frontend-god-plugins，task 4.5；从 model-editor-plugin 拆出）。
 *
 * 镜头列表来自 canonical `nodeData.modelCameras`；gizmo 与预览使用模型自身的世界包围盒，
 * 不再依赖任何片场容器或显示变换。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  MODEL_EDITOR_VERSION,
  clampShotDistance,
  modelCameraAspectRatio,
  resolveShotCamera,
  shotBoundingRadius,
  shotFitDistance,
  isModelNodeType,
  type Aabb,
  type BevyModelEditor,
  type ModelCamera
} from "@woohaa3/contracts";
import {
  modelBounds,
  type FocusTargetInput
} from "../canvas-shell/model-focus-session.js";
import { resolveModelFocusTargets } from "../canvas-shell/model-focus-targets.js";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";
import { modelSceneStore } from "../model-scene/model-scene-store.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";

let cameraSeq = 0;

export function readCameras(nodeId: string): ModelCamera[] {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  const data = canvas?.nodeData[nodeId] as { modelCameras?: unknown } | undefined;
  return Array.isArray(data?.modelCameras) ? (data.modelCameras as ModelCamera[]) : [];
}

export function submitCameras(ctx: Context, nodeId: string, cameras: readonly ModelCamera[]): boolean {
  if (!ctx.canvasSession.isWritable()) return false;
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (!canvas?.document.nodes.find(node => node.id === nodeId && isModelNodeType(node.type))) return false;
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
  const bounds = modelBounds(target);
  const radius = bounds ? shotBoundingRadius(bounds.aabb) : 1;
  return shotFitDistance(radius);
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
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (canvas?.document.nodes.find(node => node.id === nodeId && isModelNodeType(node.type)) === undefined) return;
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
      const fit = shotFitDistance(shotBoundingRadius(aabb), modelCameraAspectRatio(pose.aspect));
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
