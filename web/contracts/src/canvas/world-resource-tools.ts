/** Grouped world authoring. Permissions and run identity are always host-owned. */
import type { WorldTransform, WorldPoint, WorldRotation } from './shared-world.js';
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
  transform?: Partial<Omit<WorldTransform, 'version'>>;
  settings?: WorldCameraSettingsPatch & { lookAt?: WorldPoint };
  duration?: number;
  loop?: boolean;
};
/** The tool-specific strict schema narrows this transport DTO before dispatch. */
type WorldResourceEditBase = {
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
  duration?: number;
  loop?: boolean;
};
export type WorldResourceEdit = WorldResourceEditBase & (
  | { resourceType: 'scene_area'; operation: 'update'; patch: { title: string; transform?: never; settings?: never; duration?: never; loop?: never } }
  | { resourceType: Exclude<WorldResourceType, 'scene_area'>; patch?: WorldResourcePatch }
);

/** Frozen business response stored atomically with the canonical command. */
export type WorldResourceReceipt = {
  intentHash: string;
  target: WorldResourceTarget;
  version: string;
  deleted?: boolean;
  sceneArea?: { areaId: string; bounds: import("./shared-world.js").GroundAabb; scopeVersion: string; resourceVersion: string; expanded: boolean };
  historyReplay?: { sourceCommandId: string; direction: "undo" | "redo" };
  /** Canonical before/after state for conflict-checked history replay. */
  history?: {
    nodes: Array<{ id: string; before: { node: import("./domain/index.js").ServerCanvas["document"]["nodes"][number]; data: import("./domain/index.js").CanvasNodeData | null } | null; after: { node: import("./domain/index.js").ServerCanvas["document"]["nodes"][number]; data: import("./domain/index.js").CanvasNodeData | null } | null }>;
    beforeOtherHash: string;
    afterOtherHash: string;
    beforeEdges: import("./domain/index.js").ServerCanvas["document"]["edges"];
    afterEdges: import("./domain/index.js").ServerCanvas["document"]["edges"];
  };
  camera?: import("./shared-world.js").WorldCameraData;
  cameras?: import("./shared-world.js").WorldCameraData[];
};
