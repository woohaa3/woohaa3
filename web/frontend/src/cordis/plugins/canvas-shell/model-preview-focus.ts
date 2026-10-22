import {
  autoFrameDistance,
  clampDistance,
  FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER,
  isModelPreviewNodeType,
  MODEL_FOCUS_FOV,
  type ServerCanvas,
} from "@woohaa3/contracts";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import {
  modelBounds,
  renderedModelNodeSize,
  type FocusTargetInput,
  type ModelFocusSession,
} from "./model-focus-session.js";

function facts(targets: readonly FocusTargetInput[], nodeId: string) {
  const target = targets.find((target) => target.nodeId === nodeId);
  const node = target?.canvas.document.nodes.find((node) => node.id === nodeId);
  if (
    !target ||
    target.nonCanonical ||
    !node ||
    !isModelPreviewNodeType(node.type)
  )
    return null;
  const bounds = modelBounds(target);
  if (!bounds) return null;
  const size = renderedModelNodeSize(node);
  const width = Math.min(1024, Math.max(1, Math.round(size.width - 32)));
  const height = Math.min(1024, Math.max(1, Math.round(size.height - 68)));
  return {
    bounds,
    distance: autoFrameDistance(
      Math.max(0.01, bounds.radius),
      MODEL_FOCUS_FOV,
      width / height,
    ),
  };
}

/** Keep card zoom within the observer's range, so entering focus cannot change its distance. */
export function clampPreviewDistanceScale(
  nodeId: string,
  scale: number,
  targets: readonly FocusTargetInput[],
) {
  const source = facts(targets, nodeId);
  if (!source) return Math.max(0.001, Math.min(1e9, scale));
  return (
    clampDistance(
      Math.min(
        source.distance * scale,
        source.bounds.radius * FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER,
      ),
      source.bounds.radius,
    ) / source.distance
  );
}

/** Seed the observer from the card's local pose, before the first focus projection. */
export function restorePreviewObserver(
  focus: ModelFocusSession,
  targets: readonly FocusTargetInput[],
) {
  const camera = focus.cameraSnapshot(),
    nodeId = focus.nodeId;
  const source = nodeId ? facts(targets, nodeId) : null;
  if (!camera || !source || !nodeId) return;
  const view = modelPreviewStore.get(nodeId),
    offset = view.targetOffset ?? [0, 0, 0];
  focus.restoreCamera({
    ...camera,
    yaw: view.azimuth,
    pitch: -view.elevation,
    distance: source.distance * view.distanceScale,
    target: [
      source.bounds.center[0] + offset[0],
      source.bounds.center[1] + offset[1],
      source.bounds.center[2] + offset[2],
    ],
  });
}

/** Use the unshifted observer snapshot; panel layout compensation is not a user pan. */
export function syncPreviewObserver(
  focus: ModelFocusSession,
  targets: readonly FocusTargetInput[],
) {
  const camera = focus.cameraSnapshot(),
    nodeId = focus.nodeId;
  const source = nodeId ? facts(targets, nodeId) : null;
  if (!camera || !source || !nodeId) return;
  modelPreviewStore.set(nodeId, {
    azimuth: camera.yaw,
    elevation: -camera.pitch,
    distanceScale: camera.distance / source.distance,
    targetOffset: [
      camera.target[0] - source.bounds.center[0],
      camera.target[1] - source.bounds.center[1],
      camera.target[2] - source.bounds.center[2],
    ],
  });
}

/**
 * 首次获得聚焦内容矩形时是否应自动重取景。
 *
 * `model3d` 卡片预览在进入聚焦时已用卡片当前方向/距离/观察位置播种观察相机
 * （`restorePreviewObserver`）；若此时再按可用区域 auto-fit，会把该卡片视角覆盖为
 * 固定取景距离，违反「卡片与聚焦观察镜头共享本地视角」
 * （change: 2026-10-08-integrate-render-performance-and-model-preview）。片场
 * `composite-asset` 等非预览模型没有卡片观察态，进入后按可用区域取景是期望行为。
 */
export function shouldReframeOnInitialLayout(
  canvas: ServerCanvas | null | undefined,
  nodeId: string,
): boolean {
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return true;
  return !isModelPreviewNodeType(node.type);
}
