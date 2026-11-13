/** Grouped world authoring. Permissions and run identity are always host-owned. */
import type { GroundAabb, WorldTransform, WorldPoint, WorldRotation } from './shared-world.js';
import type { WorldCameraSettings, WorldCameraSettingsPatch } from './node-history/world-camera.js';

export const WORLD_RESOURCE_TOOLS = {
  read: 'read_world_resource',
  area: 'edit_scene_area',
  model: 'edit_world_model',
  camera: 'edit_world_camera',
  modelScript: 'edit_world_model_script',
  animation: 'edit_scene_animation_script'
} as const;
export type WorldResourceType = 'scene_area' | 'world_model' | 'world_camera' | 'world_model_script' | 'scene_animation_script';
export type WorldResourceTarget = { areaId: string } | { instanceId: string } | { cameraId: string };
export type WorldScriptEdit = { oldString: string; newString: string };
export type WorldResourcePatch = {
  title?: string;
  bounds?: GroundAabb;
  moveBy?: { u: number; v: number };
  rotateClockwise?: boolean;
  transform?: Partial<Omit<WorldTransform, 'version'>>;
  settings?: WorldCameraSettingsPatch & { lookAt?: WorldPoint };
  duration?: number;
  loop?: boolean;
};
/** The tool-specific strict schema narrows this transport DTO before dispatch. */
export type WorldResourceEdit = {
  resourceType: WorldResourceType;
  operation: 'create' | 'update' | 'replace' | 'append' | 'patch' | 'delete';
  operationId: string;
  target?: WorldResourceTarget;
  areaId?: string;
  expectedVersion?: string;
  expectedParentVersion?: string;
  title?: string;
  transform?: WorldTransform;
  settings?: Omit<WorldCameraSettings, "rotation"> & { rotation?: WorldRotation; lookAt?: WorldPoint };
  initialScript?: string;
  script?: string;
  chunk?: string;
  edits?: WorldScriptEdit[];
  patch?: WorldResourcePatch;
  duration?: number;
  loop?: boolean;
};

/** Frozen business response stored atomically with the canonical command. */
export type WorldResourceReceipt = {
  intentHash: string;
  target: WorldResourceTarget;
  version: string;
  deleted?: boolean;
  camera?: import("./shared-world.js").WorldCameraData;
  cameras?: import("./shared-world.js").WorldCameraData[];
};
