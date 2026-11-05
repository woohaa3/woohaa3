/**
 * Shared-world v1 creation-scope codecs (OC01).
 *
 * Covers the two organizational/authority scopes frozen by T01:
 *
 * - `workflowGroup2d` (`workflow-group-2d`): a 2D workflow group. Its
 *   `scopeVersion` changes only with membership or group identity; card layout,
 *   viewport and hover are not part of this payload. Membership is an
 *   organizational context and grants no 3D write access.
 * - `sceneArea` (`scene-area`): a ground rectangle. Its `scopeVersion` changes
 *   when bounds or identity change. Object pose/footprint/content versions are
 *   separate and are checked by eligibility code, never by this codec.
 *
 * Both payloads are untrusted input: only allowlisted keys survive, ids,
 * versions and member references must be nonempty unique strings, and bounds
 * must be finite and ordered (`min <= max` on both axes). Degenerate
 * points/lines are valid. No runtime lease, GPU or card-layout field is
 * accepted. The pure codec cannot know member node types or nesting; a
 * document-context validator rejects groups whose members resolve to groups.
 *
 * World cameras belong to OC05 and are not accepted here.
 */

import {
  SHARED_WORLD_VERSION,
  type GroundAabb,
  type GroundPoint,
  type SceneAreaData,
  type SharedWorldDecodeResult,
  type WorkflowGroupData
} from "./shared-world.js";
import { decodeWorldAnimationScript } from "./world-animation-script.js";
import {
  codecFailureError,
  decodeFailure,
  hasOnlyKeys,
  isFiniteWorldNumber,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField,
  readKindedRecord
} from "./shared-world-codec.js";

const WORKFLOW_GROUP_KIND = "workflow-group-2d";
const WORKFLOW_GROUP_KEYS = ["kind", "version", "groupId", "scopeVersion", "memberNodeIds"] as const;
const SCENE_AREA_KIND = "scene-area";
// 旧关键帧字段 `animation` 不再支持，但读取时容忍并从规范化结果中丢弃，避免已持久化画布
// 因遗留字段整体判为 corrupt；新写入不会产生该字段。
const SCENE_AREA_KEYS = ["kind", "version", "areaId", "scopeVersion", "bounds", "animationOrigin", "animationScript", "animation"] as const;
const GROUND_POINT_KEYS = ["u", "v"] as const;
const GROUND_AABB_KEYS = ["min", "max"] as const;

export type CreationScopeNodeData = WorkflowGroupData | SceneAreaData;

/** Finite ground `(u, v)` meters; unlike a world point it has no height field. */
export function decodeGroundPoint(input: unknown): GroundPoint | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, GROUND_POINT_KEYS)) return null;
  const u = ownField(input, "u");
  const v = ownField(input, "v");
  if (!isFiniteWorldNumber(u) || !isFiniteWorldNumber(v)) return null;
  return { u, v };
}

/** Finite ordered ground AABB in meters; zero width/height is a valid point/line. */
export function decodeGroundAabb(input: unknown): GroundAabb | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, GROUND_AABB_KEYS)) return null;
  const min = decodeGroundPoint(ownField(input, "min"));
  const max = decodeGroundPoint(ownField(input, "max"));
  if (!min || !max || min.u > max.u || min.v > max.v) return null;
  return { min, max };
}

/** Decode `workflowGroup2d`; member order is preserved and duplicates are rejected. */
export function decodeWorkflowGroupData(input: unknown): SharedWorldDecodeResult<WorkflowGroupData> {
  const read = readKindedRecord(input, WORKFLOW_GROUP_KIND, WORKFLOW_GROUP_KEYS);
  if (!read.ok) return decodeFailure(read.code, input);
  const groupId = ownField(read.record, "groupId");
  const scopeVersion = ownField(read.record, "scopeVersion");
  if (!isNonEmptyWorldId(groupId) || !isNonEmptyWorldId(scopeVersion)) {
    return decodeFailure("invalid-data", input);
  }
  const members = decodeMemberNodeIds(ownField(read.record, "memberNodeIds"));
  if (!members) return decodeFailure("invalid-data", input);
  return {
    ok: true,
    value: { kind: WORKFLOW_GROUP_KIND, version: SHARED_WORLD_VERSION, groupId, scopeVersion, memberNodeIds: members }
  };
}

/** Decode `sceneArea`; `bounds` is the authoritative ground range, not a card rect. */
export function decodeSceneAreaData(input: unknown): SharedWorldDecodeResult<SceneAreaData> {
  const read = readKindedRecord(input, SCENE_AREA_KIND, SCENE_AREA_KEYS);
  if (!read.ok) return decodeFailure(read.code, input);
  const areaId = ownField(read.record, "areaId");
  const scopeVersion = ownField(read.record, "scopeVersion");
  if (!isNonEmptyWorldId(areaId) || !isNonEmptyWorldId(scopeVersion)) {
    return decodeFailure("invalid-data", input);
  }
  const bounds = decodeGroundAabb(ownField(read.record, "bounds"));
  if (!bounds) return decodeFailure("invalid-data", input);
  const rawOrigin = ownField(read.record, "animationOrigin");
  const animationOrigin = rawOrigin === undefined ? undefined : decodeGroundPoint(rawOrigin);
  if (rawOrigin !== undefined && !animationOrigin) return decodeFailure("invalid-data", input);
  const base = {
    kind: SCENE_AREA_KIND,
    version: SHARED_WORLD_VERSION,
    areaId,
    scopeVersion,
    bounds,
    ...(animationOrigin ? { animationOrigin } : {})
  } as const;
  const rawScript = ownField(read.record, "animationScript");
  if (rawScript !== undefined) {
    const animationScript = decodeWorldAnimationScript(rawScript);
    if (!animationScript.ok) return decodeFailure("invalid-data", input);
    return { ok: true, value: { ...base, animationScript: animationScript.value } };
  }
  return { ok: true, value: base };
}

/** Decode either creation scope by its `kind` discriminant; cameras are not scopes. */
export function decodeCreationScopeData(input: unknown): SharedWorldDecodeResult<CreationScopeNodeData> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  switch (ownField(input, "kind")) {
    case WORKFLOW_GROUP_KIND: return decodeWorkflowGroupData(input);
    case SCENE_AREA_KIND: return decodeSceneAreaData(input);
    default: return decodeFailure("invalid-data", input);
  }
}

export function encodeGroundPoint(value: GroundPoint): unknown {
  const decoded = decodeGroundPoint(value);
  if (!decoded) throw codecFailureError("invalid-data", "地面坐标");
  return decoded;
}

export function encodeGroundAabb(value: GroundAabb): unknown {
  const decoded = decodeGroundAabb(value);
  if (!decoded) throw codecFailureError("invalid-data", "导演区范围");
  return decoded;
}

export function encodeWorkflowGroupData(value: WorkflowGroupData): unknown {
  const decoded = decodeWorkflowGroupData(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "2D 组");
  return decoded.value;
}

export function encodeSceneAreaData(value: SceneAreaData): unknown {
  const decoded = decodeSceneAreaData(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "导演区");
  return decoded.value;
}

export function encodeCreationScopeData(value: CreationScopeNodeData): unknown {
  const decoded = decodeCreationScopeData(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "范围配置");
  return decoded.value;
}

function decodeMemberNodeIds(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const members: string[] = [];
  const seen = new Set<string>();
  for (const member of input) {
    if (!isNonEmptyWorldId(member) || seen.has(member)) return null;
    seen.add(member);
    members.push(member);
  }
  return members;
}
