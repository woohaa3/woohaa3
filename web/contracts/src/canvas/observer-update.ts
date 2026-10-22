/**
 * 聚焦模型观察镜头增量 wire 协议。
 *
 * 仅已聚焦节点的本地朝向变化时，用固定大小的 `set_observer` 替代完整 `set_scene`。
 * 版本与 Rust `CANVAS_OBSERVER_UPDATE_VERSION` 必须逐字节一致。
 */
import type { BevyModelPreview } from "./render-scene/wire-model.js";
import type { Vec3 } from "./model-transform.js";
import type { CanvasRenderScene } from "./render-scene/wire-scene.js";

export const CANVAS_OBSERVER_UPDATE_VERSION = "woohaa-canvas-observer-v1" as const;

export type CanvasObserverUpdate = {
  version: typeof CANVAS_OBSERVER_UPDATE_VERSION;
  baseSceneGeneration: number;
  nodeId: string;
  preview: BevyModelPreview;
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
};

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export function canvasObserverUpdateRequest(input: Omit<CanvasObserverUpdate, "version">): string {
  const offset = input.preview.targetOffset ?? [0, 0, 0];
  const request: CanvasObserverUpdate = {
    version: CANVAS_OBSERVER_UPDATE_VERSION,
    baseSceneGeneration: Math.max(0, Math.trunc(input.baseSceneGeneration)),
    nodeId: input.nodeId,
    preview: {
      azimuth: finite(input.preview.azimuth),
      elevation: finite(input.preview.elevation),
      distanceScale: Math.max(0.001, finite(input.preview.distanceScale)),
      targetOffset: [finite(offset[0]), finite(offset[1]), finite(offset[2])]
    },
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
      : scene.modelFocus,
    nodes: scene.nodes.map(node => node.id === input.nodeId ? { ...node, modelPreview: { ...input.preview } } : node)
  };
}
