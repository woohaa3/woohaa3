/**
 * Scoped assistant world-authoring contract (T11a).
 *
 * The host issues every assistant write against an exact canvas scope snapshot.
 * Assistant input may name an operation and the objects it wants to touch, but it
 * never supplies the scope, object versions, leases or write capability: those are
 * resolved from the canonical projection by the host and returned in the issued
 * `WorldToolContext`.
 *
 * This module is deliberately transport-neutral. It contains the public DTOs,
 * tool names, strict decoders, failure semantics and the host-internal port used
 * by the local host composition. It never contains command mapping, storage or
 * version algorithms.
 */
import type {
  GroundAabb,
  WorldCameraData,
  WorldCameraProjection,
  WorldCompletion,
  WorldId,
  WorldObjectIdentity,
  WorldObjectVersion,
  WorldPoint,
  WorldRotation,
  WorldScopeVersion,
  WorldToolContext,
  WorldTransform,
  WorldVersion
} from "./shared-world.js";
import type { WorldCameraSettings, WorldCameraSettingsPatch } from "./node-history/world-camera.js";
import type { WorldCameraView } from "./world-camera-ui.js";
import type { WorldAnimationScript } from "./world-animation-script.js";
import type { WorldAuthoringConflict, WorldAuthoringFailureCode } from "./world-authoring.js";
import { isBoundedId, isJsonObject } from "../validation.js";
import { decodeGroundAabb } from "./creation-scope-codec.js";

export const ASSISTANT_WORLD_AUTHORITY_VERSION = "assistant-world-authority-v1" as const;

/** Selectable authoring scopes. */
export type AssistantWorldScopeSelection =
  | { kind: "scene-area"; areaId: WorldId }
  | { kind: "world-camera"; cameraId: WorldId };

export type AssistantWorldScopeKind = AssistantWorldScopeSelection["kind"];

export function assistantWorldScopeIdentity(scope: AssistantWorldScopeSelection): WorldScopeVersion["scope"] {
  return { ...scope };
}

/** Stable tool names shared by MCP registration, grant catalogs and prompts. */
export const ASSISTANT_WORLD_TOOL = {
  readContext: "get_world_context",
  readModelRig: "get_world_model_rig",
  sampleAnimation: "sample_scene_animation",
  createModel: "create_world_model",
  replaceModel: "replace_world_model_content",
  moveModel: "move_world_model",
  setAnimation: "set_scene_animation_script",
  resizeArea: "resize_scene_area",
  createCamera: "create_world_camera",
  setCamera: "set_world_camera",
  completeCamera: "complete_world_camera"
} as const;

export type AssistantWorldToolName = (typeof ASSISTANT_WORLD_TOOL)[keyof typeof ASSISTANT_WORLD_TOOL];

/** Read-only context tools are the only tools a 2D group selection can receive. */
export const ASSISTANT_WORLD_READ_TOOLS = [ASSISTANT_WORLD_TOOL.readContext] as const;

/** Scene-area write tools. Membership in a 2D group never grants these. */
export const ASSISTANT_WORLD_WRITE_TOOLS = [
  ASSISTANT_WORLD_TOOL.createModel,
  ASSISTANT_WORLD_TOOL.replaceModel,
  ASSISTANT_WORLD_TOOL.moveModel,
  ASSISTANT_WORLD_TOOL.setAnimation,
  ASSISTANT_WORLD_TOOL.resizeArea,
  ASSISTANT_WORLD_TOOL.createCamera,
  ASSISTANT_WORLD_TOOL.setCamera,
  ASSISTANT_WORLD_TOOL.completeCamera
] as const;

export const ASSISTANT_WORLD_TOOLS = [
  ...ASSISTANT_WORLD_READ_TOOLS,
  ASSISTANT_WORLD_TOOL.readModelRig,
  ASSISTANT_WORLD_TOOL.sampleAnimation,
  ...ASSISTANT_WORLD_WRITE_TOOLS
] as const satisfies readonly AssistantWorldToolName[];

export const ASSISTANT_WORLD_CAMERA_TOOLS = [
  ASSISTANT_WORLD_TOOL.readContext,
  ASSISTANT_WORLD_TOOL.setCamera,
  ASSISTANT_WORLD_TOOL.completeCamera
] as const;

/** Actual tool catalog for a selected scope. */
export function assistantWorldToolsForScope(scope: AssistantWorldScopeSelection): readonly AssistantWorldToolName[] {
  return scope.kind === "world-camera" ? ASSISTANT_WORLD_CAMERA_TOOLS : ASSISTANT_WORLD_TOOLS;
}

/** Per-source capability declaration consumed by the assistant directory. */
export type AssistantWorldSourceCapability = {
  version: typeof ASSISTANT_WORLD_AUTHORITY_VERSION;
  targets: readonly AssistantWorldScopeKind[];
  tools: readonly AssistantWorldToolName[];
  /** Completion intake requires a trusted host run; sources without tools cannot claim it. */
  completion: boolean;
};

export const ASSISTANT_WORLD_CAPABILITY_ID = "assistant.world-authoring" as const;

export function assistantWorldSourceCapability(
  input: { targets?: readonly AssistantWorldScopeKind[]; tools?: readonly AssistantWorldToolName[] } = {}
): AssistantWorldSourceCapability {
  const targets = input.targets ?? ["scene-area", "world-camera"];
  const tools = input.tools ?? (targets.includes("scene-area") ? ASSISTANT_WORLD_TOOLS : targets.includes("world-camera") ? ASSISTANT_WORLD_CAMERA_TOOLS : ASSISTANT_WORLD_READ_TOOLS);
  return {
    version: ASSISTANT_WORLD_AUTHORITY_VERSION,
    targets: [...targets],
    tools: [...tools],
    completion: tools.includes(ASSISTANT_WORLD_TOOL.completeCamera)
  };
}

/** Exact run identity requested by the trusted host. */
export interface AssistantWorldRunRequest {
  canvasId: WorldId;
  requestId: WorldId;
  runId: WorldId;
  epoch: number;
  executionId: WorldId;
  scope: AssistantWorldScopeSelection;
}

/** Public run information; it carries no process-local write capability. */
export interface AssistantWorldRunView {
  canvasId: WorldId;
  requestId: WorldId;
  runId: WorldId;
  epoch: number;
  executionId: WorldId;
  state: "active" | "cancelled" | "stopped";
  scope: WorldScopeVersion;
  writableTargets: WorldObjectVersion[];
  readOnlyReferences: WorldObjectVersion[];
}

export interface AssistantWorldIssued {
  run: AssistantWorldRunView;
  /** Host-issued context; the process-local capability stays in the host process. */
  context: WorldToolContext;
  /** The completion identity this run may persist at most once. */
  completionId: WorldId;
  retry: boolean;
}

export type AssistantWorldFailureCode =
  | WorldAuthoringFailureCode
  | "target-unavailable"
  | "capability-unsupported"
  | "not-issued"
  | "unverified-run"
  | "unverified-stop";

export interface AssistantWorldFailure {
  ok: false;
  code: AssistantWorldFailureCode;
  message: string;
  conflicts?: WorldAuthoringConflict[];
  spatialReason?: string;
}

export type AssistantWorldIssueOutcome = ({ ok: true } & AssistantWorldIssued) | AssistantWorldFailure;

/** Model content accepted by assistant tools. Content identity is derived by the authority. */
export interface AssistantWorldModelContent {
  modelScript: string;
  modelScriptVersion?: string;
  /** Optional card position only; world pose is authoritative and independent. */
  cardPosition?: { x: number; y: number };
}

export type AssistantWorldWriteOperation =
  | {
      kind: "create-model";
      operationId: WorldId;
      /** Stable node identity chosen by the host run. */
      nodeId: WorldId;
      /** Optional stable instance identity; defaults to a deterministic identity derived from nodeId. */
      instanceId?: WorldId;
      content: AssistantWorldModelContent;
      transform: WorldTransform;
    }
  | {
      kind: "replace-model-content";
      operationId: WorldId;
      instanceId: WorldId;
      expectedVersion: WorldVersion;
      content: AssistantWorldModelContent;
      /** Optional pose change applied atomically with the content replacement. */
      transform?: WorldTransform;
    }
  | {
      kind: "set-model-transform";
      operationId: WorldId;
      instanceId: WorldId;
      expectedVersion: WorldVersion;
      transform: WorldTransform;
    }
  | {
      kind: "set-scene-animation-script";
      operationId: WorldId;
      /** 导演区统一动画脚本源码（`woohaa-world-animation-js-v2`，位置轨道相对 `animationOrigin`）。 */
      script: string;
      duration: number;
      loop: boolean;
    }
  | {
      kind: "resize-scene-area";
      operationId: WorldId;
      /** Canonical area scope version observed in `get_world_context`. */
      expectedScopeVersion: WorldVersion;
      bounds: GroundAabb;
    }
  | {
      kind: "set-world-camera";
      operationId: WorldId;
      cameraId: WorldId;
      expectedSettingsVersion: WorldVersion;
      /** Full settings or a patch; omitted fields keep the current canonical value. */
      settings: WorldCameraSettingsPatch;
    }
  | {
      kind: "create-world-camera";
      operationId: WorldId;
      /** Stable node/camera identity chosen by the host run (never trusted from the tool). */
      nodeId: WorldId;
      cameraId: WorldId;
      settings: WorldCameraSettings;
      /** Optional 2D card position; the world pose lives in `settings`. */
      cardPosition?: { x: number; y: number };
    };

export interface AssistantWorldWriteInput {
  /** Host-issued context. Never accepted from the model's tool arguments. */
  contextId: WorldId;
  operation: AssistantWorldWriteOperation;
}

export type AssistantWorldWriteOutcome =
  | {
      ok: true;
      canvasId: WorldId;
      commandId: string;
      revision: number;
      duplicate: boolean;
      noop: boolean;
      /** Present for instance operations, always the canonical identity. */
      instanceId?: WorldId;
      nodeId?: WorldId;
      /** Present for camera operations. */
      cameraId?: WorldId;
      settingsVersion?: WorldVersion;
      /** Post-commit canonical object version (model or camera) for the next tool call. */
      version?: WorldVersion;
      /**
       * Post-commit camera view (unit forward + ground intersection) for camera
       * operations, so a caller can verify where the lens points instead of
       * treating a successful write as a correct framing.
       */
      view?: WorldCameraView;
    }
  | AssistantWorldFailure;

export interface AssistantWorldCompletionInput {
  contextId: WorldId;
  completion: WorldCompletion;
  /** Host-owned evidence. A public browser route never supplies this. */
  evidence?: unknown;
}

export type AssistantWorldCompletionOutcome =
  | { ok: true; duplicate: boolean; settingsVersion: WorldVersion; completionId: WorldId }
  | AssistantWorldFailure;

export interface AssistantWorldCancelInput {
  canvasId: WorldId;
  contextId: WorldId;
}

export interface AssistantWorldStopInput {
  canvasId: WorldId;
  contextId: WorldId;
  runId: WorldId;
  epoch: number;
  executionId: WorldId;
  evidence: unknown;
}

export type AssistantWorldRecoveryOutcome =
  | { ok: true; runs: readonly AssistantWorldRunView[]; capability: null }
  | AssistantWorldFailure;

/**
 * Host-internal port implemented by the canvas service. The local host wires the
 * real MCP tools and grant catalog to this port; no HTTP body or agent tool
 * argument can supply a context id that the host did not issue.
 */
export interface AssistantWorldAuthorityPort {
  issue(input: AssistantWorldRunRequest): Promise<AssistantWorldIssueOutcome>;
  write(input: AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
  cancel(input: AssistantWorldCancelInput): Promise<void>;
  confirmStopped(input: AssistantWorldStopInput): Promise<{ ok: true } | AssistantWorldFailure>;
  recover(input: { canvasId: WorldId }): Promise<AssistantWorldRecoveryOutcome>;
}

/** Host binding stored with the issued tool grant, never sent to the model prompt. */
export interface AssistantWorldGrantBinding {
  contextId: WorldId;
  completionId: WorldId;
  runId: WorldId;
  epoch: number;
  executionId: WorldId;
  scope: WorldScopeVersion;
}

// ---------------------------------------------------------------------------
// Strict decode helpers. Undecoded payloads never reach a write path.
// ---------------------------------------------------------------------------

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function point(value: unknown): value is WorldPoint {
  return isJsonObject(value) && finite(value.u) && finite(value.v) && finite(value.h);
}

function rotation(value: unknown): value is WorldRotation {
  return Array.isArray(value) && value.length === 4 && value.every(finite);
}

function transform(value: unknown): value is WorldTransform {
  return isJsonObject(value)
    && value.version === "shared-world-v1"
    && point(value.position)
    && rotation(value.rotation)
    && finite(value.scale) && value.scale > 0;
}

function projection(value: unknown): value is WorldCameraProjection {
  if (!isJsonObject(value)) return false;
  if (value.kind === "perspective") {
    return finite(value.verticalFovRadians) && finite(value.nearMeters) && finite(value.farMeters)
      && value.verticalFovRadians > 0 && value.verticalFovRadians < Math.PI
      && value.nearMeters > 0 && value.farMeters > value.nearMeters;
  }
  if (value.kind === "isometric") {
    return finite(value.verticalSizeMeters) && finite(value.nearMeters) && finite(value.farMeters)
      && value.verticalSizeMeters > 0 && value.nearMeters > 0 && value.farMeters > value.nearMeters;
  }
  return false;
}

export function decodeAssistantWorldScope(value: unknown): { ok: true; value: AssistantWorldScopeSelection } | { ok: false; code: "invalid-data"; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "invalid-data", message: "范围必须是对象" };
  if (value.kind === "scene-area" && isBoundedId(value.areaId) && Object.keys(value).length === 2) {
    return { ok: true, value: { kind: "scene-area", areaId: value.areaId } };
  }
  if (value.kind === "world-camera" && isBoundedId(value.cameraId) && Object.keys(value).length === 2) {
    return { ok: true, value: { kind: "world-camera", cameraId: value.cameraId } };
  }
  return { ok: false, code: "invalid-data", message: "范围身份无效" };
}

export function decodeAssistantWorldModelContent(value: unknown): { ok: true; value: AssistantWorldModelContent } | { ok: false; code: "invalid-data"; message: string } {
  if (!isJsonObject(value) || Object.keys(value).some(key => !["modelScript", "modelScriptVersion", "cardPosition"].includes(key))) {
    return { ok: false, code: "invalid-data", message: "模型内容包含未知字段" };
  }
  if (typeof value.modelScript !== "string" || value.modelScript.trim() === "") {
    return { ok: false, code: "invalid-data", message: "模型脚本不能为空" };
  }
  if (value.modelScriptVersion !== undefined && !isBoundedId(value.modelScriptVersion)) {
    return { ok: false, code: "invalid-data", message: "模型脚本版本无效" };
  }
  if (value.cardPosition !== undefined && (!isJsonObject(value.cardPosition) || !finite(value.cardPosition.x) || !finite(value.cardPosition.y))) {
    return { ok: false, code: "invalid-data", message: "卡片位置无效" };
  }
  return {
    ok: true,
    value: {
      modelScript: value.modelScript,
      ...(value.modelScriptVersion === undefined ? {} : { modelScriptVersion: value.modelScriptVersion as string }),
      ...(value.cardPosition === undefined ? {} : { cardPosition: { x: (value.cardPosition as { x: number }).x, y: (value.cardPosition as { y: number }).y } })
    }
  };
}

export function decodeAssistantWorldWriteOperation(value: unknown): { ok: true; value: AssistantWorldWriteOperation } | { ok: false; code: "invalid-data"; message: string } {
  if (!isJsonObject(value) || typeof value.kind !== "string" || !isBoundedId(value.operationId)) {
    return { ok: false, code: "invalid-data", message: "写入操作无效" };
  }
  const allowedKeys: Record<string, readonly string[]> = {
    "create-model": ["kind", "operationId", "nodeId", "instanceId", "content", "transform"],
    "replace-model-content": ["kind", "operationId", "instanceId", "expectedVersion", "content", "transform"],
    "set-model-transform": ["kind", "operationId", "instanceId", "expectedVersion", "transform"],
    "set-scene-animation-script": ["kind", "operationId", "script", "duration", "loop"],
    "set-world-camera": ["kind", "operationId", "cameraId", "expectedSettingsVersion", "settings"],
    "create-world-camera": ["kind", "operationId", "nodeId", "cameraId", "settings", "cardPosition"]
  };
  if (Object.keys(value).some(key => !allowedKeys[value.kind as string]?.includes(key))) {
    return { ok: false, code: "invalid-data", message: "写入操作包含未知字段" };
  }
  if (value.kind === "create-model") {
    if (!isBoundedId(value.nodeId) || (value.instanceId !== undefined && !isBoundedId(value.instanceId)) || !transform(value.transform)) {
      return { ok: false, code: "invalid-data", message: "新模型身份或变换无效" };
    }
    const content = decodeAssistantWorldModelContent(value.content);
    if (!content.ok) return content;
    return {
      ok: true,
      value: {
        kind: "create-model",
        operationId: value.operationId,
        nodeId: value.nodeId,
        ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId as string }),
        content: content.value,
        transform: value.transform
      }
    };
  }
  if (value.kind === "replace-model-content") {
    if (!isBoundedId(value.instanceId) || !isBoundedId(value.expectedVersion) || (value.transform !== undefined && !transform(value.transform))) {
      return { ok: false, code: "invalid-data", message: "替换模型目标或版本无效" };
    }
    const content = decodeAssistantWorldModelContent(value.content);
    if (!content.ok) return content;
    return {
      ok: true,
      value: {
        kind: "replace-model-content",
        operationId: value.operationId,
        instanceId: value.instanceId,
        expectedVersion: value.expectedVersion,
        content: content.value,
        ...(value.transform === undefined ? {} : { transform: value.transform })
      }
    };
  }
  if (value.kind === "set-model-transform") {
    if (!isBoundedId(value.instanceId) || !isBoundedId(value.expectedVersion) || !transform(value.transform)) {
      return { ok: false, code: "invalid-data", message: "移动模型目标或变换无效" };
    }
    return {
      ok: true,
      value: {
        kind: "set-model-transform",
        operationId: value.operationId,
        instanceId: value.instanceId,
        expectedVersion: value.expectedVersion,
        transform: value.transform
      }
    };
  }
  if (value.kind === "set-scene-animation-script") {
    if (typeof value.script !== "string" || value.script.trim() === ""
      || !finite(value.duration) || value.duration <= 0 || value.duration > 3600
      || typeof value.loop !== "boolean") {
      return { ok: false, code: "invalid-data", message: "导演区动画脚本无效" };
    }
    return {
      ok: true,
      value: { kind: "set-scene-animation-script", operationId: value.operationId, script: value.script, duration: value.duration, loop: value.loop }
    };
  }
  if (value.kind === "resize-scene-area") {
    if (!isBoundedId(value.expectedScopeVersion)) {
      return { ok: false, code: "invalid-data", message: "导演区范围版本无效" };
    }
    const bounds = decodeGroundAabb(value.bounds);
    if (!bounds) return { ok: false, code: "invalid-data", message: "导演区范围边界无效" };
    return {
      ok: true,
      value: {
        kind: "resize-scene-area",
        operationId: value.operationId,
        expectedScopeVersion: value.expectedScopeVersion,
        bounds
      }
    };
  }
  if (value.kind === "set-world-camera") {
    if (!isBoundedId(value.cameraId) || !isBoundedId(value.expectedSettingsVersion)) {
      return { ok: false, code: "invalid-data", message: "镜头目标或设置无效" };
    }
    const settings = cameraSettingsPatch(value.settings);
    if (!settings) return { ok: false, code: "invalid-data", message: "镜头设置无效" };
    return {
      ok: true,
      value: {
        kind: "set-world-camera",
        operationId: value.operationId,
        cameraId: value.cameraId,
        expectedSettingsVersion: value.expectedSettingsVersion,
        settings
      }
    };
  }
  if (value.kind === "create-world-camera") {
    if (!isBoundedId(value.nodeId) || !isBoundedId(value.cameraId)) {
      return { ok: false, code: "invalid-data", message: "新镜头身份无效" };
    }
    const settings = cameraOperationSettings(value.settings);
    if (!settings) return { ok: false, code: "invalid-data", message: "镜头设置无效" };
    const cardPosition = value.cardPosition;
    if (cardPosition !== undefined && (!isJsonObject(cardPosition) || !finite(cardPosition.x) || !finite(cardPosition.y))) {
      return { ok: false, code: "invalid-data", message: "镜头卡片位置无效" };
    }
    return {
      ok: true,
      value: {
        kind: "create-world-camera",
        operationId: value.operationId,
        nodeId: value.nodeId,
        cameraId: value.cameraId,
        settings,
        ...(cardPosition === undefined ? {} : { cardPosition: { x: cardPosition.x as number, y: cardPosition.y as number } })
      }
    };
  }
  return { ok: false, code: "invalid-data", message: "未知写入操作" };
}

/** Validate one `WorldCameraSettings` payload (shared by set/create camera operations). */
function cameraOperationSettings(value: unknown): WorldCameraSettings | null {
  if (!isJsonObject(value)) return null;
  const settings = value;
  const valid = point(settings.position) && rotation(settings.rotation) && projection(settings.projection)
    && isJsonObject(settings.captureMode) && ["static", "dynamic"].includes(settings.captureMode.kind as string)
    && isJsonObject(settings.aspect) && finite(settings.aspect.width) && settings.aspect.width > 0
    && finite(settings.aspect.height) && settings.aspect.height > 0
    && (settings.boundInstanceId === null || isBoundedId(settings.boundInstanceId));
  return valid ? (settings as unknown as WorldCameraSettings) : null;
}

const CAMERA_SETTINGS_KEYS = ["position", "rotation", "projection", "captureMode", "aspect", "boundInstanceId"] as const;

/**
 * Validate a partial camera-settings patch. At least one known field must be present;
 * omitted fields are merged with the current canonical settings by the host.
 */
function cameraSettingsPatch(value: unknown): WorldCameraSettingsPatch | null {
  if (!isJsonObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !(CAMERA_SETTINGS_KEYS as readonly string[]).includes(key))) return null;
  const patch: WorldCameraSettingsPatch = {};
  if (value.position !== undefined) {
    if (!point(value.position)) return null;
    patch.position = value.position;
  }
  if (value.rotation !== undefined) {
    if (!rotation(value.rotation)) return null;
    patch.rotation = value.rotation;
  }
  if (value.projection !== undefined) {
    if (!projection(value.projection)) return null;
    patch.projection = value.projection;
  }
  if (value.captureMode !== undefined) {
    const mode = value.captureMode;
    if (!isJsonObject(mode) || !["static", "dynamic"].includes(mode.kind as string)) return null;
    patch.captureMode = { kind: mode.kind === "dynamic" ? "dynamic" : "static" };
  }
  if (value.aspect !== undefined) {
    const aspect = value.aspect;
    if (!isJsonObject(aspect) || !finite(aspect.width) || !(aspect.width > 0) || !finite(aspect.height) || !(aspect.height > 0)) return null;
    patch.aspect = { width: aspect.width, height: aspect.height };
  }
  if (value.boundInstanceId !== undefined) {
    if (value.boundInstanceId !== null && !isBoundedId(value.boundInstanceId)) return null;
    patch.boundInstanceId = value.boundInstanceId;
  }
  return patch;
}

export function decodeAssistantWorldWriteInput(value: unknown): { ok: true; value: AssistantWorldWriteInput } | { ok: false; code: "invalid-data"; message: string } {
  if (!isJsonObject(value) || !isBoundedId(value.contextId)) {
    return { ok: false, code: "invalid-data", message: "缺少宿主工具上下文" };
  }
  const operation = decodeAssistantWorldWriteOperation(value.operation);
  if (!operation.ok) return operation;
  return { ok: true, value: { contextId: value.contextId, operation: operation.value } };
}

export function decodeAssistantWorldCompletion(value: unknown): { ok: true; value: WorldCompletion } | { ok: false; code: "invalid-data"; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "invalid-data", message: "完成身份无效" };
  const keys = ["canvasId", "runId", "completionId", "cameraId", "settingsVersion"] as const;
  if (Object.keys(value).some(key => !(keys as readonly string[]).includes(key)) || keys.some(key => !isBoundedId(value[key]))) {
    return { ok: false, code: "invalid-data", message: "完成身份字段无效" };
  }
  return {
    ok: true,
    value: {
      canvasId: value.canvasId as string,
      runId: value.runId as string,
      completionId: value.completionId as string,
      cameraId: value.cameraId as string,
      settingsVersion: value.settingsVersion as string
    }
  };
}

/** Camera tool inputs are intentionally free of identity: identity comes from the grant. */
export function decodeAssistantWorldCameraInput(value: unknown): {
  ok: true;
  value: {
    cameraId: WorldId;
    expectedSettingsVersion: WorldVersion;
    settings: WorldCameraSettingsPatch;
  };
} | { ok: false; code: "invalid-data"; message: string } {
  if (!isJsonObject(value) || !isBoundedId(value.cameraId) || !isBoundedId(value.expectedSettingsVersion)) {
    return { ok: false, code: "invalid-data", message: "镜头目标无效" };
  }
  const operation = decodeAssistantWorldWriteOperation({
    kind: "set-world-camera",
    operationId: "camera-tool",
    cameraId: value.cameraId,
    expectedSettingsVersion: value.expectedSettingsVersion,
    settings: value.settings
  });
  if (!operation.ok || operation.value.kind !== "set-world-camera") return { ok: false, code: "invalid-data", message: "镜头设置无效" };
  return {
    ok: true,
    value: {
      cameraId: operation.value.cameraId,
      expectedSettingsVersion: operation.value.expectedSettingsVersion,
      settings: operation.value.settings
    }
  };
}

export type AssistantWorldObjectSummary = {
  identity: WorldObjectIdentity;
  nodeId: string | null;
  version: WorldVersion;
  containment: "writable" | "read-only" | "outside" | "unknown";
  contentVersion?: string;
  transformVersion?: string;
};

export type WorldModelAnimationRig = {
  walkProfile?: import("./world-walk.js").HumanoidWalkProfile | null;
  motionReference?: import("./humanoid-motion-reference.js").HumanoidMotionReference;
  shapes?: Array<{
    id: string; parent: string | null;
    position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number];
    localBounds: import("./model-transform.js").Aabb;
    localTransform?: import("./model-transform.js").Transform;
  }>;
  spatial?: {
    forwardLocal: [number, number, number] | null;
    forwardSource: "humanoid-v1" | "unknown";
    groundAnchorLocal: [number, number, number] | null;
    rootToGroundHeightMeters: number | null;
    anchorSource: "foot-geometry-bounds" | "geometry-bounds" | "unknown";
  };
  groups: Array<Pick<import("./scene-ir-v2/types.js").SceneV2GroupOp, "id" | "parent" | "position" | "rotation" | "scale">>;
  rig: import("./humanoid-rig.js").StoredHumanoidRig | null;
};

/** Read-only projection returned by `get_world_context`. */
export type AssistantWorldContextView = {
  version: typeof ASSISTANT_WORLD_AUTHORITY_VERSION;
  canvasId: WorldId;
  contextId: WorldId;
  runId: WorldId;
  epoch: number;
  scope: WorldScopeVersion;
  writable: WorldObjectVersion[];
  readOnly: WorldObjectVersion[];
  objects: AssistantWorldObjectSummary[];
  /** 导演区地面范围；模型创建/移动必须落在该范围内。2D 组没有世界范围。 */
  bounds?: { min: { u: number; v: number }; max: { u: number; v: number } };
  /** Current published animation for this director area. Omitted by older hosts and for 2D groups. */
  sceneArea?: {
    nodeId: WorldId;
    revision: number;
    /** Canonical scope version the next range write must present. */
    scopeVersion: WorldVersion;
    /** Stable origin for position tracks; u/v are offsets from it, h is absolute. */
    animationOrigin: import("./shared-world.js").GroundPoint;
    /** An explicit null means the current director area has no animation script. */
    animationScript: WorldAnimationScript | null;
  };
  /** Selected camera and published scene geometry, for camera-only composition edits. */
  camera?: { nodeId: WorldId; settings: WorldCameraData };
  sceneModels?: Array<{ instanceId: WorldId; nodeId: WorldId; title: string; transform: WorldTransform; localBounds: import("./model-transform.js").Aabb | null; animationRig?: WorldModelAnimationRig }>;
  /** A 2D group has no writable world set and no completion. */
  worldWritable: boolean;
};

export function assistantWorldContextWritable(scope: WorldScopeVersion["scope"]): boolean {
  return scope.kind === "scene-area" || scope.kind === "world-camera";
}

export type { WorldCameraData };
