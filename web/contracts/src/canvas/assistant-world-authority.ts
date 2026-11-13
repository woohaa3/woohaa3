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
import type { WorldAuthoringConflict, WorldAuthoringFailure, WorldAuthoringFailureCode } from "./world-authoring.js";
import { isBoundedId, isJsonObject } from "../validation.js";
import { decodeGroundAabb } from "./creation-scope-codec.js";

import { WORLD_RESOURCE_TOOLS, type WorldResourceEdit } from "./world-resource-tools.js";

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
  animateHumanoid: "animate_humanoid",
  generateHumanoidMotion: "generate_humanoid_motion",
  getHumanoidMotion: "get_humanoid_motion",
  applyHumanoidMotion: "apply_humanoid_motion",
  readModelRig: "get_world_model_rig",
  sampleAnimation: "sample_scene_animation",
  createModel: "create_world_model",
  replaceModel: "replace_world_model_content",
  /** Read one director-area model's current script and content version. */
  readModelScript: "get_world_model_script",
  /** Append one chunk to an existing model script (skeleton → chunks). */
  appendModelScript: "append_world_model_script",
  /** Exact-text patch of one existing model script (`oldString` → `newString`). */
  patchModelScript: "patch_world_model_script",
  moveModel: "move_world_model",
  setAnimation: "set_scene_animation_script",
  resizeArea: "resize_scene_area",
  createCamera: "create_world_camera",
  setCamera: "set_world_camera",
  completeCamera: "complete_world_camera"
} as const;

export type AssistantWorldToolName = (typeof ASSISTANT_WORLD_TOOL)[keyof typeof ASSISTANT_WORLD_TOOL] | (typeof WORLD_RESOURCE_TOOLS)[keyof typeof WORLD_RESOURCE_TOOLS];

/** Read-only context tools are the only tools a 2D group selection can receive. */
export const ASSISTANT_WORLD_READ_TOOLS = [ASSISTANT_WORLD_TOOL.readContext] as const;

/** Scene-area write tools. Membership in a 2D group never grants these. */
export const LEGACY_ASSISTANT_WORLD_WRITE_TOOLS = [
  ASSISTANT_WORLD_TOOL.animateHumanoid,
  ASSISTANT_WORLD_TOOL.generateHumanoidMotion,
  ASSISTANT_WORLD_TOOL.applyHumanoidMotion,
  ASSISTANT_WORLD_TOOL.createModel,
  ASSISTANT_WORLD_TOOL.replaceModel,
  ASSISTANT_WORLD_TOOL.appendModelScript,
  ASSISTANT_WORLD_TOOL.patchModelScript,
  ASSISTANT_WORLD_TOOL.moveModel,
  ASSISTANT_WORLD_TOOL.setAnimation,
  ASSISTANT_WORLD_TOOL.resizeArea,
  ASSISTANT_WORLD_TOOL.createCamera,
  ASSISTANT_WORLD_TOOL.setCamera,
  ASSISTANT_WORLD_TOOL.completeCamera
] as const;

export const ASSISTANT_WORLD_WRITE_TOOLS = [
  ASSISTANT_WORLD_TOOL.animateHumanoid,
  ASSISTANT_WORLD_TOOL.generateHumanoidMotion,
  ASSISTANT_WORLD_TOOL.applyHumanoidMotion,
  WORLD_RESOURCE_TOOLS.area, WORLD_RESOURCE_TOOLS.model, WORLD_RESOURCE_TOOLS.camera,
  WORLD_RESOURCE_TOOLS.modelScript, WORLD_RESOURCE_TOOLS.animation
] as const;
export const ASSISTANT_WORLD_TOOLS = [
  ASSISTANT_WORLD_TOOL.readContext, WORLD_RESOURCE_TOOLS.read,
  ASSISTANT_WORLD_TOOL.sampleAnimation, ASSISTANT_WORLD_TOOL.getHumanoidMotion,
  ...ASSISTANT_WORLD_WRITE_TOOLS
] as const satisfies readonly AssistantWorldToolName[];

export const ASSISTANT_WORLD_CAMERA_TOOLS = [
  ASSISTANT_WORLD_TOOL.readContext, WORLD_RESOURCE_TOOLS.read, WORLD_RESOURCE_TOOLS.camera
] as const;

/** Actual tool catalog for a selected scope. */
export function assistantWorldToolsForScope(scope: WorldScopeVersion["scope"]): readonly AssistantWorldToolName[] {
  return scope.kind === "world-camera" ? ASSISTANT_WORLD_CAMERA_TOOLS : scope.kind === "scene-area" ? ASSISTANT_WORLD_TOOLS : ASSISTANT_WORLD_READ_TOOLS;
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
    completion: tools.includes(ASSISTANT_WORLD_TOOL.completeCamera) || tools.includes(WORLD_RESOURCE_TOOLS.camera)
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
  | "unverified-stop"
  /** `oldString` never occurs in the current script. */
  | "patch-not-found"
  /** `oldString` occurs more than once; the caller must supply more context. */
  | "patch-ambiguous"
  /** `oldString === newString`; nothing changed and no version advanced. */
  | "patch-noop"
  | "reference-conflict"
  | "already-exists";

/** One place a patch `oldString` occurs; `line` is 1-based. */
export interface AssistantWorldPatchMatch {
  line: number;
  /** 1-based column inside that line. */
  column: number;
  /** Bounded original-text excerpt around the match. */
  excerpt: string;
}

/**
 * Actionable patch diagnostics. They name where the requested text is (or is
 * nearly) located so the caller can widen its context instead of guessing.
 */
export interface AssistantWorldPatchDiagnostic {
  /** How many times `oldString` occurred (0 for not-found, >1 for ambiguous). */
  occurrences: number;
  /** Occurrence positions, bounded. */
  matches?: AssistantWorldPatchMatch[];
  /** Nearest similar excerpt, present for `patch-not-found`. */
  closest?: AssistantWorldPatchMatch;
  /** Current authoritative script length in characters. */
  scriptLength: number;
}

export interface AssistantWorldFailure {
  ok: false;
  code: AssistantWorldFailureCode;
  message: string;
  conflicts?: WorldAuthoringConflict[];
  spatialReason?: string;
  /** Actionable out-of-scope geometry, only when the authority could read it. */
  spatialDiagnostic?: WorldAuthoringFailure["spatialDiagnostic"];
  /** Patch-only diagnostics (`patch-not-found` / `patch-ambiguous`). */
  patchDiagnostic?: AssistantWorldPatchDiagnostic;
  /** Current authoritative version, present on `version-conflict` when it could be read. */
  currentVersion?: WorldVersion;
  references?: Array<{ nodeId: string; kind: string }>;
  editIndex?: number;
}

export type AssistantWorldIssueOutcome = ({ ok: true } & AssistantWorldIssued) | AssistantWorldFailure;

/**
 * Model content accepted by assistant tools. Content identity is derived by the authority.
 *
 * 模型没有卡片，位置只由创建操作的 `transform` 表达
 * （change: 2026-11-10-remove-legacy-model-card-nodes）。
 */
export interface AssistantWorldModelContent {
  modelScript: string;
  modelScriptVersion?: string;
  /** 新建模型时画布上的卡片落点；缺省由画布按非重叠规则决定。 */
  cardPosition?: { x: number; y: number };
}

export type AssistantWorldWriteOperation =
  | { kind: "edit-resource"; operationId: string; edit: WorldResourceEdit }
  | {
      kind: "create-model";
      operationId: WorldId;
      /** Stable node identity chosen by the host run. */
      nodeId: WorldId;
      /** Optional stable instance identity; defaults to a deterministic identity derived from nodeId. */
      instanceId?: WorldId;
      /** Empty content is a skeleton: the model gets an identity and a version but renders nothing until chunks arrive. */
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
      /** Append one chunk to the authoritative script; the host composes `current + chunk`. */
      kind: "append-model-script";
      operationId: WorldId;
      instanceId: WorldId;
      expectedVersion: WorldVersion;
      chunk: string;
    }
  | {
      /** Exact-text patch: `oldString` must occur exactly once in the current script. */
      kind: "patch-model-script";
      operationId: WorldId;
      instanceId: WorldId;
      expectedVersion: WorldVersion;
      oldString: string;
      newString: string;
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
      /** Trusted host-only stable motion asset, committed atomically with the script. */
      motionAsset?: import("./domain/index.js").StoredAsset;
      motionTarget?: {instanceId:WorldId;expectedVersion:WorldVersion;scopeVersion?:WorldVersion;canvasRevision?:number};
      motionBaseRevision?: number;
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
      /** Post-commit authoritative script length in characters (chunk writes). */
      scriptLength?: number;
      /** How many places an exact-text patch replaced (always 1 on success). */
      replaced?: number;
      /**
       * Post-commit camera view (unit forward + ground intersection) for camera
       * operations, so a caller can verify where the lens points instead of
       * treating a successful write as a correct framing.
       */
      view?: WorldCameraView;
      target?: import("./world-resource-tools.js").WorldResourceTarget;
      deleted?: boolean;
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
  if (!isJsonObject(value) || Object.keys(value).some(key => !["modelScript", "modelScriptVersion"].includes(key))) {
    return { ok: false, code: "invalid-data", message: "模型内容包含未知字段" };
  }
  // 空脚本是合法骨架：身份与版本照常由宿主派生，内容在追加前不参与渲染。
  if (typeof value.modelScript !== "string") {
    return { ok: false, code: "invalid-data", message: "模型脚本必须是字符串" };
  }
  if (value.modelScriptVersion !== undefined && !isBoundedId(value.modelScriptVersion)) {
    return { ok: false, code: "invalid-data", message: "模型脚本版本无效" };
  }
  return {
    ok: true,
    value: {
      modelScript: value.modelScript,
      ...(value.modelScriptVersion === undefined ? {} : { modelScriptVersion: value.modelScriptVersion as string })
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
    "append-model-script": ["kind", "operationId", "instanceId", "expectedVersion", "chunk"],
    "patch-model-script": ["kind", "operationId", "instanceId", "expectedVersion", "oldString", "newString"],
    "set-model-transform": ["kind", "operationId", "instanceId", "expectedVersion", "transform"],
    "set-scene-animation-script": ["kind", "operationId", "script", "duration", "loop", "motionAsset", "motionTarget", "motionBaseRevision"],
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
  if (value.kind === "append-model-script") {
    if (!isBoundedId(value.instanceId) || !isBoundedId(value.expectedVersion) || value.chunk === undefined) {
      return { ok: false, code: "invalid-data", message: "追加脚本目标或版本无效" };
    }
    if (typeof value.chunk !== "string" || value.chunk === "") {
      return { ok: false, code: "invalid-data", message: "追加片段必须是非空字符串" };
    }
    return {
      ok: true,
      value: {
        kind: "append-model-script",
        operationId: value.operationId,
        instanceId: value.instanceId,
        expectedVersion: value.expectedVersion,
        chunk: value.chunk
      }
    };
  }
  if (value.kind === "patch-model-script") {
    if (!isBoundedId(value.instanceId) || !isBoundedId(value.expectedVersion)) {
      return { ok: false, code: "invalid-data", message: "修补脚本目标或版本无效" };
    }
    if (typeof value.oldString !== "string" || value.oldString === "" || typeof value.newString !== "string") {
      return { ok: false, code: "invalid-data", message: "修补脚本需要非空 oldString 与字符串 newString" };
    }
    return {
      ok: true,
      value: {
        kind: "patch-model-script",
        operationId: value.operationId,
        instanceId: value.instanceId,
        expectedVersion: value.expectedVersion,
        oldString: value.oldString,
        newString: value.newString
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
    if (value.motionTarget !== undefined && (!isJsonObject(value.motionTarget) || Object.keys(value.motionTarget).some(k => !["instanceId","expectedVersion","scopeVersion","canvasRevision"].includes(k)) || !isBoundedId(value.motionTarget.instanceId) || !isBoundedId(value.motionTarget.expectedVersion) || (value.motionTarget.scopeVersion!==undefined&&!isBoundedId(value.motionTarget.scopeVersion)) || (value.motionTarget.canvasRevision!==undefined&&(!Number.isInteger(value.motionTarget.canvasRevision)||(value.motionTarget.canvasRevision as number)<0)))) return {ok:false,code:"invalid-data",message:"动作目标版本无效"};
    if (value.motionAsset !== undefined && (!Number.isInteger(value.motionBaseRevision) || (value.motionBaseRevision as number)<0)) return {ok:false,code:"invalid-data",message:"动作应用缺少导演区动画版本"};
    if ((value.motionAsset === undefined) !== (value.motionTarget === undefined)) return {ok:false,code:"invalid-data",message:"动作资产与目标版本必须同时提供"};
    if (value.motionAsset !== undefined) {
      const asset = value.motionAsset;
      if (!isJsonObject(asset) || Object.keys(asset).some(k => !['id','title','mediaKind','source','status','createdAt','metadata','nodeId','providerTaskId','provenance','durationSeconds'].includes(k))
        || !isBoundedId(asset.id) || typeof asset.title !== 'string' || asset.mediaKind !== 'motion' || asset.source !== 'generated' || asset.status !== 'ready'
        || typeof asset.createdAt !== 'string' || !Number.isFinite(Date.parse(asset.createdAt)) || !isJsonObject(asset.metadata)
        || typeof asset.metadata.storageKey !== 'string' || typeof asset.metadata.checksum !== 'string'
        || !/^[a-f0-9]{64}$/i.test(asset.metadata.checksum)) {
        return {ok:false,code:'invalid-data',message:'动作资产必须是宿主提供的稳定 ready motion 资产'};
      }
    }

    if (typeof value.script !== "string" || value.script.trim() === ""
      || !finite(value.duration) || value.duration <= 0 || value.duration > 3600
      || typeof value.loop !== "boolean") {
      return { ok: false, code: "invalid-data", message: "导演区动画脚本无效" };
    }
    return {
      ok: true,
      value: { kind: "set-scene-animation-script", operationId: value.operationId, script: value.script, duration: value.duration, loop: value.loop, ...(value.motionBaseRevision === undefined ? {} : {motionBaseRevision:value.motionBaseRevision as number}), ...(value.motionAsset === undefined ? {} : {motionAsset:value.motionAsset as import("./domain/index.js").StoredAsset}), ...(value.motionTarget === undefined ? {} : {motionTarget:value.motionTarget as {instanceId:WorldId;expectedVersion:WorldVersion;scopeVersion?:WorldVersion;canvasRevision?:number}}) }
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

/**
 * Compose the authoritative script after one append.
 *
 * An append is a plain tail concatenation: chunks are never separated or
 * reformatted by the host, so `readback === original + chunk1 + chunk2 + …`
 * exactly. Callers are responsible for emitting a chunk that can end a program
 * (host-side validation of the composed script is the judge).
 */
export function appendWorldModelChunk(current: string, chunk: string): string {
  return `${current}${chunk}`;
}

function lineColumnOf(script: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (script.charCodeAt(cursor) === 10) {
      line += 1;
      lineStart = cursor + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

function excerptAround(script: string, start: number, end: number, radius = 40): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(script.length, end + radius);
  const head = from > 0 ? "…" : "";
  const tail = to < script.length ? "…" : "";
  return `${head}${script.slice(from, to)}${tail}`;
}

function allIndicesOf(script: string, needle: string, limit = 16): number[] {
  const indices: number[] = [];
  let from = 0;
  while (indices.length < limit) {
    const found = script.indexOf(needle, from);
    if (found < 0) break;
    indices.push(found);
    from = found + Math.max(1, needle.length);
  }
  return indices;
}

/** Bounded Levenshtein distance (early exit above `limit`). */
function boundedDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMin = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Locate the nearest place the requested text almost matched.
 *
 * Two signals, both derived from the caller's own needle: anchored positions of
 * its distinctive lines (so indentation or whitespace differences still point at
 * a real line) and a bounded sliding edit-distance scan (so a needle that only
 * partially overlaps still resolves). Candidates are scored by edit distance
 * normalised by needle length; no location is ever invented.
 */
function closestExcerpt(script: string, needle: string, occurrences: readonly number[]): AssistantWorldPatchMatch | undefined {
  if (script.length === 0 || needle.length === 0) return undefined;
  if (occurrences.length > 0) {
    const index = occurrences[0]!;
    return { ...lineColumnOf(script, index), excerpt: excerptAround(script, index, index + needle.length) };
  }
  // Edit-distance scan is bounded: large scripts are sampled on a stride so the
  // closest-match search never becomes the dominant cost of a failed patch.
  const width = Math.min(needle.length, 96);
  const probe = needle.slice(0, width);
  const limit = Math.max(2, Math.floor(width / 4));
  const stride = Math.max(1, Math.floor(script.length / 4096));
  let best: { index: number; distance: number } | null = null;
  for (let offset = 0; offset + width <= script.length; offset += stride) {
    const window = script.slice(offset, offset + width);
    // Cheap gate: require at least one shared 12-character run before the full scan.
    if (!probe.slice(0, 12).includes(window.slice(0, 1)) && !window.slice(0, 12).includes(probe.slice(0, 1))) continue;
    const distance = boundedDistance(probe, window, limit);
    if (!best || distance < best.distance) best = { index: offset, distance };
  }
  // Anchors: positions of the needle's first non-space token (any indentation).
  const anchors = new Set<number>();
  const trimmed = probe.trimStart();
  if (trimmed.length >= 2) {
    for (const index of allIndicesOf(script, trimmed.slice(0, Math.min(trimmed.length, 24)), 8)) anchors.add(index);
  }
  for (const index of anchors) {
    const distance = boundedDistance(probe, script.slice(index, index + width), limit);
    if (!best || distance < best.distance) best = { index, distance };
  }
  if (!best) return undefined;
  const similarity = width === 0 ? 0 : 1 - best.distance / width;
  // A single shared character is not actionable evidence; require real overlap.
  if (similarity < 0.5) return undefined;
  return { ...lineColumnOf(script, best.index), excerpt: excerptAround(script, best.index, best.index + needle.length) };
}

export type WorldModelScriptPatchPlan =
  | { ok: true; script: string; replaced: 1 }
  | { ok: false; code: "patch-not-found" | "patch-ambiguous" | "patch-noop"; diagnostic: AssistantWorldPatchDiagnostic };

/**
 * Plan one exact-text patch against the current authoritative script.
 *
 * Semantics match an editor's `edit`: `oldString` must occur exactly once. Three
 * refusals are explicit and never guess — `patch-not-found`, `patch-ambiguous`
 * and `patch-noop` — and each refusal leaves the script untouched.
 */
export function planWorldModelScriptPatch(current: string, oldString: string, newString: string): WorldModelScriptPatchPlan {
  if (oldString === newString) {
    const count = current.includes(oldString) ? allIndicesOf(current, oldString, Number.MAX_SAFE_INTEGER).length : 0;
    return {
      ok: false,
      code: "patch-noop",
      diagnostic: { occurrences: count, scriptLength: current.length }
    };
  }
  const indices = allIndicesOf(current, oldString);
  if (indices.length === 0) {
    const closest = closestExcerpt(current, oldString, indices);
    return {
      ok: false,
      code: "patch-not-found",
      diagnostic: { occurrences: 0, scriptLength: current.length, ...(closest ? { closest } : {}) }
    };
  }
  if (indices.length > 1) {
    return {
      ok: false,
      code: "patch-ambiguous",
      diagnostic: {
        occurrences: indices.length,
        scriptLength: current.length,
        matches: indices.map((index) => ({ ...lineColumnOf(current, index), excerpt: excerptAround(current, index, index + oldString.length) }))
      }
    };
  }
  const index = indices[0]!;
  return { ok: true, script: `${current.slice(0, index)}${newString}${current.slice(index + oldString.length)}`, replaced: 1 };
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
    areaId?: string;
    title?: string;
    resourceVersion?: string;
    nodeId: WorldId;
    revision: number;
    /** Canonical scope version the next range write must present. */
    scopeVersion: WorldVersion;
    /** Stable origin for position tracks; u/v are offsets from it, h is absolute. */
    animationOrigin: import("./shared-world.js").GroundPoint;
    animationQuarterTurns?: number;
    /** An explicit null means the current director area has no animation script. */
    animationScript: WorldAnimationScript | null;
  };
  /** Selected camera and published scene geometry, for camera-only composition edits. */
  camera?: { nodeId: WorldId; settings: WorldCameraData };
  sceneModels?: Array<{ instanceId: WorldId; nodeId: WorldId; title: string; transform: WorldTransform; localBounds: import("./model-transform.js").Aabb | null; animationRig?: WorldModelAnimationRig }>;
  /**
   * Authoritative scripts of the instance identities in this scope (writable plus
   * read-only references), keyed by instance id. `get_world_model_script` reads
   * `includeSource` from here, so a chunk write can verify its real tail.
   * Omitted by hosts that predate chunked authoring.
   */
  modelScripts?: Record<WorldId, string>;
  resourceVersions?: Record<string, string>;
  sceneCameras?: Array<{ nodeId: string; title: string; settings: WorldCameraData }>;
  /** A 2D group has no writable world set and no completion. */
  worldWritable: boolean;
};

export function assistantWorldContextWritable(scope: WorldScopeVersion["scope"]): boolean {
  return scope.kind === "scene-area" || scope.kind === "world-camera";
}

export type { WorldCameraData };
