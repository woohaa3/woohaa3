import { resolveSomaBodyPreset } from "../soma-humanoid/body-presets.js";
import { decodeWorldInstanceData } from "../shared-world-codec.js";
import { decodeSceneAreaData, decodeWorkflowGroupData } from "../creation-scope-codec.js";
import { decodeWorldCamera } from "../world-camera-codec.js";
import { sanitizeRuntimeNodeConfigPatch } from "./runtime-node-data.js";
import { decodeManagedNodeRelation } from "../managed-node.js";
import { decodeMediaContentRef } from "../media-content.js";
import { decodeModelContentVersion } from "../model-definition.js";
import { storedHumanoidRig } from "../humanoid-rig.js";

const WORLD_NODE_FIELDS = new Set(["title", "prompt", "panelPrompt", "agentId", "sceneId", "inputMapping", "workflowGroup2d", "sceneArea", "worldCamera", "imageDirectorSource", "imageDirectorGeneration"]);
const MODEL_FIELDS = new Set([...WORLD_NODE_FIELDS, "sharedWorldInstance", "managedBy", "taskKind", "inputMapping", "status", "taskStatus", "activeRunId", "modelKey", "progress", "error", "errorMessage", "result", "resultPreview", "providerTaskId", "durationSeconds", "mediaContent", "outputAssetId", "posterAssetId", "resourceKind", "frozenPreview", "parameters", "modelScript", "modelScriptLanguage", "modelScriptVersion", "modelScriptStatus", "modelScriptError", "modelSourceKind", "modelAssetId", "modelContentVersion", "modelPlacement", "shotPose", "modelRig", "directorCharacterCreation"]);
const TEXT_FIELDS = ["title", "prompt", "panelPrompt", "agentId", "sceneId"];
const LOCAL_FIELDS = new Set(["writeLease", "lease", "toolContext", "gpuResource", "gpuHandle", "runtimeHandle", "matrix"]);

const STRING_FIELDS = ["taskKind", "activeRunId", "modelKey", "providerTaskId", "outputAssetId", "posterAssetId", "resourceKind", "modelScript", "modelScriptLanguage", "modelScriptVersion", "modelAssetId"];
const NULLABLE_STRING_FIELDS = ["error", "errorMessage", "modelScriptError"];
const ENUM_FIELDS: Record<string, readonly string[]> = {
  status: ["idle", "queued", "running", "success", "failed", "draft", "ready", "archived"],
  taskStatus: ["idle", "pending", "processing", "successed", "failed", "cancelled", "unknown"],
  modelScriptStatus: ["ok", "failed"],
  modelSourceKind: ["glb"]
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Object.values(value).every(child => json(child, seen));
  seen.delete(value);
  return valid;
}

function validResult(value: unknown): boolean {
  if (!record(value) || !["text", "image", "video", "audio", "motion"].includes(value.kind as string)) return false;
  return Object.entries(value).every(([key, item]) => key === "kind" || (["text", "url", "posterUrl"].includes(key) && typeof item === "string") || (key === "durationSeconds" && typeof item === "number" && Number.isFinite(item)));
}

function validInputMapping(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => record(item) && typeof item.sourceNodeId === "string" && typeof item.role === "string" && Object.entries(item).every(([key, field]) =>
    (["slotId", "sourceNodeId", "role", "sortKey", "label"].includes(key) && typeof field === "string") ||
    (key === "sourceAssetIds" && Array.isArray(field) && field.every(id => typeof id === "string"))));
}

function validModelFields(fields: Record<string, unknown>): string | null {
  for (const key of STRING_FIELDS) if (fields[key] !== undefined && typeof fields[key] !== "string") return key;
  for (const key of NULLABLE_STRING_FIELDS) if (fields[key] !== undefined && fields[key] !== null && typeof fields[key] !== "string") return key;
  for (const [key, values] of Object.entries(ENUM_FIELDS)) if (fields[key] !== undefined && !values.includes(fields[key] as string)) return key;
  for (const key of ["progress", "durationSeconds"]) if (fields[key] !== undefined && (typeof fields[key] !== "number" || !Number.isFinite(fields[key]))) return key;
  for (const key of ["result", "resultPreview", "frozenPreview"]) if (fields[key] !== undefined && !validResult(fields[key])) return key;
  if (fields.inputMapping !== undefined && !validInputMapping(fields.inputMapping)) return "inputMapping";
  if (fields.parameters !== undefined && (!record(fields.parameters) || !json(fields.parameters))) return "parameters";
  if (fields.mediaContent !== undefined && !decodeMediaContentRef(fields.mediaContent).ok) return "mediaContent";
  if (fields.modelContentVersion !== undefined) {
    const decoded = decodeModelContentVersion(fields.modelContentVersion);
    if (!decoded.ok || !containsOnlyDecodedFields(fields.modelContentVersion, decoded.value)) return "modelContentVersion";
  }
  if (fields.managedBy !== undefined) {
    const decoded = decodeManagedNodeRelation(fields.managedBy);
    if (!decoded.ok || !containsOnlyDecodedFields(fields.managedBy, decoded.value)) return "managedBy";
  }
  if (fields.modelRig !== undefined) {
    const decoded = storedHumanoidRig(fields.modelRig);
    if (!decoded.ok || !containsOnlyDecodedFields(fields.modelRig, decoded.value)) return "modelRig";
  }
  return null;
}

function containsLocalState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLocalState);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => LOCAL_FIELDS.has(key) || /^gpu/i.test(key) || containsLocalState(child));
}

function containsOnlyDecodedFields(input: unknown, decoded: unknown): boolean {
  if (Array.isArray(input)) {
    return Array.isArray(decoded) && input.length === decoded.length && input.every((item, index) => {
      const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
      const match = typeof id === "string" ? decoded.find(entry => entry && typeof entry === "object" && entry.id === id) : decoded[index];
      return containsOnlyDecodedFields(item, match);
    });
  }
  if (input && typeof input === "object") {
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return false;
    return Object.entries(input).every(([key, value]) => (key === "focusOffset" && value === null) || (Object.prototype.hasOwnProperty.call(decoded, key) && containsOnlyDecodedFields(value, (decoded as Record<string, unknown>)[key])));
  }
  return true;
}

/** 2D 卡片布局是否适用于该节点；导演区与共享世界模型没有卡片。 */
export function nodeHasCanvasCard(
  node: { type: string },
  data: Record<string, unknown> | undefined
): boolean {
  if (node.type === "scene-area") return false;
  if (data?.sharedWorldInstance !== undefined) return false;
  return true;
}

/** Validate the complete document, including references and independent ID namespaces. */
export function validateWorldIdentities(nodes: readonly { id: string; type: string }[], data: Record<string, unknown>): string | null {
  const types = new Map(nodes.map(node => [node.id, node.type]));
  const ids = new Map<string, Set<string>>();
  const definitions = [
    ["sharedWorldInstance", "model3d", decodeWorldInstanceData, "instanceId"],
    ["workflowGroup2d", "workflow-group-2d", decodeWorkflowGroupData, "groupId"],
    ["sceneArea", "scene-area", decodeSceneAreaData, "areaId"],
    ["worldCamera", "world-camera", decodeWorldCamera, "cameraId"]
  ] as const;
  for (const node of nodes) {
    const raw = data[node.id];
    const fields = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (fields.imageDirectorGeneration !== undefined) {
      const generation = fields.imageDirectorGeneration;
      if (node.type !== "scene-area" || !record(generation) || Object.keys(generation).length !== 1 || typeof generation.requestId !== "string" || !generation.requestId.trim()) return `Invalid imageDirectorGeneration on ${node.id}`;
    }
    if (node.type === "workflow-group-2d" || node.type === "scene-area" || node.type === "world-camera" || fields.sharedWorldInstance !== undefined) {
      const allowed = node.type === "model3d" ? MODEL_FIELDS : WORLD_NODE_FIELDS;
      for (const key of Object.keys(fields)) {
        if (!allowed.has(key)) return `Unsupported field ${key} on ${node.id}`;
      }
      for (const key of TEXT_FIELDS) {
        if (fields[key] !== undefined && typeof fields[key] !== "string") return `Invalid ${key} on ${node.id}`;
      }
      if (fields.imageDirectorSource !== undefined) {
        const source = fields.imageDirectorSource;
        const keys = ["operationId", "sourceNodeId", "assetId", "contentVersion"];
        if (!record(source) || Object.keys(source).length !== keys.length || keys.some(key => typeof source[key] !== "string" || !(source[key] as string).trim())) return `Invalid imageDirectorSource on ${node.id}`;
      }
      if (fields.directorCharacterCreation !== undefined) {
        const marker = fields.directorCharacterCreation;
        if (node.type !== "model3d" || !record(marker) || Object.keys(marker).some(key => !["areaId", "scopeVersion", "kind", "bodyPreset", "capsulePreset"].includes(key)) || typeof marker.areaId !== "string" || !marker.areaId.trim() || typeof marker.scopeVersion !== "string" || !marker.scopeVersion.trim() || (marker.kind !== "capsule" && marker.kind !== "humanoid")) return `Invalid directorCharacterCreation on ${node.id}`;
        if (marker.capsulePreset !== undefined && (marker.kind !== "capsule" || marker.capsulePreset !== "two-heads" || marker.bodyPreset !== undefined)) return `Invalid directorCharacterCreation on ${node.id}`;
        if (marker.bodyPreset !== undefined) {
          if (marker.kind !== "humanoid") return `Invalid directorCharacterCreation on ${node.id}`;
          try { resolveSomaBodyPreset(marker.bodyPreset); }
          catch { return `Invalid directorCharacterCreation on ${node.id}`; }
        }
      }
      if (fields.inputMapping !== undefined && !validInputMapping(fields.inputMapping)) return `Invalid inputMapping on ${node.id}`;
      if (Object.entries(fields).some(([key, value]) => key !== "parameters" && (LOCAL_FIELDS.has(key) || /^gpu/i.test(key) || containsLocalState(value)))) return `Transient state on ${node.id}`;
      if (node.type === "model3d") {
        const invalid = validModelFields(fields);
        if (invalid) return `Invalid ${invalid} on ${node.id}`;
      }
      for (const key of ["modelPlacement", "shotPose"]) {
        if (fields[key] === undefined) continue;
        const decoded = sanitizeRuntimeNodeConfigPatch({ [key]: fields[key] });
        if (!decoded.ok || !containsOnlyDecodedFields(fields[key], decoded.value[key])) return `Invalid ${key} on ${node.id}`;
      }
    }
    for (const [key, type, decode, idKey] of definitions) {
      const present = Object.prototype.hasOwnProperty.call(fields, key);
      if (!present && node.type !== type) continue;
      if (!present && key === "sharedWorldInstance") continue;
      if (!present || node.type !== type) return `Invalid ${key} on ${node.id}`;
      const result = decode(fields[key]);
      if (!result.ok) return `Invalid ${key} on ${node.id}: ${result.code}`;
      const value = result.value as unknown as Record<string, unknown>;
      const id = value[idKey] as string;
      const used = ids.get(key) ?? new Set<string>();
      if (used.has(id)) return `Duplicate ${key} identity: ${id}`;
      used.add(id); ids.set(key, used);
      if (key === "workflowGroup2d") {
        for (const member of value.memberNodeIds as string[]) {
          if (!types.has(member) || types.get(member) === "workflow-group-2d") return `Invalid group member: ${member}`;
        }
      }
    }
  }
  return null;
}
