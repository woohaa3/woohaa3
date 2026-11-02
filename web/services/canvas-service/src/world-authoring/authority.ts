/**
 * Production scene-area authority (T06).
 *
 * The authority derives every write decision from the canonical canvas projection:
 *
 * - scope bounds/version come from the `sceneArea` payload, never a card rect;
 * - instance footprints come from the same authoritative `executeSceneIr` +
 *   `v2SceneAabb` pipeline used by T03b conversion, transformed by the canonical
 *   world transform; unknown bounds never authorize;
 * - cameras are classified by their spatial anchor, never their card position;
 * - 2D workflow groups only return read-only references and cannot grant 3D writes.
 *
 * Footprint execution is asynchronous, so `prepareCanvas` resolves and caches the
 * local model AABBs for one exact canvas revision. `eligible`/`resolve` stay
 * synchronous (the lease store/commit transaction is synchronous) but fail closed
 * whenever the cached content/revision no longer matches.
 */
import {
  classifyCameraPoint,
  classifyFootprint,
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  decodeWorldCamera,
  decodeWorldInstanceData,
  quatRotate,
  stableStringify,
  v2SceneAabb,
  type Aabb,
  type GroundAabb,
  type SceneAreaData,
  type SceneAreaPlanAreaSource,
  type SceneAreaPlanMemberSet,
  type ServerCanvas,
  type WorldAuthoritySnapshot,
  type WorldCameraData,
  type WorldGroupAuthoritySnapshot,
  type WorldInstanceData,
  type WorldObjectAuthorityEntry,
  type WorldObjectIdentity,
  type WorldObjectVersion,
  type WorldScopeIdentity,
  type WorldScopeVersion,
  type WorldTransform,
  type WorkflowGroupData
} from "@woohaa3/contracts";
import { executeSceneIr } from "../model-mcp/script-executor.js";
import type { SpatialCommitAuthority } from "./spatial-leases.js";

export type AuthorityScopeRef =
  | { kind: "scene-area"; areaId: string }
  | { kind: "workflow-group-2d"; groupId: string };

export type PreparedWorldScope =
  | { ok: true; snapshot: WorldAuthoritySnapshot }
  | { ok: false; code: "not-ready" | "invalid-data" | "outside-scope"; message: string };

export type PreparedWorldGroup =
  | { ok: true; snapshot: WorldGroupAuthoritySnapshot }
  | { ok: false; code: "not-ready" | "invalid-data" | "outside-scope"; message: string };

type InstanceRecord = {
  nodeId: string;
  data: WorldInstanceData;
  identity: Extract<WorldObjectIdentity, { kind: "instance" }>;
  contentVersion: string;
  transformVersion: string;
  version: string;
  /** Asset-local AABB; `null` means the content could not be prepared. */
  localAabb: Aabb | null;
};

type CameraRecord = {
  nodeId: string;
  data: WorldCameraData;
  identity: Extract<WorldObjectIdentity, { kind: "camera" }>;
  version: string;
  contentVersion: string;
  transformVersion: string;
};

export type SceneAreaCache = {
  kind: "scene-area";
  canvasId: string;
  revision: number;
  scope: WorldScopeVersion;
  areaNodeId: string;
  area: SceneAreaData;
  instances: Map<string, InstanceRecord>;
  cameras: Map<string, CameraRecord>;
};

export type GroupCache = {
  kind: "workflow-group-2d";
  canvasId: string;
  revision: number;
  scope: WorldScopeVersion;
  groupNodeId: string;
  group: WorkflowGroupData;
  instances: Map<string, InstanceRecord>;
  cameras: Map<string, CameraRecord>;
};

export type AuthorityCache = SceneAreaCache | GroupCache;

const CONTENT_FIELDS = [
  "modelScript",
  "modelScriptLanguage",
  "modelScriptVersion",
  "modelSourceKind",
  "modelAssetId",
  "modelContentVersion"
] as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Deterministic, browser-independent version hash (two independent 32-bit lanes). */
export function stableAuthorityVersion(prefix: string, value: unknown): string {
  const text = `${prefix}\u0000${stableStringify(value)}`;
  let a = 5381;
  let b = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = ((a << 5) + a + code) | 0;
    b = ((b ^ code) * 0x01000193) | 0;
  }
  return `${prefix}-${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

function nodeData(canvas: ServerCanvas, nodeId: string): Record<string, unknown> | null {
  const raw = canvas.nodeData[nodeId];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function findArea(canvas: ServerCanvas, areaId: string): { nodeId: string; data: SceneAreaData } | null {
  for (const node of canvas.document.nodes) {
    if (node.type !== "scene-area") continue;
    const decoded = decodeSceneAreaData(nodeData(canvas, node.id)?.sceneArea);
    if (decoded.ok && decoded.value.areaId === areaId) return { nodeId: node.id, data: decoded.value };
  }
  return null;
}

function findGroup(canvas: ServerCanvas, groupId: string): { nodeId: string; data: WorkflowGroupData } | null {
  for (const node of canvas.document.nodes) {
    if (node.type !== "workflow-group-2d") continue;
    const decoded = decodeWorkflowGroupData(nodeData(canvas, node.id)?.workflowGroup2d);
    if (decoded.ok && decoded.value.groupId === groupId) return { nodeId: node.id, data: decoded.value };
  }
  return null;
}

function instanceContentVersion(fields: Record<string, unknown>): string {
  return stableAuthorityVersion("world-content", Object.fromEntries(
    CONTENT_FIELDS.map(field => [field, fields[field] ?? null])
  ));
}

function instanceVersion(instanceId: string, contentVersion: string, transformVersion: string): string {
  return stableAuthorityVersion("world-instance", { instanceId, contentVersion, transformVersion });
}

/** Shared with the scene-area command mapper and its tests. */
export { instanceContentVersion, instanceVersion };

/** Deterministic next camera settings identity; pose changes always advance it. */
export function nextCameraSettingsVersion(camera: WorldCameraData): string {
  return stableAuthorityVersion("world-camera-settings", {
    cameraId: camera.cameraId,
    position: camera.position,
    rotation: camera.rotation,
    projection: camera.projection,
    captureMode: camera.captureMode,
    aspect: camera.aspect,
    boundInstanceId: camera.boundInstanceId
  });
}

/** Deterministic scene-area scope identity; bounds/identity changes advance it. */
export function nextSceneAreaScopeVersion(areaId: string, bounds: GroundAabb): string {
  return stableAuthorityVersion("scene-area-scope", { areaId, bounds });
}

/** Read a world object's authoritative version directly from a projection. */
export function worldObjectVersion(canvas: ServerCanvas, target: WorldObjectIdentity): string | null {
  for (const node of canvas.document.nodes) {
    const fields = nodeData(canvas, node.id);
    if (!fields) continue;
    if (target.kind === "instance") {
      const decoded = decodeWorldInstanceData(fields.sharedWorldInstance);
      if (decoded.ok && decoded.value.instanceId === target.instanceId) {
        return instanceVersion(
          target.instanceId,
          instanceContentVersion(fields),
          stableAuthorityVersion("world-pose", decoded.value.transform)
        );
      }
    } else {
      const decoded = decodeWorldCamera(fields.worldCamera);
      if (decoded.ok && decoded.value.cameraId === target.cameraId) return decoded.value.settingsVersion;
    }
  }
  return null;
}

/** Read the current scene-area scope version; `null` means the area is absent. */
export function sceneAreaScopeVersion(canvas: ServerCanvas, areaId: string): string | null {
  return findArea(canvas, areaId)?.data.scopeVersion ?? null;
}

function instanceRecord(
  nodeId: string,
  data: WorldInstanceData,
  fields: Record<string, unknown>,
  localAabb: Aabb | null
): InstanceRecord {
  const contentVersion = instanceContentVersion(fields);
  const transformVersion = stableAuthorityVersion("world-pose", data.transform);
  return {
    nodeId,
    data,
    identity: { kind: "instance", instanceId: data.instanceId },
    contentVersion,
    transformVersion,
    version: instanceVersion(data.instanceId, contentVersion, transformVersion),
    localAabb
  };
}

function cameraRecord(nodeId: string, data: WorldCameraData): CameraRecord {
  return {
    nodeId,
    data,
    identity: { kind: "camera", cameraId: data.cameraId },
    version: data.settingsVersion,
    contentVersion: stableAuthorityVersion("world-camera-content", {
      settingsVersion: data.settingsVersion,
      projection: data.projection,
      captureMode: data.captureMode,
      aspect: data.aspect,
      boundInstanceId: data.boundInstanceId
    }),
    transformVersion: stableAuthorityVersion("world-camera-pose", {
      position: data.position,
      rotation: data.rotation
    })
  };
}

/** Asset-local AABB → conservative ground AABB in world meters. */
export function instanceFootprint(localAabb: Aabb, transform: WorldTransform): GroundAabb {
  // Asset-local axes are Y-up; the shared world basis is (u, v, h). A local point
  // (x, y, z) is (x, -z, y) in world meters. The stored world rotation is already
  // expressed in that basis, so it applies directly (do not re-conjugate it here).
  const points: Array<{ u: number; v: number }> = [];
  for (let index = 0; index < 8; index += 1) {
    const local: [number, number, number] = [
      index & 1 ? localAabb.max[0] : localAabb.min[0],
      index & 2 ? localAabb.max[1] : localAabb.min[1],
      index & 4 ? localAabb.max[2] : localAabb.min[2]
    ];
    const worldLocal: [number, number, number] = [local[0], -local[2], local[1]];
    const rotated = quatRotate(
      [transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]],
      worldLocal
    );
    points.push({
      u: transform.position.u + rotated[0] * transform.scale,
      v: transform.position.v + rotated[1] * transform.scale
    });
  }
  const u = points.map(point => point.u);
  const v = points.map(point => point.v);
  return {
    min: { u: Math.min(...u), v: Math.min(...v) },
    max: { u: Math.max(...u), v: Math.max(...v) }
  };
}

function objectEntry(
  record: InstanceRecord | CameraRecord,
  containment: WorldObjectAuthorityEntry["containment"]
): WorldObjectAuthorityEntry {
  return {
    identity: record.identity,
    nodeId: record.nodeId,
    version: record.version,
    containment,
    contentVersion: record.contentVersion,
    transformVersion: record.transformVersion
  };
}

function instanceContainment(record: InstanceRecord, area: GroundAabb): WorldObjectAuthorityEntry["containment"] {
  if (!record.localAabb) return "unknown";
  const bounds = instanceFootprint(record.localAabb, record.data.transform);
  const result = classifyFootprint({
    area,
    footprint: {
      status: "ready",
      bounds,
      contentVersion: record.contentVersion,
      transformVersion: record.transformVersion
    },
    contentVersion: record.contentVersion,
    transformVersion: record.transformVersion
  });
  if (result === "unknown") return "unknown";
  return result === "complete" ? "writable" : result === "partial" ? "read-only" : "outside";
}

function cameraContainment(record: CameraRecord, area: GroundAabb): WorldObjectAuthorityEntry["containment"] {
  const result = classifyCameraPoint({ area, position: record.data.position });
  if (result === "unknown") return "unknown";
  return result === "complete" ? "writable" : "outside";
}

function areaSource(cache: SceneAreaCache): SceneAreaPlanAreaSource {
  return { areaId: cache.area.areaId, scopeVersion: cache.area.scopeVersion, bounds: cache.area.bounds };
}

function membersFor(instances: InstanceRecord[], cameras: CameraRecord[]): SceneAreaPlanMemberSet {
  return {
    instances: instances.map(record => ({
      identity: record.identity,
      version: record.version,
      transform: record.data.transform
    })),
    cameras: cameras.map(record => ({
      identity: record.identity,
      version: record.version,
      camera: record.data
    }))
  };
}

type ObjectState = {
  identity: WorldObjectIdentity;
  version: string;
  instance?: { contentVersion: string; transformVersion: string; transform: WorldTransform; localAabb: Aabb | null };
  camera?: WorldCameraData;
};

export type WorldAuthoringAuthority = SpatialCommitAuthority & {
  /**
   * Resolve and cache one exact canonical revision. Unknown instance bounds make
   * the whole scope not-ready; unknown never degrades to an empty writable set.
   */
  prepareCanvas(canvas: ServerCanvas, scope: { kind: "scene-area"; areaId: string }): Promise<PreparedWorldScope>;
  prepareGroup(canvas: ServerCanvas, groupId: string): Promise<PreparedWorldGroup>;
  /** Exposed for the semantic service to reuse the prepared local AABBs. */
  cacheFor(canvasId: string, scope: WorldScopeVersion): AuthorityCache | null;
  /**
   * Prepare the local AABB for model content that is about to be created or
   * replaced. New content never inherits eligibility from an existing version;
   * the caller must prepare it before committing so containment is decided from
   * the exact post-state content. Returns `null` when bounds remain unknown.
   */
  prepareContent(fields: Record<string, unknown>): Promise<{ contentVersion: string; localAabb: Aabb } | null>;
  /** Drop cached projections for one canvas. */
  invalidate(canvasId: string): void;
};

export interface WorldAuthoringAuthorityOptions {
  /** Test seam; defaults to the production isolated script executor. */
  executeScene?: typeof executeSceneIr;
  /** Host-owned exact-stop evidence. Defaults to fail closed. */
  verifyStopped?: (identity: { canvasId: string; runId: string; epoch: number; executionId: string }, evidence: unknown) => boolean;
}

export function createWorldAuthoringAuthority(
  options: WorldAuthoringAuthorityOptions = {}
): WorldAuthoringAuthority {
  const caches = new Map<string, AuthorityCache>();
  /**
   * Content-addressed successful local AABBs; pose changes reuse the same
   * prepared geometry. Preparation failures are deliberately never stored: a
   * transient executor throw/structured failure must not poison the content, so
   * the same authority can retry and recover while every retry still starts
   * from `unknown` (fail closed) until real bounds exist.
   */
  const localAabbCache = new Map<string, Aabb>();
  /** Versions validated as the post-state of an in-flight atomic resolve. */
  const postEligible = new Set<string>();
  const postKey = (canvasId: string, scopeVersion: string, target: WorldObjectIdentity, version: string): string =>
    `${canvasId}\u0000${scopeVersion}\u0000${target.kind}\u0000${target.kind === "instance" ? target.instanceId : target.cameraId}\u0000${version}`;
  const scopeKey = (canvasId: string, scope: AuthorityScopeRef | WorldScopeIdentity): string =>
    scope.kind === "scene-area"
      ? `${canvasId}\u0000area\u0000${scope.areaId}`
      : `${canvasId}\u0000group\u0000${scope.groupId}`;

  const scopeRefOf = (scope: WorldScopeVersion): AuthorityScopeRef =>
    scope.scope.kind === "scene-area"
      ? { kind: "scene-area", areaId: scope.scope.areaId }
      : { kind: "workflow-group-2d", groupId: scope.scope.groupId };

  async function collectInstances(canvas: ServerCanvas): Promise<{ records: Map<string, InstanceRecord>; unknown: boolean }> {
    const records = new Map<string, InstanceRecord>();
    let unknown = false;
    for (const node of canvas.document.nodes) {
      const fields = nodeData(canvas, node.id);
      if (!fields || fields.sharedWorldInstance === undefined) continue;
      const decoded = decodeWorldInstanceData(fields.sharedWorldInstance);
      if (!decoded.ok) {
        unknown = true;
        continue;
      }
      const data = decoded.value;
      const contentVersion = instanceContentVersion(fields);
      let localAabb = localAabbCache.get(contentVersion) ?? null;
      if (!localAabb) {
        if (fields.modelSourceKind !== "glb" && typeof fields.modelScript === "string" && fields.modelScript.trim().length > 0) {
          try {
            const execution = await (options.executeScene ?? executeSceneIr)(fields.modelScript, fields.modelScriptVersion, {});
            if (execution.ok) {
              // Only a successful authoritative execution is cacheable. Empty or
              // failed results stay unknown and are re-evaluated on the next
              // explicit prepare instead of becoming a permanent failure.
              const prepared = v2SceneAabb(execution.ops);
              if (prepared) {
                localAabb = prepared;
                localAabbCache.set(contentVersion, prepared);
              }
            }
          } catch {
            localAabb = null;
          }
        }
      }
      if (!localAabb) unknown = true;
      records.set(data.instanceId, instanceRecord(node.id, data, fields, localAabb));
    }
    return { records, unknown };
  }

  function collectCameras(canvas: ServerCanvas): Map<string, CameraRecord> {
    const records = new Map<string, CameraRecord>();
    for (const node of canvas.document.nodes) {
      const fields = nodeData(canvas, node.id);
      if (!fields || fields.worldCamera === undefined) continue;
      const decoded = decodeWorldCamera(fields.worldCamera);
      if (decoded.ok) records.set(decoded.value.cameraId, cameraRecord(node.id, decoded.value));
    }
    return records;
  }

  async function prepareArea(
    canvas: ServerCanvas,
    scope: { kind: "scene-area"; areaId: string }
  ): Promise<PreparedWorldScope> {
    if (!nonEmpty(scope.areaId)) return { ok: false, code: "invalid-data", message: "场景区身份无效" };
    const found = findArea(canvas, scope.areaId);
    if (!found) return { ok: false, code: "outside-scope", message: "场景区不存在" };
    const { records: instances, unknown } = await collectInstances(canvas);
    const cameras = collectCameras(canvas);
    if (unknown) return { ok: false, code: "not-ready", message: "存在无法确定权威占地的模型" };

    const writable: WorldObjectVersion[] = [];
    const readOnly: WorldObjectVersion[] = [];
    const objects: WorldObjectAuthorityEntry[] = [];
    const writableInstances: InstanceRecord[] = [];
    const writableCameras: CameraRecord[] = [];
    for (const record of instances.values()) {
      const containment = instanceContainment(record, found.data.bounds);
      objects.push(objectEntry(record, containment));
      if (containment === "writable") {
        writable.push({ ...record.identity, version: record.version });
        writableInstances.push(record);
      } else if (containment === "read-only") {
        readOnly.push({ ...record.identity, version: record.version });
      }
    }
    for (const record of cameras.values()) {
      const containment = cameraContainment(record, found.data.bounds);
      objects.push(objectEntry(record, containment));
      if (containment === "writable") {
        writable.push({ ...record.identity, version: record.version });
        writableCameras.push(record);
      }
    }

    const cache: SceneAreaCache = {
      kind: "scene-area",
      canvasId: canvas.id,
      revision: canvas.revision,
      scope: { scope: { kind: "scene-area", areaId: found.data.areaId }, scopeVersion: found.data.scopeVersion },
      areaNodeId: found.nodeId,
      area: found.data,
      instances,
      cameras
    };
    caches.set(scopeKey(canvas.id, scope), cache);

    return {
      ok: true,
      snapshot: {
        version: "world-authoring-v1",
        canvasId: canvas.id,
        revision: canvas.revision,
        scope: cache.scope,
        areaNodeId: found.nodeId,
        area: areaSource(cache),
        bounds: { min: { ...found.data.bounds.min }, max: { ...found.data.bounds.max } },
        writable,
        readOnly,
        members: membersFor(writableInstances, writableCameras),
        objects
      }
    };
  }

  async function prepareGroup(canvas: ServerCanvas, groupId: string): Promise<PreparedWorldGroup> {
    if (!nonEmpty(groupId)) return { ok: false, code: "invalid-data", message: "2D 组身份无效" };
    const found = findGroup(canvas, groupId);
    if (!found) return { ok: false, code: "outside-scope", message: "2D 组不存在" };
    const { records: instances, unknown } = await collectInstances(canvas);
    const cameras = collectCameras(canvas);
    if (unknown) return { ok: false, code: "not-ready", message: "存在无法确定权威占地的模型" };

    const readOnly: WorldObjectVersion[] = [];
    const objects: WorldObjectAuthorityEntry[] = [];
    for (const memberNodeId of found.data.memberNodeIds) {
      const instance = [...instances.values()].find(record => record.nodeId === memberNodeId);
      if (instance) {
        readOnly.push({ ...instance.identity, version: instance.version });
        objects.push(objectEntry(instance, "read-only"));
        continue;
      }
      const camera = [...cameras.values()].find(record => record.nodeId === memberNodeId);
      if (camera) {
        readOnly.push({ ...camera.identity, version: camera.version });
        objects.push(objectEntry(camera, "read-only"));
      }
    }

    const cache: GroupCache = {
      kind: "workflow-group-2d",
      canvasId: canvas.id,
      revision: canvas.revision,
      scope: { scope: { kind: "workflow-group-2d", groupId: found.data.groupId }, scopeVersion: found.data.scopeVersion },
      groupNodeId: found.nodeId,
      group: found.data,
      instances,
      cameras
    };
    caches.set(scopeKey(canvas.id, { kind: "workflow-group-2d", groupId }), cache);

    return {
      ok: true,
      snapshot: {
        version: "world-authoring-v1",
        canvasId: canvas.id,
        revision: canvas.revision,
        scope: cache.scope,
        writable: [],
        readOnly,
        objects
      }
    };
  }

  function cacheFor(canvasId: string, scope: WorldScopeVersion): AuthorityCache | null {
    return caches.get(scopeKey(canvasId, scopeRefOf(scope))) ?? null;
  }

  function recordFor(cache: AuthorityCache, target: WorldObjectIdentity): InstanceRecord | CameraRecord | null {
    return target.kind === "instance"
      ? cache.instances.get(target.instanceId) ?? null
      : cache.cameras.get(target.cameraId) ?? null;
  }

  function eligible(scope: WorldScopeVersion, targets: WorldObjectVersion[], canvasId: string): boolean {
    const cache = cacheFor(canvasId, scope);
    if (!cache) return false;
    if (cache.kind !== "scene-area") return targets.length === 0;
    if (cache.scope.scopeVersion !== scope.scopeVersion) return false;
    if (cache.scope.scope.kind !== scope.scope.kind) return false;
    for (const target of targets) {
      if (postEligible.has(postKey(canvasId, scope.scopeVersion, target, target.version))) continue;
      const record = recordFor(cache, target);
      if (!record) return false;
      if (record.version !== target.version) return false;
      const containment = record.identity.kind === "instance"
        ? instanceContainment(record as InstanceRecord, cache.area.bounds)
        : cameraContainment(record as CameraRecord, cache.area.bounds);
      if (containment !== "writable") return false;
    }
    return true;
  }

  /** Read one world object directly from a concrete projection (resolve path). */
  function stateAgainst(canvas: ServerCanvas, target: WorldObjectIdentity, cache: AuthorityCache): ObjectState | null {
    for (const node of canvas.document.nodes) {
      const fields = nodeData(canvas, node.id);
      if (!fields) continue;
      if (target.kind === "instance") {
        const decoded = decodeWorldInstanceData(fields.sharedWorldInstance);
        if (!decoded.ok || decoded.value.instanceId !== target.instanceId) continue;
        const contentVersion = instanceContentVersion(fields);
        const transformVersion = stableAuthorityVersion("world-pose", decoded.value.transform);
        const cached = cache.instances.get(target.instanceId);
        const localAabb = cached && cached.contentVersion === contentVersion
          ? cached.localAabb
          : localAabbCache.get(contentVersion) ?? null;
        return {
          identity: target,
          version: instanceVersion(target.instanceId, contentVersion, transformVersion),
          instance: { contentVersion, transformVersion, transform: decoded.value.transform, localAabb }
        };
      }
      const decoded = decodeWorldCamera(fields.worldCamera);
      if (!decoded.ok || decoded.value.cameraId !== target.cameraId) continue;
      return {
        identity: target,
        version: decoded.value.settingsVersion,
        camera: decoded.value
      };
    }
    return null;
  }

  function containmentOf(state: ObjectState, area: GroundAabb): WorldObjectAuthorityEntry["containment"] {
    if (state.instance) {
      if (!state.instance.localAabb) return "unknown";
      const bounds = instanceFootprint(state.instance.localAabb, state.instance.transform);
      const result = classifyFootprint({
        area,
        footprint: {
          status: "ready",
          bounds,
          contentVersion: state.instance.contentVersion,
          transformVersion: state.instance.transformVersion
        },
        contentVersion: state.instance.contentVersion,
        transformVersion: state.instance.transformVersion
      });
      if (result === "unknown") return "unknown";
      return result === "complete" ? "writable" : result === "partial" ? "read-only" : "outside";
    }
    if (!state.camera) return "unknown";
    const result = classifyCameraPoint({ area, position: state.camera.position });
    if (result === "unknown") return "unknown";
    return result === "complete" ? "writable" : "outside";
  }

  function cameraPoseVersion(camera: WorldCameraData): string {
    return stableAuthorityVersion("world-camera-pose", { position: camera.position, rotation: camera.rotation });
  }

  const authority: WorldAuthoringAuthority = {
    prepareCanvas: prepareArea,
    prepareGroup,
    cacheFor,
    async prepareContent(fields) {
      const contentVersion = instanceContentVersion(fields);
      const cached = localAabbCache.get(contentVersion);
      if (cached) return { contentVersion, localAabb: cached };
      if (fields.modelSourceKind === "glb" || typeof fields.modelScript !== "string" || fields.modelScript.trim().length === 0) return null;
      try {
        const execution = await (options.executeScene ?? executeSceneIr)(fields.modelScript, fields.modelScriptVersion, {});
        if (!execution.ok) return null;
        const prepared = v2SceneAabb(execution.ops);
        if (!prepared) return null;
        localAabbCache.set(contentVersion, prepared);
        return { contentVersion, localAabb: prepared };
      } catch {
        return null;
      }
    },
    invalidate(canvasId) {
      const prefix = `${canvasId}\u0000`;
      for (const key of [...caches.keys()]) {
        if (key.startsWith(prefix)) caches.delete(key);
      }
      // Post-state eligibility is derived from the dropped projections; keeping
      // it would let an expired version survive invalidation and a later
      // re-preparation. A fresh prepare must re-establish every target.
      for (const key of [...postEligible]) {
        if (key.startsWith(prefix)) postEligible.delete(key);
      }
    },
    eligible(intent, targets) {
      return eligible(intent.scope, targets, intent.canvasId);
    },
    stopped(identity, evidence) {
      return options.verifyStopped?.(identity, evidence) === true;
    },
    resolve(intent, before, after, targets) {
      const scope = intent.scope;
      const cache = cacheFor(intent.canvasId, scope);
      if (!cache || cache.revision !== before.revision) return null;

      if (scope.scope.kind === "workflow-group-2d") {
        if (targets.length !== 0) return null;
        const found = findGroup(before, scope.scope.groupId);
        if (!found || found.data.scopeVersion !== scope.scopeVersion) return null;
        return {
          scope: { scope: { kind: "workflow-group-2d", groupId: found.data.groupId }, scopeVersion: found.data.scopeVersion },
          previous: [],
          next: []
        };
      }

      if (cache.kind !== "scene-area") return null;
      const beforeArea = findArea(before, scope.scope.areaId)?.data ?? null;
      const afterArea = findArea(after, scope.scope.areaId)?.data ?? null;
      if (!beforeArea && !afterArea) return null;
      // A delete removes the area; its inverse restores the same frozen area. Use
      // whichever side carries the scope so undo can revalidate the frozen state.
      const scopeArea = beforeArea ?? afterArea!;
      if (scopeArea.scopeVersion !== scope.scopeVersion) return null;
      const previous: WorldObjectVersion[] = [];
      const next: WorldObjectVersion[] = [];

      for (const target of targets) {
        const beforeState = stateAgainst(before, target, cache);
        const afterState = stateAgainst(after, target, cache);
        if (!beforeState) {
          if (!afterState) return null;
          if (afterArea) {
            const afterContainment = containmentOf(afterState, afterArea.bounds);
            if (afterContainment !== "writable") return null;
            postEligible.add(postKey(intent.canvasId, intent.scope.scopeVersion, target, afterState.version));
          }
          previous.push({ ...target, version: "absent" });
          next.push({ ...target, version: afterState.version });
          continue;
        }
        const beforeContainment = containmentOf(beforeState, beforeArea?.bounds ?? scopeArea.bounds);
        if (beforeContainment !== "writable") return null;

        if (beforeState.camera && afterState?.camera) {
          const poseChanged = cameraPoseVersion(beforeState.camera) !== cameraPoseVersion(afterState.camera);
          if (poseChanged && afterState.camera.settingsVersion === beforeState.camera.settingsVersion) return null;
        }
        if (afterState && afterArea) {
          const afterContainment = containmentOf(afterState, afterArea.bounds);
          if (afterContainment !== "writable") return null;
          postEligible.add(postKey(intent.canvasId, intent.scope.scopeVersion, target, afterState.version));
        }
        previous.push({ ...target, version: beforeState.version });
        if (afterState) {
          next.push({ ...target, version: afterState.version });
        } else {
          // Deleting an eligible object is a valid post-state; record it so the
          // lease store's post-state recheck accepts the produced version.
          postEligible.add(postKey(intent.canvasId, intent.scope.scopeVersion, target, "absent"));
          next.push({ ...target, version: "absent" });
        }
      }

      return {
        scope: { scope: { kind: "scene-area", areaId: scopeArea.areaId }, scopeVersion: scopeArea.scopeVersion },
        previous,
        next
      };
    }
  };

  return authority;
}
