/**
 * 聚焦模型观察镜头增量 wire 协议。
 *
 * 仅已聚焦节点的本地朝向变化时，用固定大小的 `set_observer` 替代完整 `set_scene`。
 * 版本与 Rust `CANVAS_OBSERVER_UPDATE_VERSION` 必须逐字节一致。
 *
 * v2 删除了卡片预览姿态（`preview`）：普通模型聚焦只用世界包围盒取景，观察相机不再
 * 回写任何卡片观察态（change: 2026-11-10-remove-legacy-model-card-nodes）。
 */
import type { Vec3 } from "./model-transform.js";
import type { CanvasRenderScene } from "./render-scene/wire-scene.js";

export const CANVAS_OBSERVER_UPDATE_VERSION = "woohaa-canvas-observer-v2" as const;

export type CanvasObserverUpdate = {
  version: typeof CANVAS_OBSERVER_UPDATE_VERSION;
  baseSceneGeneration: number;
  nodeId: string;
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
};

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export function canvasObserverUpdateRequest(input: Omit<CanvasObserverUpdate, "version">): string {
  const request: CanvasObserverUpdate = {
    version: CANVAS_OBSERVER_UPDATE_VERSION,
    baseSceneGeneration: Math.max(0, Math.trunc(input.baseSceneGeneration)),
    nodeId: input.nodeId,
    yaw: finite(input.yaw),
    pitch: finite(input.pitch),
    distance: finite(input.distance),
    target: [finite(input.target[0]), finite(input.target[1]), finite(input.target[2])]
  };
  return JSON.stringify(request);
}

export function applyObserverToScene<T extends CanvasRenderScene>(
  scene: T,
  input: Omit<CanvasObserverUpdate, "version">
): T {
  return {
    ...scene,
    modelFocus: scene.modelFocus && scene.modelFocus.nodeId === input.nodeId
      ? { ...scene.modelFocus, yaw: input.yaw, pitch: input.pitch, distance: input.distance, target: [...input.target] }
      : scene.modelFocus
  };
}
