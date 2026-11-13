/**
 * Shared-world v1 copy reference remapping (OC03).
 *
 * Pure conversion for a caller-defined copy collection (clipboard, duplicate,
 * migration batch). The caller owns the collection boundary and every new
 * identity; this module never allocates persistent IDs, touches the clipboard,
 * stores, Yjs, databases, undo history or transactions.
 *
 * T01 identity namespaces are kept apart:
 *
 * - structural node ids (also used by `workflowGroup2d.memberNodeIds`);
 * - `worldInstance.instanceId`;
 * - `workflowGroup2d.groupId`;
 * - `sceneArea.areaId`;
 * - `worldCamera.cameraId`.
 *
 * A group and an area may legitimately share one id string, so callers pass one
 * old→new table per namespace instead of a single flat map.
 *
 * Persistent collection-internal references rewritten here include:
 * `worldCamera.boundInstanceId`, `workflowGroup2d.memberNodeIds` and animation
 * track instance targets. A reference that does not resolve inside the collection is
 * reported as `binding-unavailable`; it is never silently unbound, rebound to
 * another object or widened to a whole-world view.
 *
 * Reserved world payloads (`SHARED_WORLD_NODE_DATA_KEYS`) are validated with the
 * OC01 codecs. Unknown versions report `unsupported-version`, every other
 * structural/number/allowlist violation reports `invalid-data`; the camera
 * payload has no OC01 codec yet, so it is validated here against the frozen T01
 * shape (camera pose semantics remain OC05's responsibility). Non-world nodeData
 * keys are treated as opaque persistent JSON and copied without interpretation.
 *
 * T01 transient host state (write leases, occupancy epochs, GPU/runtime handles,
 * matrices) is not part of nodeData and is never read or emitted: output entries
 * contain only `sourceNodeId`, `nodeId`, `nodeData` and `worldKind`, and world
 * payloads are rebuilt from validated DTO fields, so extra runtime fields cannot
 * ride along. A failed remap keeps the caller's input and previous document
 * untouched; a successful remap returns fresh objects that never alias the input.
 *
 * `scopeVersion` and `settingsVersion` are opaque authority-owned versions, not
 * IDs, and are copied unchanged. Because a copy replaces the group/area identity,
 * T01 requires the authority (T03) to publish a fresh `scopeVersion` for the new
 * scope identity; this module deliberately does not mint versions. Member node
 * types and nesting remain document-context rules (OC01), so only membership
 * resolution is checked here.
 */

import {
  SHARED_WORLD_NODE_DATA_KEYS,
  SHARED_WORLD_VERSION,
  sceneAreaAnimationOrigin,
  type SharedWorldDecodeResult,
  type SceneAreaData,
  type WorldCameraCaptureMode,
  type WorldCameraData,
  type WorldCameraProjection,
  type WorldId,
  type WorldInstanceData,
  type WorkflowGroupData
} from "./shared-world.js";
import {
  createWorldAnimationScript,
  executeWorldAnimationScript,
  serializeWorldAnimationScript
} from "./world-animation-script.js";
import {
  decodeFailure,
  decodeWorldInstanceData,
  decodeWorldPoint,
  decodeWorldRotation,
  hasOnlyKeys,
  isFiniteWorldNumber,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField,
  readKindedRecord,
  type SharedWorldCodecFailureCode
} from "./shared-world-codec.js";
import { decodeSceneAreaData, decodeWorkflowGroupData } from "./creation-scope-codec.js";

/** `Map` for hosts and plain records for serialized callers; both are pure input. */
export type WorldCopyIdTable = ReadonlyMap<WorldId, WorldId> | Readonly<Record<WorldId, WorldId>>;

export interface WorldReferenceRemapIdMap {
  /** Structural canvas node ids; also the namespace of `memberNodeIds`. */
  readonly nodeIds: WorldCopyIdTable;
  /** `sharedWorldInstance.instanceId` namespace. */
  readonly instanceIds?: WorldCopyIdTable;
  /** `workflowGroup2d.groupId` namespace. */
  readonly groupIds?: WorldCopyIdTable;
  /** `sceneArea.areaId` namespace. */
  readonly areaIds?: WorldCopyIdTable;
  /** `worldCamera.cameraId` namespace. */
  readonly cameraIds?: WorldCopyIdTable;
  /** Optional immutable media asset aliases; omitted assets retain their identity. */
  readonly assetIds?: WorldCopyIdTable;
}

/** One node of the copied collection. Host runtime state is not part of this input. */
export interface WorldCopySourceNode {
  /** Source structural node id. */
  readonly nodeId: WorldId;
  /** Untrusted persistent nodeData; only the reserved T01 world keys are rewritten. */
  readonly nodeData?: unknown;
}

export type WorldReferenceRemapWorldKind =
  | "world-instance"
  | "workflow-group-2d"
  | "scene-area"
  | "world-camera";

export interface WorldReferenceRemapEntry {
  readonly sourceNodeId: WorldId;
  /** Caller-assigned structural id for the copy. */
  readonly nodeId: WorldId;
  /** Fresh persistent nodeData with all collection-internal references rewritten. */
  readonly nodeData: Record<string, unknown>;
  /** Shared-world payload kind, or `null` for ordinary nodes. */
  readonly worldKind: WorldReferenceRemapWorldKind | null;
}

export type WorldReferenceRemapFailureCode =
  | SharedWorldCodecFailureCode
  | "unmapped-identity"
  | "binding-unavailable";

export type WorldReferenceRelation = "node" | "instance" | "group" | "area" | "camera";

export interface WorldReferenceUnavailable {
  readonly relation: WorldReferenceRelation;
  readonly id: WorldId;
}

export interface WorldReferenceRemapFailure {
  readonly ok: false;
  readonly code: WorldReferenceRemapFailureCode;
  /** Node being remapped when the failure was detected, when known. */
  readonly sourceNodeId?: WorldId;
  /** T01 DTO field or reserved nodeData key that failed resolution. */
  readonly field?: string;
  /** The unresolved or unmapped source identity. */
  readonly reference?: WorldReferenceUnavailable;
}

export type WorldReferenceRemapResult =
  | { readonly ok: true; readonly nodes: readonly WorldReferenceRemapEntry[] }
  | WorldReferenceRemapFailure;

export interface WorldReferenceRemapInput {
  readonly nodes: readonly WorldCopySourceNode[];
  readonly ids: WorldReferenceRemapIdMap;
}

const WORLD_NODE_DATA_KEYS = [
  SHARED_WORLD_NODE_DATA_KEYS.instance,
  SHARED_WORLD_NODE_DATA_KEYS.group,
  SHARED_WORLD_NODE_DATA_KEYS.area,
  SHARED_WORLD_NODE_DATA_KEYS.camera
] as const;

const CAMERA_KIND = "world-camera";
const CAMERA_KEYS = [
  "kind",
  "version",
  "cameraId",
  "settingsVersion",
  "position",
  "rotation",
  "projection",
  "captureMode",
  "aspect",
  "boundInstanceId"
] as const;
const ISOMETRIC_PROJECTION_KEYS = ["kind", "verticalSizeMeters", "nearMeters", "farMeters"] as const;
const PERSPECTIVE_PROJECTION_KEYS = ["kind", "verticalFovRadians", "nearMeters", "farMeters"] as const;
const CAPTURE_MODE_KEYS = ["kind"] as const;
const ASPECT_KEYS = ["width", "height"] as const;

type DecodedWorld =
  | { readonly kind: "world-instance"; readonly value: WorldInstanceData }
  | { readonly kind: "workflow-group-2d"; readonly value: WorkflowGroupData }
  | { readonly kind: "scene-area"; readonly value: SceneAreaData }
  | { readonly kind: "world-camera"; readonly value: WorldCameraData };

interface PreparedEntry {
  readonly sourceNodeId: WorldId;
  readonly nodeData: Record<string, unknown>;
  readonly worldKey: (typeof WORLD_NODE_DATA_KEYS)[number] | null;
  readonly world: DecodedWorld | null;
}

interface IdTableRead {
  readonly ok: true;
  readonly table: ReadonlyMap<WorldId, WorldId>;
}

/**
 * Rewrite the collection-internal references of one copied node set.
 *
 * The function is total over its typed input: it returns `ok: false` instead of
 * throwing, and only rejects the whole batch. `ok: true` preserves the caller's
 * node order and contains freshly built objects.
 */
export function remapWorldCopyReferences(input: WorldReferenceRemapInput): WorldReferenceRemapResult {
  if (!isJsonRecord(input)) return fail("invalid-data");
  if (!Array.isArray(ownField(input, "nodes"))) return fail("invalid-data");
  const idsInput = ownField(input, "ids");
  if (!isJsonRecord(idsInput)) return fail("invalid-data");

  const nodeIds = readIdTable(ownField(idsInput, "nodeIds"), "ids.nodeIds");
  if (!nodeIds.ok) return nodeIds;
  const instanceIds = readOptionalIdTable(idsInput, "instanceIds");
  if (!instanceIds.ok) return instanceIds;
  const groupIds = readOptionalIdTable(idsInput, "groupIds");
  if (!groupIds.ok) return groupIds;
  const areaIds = readOptionalIdTable(idsInput, "areaIds");
  if (!areaIds.ok) return areaIds;
  const assetIds = readOptionalIdTable(idsInput, "assetIds");
  if (!assetIds.ok) return assetIds;
  const cameraIds = readOptionalIdTable(idsInput, "cameraIds");
  if (!cameraIds.ok) return cameraIds;

  const prepared: PreparedEntry[] = [];
  const sourceNodeIds = new Set<WorldId>();
  for (const raw of input.nodes as readonly unknown[]) {
    const entry = prepareEntry(raw);
    if (!entry.ok) return entry;
    if (sourceNodeIds.has(entry.entry.sourceNodeId)) {
      return fail("invalid-data", { sourceNodeId: entry.entry.sourceNodeId, field: "nodeId" });
    }
    sourceNodeIds.add(entry.entry.sourceNodeId);
    prepared.push(entry.entry);
  }

  const worldIdentities = collectWorldIdentities(prepared);
  if (!worldIdentities.ok) return worldIdentities;

  const nodes: WorldReferenceRemapEntry[] = [];
  for (const entry of prepared) {
    const newNodeId = requireMappedId(nodeIds.table, entry.sourceNodeId, { relation: "node", id: entry.sourceNodeId }, entry.sourceNodeId);
    if (typeof newNodeId !== "string") return newNodeId;

    let nodeData = entry.nodeData;
    if (entry.world && entry.worldKey) {
      const remapped = remapWorldPayload(entry.world, {
        sourceNodeId: entry.sourceNodeId,
        nodeIds: nodeIds.table,
        instanceIds: instanceIds.table,
        groupIds: groupIds.table,
        areaIds: areaIds.table,
        cameraIds: cameraIds.table,
        assetIds: assetIds.table,
        sourceNodeIds,
        sourceInstanceIds: worldIdentities.instanceIds
      });
      if (!remapped.ok) return remapped;
      nodeData = { ...entry.nodeData, [entry.worldKey]: remapped.payload };
    }

    nodes.push({
      sourceNodeId: entry.sourceNodeId,
      nodeId: newNodeId,
      nodeData,
      worldKind: entry.world ? entry.world.kind : null
    });
  }

  return { ok: true, nodes };
}

function prepareEntry(
  raw: unknown
): { readonly ok: true; readonly entry: PreparedEntry } | WorldReferenceRemapFailure {
  if (!isJsonRecord(raw)) return fail("invalid-data");
  const sourceNodeId = ownField(raw, "nodeId");
  if (!isNonEmptyWorldId(sourceNodeId)) return fail("invalid-data");
  const rawData = ownField(raw, "nodeData");
  if (rawData !== undefined && rawData !== null && !isJsonRecord(rawData)) {
    return fail("invalid-data", { sourceNodeId, field: "nodeData" });
  }
  const nodeData = rawData === undefined || rawData === null ? {} : rawData;

  const presentWorldKeys = WORLD_NODE_DATA_KEYS.filter(key => Object.prototype.hasOwnProperty.call(nodeData, key));
  if (presentWorldKeys.length > 1) {
    return fail("invalid-data", { sourceNodeId, field: "nodeData" });
  }

  if (presentWorldKeys.length === 0) {
    const cloned = cloneRecord(nodeData, sourceNodeId);
    if (!cloned.ok) return cloned;
    return { ok: true, entry: { sourceNodeId, nodeData: cloned.record, worldKey: null, world: null } };
  }

  const worldKey = presentWorldKeys[0]!;
  const world = decodeWorldPayload(worldKey, nodeData[worldKey]);
  if (!world.ok) return fail(world.code, { sourceNodeId, field: worldKey });
  const otherKeys = cloneRecordExcept(nodeData, worldKey, sourceNodeId);
  if (!otherKeys.ok) return otherKeys;
  return { ok: true, entry: { sourceNodeId, nodeData: otherKeys.record, worldKey, world: world.world } };
}

function decodeWorldPayload(
  key: (typeof WORLD_NODE_DATA_KEYS)[number],
  payload: unknown
): { readonly ok: true; readonly world: DecodedWorld } | { readonly ok: false; readonly code: SharedWorldCodecFailureCode } {
  switch (key) {
    case SHARED_WORLD_NODE_DATA_KEYS.instance: {
      const decoded = decodeWorldInstanceData(payload);
      return decoded.ok ? { ok: true, world: { kind: "world-instance", value: decoded.value } } : { ok: false, code: decoded.code };
    }
    case SHARED_WORLD_NODE_DATA_KEYS.group: {
      const decoded = decodeWorkflowGroupData(payload);
      return decoded.ok ? { ok: true, world: { kind: "workflow-group-2d", value: decoded.value } } : { ok: false, code: decoded.code };
    }
    case SHARED_WORLD_NODE_DATA_KEYS.area: {
      const decoded = decodeSceneAreaData(payload);
      return decoded.ok ? { ok: true, world: { kind: "scene-area", value: decoded.value } } : { ok: false, code: decoded.code };
    }
    case SHARED_WORLD_NODE_DATA_KEYS.camera: {
      const decoded = decodeWorldCameraData(payload);
      return decoded.ok ? { ok: true, world: { kind: "world-camera", value: decoded.value } } : { ok: false, code: decoded.code };
    }
  }
}

function collectWorldIdentities(
  prepared: readonly PreparedEntry[]
): { readonly ok: true; readonly instanceIds: ReadonlySet<WorldId> } | WorldReferenceRemapFailure {
  const instanceIds = new Set<WorldId>();
  const groupIds = new Set<WorldId>();
  const areaIds = new Set<WorldId>();
  const cameraIds = new Set<WorldId>();
  for (const entry of prepared) {
    const world = entry.world;
    if (!world) continue;
    const seen =
      world.kind === "world-instance"
        ? instanceIds
        : world.kind === "workflow-group-2d"
          ? groupIds
          : world.kind === "scene-area"
            ? areaIds
            : cameraIds;
    const id = ownWorldId(world);
    if (seen.has(id)) return fail("invalid-data", { sourceNodeId: entry.sourceNodeId, field: ownWorldIdField(world) });
    seen.add(id);
  }
  return { ok: true, instanceIds };
}

function ownWorldId(world: DecodedWorld): WorldId {
  switch (world.kind) {
    case "world-instance": return world.value.instanceId;
    case "workflow-group-2d": return world.value.groupId;
    case "scene-area": return world.value.areaId;
    case "world-camera": return world.value.cameraId;
  }
}

function ownWorldIdField(world: DecodedWorld): string {
  switch (world.kind) {
    case "world-instance": return "instanceId";
    case "workflow-group-2d": return "groupId";
    case "scene-area": return "areaId";
    case "world-camera": return "cameraId";
  }
}

interface RemapContext {
  readonly assetIds: ReadonlyMap<WorldId, WorldId> | undefined;
  readonly sourceNodeId: WorldId;
  readonly nodeIds: ReadonlyMap<WorldId, WorldId>;
  readonly instanceIds: ReadonlyMap<WorldId, WorldId> | undefined;
  readonly groupIds: ReadonlyMap<WorldId, WorldId> | undefined;
  readonly areaIds: ReadonlyMap<WorldId, WorldId> | undefined;
  readonly cameraIds: ReadonlyMap<WorldId, WorldId> | undefined;
  readonly sourceNodeIds: ReadonlySet<WorldId>;
  readonly sourceInstanceIds: ReadonlySet<WorldId>;
}

function remapWorldPayload(
  world: DecodedWorld,
  context: RemapContext
): { readonly ok: true; readonly payload: Record<string, unknown> } | WorldReferenceRemapFailure {
  switch (world.kind) {
    case "world-instance": {
      const instanceId = requireMappedId(context.instanceIds, world.value.instanceId, { relation: "instance", id: world.value.instanceId }, context.sourceNodeId);
      if (typeof instanceId !== "string") return instanceId;
      const value = world.value;
      return {
        ok: true,
        payload: {
          kind: value.kind,
          version: SHARED_WORLD_VERSION,
          instanceId,
          transform: {
            version: SHARED_WORLD_VERSION,
            position: value.transform.position,
            rotation: value.transform.rotation,
            scale: value.transform.scale
          }
        }
      };
    }
    case "workflow-group-2d": {
      const groupId = requireMappedId(context.groupIds, world.value.groupId, { relation: "group", id: world.value.groupId }, context.sourceNodeId);
      if (typeof groupId !== "string") return groupId;
      const members: WorldId[] = [];
      for (const member of world.value.memberNodeIds) {
        if (!context.sourceNodeIds.has(member)) {
          return fail("binding-unavailable", {
            sourceNodeId: context.sourceNodeId,
            field: "memberNodeIds",
            reference: { relation: "node", id: member }
          });
        }
        const mapped = requireMappedId(context.nodeIds, member, { relation: "node", id: member }, context.sourceNodeId);
        if (typeof mapped !== "string") return mapped;
        members.push(mapped);
      }
      return {
        ok: true,
        payload: {
          kind: world.value.kind,
          version: SHARED_WORLD_VERSION,
          groupId,
          scopeVersion: world.value.scopeVersion,
          memberNodeIds: members
        }
      };
    }
    case "scene-area": {
      const areaId = requireMappedId(context.areaIds, world.value.areaId, { relation: "area", id: world.value.areaId }, context.sourceNodeId);
      if (typeof areaId !== "string") return areaId;
      let animationScript = world.value.animationScript;
      if (animationScript) {
        // 动画脚本是代码：先编译成 IR，再按复制集合重写目标身份并反序列化，
        // 不允许把旧 ID 留在脚本里。
        const compiled = executeWorldAnimationScript(animationScript.script, {
          duration: animationScript.duration,
          loop: animationScript.loop
        });
        if (!compiled.ok) {
          return fail("binding-unavailable", {
            sourceNodeId: context.sourceNodeId,
            field: "animationScript",
            reference: { relation: "node", id: context.sourceNodeId }
          });
        }
        const instanceTracks = [];
        for (const track of compiled.ir.instanceTracks) {
          if (!context.sourceInstanceIds.has(track.targetId)) {
            return fail("binding-unavailable", {
              sourceNodeId: context.sourceNodeId,
              field: "animationScript.instanceTracks",
              reference: { relation: "instance", id: track.targetId }
            });
          }
          const instanceId = requireMappedId(context.instanceIds, track.targetId,
            { relation: "instance", id: track.targetId }, context.sourceNodeId);
          if (typeof instanceId !== "string") return instanceId;
          instanceTracks.push({ ...track, targetId: instanceId });
        }
        const partTracks = [];
        for (const track of compiled.ir.partTracks ?? []) {
          if (!context.sourceInstanceIds.has(track.targetId)) {
            return fail("binding-unavailable", {
              sourceNodeId: context.sourceNodeId,
              field: "animationScript.partTracks",
              reference: { relation: "instance", id: track.targetId }
            });
          }
          const instanceId = requireMappedId(context.instanceIds, track.targetId,
            { relation: "instance", id: track.targetId }, context.sourceNodeId);
          if (typeof instanceId !== "string") return instanceId;
          partTracks.push({ ...track, targetId: instanceId });
        }
        const walkTracks = [];
        for (const track of compiled.ir.walkTracks ?? []) {
          if (!context.sourceInstanceIds.has(track.targetId)) {
            return fail("binding-unavailable", {
              sourceNodeId: context.sourceNodeId,
              field: "animationScript.walkTracks",
              reference: { relation: "instance", id: track.targetId }
            });
          }
          const instanceId = requireMappedId(context.instanceIds, track.targetId,
            { relation: "instance", id: track.targetId }, context.sourceNodeId);
          if (typeof instanceId !== "string") return instanceId;
          walkTracks.push({ ...track, targetId: instanceId });
        }
        const somaTracks = [];
        for (const track of compiled.ir.somaTracks ?? []) {
          if (!context.sourceInstanceIds.has(track.targetId)) return fail("binding-unavailable", {sourceNodeId:context.sourceNodeId,field:"animationScript.somaTracks",reference:{relation:"instance",id:track.targetId}});
          const instanceId = requireMappedId(context.instanceIds,track.targetId,{relation:"instance",id:track.targetId},context.sourceNodeId);
          if (typeof instanceId !== "string") return instanceId;
          somaTracks.push({...track,targetId:instanceId,assetId:context.assetIds?.get(track.assetId) ?? track.assetId});
        }
        const cameraTracks = [];
        for (const track of compiled.ir.cameraTracks) {
          if (!context.cameraIds?.has(track.targetId)) {
            return fail("binding-unavailable", {
              sourceNodeId: context.sourceNodeId,
              field: "animationScript.cameraTracks",
              reference: { relation: "camera", id: track.targetId }
            });
          }
          const cameraId = requireMappedId(context.cameraIds, track.targetId,
            { relation: "camera", id: track.targetId }, context.sourceNodeId);
          if (typeof cameraId !== "string") return cameraId;
          cameraTracks.push({ ...track, targetId: cameraId });
        }
        const script = serializeWorldAnimationScript({ ...compiled.ir, instanceTracks, cameraTracks, ...(compiled.ir.partTracks ? { partTracks } : {}), ...(compiled.ir.walkTracks ? {walkTracks} : {}), ...(compiled.ir.somaTracks ? {somaTracks} : {}) });
        animationScript = createWorldAnimationScript({
          script,
          duration: animationScript.duration,
          loop: animationScript.loop,
          revision: animationScript.revision
        });
      }
      return {
        ok: true,
        payload: {
          kind: world.value.kind,
          version: SHARED_WORLD_VERSION,
          areaId,
          scopeVersion: world.value.scopeVersion,
          animationOrigin: sceneAreaAnimationOrigin(world.value),
          ...(world.value.animationQuarterTurns !== undefined ? { animationQuarterTurns: world.value.animationQuarterTurns } : {}),
          bounds: { min: world.value.bounds.min, max: world.value.bounds.max },
          ...(animationScript ? { animationScript } : {})
        }
      };
    }
    case "world-camera": {
      const cameraId = requireMappedId(context.cameraIds, world.value.cameraId, { relation: "camera", id: world.value.cameraId }, context.sourceNodeId);
      if (typeof cameraId !== "string") return cameraId;
      const boundSource = world.value.boundInstanceId;
      let boundInstanceId: WorldId | null = null;
      if (boundSource !== null) {
        // `null` is the only intentional unbound state. A non-null binding must
        // resolve to an instance copied in this same collection; never drop it,
        // point at a different instance or turn it into a whole-world camera.
        if (!context.sourceInstanceIds.has(boundSource)) {
          return fail("binding-unavailable", {
            sourceNodeId: context.sourceNodeId,
            field: "boundInstanceId",
            reference: { relation: "instance", id: boundSource }
          });
        }
        const mapped = requireMappedId(context.instanceIds, boundSource, { relation: "instance", id: boundSource }, context.sourceNodeId);
        if (typeof mapped !== "string") return mapped;
        boundInstanceId = mapped;
      }
      const value = world.value;
      return {
        ok: true,
        payload: {
          kind: value.kind,
          version: SHARED_WORLD_VERSION,
          cameraId,
          settingsVersion: value.settingsVersion,
          position: value.position,
          rotation: value.rotation,
          projection: { ...value.projection },
          captureMode: { kind: value.captureMode.kind },
          aspect: { width: value.aspect.width, height: value.aspect.height },
          boundInstanceId
        }
      };
    }
  }
}

function requireMappedId(
  table: ReadonlyMap<WorldId, WorldId> | undefined,
  source: WorldId,
  reference: WorldReferenceUnavailable,
  sourceNodeId: WorldId
): WorldId | WorldReferenceRemapFailure {
  const mapped = table?.get(source);
  if (mapped === undefined || mapped === source) {
    return fail("unmapped-identity", {
      sourceNodeId,
      field: reference.relation === "node" ? "nodeId" : `${reference.relation}Id`,
      reference
    });
  }
  return mapped;
}

function readOptionalIdTable(
  idsInput: Record<string, unknown>,
  key: "instanceIds" | "groupIds" | "areaIds" | "cameraIds" | "assetIds"
): { readonly ok: true; readonly table: ReadonlyMap<WorldId, WorldId> | undefined } | WorldReferenceRemapFailure {
  const raw = ownField(idsInput, key);
  if (raw === undefined) return { ok: true, table: undefined };
  return readIdTable(raw, `ids.${key}`);
}

function readIdTable(
  raw: unknown,
  field: string
): IdTableRead | WorldReferenceRemapFailure {
  const table = new Map<WorldId, WorldId>();
  const entries: Array<readonly [unknown, unknown]> = [];
  if (raw instanceof Map) {
    for (const [key, value] of raw.entries()) entries.push([key, value]);
  } else if (isJsonRecord(raw)) {
    for (const key of Object.keys(raw)) entries.push([key, ownField(raw, key)]);
  } else {
    return fail("invalid-data", { field });
  }

  const targets = new Set<WorldId>();
  for (const [key, value] of entries) {
    if (!isNonEmptyWorldId(key) || !isNonEmptyWorldId(value)) return fail("invalid-data", { field });
    if (table.has(key) || targets.has(value)) return fail("invalid-data", { field });
    table.set(key, value);
    targets.add(value);
  }
  return { ok: true, table };
}

function cloneRecord(
  record: Record<string, unknown>,
  sourceNodeId: WorldId
): { readonly ok: true; readonly record: Record<string, unknown> } | WorldReferenceRemapFailure {
  try {
    return { ok: true, record: cloneJson(record) as Record<string, unknown> };
  } catch {
    return fail("invalid-data", { sourceNodeId, field: "nodeData" });
  }
}

function cloneRecordExcept(
  record: Record<string, unknown>,
  skipped: string,
  sourceNodeId: WorldId
): { readonly ok: true; readonly record: Record<string, unknown> } | WorldReferenceRemapFailure {
  const out: Record<string, unknown> = {};
  try {
    for (const key of Object.keys(record)) {
      if (key === skipped) continue;
      out[key] = cloneJson(record[key]);
    }
  } catch {
    return fail("invalid-data", { sourceNodeId, field: "nodeData" });
  }
  return { ok: true, record: out };
}

/** JSON-only copy with cycle detection; rejects primitives JSON cannot persist. */
function cloneJson(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-json-number");
    return value;
  }
  if (typeof value !== "object") throw new Error("non-json-value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("non-json-object");
  if (seen.has(value)) throw new Error("json-cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => cloneJson(item, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneJson((value as Record<string, unknown>)[key], seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

function fail(
  code: WorldReferenceRemapFailureCode,
  detail: { sourceNodeId?: WorldId; field?: string; reference?: WorldReferenceUnavailable } = {}
): WorldReferenceRemapFailure {
  return { ok: false, code, ...detail };
}

/** Validate a `worldCamera` payload with the frozen T01 structure allowlist.
 * Pose/projection semantics such as the isometric direction rule stay with OC05. */
function decodeWorldCameraData(input: unknown): SharedWorldDecodeResult<WorldCameraData> {
  const read = readKindedRecord(input, CAMERA_KIND, CAMERA_KEYS);
  if (!read.ok) return decodeFailure(read.code, input);
  const record = read.record;
  const cameraId = ownField(record, "cameraId");
  const settingsVersion = ownField(record, "settingsVersion");
  if (!isNonEmptyWorldId(cameraId) || !isNonEmptyWorldId(settingsVersion)) return decodeFailure("invalid-data", input);

  const position = decodeWorldPoint(ownField(record, "position"));
  const rotation = decodeWorldRotation(ownField(record, "rotation"));
  const projection = decodeCameraProjection(ownField(record, "projection"));
  const captureMode = decodeCameraCaptureMode(ownField(record, "captureMode"));
  const aspect = decodeCameraAspect(ownField(record, "aspect"));
  const rawBinding = ownField(record, "boundInstanceId");
  const boundInstanceId = rawBinding === null ? null : isNonEmptyWorldId(rawBinding) ? rawBinding : undefined;

  if (!position || !rotation || !projection || !captureMode || !aspect || boundInstanceId === undefined) {
    return decodeFailure("invalid-data", input);
  }

  return {
    ok: true,
    value: {
      kind: CAMERA_KIND,
      version: SHARED_WORLD_VERSION,
      cameraId,
      settingsVersion,
      position,
      rotation,
      projection,
      captureMode,
      aspect,
      boundInstanceId
    }
  };
}

function decodeCameraProjection(input: unknown): WorldCameraProjection | null {
  if (!isJsonRecord(input)) return null;
  const kind = ownField(input, "kind");
  if (kind === "isometric") {
    if (!hasOnlyKeys(input, ISOMETRIC_PROJECTION_KEYS)) return null;
    const size = ownField(input, "verticalSizeMeters");
    const near = ownField(input, "nearMeters");
    const far = ownField(input, "farMeters");
    if (!isFiniteWorldNumber(size) || size <= 0) return null;
    if (!isFiniteWorldNumber(near) || !isFiniteWorldNumber(far) || !(near > 0) || !(far > near)) return null;
    return { kind: "isometric", verticalSizeMeters: size, nearMeters: near, farMeters: far };
  }
  if (kind === "perspective") {
    if (!hasOnlyKeys(input, PERSPECTIVE_PROJECTION_KEYS)) return null;
    const fov = ownField(input, "verticalFovRadians");
    const near = ownField(input, "nearMeters");
    const far = ownField(input, "farMeters");
    if (!isFiniteWorldNumber(fov) || !(fov > 0) || !(fov < Math.PI)) return null;
    if (!isFiniteWorldNumber(near) || !isFiniteWorldNumber(far) || !(near > 0) || !(far > near)) return null;
    return { kind: "perspective", verticalFovRadians: fov, nearMeters: near, farMeters: far };
  }
  return null;
}

function decodeCameraCaptureMode(input: unknown): WorldCameraCaptureMode | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, CAPTURE_MODE_KEYS)) return null;
  const kind = ownField(input, "kind");
  return kind === "static" || kind === "dynamic" ? { kind } : null;
}

function decodeCameraAspect(input: unknown): { width: number; height: number } | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ASPECT_KEYS)) return null;
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  if (!isFiniteWorldNumber(width) || !isFiniteWorldNumber(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}
