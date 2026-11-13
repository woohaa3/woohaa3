import { directorCharacterCommitTargets } from "./director-character-guard.js";
/**
 * Production scene-area authority (T06).
 *
 * The authority derives every write decision from the canonical canvas projection:
 *
 * - scope bounds/version come from the `sceneArea` payload, never a card rect;
 * - instance ground anchors come from authoritative script execution with stored
 *   rig parameters or scoped GLB bytes, transformed by the canonical world pose;
 *   unknown geometry never authorizes; body AABBs only classify references;
 * - cameras are classified by their spatial anchor, never their card position;
 * - 2D workflow groups only return read-only references and cannot grant 3D writes.
 *
 * Footprint execution is asynchronous, so `prepareCanvas` resolves and caches the
 * local model geometry and anchors for one exact canvas revision. `eligible`/`resolve` stay
 * synchronous (the lease store/commit transaction is synchronous) but fail closed
 * whenever the cached content/revision no longer matches.
 */
import {
  GLB_MAX_FILE_BYTES,
  classifyCameraPoint,
  classifyFootprint,
  decodeGlbModelReference,
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  decodeWorldCamera,
  decodeWorldInstanceData,
  isValidStorageKey,
  isMediaObjectNotFoundError,
  parseGlbModel,
  quatRotate,
  stableStringify,
  v2ShapeLocalBounds,
  v2ShapeLocalTransform,
  transformPoint,
  type SceneV2Op,
  type SceneV2ShapeOp,
  modelGroundAnchorLocal,
  worldModelGroundAnchor,
  storedHumanoidRig,
  type Vec3,
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
import { createHash } from "node:crypto";
import type { CanvasMediaClient } from "../clients/media-client.js";
import { executeSceneIr } from "../model-mcp/script-executor.js";
import type { SpatialCommitAuthority } from "./spatial-leases.js";

export type AuthorityScopeRef =
  | { kind: "scene-area"; areaId: string }
  | { kind: "workflow-group-2d"; groupId: string }
  | { kind: "world-camera"; cameraId: string };

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
  localGroundAnchor: Vec3 | null;
  footprint: GroundAabb | null;
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

export type CameraCache = {
  kind: "world-camera";
  canvasId: string;
  revision: number;
  scope: WorldScopeVersion;
  cameraNodeId: string;
  cameraId: string;
  instances: Map<string, InstanceRecord>;
  cameras: Map<string, CameraRecord>;
};
export type AuthorityCache = SceneAreaCache | GroupCache | CameraCache;
export type PreparedWorldCamera =
  | { ok: true; snapshot: { scope: WorldScopeVersion; writable: WorldObjectVersion[]; readOnly: WorldObjectVersion[] } }
  | { ok: false; code: "invalid-data" | "outside-scope"; message: string };

const CONTENT_FIELDS = [
  "modelScript",
  "modelScriptLanguage",
  "modelScriptVersion",
  "modelSourceKind",
  "modelAssetId",
  "modelContentVersion",
  "modelRig"
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

function instanceContentVersion(fields: Record<string, unknown>, canvas?: ServerCanvas): string {
  const content = Object.fromEntries(
    CONTENT_FIELDS.map(field => [field, fields[field] ?? null])
  );
  if (fields.modelSourceKind !== "glb") return stableAuthorityVersion("world-content", content);
  const asset = canvas?.assets.find(entry => entry.id === fields.modelAssetId);
  // Asset ids can be reused by asset.upsert without changing nodeData. Both
  // bounds and object versions must follow the canonical asset, including after
  // a new prepare; an old context must not silently authorize replacement bytes.
  return stableAuthorityVersion("world-content", {
    ...content,
    canvasId: canvas?.id ?? null,
    asset: asset ? {
      mediaKind: asset.mediaKind,
      status: asset.status,
      storageKey: asset.metadata?.storageKey ?? null,
      checksum: asset.metadata?.checksum ?? null,
      size: asset.metadata?.size ?? null,
      contentType: asset.metadata?.contentType ?? null
    } : null
  });
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

/** Freeze everything outside the affected nodes so history cannot truncate later work. */
export function resourceHistoryOtherHash(canvas: ServerCanvas, ids: ReadonlySet<string>): string {
  return stableAuthorityVersion("resource-history-other", {
    title: canvas.title,
    nodes: canvas.document.nodes.filter(node => !ids.has(node.id)),
    edges: canvas.document.edges.filter(edge => !ids.has(edge.source) && !ids.has(edge.target)),
    nodeData: Object.fromEntries(Object.entries(canvas.nodeData).filter(([id]) => !ids.has(id))),
    assets: canvas.assets, jobs: canvas.jobs
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
          instanceContentVersion(fields, canvas),
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
  contentVersion: string,
  localAabb: Aabb | null,
  localGroundAnchor: Vec3 | null,
  footprint: GroundAabb | null
): InstanceRecord {
  const transformVersion = stableAuthorityVersion("world-pose", data.transform);
  return {
    nodeId,
    data,
    identity: { kind: "instance", instanceId: data.instanceId },
    contentVersion,
    transformVersion,
    version: instanceVersion(data.instanceId, contentVersion, transformVersion),
    localAabb,
    localGroundAnchor,
    footprint
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

/** Transform every primitive corner through its complete hierarchy. Composing
 * non-uniform scales and rotations as a single TRS can lose shear and underbound. */
function authoritativeSceneBounds(ops: readonly SceneV2Op[]): Aabb | null {
  const shapes = ops.filter((op): op is SceneV2ShapeOp => ["group", "box", "cylinder", "mesh", "sphere", "capsule", "segment"].includes(op.t));
  const byId = new Map(shapes.map(shape => [shape.id, shape]));
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const shape of shapes) {
    if (shape.t === "group") continue;
    const bounds = v2ShapeLocalBounds(shape);
    if (!bounds) return null;
    for (let i = 0; i < 8; i++) {
      let point: Vec3 = [0, 1, 2].map(axis => i & (1 << axis) ? bounds.max[axis]! : bounds.min[axis]!) as Vec3;
      let current: SceneV2ShapeOp | undefined = shape;
      const seen = new Set<string>();
      while (current) {
        if (seen.has(current.id)) return null;
        seen.add(current.id);
        point = transformPoint(v2ShapeLocalTransform(current), point);
        if (current.parent !== null && !byId.has(current.parent)) return null;
        current = current.parent === null ? undefined : byId.get(current.parent);
      }
      if (!point.every(Number.isFinite)) return null;
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, point[axis]!); max[axis] = Math.max(max[axis]!, point[axis]!); }
      count++;
    }
  }
  return count ? { min, max } : null;
}

/** Exact ground extrema of each static primitive after the full affine hierarchy.
 * Support functions avoid projecting a merged AABB through a second rotation;
 * mesh extrema come from the actual vertices. */
function sceneGroundFootprint(ops: readonly SceneV2Op[], root: WorldTransform): GroundAabb | null {
  const shapes = ops.filter((op): op is SceneV2ShapeOp => ["group", "box", "cylinder", "mesh", "sphere", "capsule", "segment"].includes(op.t));
  const byId = new Map(shapes.map(shape => [shape.id, shape]));
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  let count = 0;
  for (const shape of shapes) {
    if (shape.t === "group") continue;
    const chain: SceneV2ShapeOp[] = [];
    const seen = new Set<string>();
    let current: SceneV2ShapeOp | undefined = shape;
    while (current) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      chain.push(current);
      if (current.parent !== null && !byId.has(current.parent)) return null;
      current = current.parent === null ? undefined : byId.get(current.parent);
    }
    const project = (input: Vec3): [number, number] => {
      let point = input;
      for (const node of chain) point = transformPoint(v2ShapeLocalTransform(node), point);
      const rotated = quatRotate([...root.rotation], [point[0], -point[2], point[1]]);
      return [root.position.u + root.scale * rotated[0], root.position.v + root.scale * rotated[1]];
    };
    if (shape.t === "mesh") {
      // Unreferenced vertices are not rendered and must not enlarge the area.
      for (const index of new Set(shape.faces.flat())) {
        const vertex = shape.vertices[index];
        if (!vertex) return null;
        const p = project(vertex);
        if (!p.every(Number.isFinite)) return null;
        for (let axis = 0; axis < 2; axis++) { min[axis] = Math.min(min[axis]!, p[axis]!); max[axis] = Math.max(max[axis]!, p[axis]!); }
        count++;
      }
      continue;
    }
    const bounds = v2ShapeLocalBounds(shape);
    if (!bounds) return null;
    const origin = project([0, 0, 0]);
    const basis = ([0, 1, 2] as const).map(axis => {
      let vector: Vec3 = [0, 0, 0]; vector[axis] = 1;
      for (const node of chain) {
        const local = v2ShapeLocalTransform(node);
        vector = quatRotate(local.rotation, [vector[0] * local.scale[0], vector[1] * local.scale[1], vector[2] * local.scale[2]]);
      }
      const rotated = quatRotate([...root.rotation], [vector[0], -vector[2], vector[1]]);
      return [root.scale * rotated[0], root.scale * rotated[1]];
    });
    const half = [0, 1, 2].map(axis => (bounds.max[axis]! - bounds.min[axis]!) / 2);
    const center = [0, 1, 2].map(axis => (bounds.max[axis]! + bounds.min[axis]!) / 2);
    for (let axis = 0; axis < 2; axis++) {
      const row = basis.map(column => column[axis]!);
      const middle = origin[axis]! + row.reduce((sum, value, i) => sum + value * center[i]!, 0);
      const radius = shape.t === "sphere" ? shape.radius * Math.hypot(...row)
        : shape.t === "cylinder" ? shape.radius * Math.hypot(row[0]!, row[2]!) + shape.height / 2 * Math.abs(row[1]!)
        : shape.t === "capsule" || (shape.t === "segment" && shape.shape === "capsule")
          ? half[0]! * Math.hypot(...row) + Math.max(0, half[1]! - half[0]!) * Math.abs(row[1]!)
          : row.reduce((sum, value, i) => sum + Math.abs(value) * half[i]!, 0);
      if (!Number.isFinite(middle) || !Number.isFinite(radius)) return null;
      min[axis] = Math.min(min[axis]!, middle - radius);
      max[axis] = Math.max(max[axis]!, middle + radius);
    }
    count++;
  }
  return count ? { min: { u: min[0]!, v: min[1]! }, max: { u: max[0]!, v: max[1]! } } : null;
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
  return containmentOfGeometry(record.footprint, record.localGroundAnchor, record.data.transform, area);
}

function containmentOfGeometry(footprint: GroundAabb | null, localGroundAnchor: Vec3 | null, transform: WorldTransform, area: GroundAabb): WorldObjectAuthorityEntry["containment"] {
  if (!footprint || !localGroundAnchor) return "unknown";
  const anchor = worldModelGroundAnchor(localGroundAnchor, transform);
  const point = classifyCameraPoint({ area, position: { ...anchor, h: 0 } });
  if (point === "unknown") return "unknown";
  if (point === "complete") return "writable";
  const overlap = classifyFootprint({ area, footprint: {
    status: "ready", bounds: footprint, contentVersion: "prepared", transformVersion: "current"
  }, contentVersion: "prepared", transformVersion: "current" });
  return overlap === "unknown" ? "unknown" : overlap === "outside" ? "outside" : "read-only";
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
  instance?: { contentVersion: string; transformVersion: string; transform: WorldTransform; localAabb: Aabb | null; localGroundAnchor: Vec3 | null; footprint: GroundAabb | null };
  camera?: WorldCameraData;
};

export type WorldAuthoringAuthority = SpatialCommitAuthority & {
  /**
   * Resolve and cache one exact canonical revision. An instance whose geometry
   * cannot be prepared is classified `unknown` and is never writable, but it does
   * not make the whole scope not-ready: one skeleton or unloaded asset must not
   * block every other write in the director area. Unknown never degrades to an
   * empty writable set — every other instance is still classified normally, and
   * the unknown target keeps failing closed at the write that touches it.
   */
  prepareCanvas(canvas: ServerCanvas, scope: { kind: "scene-area"; areaId: string }): Promise<PreparedWorldScope>;
  prepareGroup(canvas: ServerCanvas, groupId: string): Promise<PreparedWorldGroup>;
  prepareCamera(canvas: ServerCanvas, cameraId: string): Promise<PreparedWorldCamera>;
  /** Exposed for the semantic service to reuse the prepared local AABBs. */
  cacheFor(canvasId: string, scope: WorldScopeVersion): AuthorityCache | null;
  /**
   * Prepare the local AABB for model content that is about to be created or
   * replaced. New content never inherits eligibility from an existing version;
   * GLB needs the current canonical canvas to resolve its scoped asset identity;
   * the caller must prepare it before committing so containment is decided from
   * the exact post-state content. Returns `null` when bounds remain unknown.
   */
  prepareContent(fields: Record<string, unknown>, canvas?: ServerCanvas): Promise<{ contentVersion: string; localAabb: Aabb; localGroundAnchor?: Vec3; footprint?: (transform: WorldTransform) => GroundAabb | null } | null>;
  /** Drop cached projections for one canvas. */
  invalidate(canvasId: string): void;
};

export interface WorldAuthoringAuthorityOptions {
  /** Trusted bytes for canonical canvas assets; always read with canvasId. */
  media?: Pick<CanvasMediaClient, "read"> | null;
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
   * Content-addressed successful geometry and anchors; pose changes reuse the same
   * prepared geometry. Preparation failures are deliberately never stored: a
   * transient executor throw/structured failure must not poison the content, so
   * the same authority can retry and recover while every retry still starts
   * from `unknown` (fail closed) until real bounds exist.
   */
  const localAabbCache = new Map<string, { localAabb: Aabb; localGroundAnchor: Vec3; ops: readonly SceneV2Op[] }>();
  /** Versions validated as the post-state of an in-flight atomic resolve. */
  const postEligible = new Set<string>();
  const postKey = (canvasId: string, scopeVersion: string, target: WorldObjectIdentity, version: string): string =>
    `${canvasId}\u0000${scopeVersion}\u0000${target.kind}\u0000${target.kind === "instance" ? target.instanceId : target.cameraId}\u0000${version}`;
  const scopeKey = (canvasId: string, scope: AuthorityScopeRef | WorldScopeIdentity): string =>
    scope.kind === "scene-area"
      ? `${canvasId}\u0000area\u0000${scope.areaId}`
      : scope.kind === "world-camera" ? `${canvasId}\u0000camera\u0000${scope.cameraId}`
      : `${canvasId}\u0000group\u0000${scope.groupId}`;

  const scopeRefOf = (scope: WorldScopeVersion): AuthorityScopeRef => ({ ...scope.scope });

  async function prepareGeometry(fields: Record<string, unknown>, canvas?: ServerCanvas): Promise<
    | { ok: true; contentVersion: string; localAabb: Aabb; localGroundAnchor: Vec3; ops: readonly SceneV2Op[] }
    | { ok: false; reason: string }
  > {
    const failure = (reason: string) => ({ ok: false as const, reason });
    const contentVersion = instanceContentVersion(fields, canvas);
    if (fields.modelSourceKind === "glb") {
      if (!canvas || !options.media?.read) return failure("GLB 资源读取服务未就绪，请稍后重试");
      const reference = decodeGlbModelReference(fields);
      if (!reference.ok) return failure("GLB 资源引用无效，请重新导入模型");
      const asset = canvas.assets.find(entry => entry.id === reference.value.assetId);
      const metadata = asset?.metadata;
      if (asset?.status !== "ready" || asset.mediaKind !== "file" || !metadata) return failure("GLB 资源未就绪，请检查模型资产");
      const { storageKey, checksum, size, contentType } = metadata;
      if (!isValidStorageKey(storageKey) || typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum) ||
        typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > GLB_MAX_FILE_BYTES ||
        contentType !== "model/gltf-binary") return failure("GLB 资源元数据无效，请重新导入模型");
      if (storageKey !== `sha256-${checksum}` && !storageKey.startsWith(`generation-outputs/${checksum}.`)) return failure("GLB 资源校验信息不一致，请重新导入模型");
      const cached = localAabbCache.get(contentVersion);
      if (cached) return { ok: true, contentVersion, ...cached };
      try {
        const raw = await options.media.read(storageKey, canvas.id);
        if (raw.contentType !== contentType || raw.bytes.byteLength !== size || raw.bytes.byteLength > GLB_MAX_FILE_BYTES ||
          createHash("sha256").update(raw.bytes).digest("hex") !== checksum) return failure("GLB 文件与资产校验信息不一致，请重新导入模型");
        const parsed = parseGlbModel(raw.bytes);
        if (!parsed.ok) return failure("GLB 文件无法解析，请检查文件格式后重新导入");
        // GLB hierarchy/TRS is already in the parsed ops. Shared-world rendering
        // applies only the instance root, never the legacy card modelPlacement.
        const localAabb = authoritativeSceneBounds(parsed.ops);
        if (!localAabb) return failure("GLB 没有可计算位置的几何内容");
        const localGroundAnchor = modelGroundAnchorLocal(parsed.ops, null);
        if (!localGroundAnchor) return failure("GLB 几何无法计算落地位置");
        localAabbCache.set(contentVersion, { localAabb, localGroundAnchor, ops: parsed.ops });
        return { ok: true, contentVersion, localAabb, localGroundAnchor, ops: parsed.ops };
      } catch (error) {
        if (isMediaObjectNotFoundError(error) || (error as { status?: unknown } | null)?.status === 404) {
          return failure("GLB 文件在当前存储中不存在，请恢复原文件或重新导入模型");
        }
        if ((error as { code?: unknown } | null)?.code === "limit-exceeded") return failure("GLB 文件超过当前资源读取上限");
        return failure("GLB 资源读取失败，请检查存储连接后重试");
      }
    }
    const cached = localAabbCache.get(contentVersion);
    if (cached) return { ok: true, contentVersion, ...cached };
    if (typeof fields.modelScript !== "string" || fields.modelScript.trim().length === 0) return failure("模型脚本为空，请修复模型内容");
    try {
      const stored = fields.modelRig == null ? null : storedHumanoidRig(fields.modelRig);
      if (stored && !stored.ok) return failure("模型骨骼参数无效，请修复模型内容");
      const rig = stored?.ok ? stored.value : null;
      const execution = await (options.executeScene ?? executeSceneIr)(fields.modelScript, fields.modelScriptVersion, rig ? { rig: rig.parameters } : {});
      if (!execution.ok) return failure(`模型脚本执行失败：${execution.message}`);
      const localAabb = authoritativeSceneBounds(execution.ops);
      if (!localAabb) return failure("模型脚本没有生成可计算位置的几何内容");
      const localGroundAnchor = modelGroundAnchorLocal(execution.ops, rig);
      if (!localGroundAnchor) return failure("模型几何无法计算落地位置");
      localAabbCache.set(contentVersion, { localAabb, localGroundAnchor, ops: execution.ops });
      return { ok: true, contentVersion, localAabb, localGroundAnchor, ops: execution.ops };
    } catch {
      return failure("模型脚本执行异常，请重试或检查模型内容");
    }
  }

  async function prepareContent(fields: Record<string, unknown>, canvas?: ServerCanvas) {
    const prepared = await prepareGeometry(fields, canvas);
    if (!prepared.ok) return null;
    const { ok: _, ops, ...content } = prepared;
    return { ...content, footprint: (transform: WorldTransform) => sceneGroundFootprint(ops, transform) };
  }

  async function collectInstances(canvas: ServerCanvas) {
    const records = new Map<string, InstanceRecord>();
    const failures: string[] = [];
    for (const node of canvas.document.nodes) {
      const fields = nodeData(canvas, node.id);
      if (!fields || fields.sharedWorldInstance === undefined) continue;
      const asset = canvas.assets.find(entry => entry.id === fields.modelAssetId);
      const label = nonEmpty(fields.title) ? fields.title : asset?.title;
      const describeFailure = (reason: string) => failures.push(`模型「${label || node.id}」${label ? `（${node.id}）` : ""}：${reason}`);
      const decoded = decodeWorldInstanceData(fields.sharedWorldInstance);
      if (!decoded.ok) {
        describeFailure("世界实例变换无效，请修复模型位置");
        continue;
      }
      const data = decoded.value;
      const contentVersion = instanceContentVersion(fields, canvas);
      const prepared = await prepareGeometry(fields, canvas);
      const localAabb = prepared.ok ? prepared.localAabb : null;
      const localGroundAnchor = prepared.ok ? prepared.localGroundAnchor : null;
      if (!prepared.ok) describeFailure(prepared.reason);
      const footprint = prepared.ok ? sceneGroundFootprint(prepared.ops, data.transform) : null;
      records.set(data.instanceId, instanceRecord(node.id, data, contentVersion, localAabb, localGroundAnchor, footprint));
    }
    const failureMessage = failures.length
      ? `无法准备场景模型。${failures.slice(0, 3).join("；")}${failures.length > 3 ? `；另有 ${failures.length - 3} 个模型需要修复` : ""}`
      : null;
    return { records, failureMessage };
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
    if (!nonEmpty(scope.areaId)) return { ok: false, code: "invalid-data", message: "导演区身份无效" };
    const found = findArea(canvas, scope.areaId);
    if (!found) return { ok: false, code: "outside-scope", message: "导演区不存在" };
    const { records: instances } = await collectInstances(canvas);
    const cameras = collectCameras(canvas);
    // Unknown geometry never authorizes a write, but it must not lock the whole area:
    // a design target (an empty skeleton waiting for its first chunk, or an asset whose
    // bytes are not ready) only makes *that* model non-writable. Treating it as fatal
    // would let one unfinished model block every other write in the director area.
    // Such instances stay `unknown`/read-only and every write to them still fails
    // closed at the target level.

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
    const { records: instances } = await collectInstances(canvas);
    const cameras = collectCameras(canvas);
    // Unknown geometry never authorizes a write, but it must not lock the whole area:
    // a design target (an empty skeleton waiting for its first chunk, or an asset whose
    // bytes are not ready) only makes *that* model non-writable. Treating it as fatal
    // would let one unfinished model block every other write in the director area.
    // Such instances stay `unknown`/read-only and every write to them still fails
    // closed at the target level.

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

  async function prepareCamera(canvas: ServerCanvas, cameraId: string): Promise<PreparedWorldCamera> {
    if (!nonEmpty(cameraId)) return { ok: false, code: "invalid-data", message: "镜头身份无效" };
    const cameras = collectCameras(canvas);
    const selected = cameras.get(cameraId);
    if (!selected) return { ok: false, code: "outside-scope", message: "镜头不存在" };
    // Geometry is reference-only. Unknown bounds must not prevent editing a lens.
    const { records: instances } = await collectInstances(canvas);
    const scope: WorldScopeVersion = {
      scope: { kind: "world-camera", cameraId },
      // Settings advance independently, so successive edits retain the same scope.
      scopeVersion: stableAuthorityVersion("camera-scope", { cameraId, nodeId: selected.nodeId })
    };
    const cache: CameraCache = { kind: "world-camera", canvasId: canvas.id, revision: canvas.revision,
      scope, cameraNodeId: selected.nodeId, cameraId, instances, cameras };
    caches.set(scopeKey(canvas.id, scope.scope), cache);
    const references = [...instances.values()].filter(record => !selected.data.boundInstanceId || record.identity.instanceId === selected.data.boundInstanceId);
    return { ok: true, snapshot: { scope, writable: [{ ...selected.identity, version: selected.version }],
      readOnly: references.map(record => ({ ...record.identity, version: record.version })) } };
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
    if (cache.kind === "world-camera") {
      return cache.scope.scopeVersion === scope.scopeVersion && scope.scope.kind === "world-camera" && scope.scope.cameraId === cache.cameraId
        && targets.every(target => target.kind === "camera" && target.cameraId === cache.cameraId
          && (cache.cameras.get(target.cameraId)?.version === target.version || postEligible.has(postKey(canvasId, scope.scopeVersion, target, target.version))));
    }
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
        const contentVersion = instanceContentVersion(fields, canvas);
        const transformVersion = stableAuthorityVersion("world-pose", decoded.value.transform);
        const cached = cache.instances.get(target.instanceId);
        const localAabb = cached && cached.contentVersion === contentVersion
          ? cached.localAabb
          : localAabbCache.get(contentVersion)?.localAabb ?? null;
        const localGroundAnchor = cached && cached.contentVersion === contentVersion
          ? cached.localGroundAnchor
          : localAabbCache.get(contentVersion)?.localGroundAnchor ?? null;
        const ops = localAabbCache.get(contentVersion)?.ops;
        const footprint = ops ? sceneGroundFootprint(ops, decoded.value.transform) : null;
        return {
          identity: target,
          version: instanceVersion(target.instanceId, contentVersion, transformVersion),
          instance: { contentVersion, transformVersion, transform: decoded.value.transform, localAabb, localGroundAnchor, footprint }
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
      return containmentOfGeometry(state.instance.footprint, state.instance.localGroundAnchor, state.instance.transform, area);
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
    userCreateTargets: (before, after) => directorCharacterCommitTargets(before, after, (areaId, scopeVersion) => cacheFor(before.id, { scope: { kind: "scene-area", areaId }, scopeVersion })),
    prepareCanvas: prepareArea,
    prepareGroup,
    prepareCamera,
    cacheFor,
    prepareContent,
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
    expansionCandidates(intent, before, after) {
      if (intent.scope.scope.kind !== "scene-area") return null;
      const cache = cacheFor(intent.canvasId, intent.scope);
      const previous = findArea(before, intent.scope.scope.areaId)?.data;
      const next = findArea(after, intent.scope.scope.areaId)?.data;
      if (!cache || cache.kind !== "scene-area" || cache.revision !== before.revision || !previous || !next) return null;
      const old = previous.bounds, bounds = next.bounds;
      if (bounds.min.u > old.min.u || bounds.min.v > old.min.v || bounds.max.u < old.max.u || bounds.max.v < old.max.v) return null;
      const intersects = (a: GroundAabb, b: GroundAabb) => a.max.u >= b.min.u && a.min.u <= b.max.u && a.max.v >= b.min.v && a.min.v <= b.max.v;
      const inside = (a: GroundAabb, b: GroundAabb) => a.min.u >= b.min.u && a.min.v >= b.min.v && a.max.u <= b.max.u && a.max.v <= b.max.v;
      const candidates: WorldObjectIdentity[] = [];
      for (const record of cache.instances.values()) {
        let footprint: GroundAabb;
        if (!record.localAabb) {
          // An authorized empty skeleton can acquire geometry in this same edit.
          if (!intent.writable.some(target => target.kind === "instance" && target.instanceId === record.data.instanceId)) return null;
          const post = stateAgainst(after, record.identity, cache);
          if (!post?.instance?.localAabb) return null;
          const ops = localAabbCache.get(post.instance.contentVersion)?.ops;
          const calculated = ops && sceneGroundFootprint(ops, post.instance.transform);
          if (!calculated) return null;
          footprint = calculated;
        } else {
          const ops = localAabbCache.get(record.contentVersion)?.ops;
          const calculated = ops && sceneGroundFootprint(ops, record.data.transform);
          if (!calculated) return null;
          footprint = calculated;
        }
        if (intersects(footprint, bounds) && !inside(footprint, old)) candidates.push(record.identity);
      }
      for (const record of cache.cameras.values()) {
        const { u, v } = record.data.position;
        const footprint = { min: { u, v }, max: { u, v } };
        if (intersects(footprint, bounds) && !inside(footprint, old)) candidates.push(record.identity);
      }
      return candidates;
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

      if (scope.scope.kind === "world-camera") {
        if (cache.kind !== "world-camera" || cache.cameraId !== scope.scope.cameraId || cache.scope.scopeVersion !== scope.scopeVersion) return null;
        const previous: WorldObjectVersion[] = [];
        const next: WorldObjectVersion[] = [];
        for (const target of targets) {
          if (target.kind !== "camera" || target.cameraId !== cache.cameraId) return null;
          const from = stateAgainst(before, target, cache);
          const to = stateAgainst(after, target, cache);
          if (!from?.camera || !to?.camera) return null;
          if (cameraPoseVersion(from.camera) !== cameraPoseVersion(to.camera) && from.version === to.version) return null;
          postEligible.add(postKey(intent.canvasId, scope.scopeVersion, target, to.version));
          previous.push({ ...target, version: from.version });
          next.push({ ...target, version: to.version });
        }
        return { scope, previous, next };
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
            // A new object must be inside the area, but its geometry may legitimately
            // still be unknown: that is exactly a skeleton created for chunked
            // authoring (no script yet), or an asset whose bytes are not ready. Such
            // an object is created read-only/not-ready and never authorized for a
            // later write until its geometry exists; refusing the create instead
            // would make the skeleton step impossible. An object whose geometry *is*
            // known must still be fully contained.
            const afterContainment = containmentOf(afterState, afterArea.bounds);
            if (afterContainment !== "writable" && afterContainment !== "unknown") return null;
            // Both branches record the post-state version: the object may be created
            // read-only (unknown geometry) and still holds the lease version a later
            // chunk needs.
            postEligible.add(postKey(intent.canvasId, intent.scope.scopeVersion, target, afterState.version));
          }
          previous.push({ ...target, version: "absent" });
          next.push({ ...target, version: afterState.version });
          continue;
        }
        const beforeContainment = containmentOf(beforeState, beforeArea?.bounds ?? scopeArea.bounds);
        // A skeleton (or an unloaded asset) is `unknown`: it has no geometry to violate
        // containment yet, and the real geometry supplied by this very write is
        // checked below. Anything known to be partial or outside still refuses.
        if (beforeContainment !== "writable" && beforeContainment !== "unknown") return null;
        if (beforeContainment === "unknown" && afterState && afterArea) {
          const afterContainment = containmentOf(afterState, afterArea.bounds);
          if (afterContainment !== "writable") return null;
        }

        if (beforeState.camera && afterState?.camera) {
          const poseChanged = cameraPoseVersion(beforeState.camera) !== cameraPoseVersion(afterState.camera);
          if (poseChanged && afterState.camera.settingsVersion === beforeState.camera.settingsVersion) return null;
        }
        if (afterState && afterArea) {
          // Writing content that legitimately has no geometry yet (an empty skeleton
          // being created or reset for chunked authoring) is allowed: the object
          // becomes read-only until a chunk supplies geometry, and the lease keeps
          // the produced version so the next append can attach to it.
          const afterContainment = containmentOf(afterState, afterArea.bounds);
          if (afterContainment !== "writable" && afterContainment !== "unknown") return null;
          if (afterContainment !== "writable") {
            previous.push({ ...target, version: beforeState.version });
            next.push({ ...target, version: afterState.version });
            postEligible.add(postKey(intent.canvasId, intent.scope.scopeVersion, target, afterState.version));
            continue;
          }
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

      // A bounds edit advances the scope version in the same commit; adopt the
      // post-state scope so this run can keep writing against the new range.
      const effectiveArea = afterArea ?? scopeArea;
      return {
        scope: { scope: { kind: "scene-area", areaId: effectiveArea.areaId }, scopeVersion: effectiveArea.scopeVersion },
        previous,
        next
      };
    }
  };

  return authority;
}
