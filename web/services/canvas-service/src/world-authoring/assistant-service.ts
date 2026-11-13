/**
 * Scoped assistant world authoring (T11a).
 *
 * The assistant never owns permission, versions or leases. This service:
 *
 * - issues a `WorldToolContext` from the canonical scope snapshot and the
 *   persistent run identity (T06);
 * - maps typed tool operations onto the real `CanvasRoom` command queue while
 *   carrying the process-local spatial capability, so every write revalidates
 *   scope, typed target, version, epoch and atomic occupancy inside the commit
 *   transaction;
 * - creates new model instances with a shared-world identity from the same
 *   commit, so node and instance identity cannot diverge;
 * - records the exact successful writes for one run and accepts camera
 *   completion only for a camera/version this run actually wrote;
 * - cancels the grant first and keeps occupancy until the host confirms the
 *   exact execution stopped.
 *
 * No browser route can call `complete`; the host wires it to the authenticated
 * MCP tool path with a grant that already carries the issued context.
 */
import {
  somaSkeletonPrefix,
  projectSomaRootTranslation,
  isSomaMotionMetadata,
  DEFAULT_MODEL_PLACEMENT,
  describeWorldModelAnimationRig,
  findNonOverlappingNodePosition,
  initialCameraCardPosition,
  SHARED_WORLD_VERSION,
  assistantWorldToolsForScope,
  decodeSceneAreaData,
  decodeWorldCamera,
  decodeWorldInstanceData,
  normalizeModelDefinition,
  humanoidRigForAuthoredScript,
  sceneAreaAnimationOrigin,
  type AssistantWorldCancelInput,
  type AssistantWorldCompletionInput,
  type AssistantWorldCompletionOutcome,
  type AssistantWorldFailure,
  type AssistantWorldFailureCode,
  type AssistantWorldIssueOutcome,
  type AssistantWorldModelContent,
  type AssistantWorldRecoveryOutcome,
  type AssistantWorldRunRequest,
  type AssistantWorldRunView,
  type AssistantWorldStopInput,
  type AssistantWorldWriteInput,
  type AssistantWorldWriteOperation,
  type AssistantWorldWriteOutcome,
  type CanvasNodeData,
  type GroundAabb,
  type SceneAreaData,
  type ServerCanvas,
  type WorldObjectIdentity,
  type WorldObjectVersion,
  type WorldCameraData,
  type WorldTransform,
  type WorldToolContext,
  WORLD_CAMERA_CARD_SIZE,
  createWorldAnimationScript,
  executeWorldAnimationScript,
  appendWorldModelChunk,
  planWorldModelScriptPatch,
  mergeWorldCameraSettings,
  serializeWorldAnimationScript,
  worldCameraView
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, computeCommandPayloadHash, stableStringify } from "@woohaa3/contracts/canvas-yjs";
import { executeSceneIr } from "../model-mcp/script-executor.js";
import type { CanvasRoom } from "../sync/room.js";
import type { RoomCommandResult, RoomSpatialDiagnostic } from "../sync/room-types.js";
import { instanceFootprint, stableAuthorityVersion, worldObjectVersion, nextSceneAreaScopeVersion, type WorldAuthoringAuthority } from "./authority.js";
import { findWorldCameraNodeId, planWorldCameraSettings, worldCameraSettingsOf, type WorldCameraSettingsService } from "./camera-service.js";
import type { WorldCameraCompletionVerification } from "./camera-service.js";
import type { WorldAuthoringService } from "./scene-area-service.js";
import { objectKey, type LeaseRecord, type SpatialWriteContext } from "./spatial-leases.js";
import {
  hostCompletionKey,
  type AssistantHostCompletionFact,
  type AssistantHostCompletionIdentity,
  type AssistantHostCompletionRepository,
  type AssistantWorldCommittedWrite,
  type AssistantWorldWriteIntent
} from "./host-completions.js";

export type AssistantWorldServiceDeps = {
  authority: Pick<WorldAuthoringAuthority, "prepareContent" | "prepareCanvas"> & Partial<Pick<WorldAuthoringAuthority, "cacheFor" | "prepareCamera">>;
  worldAuthoring: Pick<WorldAuthoringService, "issueContext" | "revokeContext" | "resolveCapability" | "refreshContextVersions" | "refreshContextScope">;
  cameraSettings: Pick<WorldCameraSettingsService, "save" | "complete">;
  resolveRoom(canvasId: string): Promise<CanvasRoom | null>;
  cancel(canvasId: string, requestId: string): Promise<void>;
  confirmStopped(input: {
    canvasId: string;
    requestId: string;
    runId: string;
    epoch: number;
    executionId: string;
    evidence: unknown;
  }): Promise<void>;
  /** Host-owned durable T08 history lookup for idempotent completion retries after reopen. */
  findRecordedCompletion?(completion: AssistantWorldCompletionInput["completion"]): boolean | Promise<boolean>;
  /**
   * Durable trusted completion facts. The fact is persisted before the T08
   * history write, so a transient history failure (or a restart between the
   * two writes) can retry the exact completion after the run was stopped and
   * its occupancy released. Tests may omit it; production must wire it.
   *
   * Implementations that persist completion facts must also persist committed
   * camera writes via the optional outbox methods: a camera commit is durable
   * before the write returns, so a restart before the first terminal settle can
   * promote the exact run/completion/camera/settings pair instead of losing it.
   */
  hostCompletions?: AssistantHostCompletionRepository;
  pending(): Promise<LeaseRecord[]>;
};

type RunLedger = {
  canvasId: string;
  contextId: string;
  requestId: string;
  runId: string;
  epoch: number;
  executionId: string;
  completionId: string;
  writes: Map<string, { identity: WorldObjectIdentity; version: string; snapshot?: WorldCameraData }>;
  /**
   * `operationId → intent hash` for chunk writes. Reusing one operation id for a
   * different chunk is a reused identity (request-id-reused), not a retry; the
   * mapping is per run so a completed run releases it with its ledger.
   */
  chunkIntents: Map<string, string>;
  cancelled: boolean;
  /**
   * Set only after the host confirmed the exact execution stopped. A settled
   * run keeps its identity for idempotent completion/stop retries but never
   * accepts another write.
   */
  settled: boolean;
};

/**
 * Trusted host completion fact.
 *
 * It is recorded only from the durable application turn status after the turn
 * reached a successful terminal state, together with the camera/version this
 * run actually wrote. Transport evidence, prompts, capture refreshes and later
 * generations can never insert a row here.
 */
type HostCompletion = AssistantHostCompletionFact;

export type AssistantWorldService = {
  issue(input: AssistantWorldRunRequest): Promise<AssistantWorldIssueOutcome>;
  /** Read the issued context and its object containment summary without writing. */
  read(input: { canvasId: string; contextId: string }): Promise<{ ok: true; view: import("@woohaa3/contracts").AssistantWorldContextView } | AssistantWorldFailure>;
  write(input: AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
  cancel(input: AssistantWorldCancelInput): Promise<void>;
  confirmStopped(input: AssistantWorldStopInput): Promise<{ ok: true } | AssistantWorldFailure>;
  /**
   * Host turn-settled hook. The application ledger supplies the durable terminal
   * status and owner; a successful turn first records one host completion fact,
   * then the exact run is confirmed stopped and its occupancy released.
   * Reopened processes resolve the persistent pending record instead of relying
   * on the in-process ledger.
   */
  settleRun(input: {
    canvasId: string;
    runId: string;
    status?: "queued" | "running" | "committing" | "succeeded" | "partial" | "failed" | "cancelled";
    evidence: unknown;
  }): Promise<{ ok: true } | AssistantWorldFailure>;
  recover(input: { canvasId: string }): Promise<AssistantWorldRecoveryOutcome>;
  /**
   * Host-internal camera completion verifier. The canvas composition wires it to
   * T08. It resolves durable host facts, so it may be asynchronous.
   */
  verifyCompletion(
    completion: AssistantWorldCompletionInput["completion"],
    evidence: unknown
  ): WorldCameraCompletionVerification | Promise<WorldCameraCompletionVerification>;
  /**
   * Retry every outstanding durable host completion fact. Called at host start
   * so a transient history failure is补记 after restart without re-running the
   * assistant or recreating history.
   */
  resumePendingCompletions(): Promise<{ ok: true; attempted: number; remaining: number } | AssistantWorldFailure>;
  close(): void;
};

function failure(code: AssistantWorldFailureCode, message: string, extra: Partial<AssistantWorldFailure> = {}): AssistantWorldFailure {
  return { ok: false, code, message, ...extra };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(left: WorldObjectIdentity, right: WorldObjectIdentity): boolean {
  return left.kind === right.kind && (left.kind === "instance"
    ? left.instanceId === (right as Extract<WorldObjectIdentity, { kind: "instance" }>).instanceId
    : left.cameraId === (right as Extract<WorldObjectIdentity, { kind: "camera" }>).cameraId);
}

/** Axes whose footprint leaves `bounds` (inclusive edges count as inside). */
function outsideGroundAxes(actual: GroundAabb, bounds: GroundAabb): Array<"u" | "v"> {
  const axes: Array<"u" | "v"> = [];
  for (const axis of ["u", "v"] as const) {
    if (actual.min[axis] < bounds.min[axis] || actual.max[axis] > bounds.max[axis]) axes.push(axis);
  }
  return axes;
}

/**
 * Carry the authority's typed spatial reason into the assistant failure.
 *
 * The reason must survive so an assistant can tell `outside-scope` from
 * `version-conflict` and `version-unknown`; dropping it would turn a real
 * version mismatch into a misleading scope error.
 */
function spatialDetail(result: Extract<RoomCommandResult, { ok: false }>): Partial<AssistantWorldFailure> {
  return result.spatialReason ? { spatialReason: result.spatialReason } : {};
}

/** Room-reported geometry (when the authority could read it) plus the assistant's own explanation. */
function spatialDiagnostic(
  result: Extract<RoomCommandResult, { ok: false }>,
  fallback: RoomSpatialDiagnostic = {}
): RoomSpatialDiagnostic {
  const room = result.spatialDiagnostic;
  return {
    ...fallback,
    ...room,
    ...(room?.actual || !fallback.actual ? {} : { actual: fallback.actual }),
    ...(room?.bounds || !fallback.bounds ? {} : { bounds: fallback.bounds }),
    ...(room?.outsideAxes || !fallback.outsideAxes ? {} : { outsideAxes: fallback.outsideAxes })
  };
}

function commandFailure(result: Extract<RoomCommandResult, { ok: false }>): AssistantWorldFailure {
  switch (result.code) {
    case "spatial-rejected": {
      switch (result.spatialReason) {
        case "version-conflict": return failure("version-conflict", "模型或镜头版本已变化", spatialDetail(result));
        case "version-unknown": return failure("version-conflict", "无法核对模型或镜头的当前版本，请重新读取世界上下文后重试", spatialDetail(result));
        case "lease-conflict": return failure("lease-conflict", "目标正被其他运行占用", spatialDetail(result));
        case "stale-epoch": return failure("stale-epoch", "写能力已失效", spatialDetail(result));
        case "cancelled": return failure("cancelled", "运行已取消", spatialDetail(result));
        case "outside-scope":
          return failure("outside-scope", result.message, spatialDetail(result));
        default: return failure("invalid-data", result.message, spatialDetail(result));
      }
    }
    case "lease-conflict": return { ...failure("lease-conflict", result.message), ...(result.conflict ? { conflicts: [{ target: result.conflict.target, version: null, runId: result.conflict.runId, epoch: result.conflict.epoch }] } : {}) };
    case "outside-scope": return failure("outside-scope", result.message, spatialDetail(result));
    case "stale-epoch": return failure("stale-epoch", result.message);
    case "version-conflict":
    case "edit-precondition-failed": return failure("version-conflict", result.message);
    case "cancelled": return failure("cancelled", result.message);
    case "command-id-reused":
    case "request-id-reused": return failure("operation-conflict", "相同 operationId 使用了不同意图");
    case "write-forbidden": return failure("write-forbidden", result.message);
    default: return failure("invalid-data", result.message);
  }
}

function runView(record: LeaseRecord): AssistantWorldRunView {
  return {
    canvasId: record.intent.canvasId,
    requestId: record.intent.requestId,
    runId: record.intent.runId,
    epoch: record.intent.epoch,
    executionId: record.intent.executionId,
    state: record.state,
    scope: record.intent.scope,
    writableTargets: record.intent.writable,
    readOnlyReferences: record.intent.readOnly
  };
}

function contentFields(content: AssistantWorldModelContent, previousRig?: unknown): Record<string, unknown> {
  const resolved = humanoidRigForAuthoredScript(content.modelScript, undefined, previousRig);
  if (!resolved.ok) throw new Error(resolved.message);
  const definition = normalizeModelDefinition({
    modelScript: content.modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: content.modelScriptVersion ?? "woohaa-model-js-v2",
    placement: DEFAULT_MODEL_PLACEMENT,
    rig: resolved.rig
  });
  if (!definition.ok) throw new Error(definition.reason);
  return {
    modelScript: definition.value.modelScript,
    modelScriptLanguage: definition.value.modelScriptLanguage,
    modelScriptVersion: definition.value.modelScriptVersion,
    modelContentVersion: definition.value.contentVersion,
    modelPlacement: definition.value.placement,
    ...(definition.value.rig ? { modelRig: definition.value.rig } : {})
  };
}

/**
 * Skeleton model content: an empty script with a real identity and a real
 * content version. It carries no geometry (the authority reports it as
 * not-ready) and renders nothing until the first chunk arrives.
 */
function skeletonContentFields(content: AssistantWorldModelContent): Record<string, unknown> {
  const definition = normalizeModelDefinition({
    modelScript: "",
    modelScriptLanguage: "javascript",
    modelScriptVersion: content.modelScriptVersion ?? "woohaa-model-js-v2",
    placement: DEFAULT_MODEL_PLACEMENT,
    rig: null
  });
  if (!definition.ok) throw new Error(definition.reason);
  return {
    modelScript: "",
    modelScriptLanguage: definition.value.modelScriptLanguage,
    modelScriptVersion: definition.value.modelScriptVersion,
    modelContentVersion: definition.value.contentVersion,
    modelPlacement: definition.value.placement
  };
}

/** Read the authoritative script of one world instance, or `null` when absent. */
function scriptOfNode(fields: Record<string, unknown>): string | null {
  return typeof fields.modelScript === "string" ? fields.modelScript : null;
}

function instanceFields(fields: Record<string, unknown>, instanceId: string, transform: WorldTransform): Record<string, unknown> {
  return {
    ...fields,
    sharedWorldInstance: {
      kind: "world-instance",
      version: SHARED_WORLD_VERSION,
      instanceId,
      transform
    }
  };
}

function findWritable(context: WorldToolContext, identity: WorldObjectIdentity): WorldObjectVersion | null {
  return context.writableTargets.find(entry => sameIdentity(entry.target, identity))?.target ?? null;
}

/**
 * Key the derived command by the *semantic intent*, not only the caller's
 * operation id. The MCP tool keeps a stable operation id per work/target so a
 * transport retry stays idempotent, while a genuinely different move/replace/
 * camera intent must produce a different command id. Without this, the room's
 * idempotency precheck would return the first receipt and silently discard the
 * second change.
 */
function intentCommandId(tag: string, operation: AssistantWorldWriteOperation): string {
  const { operationId, ...intent } = operation;
  return `${tag}:${operationId}:${stableAuthorityVersion("assistant-world-intent", intent)}`;
}

function findInstanceNode(canvas: ServerCanvas, instanceId: string): { nodeId: string; fields: Record<string, unknown> } | null {
  for (const node of canvas.document.nodes) {
    const fields = canvas.nodeData[node.id];
    if (!record(fields)) continue;
    const decoded = decodeWorldInstanceData(fields.sharedWorldInstance);
    if (decoded.ok && decoded.value.instanceId === instanceId) return { nodeId: node.id, fields };
  }
  return null;
}

/** Existing world instance/camera identities in the published canvas. */
function existingWorldTargets(canvas: ServerCanvas): { instances: Set<string>; cameras: Set<string> } {
  const instances = new Set<string>();
  const cameras = new Set<string>();
  for (const node of canvas.document.nodes) {
    const fields = canvas.nodeData[node.id];
    if (!record(fields)) continue;
    const instance = decodeWorldInstanceData(fields.sharedWorldInstance);
    if (instance.ok) instances.add(instance.value.instanceId);
    const camera = decodeWorldCamera(fields.worldCamera);
    if (camera.ok) cameras.add(camera.value.cameraId);
  }
  return { instances, cameras };
}

function hasNode(canvas: ServerCanvas, nodeId: string): boolean {
  return canvas.document.nodes.some(node => node.id === nodeId);
}

/** Locate a scene area by its stable areaId (node id may differ). */
function findArea(canvas: ServerCanvas, areaId: string): { node: ServerCanvas["document"]["nodes"][number]; area: SceneAreaData } | null {
  for (const node of canvas.document.nodes) {
    if (node.type !== "scene-area") continue;
    const decoded = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
    if (decoded.ok && decoded.value.areaId === areaId) return { node, area: decoded.value };
  }
  return null;
}


export function createAssistantWorldService(deps: AssistantWorldServiceDeps): AssistantWorldService {
  const rigCache = new Map<string, import("@woohaa3/contracts").WorldModelAnimationRig | null>();
async function animationRigOf(fields: Record<string, unknown>): Promise<import("@woohaa3/contracts").WorldModelAnimationRig | null> {
  if (!fields || typeof fields.modelScript !== "string") return null;
  const resolved = humanoidRigForAuthoredScript(fields.modelScript, undefined, fields.modelRig);
  if (!resolved.ok) return null;
  const rig = resolved.rig;
  const key = JSON.stringify([fields.modelScript, fields.modelScriptVersion, fields.modelRig]);
  if (rigCache.has(key)) return rigCache.get(key)!;
  const execution = await executeSceneIr(fields.modelScript, fields.modelScriptVersion, { ...(rig ? { rig: rig.parameters } : {}) });
  if (rigCache.size >= 64) rigCache.delete(rigCache.keys().next().value!);
  if (!execution.ok) { rigCache.set(key, null); return null; }
  const value = describeWorldModelAnimationRig(execution.ops, rig);
  if (rigCache.size >= 64) rigCache.delete(rigCache.keys().next().value!);
  rigCache.set(key, value);
  return value;
}

  const ledgers = new Map<string, RunLedger>();
  const hostCompletions = new Map<string, HostCompletion>();
  /**
   * Completion keys whose T08 history row is known to exist in this process.
   * A fact is removed from the durable pending store only after the history
   * write returns success, so stop/release never hides a failed write.
   */
  const recordedCompletions = new Map<string, HostCompletion>();

  function hostIdentity(completion: AssistantWorldCompletionInput["completion"]): AssistantHostCompletionIdentity {
    return {
      canvasId: completion.canvasId,
      runId: completion.runId,
      completionId: completion.completionId,
      cameraId: completion.cameraId
    };
  }

  async function loadHostCompletion(completion: AssistantWorldCompletionInput["completion"]): Promise<HostCompletion | null> {
    const key = hostCompletionKey(completion);
    const cached = hostCompletions.get(key);
    if (cached) return cached;
    if (!deps.hostCompletions) return null;
    try {
      const stored = await deps.hostCompletions.get(hostIdentity(completion));
      if (stored) hostCompletions.set(key, stored);
      return stored;
    } catch {
      // Unknown durable state stays fail-closed.
      return null;
    }
  }

  async function rememberHostCompletion(fact: HostCompletion): Promise<void> {
    hostCompletions.set(hostCompletionKey(fact), fact);
    if (deps.hostCompletions) await deps.hostCompletions.put(fact);
  }

  async function forgetHostCompletion(fact: HostCompletion): Promise<void> {
    const key = hostCompletionKey(fact);
    recordedCompletions.set(key, fact);
    hostCompletions.delete(key);
    if (deps.hostCompletions) await deps.hostCompletions.delete(fact);
  }

  async function listHostCompletions(input: { canvasId: string; runId: string }): Promise<HostCompletion[]> {
    if (deps.hostCompletions) {
      try {
        const stored = await deps.hostCompletions.list(input);
        for (const fact of stored) hostCompletions.set(hostCompletionKey(fact), fact);
        return stored;
      } catch {
        return [...hostCompletions.values()].filter(fact => fact.canvasId === input.canvasId && fact.runId === input.runId);
      }
    }
    return [...hostCompletions.values()].filter(fact => fact.canvasId === input.canvasId && fact.runId === input.runId);
  }

  /**
   * Persist one already-committed camera write in the durable outbox. This is
   * required at the authoritative commit boundary and not best-effort: if the
   * outbox write fails, the caller must not receive success (a retry with the
   * same intent resolves the idempotent camera receipt and writes the outbox).
   */
  async function rememberCommittedWrite(write: AssistantWorldCommittedWrite): Promise<void> {
    if (!deps.hostCompletions) return;
    if (!deps.hostCompletions.putCommitted) {
      // A durable completion store without the commit outbox would re-introduce
      // the lost-completion window; refuse to report a durable write success.
      throw Object.assign(new Error("助手完成事实仓库缺少世界写入 outbox"), { code: "not-ready" });
    }
    await deps.hostCompletions.putCommitted(write);
  }

  async function listCommittedWrites(input: { canvasId: string; runId: string }): Promise<AssistantWorldCommittedWrite[]> {
    if (!deps.hostCompletions?.listCommitted) return [];
    try {
      return await deps.hostCompletions.listCommitted(input);
    } catch {
      // Unknown durable state stays fail-closed; the caller reports not-ready.
      throw Object.assign(new Error("无法读取待核对的世界写入"), { code: "not-ready" });
    }
  }

  function writeFromIntent(intent: AssistantWorldWriteIntent): AssistantWorldCommittedWrite {
    return {
      canvasId: intent.canvasId,
      requestId: intent.requestId,
      runId: intent.runId,
      epoch: intent.epoch,
      executionId: intent.executionId,
      contextId: intent.contextId,
      completionId: intent.completionId,
      cameraId: intent.cameraId,
      settingsVersion: intent.settingsVersion,
      snapshot: intent.snapshot
    };
  }

  async function persistWriteIntent(intent: AssistantWorldWriteIntent): Promise<void> {
    // No durable repository means an embedded/test service without restart
    // recovery; it must not claim durability. Production always wires one.
    if (!deps.hostCompletions) return;
    if (!deps.hostCompletions.putIntent || !deps.hostCompletions.getIntent
      || !deps.hostCompletions.listIntents || !deps.hostCompletions.deleteIntent) {
      throw Object.assign(new Error("助手完成事实仓库缺少世界写入意图"), { code: "not-ready" });
    }
    await deps.hostCompletions.putIntent(intent);
  }

  async function deleteWriteIntent(commandId: string): Promise<void> {
    if (!deps.hostCompletions?.deleteIntent) return;
    await deps.hostCompletions.deleteIntent(commandId);
  }

  async function listWriteIntents(input: { canvasId: string; runId: string }): Promise<AssistantWorldWriteIntent[]> {
    if (!deps.hostCompletions?.listIntents) return [];
    return deps.hostCompletions.listIntents(input);
  }

  type IntentResolution =
    | { status: "committed"; intent: AssistantWorldWriteIntent; revision: number; changed: boolean }
    | { status: "uncommitted" }
    | { status: "unknown"; failure: AssistantWorldFailure };

  /**
   * Resolve a durable intent against the *original real command receipt*. The
   * intent itself is only a proposal: only a matching receipt (same commandId
   * and exact payload hash) proves the canonical camera commit happened.
   */
  async function resolveWriteIntent(intent: AssistantWorldWriteIntent): Promise<IntentResolution> {
    let room: CanvasRoom | null;
    try {
      room = await deps.resolveRoom(intent.canvasId);
    } catch {
      room = null;
    }
    if (!room) return { status: "unknown", failure: failure("not-ready", "无法读取画布以核对世界写入") };
    // Embedded/test rooms may intentionally expose no durable command receipt
    // store. They never claim restart recovery; the canonical save result stays
    // authoritative in-process.
    if (typeof room.lookupCommand !== "function") return { status: "uncommitted" };
    let receipt: Awaited<ReturnType<CanvasRoom["lookupCommand"]>>;
    try {
      receipt = await room.lookupCommand(intent.commandId);
    } catch {
      return { status: "unknown", failure: failure("not-ready", "无法读取世界写入回执") };
    }
    if (!receipt) return { status: "uncommitted" };
    if (receipt.payloadHash !== intent.payloadHash) {
      return { status: "unknown", failure: failure("operation-conflict", "世界写入回执与持久意图不一致") };
    }
    return { status: "committed", intent, revision: receipt.revision, changed: receipt.changed };
  }

  /**
   * Persist the verified commit in the outbox and drop the intent. A failure
   * here keeps the intent so the exact commit remains recoverable.
   */
  async function adoptVerifiedIntent(intent: AssistantWorldWriteIntent): Promise<{ ok: true } | AssistantWorldFailure> {
    try {
      await rememberCommittedWrite(writeFromIntent(intent));
    } catch (error) {
      return failure("not-ready", error instanceof Error ? error.message : "世界写入事实保存失败");
    }
    try {
      await deleteWriteIntent(intent.commandId);
    } catch {
      // A lingering intent only re-adopts the same outbox row idempotently.
    }
    return { ok: true };
  }

  /**
   * Reconcile every durable intent for a run before promotion/release.
   *
   * Committed intents become outbox rows (never completion facts); uncommitted
   * intents are dropped; unknown receipt state keeps both the intent and the
   * run fail-closed. Superseded writes for the same run/camera keep the highest
   * committed revision, matching the single completion identity of a run.
   */
  async function reconcileRunIntents(input: { canvasId: string; runId: string }): Promise<{ ok: true } | AssistantWorldFailure> {
    let intents: AssistantWorldWriteIntent[];
    try {
      intents = await listWriteIntents(input);
    } catch (error) {
      return failure("not-ready", error instanceof Error ? error.message : "无法读取世界写入意图");
    }
    const committed = new Map<string, { intent: AssistantWorldWriteIntent; revision: number }>();
    for (const intent of intents) {
      const resolved = await resolveWriteIntent(intent);
      if (resolved.status === "unknown") return resolved.failure;
      if (resolved.status === "uncommitted") {
        try {
          await deleteWriteIntent(intent.commandId);
        } catch {
          // A later attempt re-checks the same absent receipt.
        }
        continue;
      }
      const key = hostCompletionKey(intent);
      const current = committed.get(key);
      if (!current || resolved.revision >= current.revision) {
        committed.set(key, { intent, revision: resolved.revision });
      }
    }
    for (const { intent } of committed.values()) {
      const adopted = await adoptVerifiedIntent(intent);
      if (!adopted.ok) return adopted;
    }
    // Superseded/losing intents never authorize history.
    for (const intent of intents) {
      const key = hostCompletionKey(intent);
      const winner = committed.get(key);
      if (!winner || winner.intent.commandId !== intent.commandId) {
        try {
          await deleteWriteIntent(intent.commandId);
        } catch {
          // Idempotent later cleanup.
        }
      }
    }
    return { ok: true };
  }

  async function discardWriteIntents(input: { canvasId: string; runId: string }): Promise<void> {
    let intents: AssistantWorldWriteIntent[];
    try {
      intents = await listWriteIntents(input);
    } catch {
      return;
    }
    for (const intent of intents) {
      try {
        await deleteWriteIntent(intent.commandId);
      } catch {
        // A lingering intent is still never promoted for an unsuccessful run.
      }
    }
  }

  /**
   * A terminal failed/cancelled run can never produce a completion. Drop its
   * outbox rows after the trusted stop was verified so they do not linger.
   */
  async function discardCommittedWrites(input: { canvasId: string; runId: string }): Promise<void> {
    if (!deps.hostCompletions?.listCommitted || !deps.hostCompletions.deleteCommitted) return;
    try {
      const writes = await deps.hostCompletions.listCommitted(input);
      for (const write of writes) {
        if (write.canvasId !== input.canvasId || write.runId !== input.runId) continue;
        await deps.hostCompletions.deleteCommitted(write);
      }
    } catch {
      // The unsuccessful run must not create history; a lingering outbox row is
      // never promoted because only succeeded/partial settle promotes.
    }
  }

  /**
   * Promote a durable committed write to a trusted completion fact. Only called
   * from a host settle whose durable terminal status is succeeded/partial (and,
   * after a reopen, after the original occupancy has been confirmed stopped).
   */
  async function promoteCommittedWrite(
    write: AssistantWorldCommittedWrite,
    status: "succeeded" | "partial",
    evidence: unknown
  ): Promise<{ ok: true } | AssistantWorldFailure> {
    const fact: HostCompletion = {
      canvasId: write.canvasId,
      requestId: write.requestId,
      runId: write.runId,
      completionId: write.completionId,
      cameraId: write.cameraId,
      settingsVersion: write.settingsVersion,
      status,
      snapshot: write.snapshot
    };
    const key = hostCompletionKey(fact);
    if (!recordedCompletions.has(key)) {
      try {
        await rememberHostCompletion(fact);
      } catch (error) {
        return failure("not-ready", error instanceof Error ? error.message : "助手完成事实保存失败");
      }
    }
    try {
      await deps.hostCompletions?.deleteCommitted?.(write);
    } catch {
      // The durable fact is authoritative; a lingering outbox row only causes an
      // idempotent re-promotion, never a second history row.
    }
    return writeHostCompletion(fact, evidence);
  }

  /**
   * Attempt the T08 history write for one trusted fact. Success removes the
   * durable pending row; any failure keeps it for a later settle/complete/restart.
   */
  async function writeHostCompletion(fact: HostCompletion, evidence: unknown): Promise<{ ok: true } | AssistantWorldFailure> {
    const completion = {
      canvasId: fact.canvasId,
      runId: fact.runId,
      completionId: fact.completionId,
      cameraId: fact.cameraId,
      settingsVersion: fact.settingsVersion
    };
    const key = hostCompletionKey(fact);
    if (recordedCompletions.has(key)) return { ok: true };
    if (deps.findRecordedCompletion) {
      try {
        if (await deps.findRecordedCompletion(completion)) {
          await forgetHostCompletion(fact);
          return { ok: true };
        }
      } catch {
        // Unknown history state is not success; continue to the write attempt.
      }
    }
    let completed: Awaited<ReturnType<typeof deps.cameraSettings.complete>>;
    try {
      completed = await deps.cameraSettings.complete({ completion, evidence });
    } catch (error) {
      return failure("not-ready", error instanceof Error ? error.message : "镜头完成留档失败");
    }
    if (!completed.ok) return completed;
    try {
      await forgetHostCompletion(fact);
    } catch {
      // The history row already exists; a lingering pending fact only causes an
      // idempotent duplicate retry, never a second row.
    }
    return { ok: true };
  }

  async function inspect(canvasId: string): Promise<{ ok: true; room: CanvasRoom; canvas: ServerCanvas } | AssistantWorldFailure> {
    const room = await deps.resolveRoom(canvasId);
    if (!room) return failure("not-found", "画布不存在");
    const inspected = await room.inspectPublished(value => value);
    if (!inspected.ok) return failure("not-ready", inspected.message);
    return { ok: true, room, canvas: inspected.canvas };
  }

  function ledgerFor(contextId: string): RunLedger | AssistantWorldFailure {
    const ledger = ledgers.get(contextId);
    if (!ledger) return failure("not-issued", "工具运行不是宿主签发的");
    if (ledger.cancelled) return failure("cancelled", "工具运行已取消");
    if (ledger.settled) return failure("not-issued", "工具运行已结束");
    return ledger;
  }

  function resolve(contextId: string): { ledger: RunLedger; context: WorldToolContext; capability: SpatialWriteContext } | AssistantWorldFailure {
    const ledger = ledgerFor(contextId);
    if ("ok" in ledger) return ledger;
    const resolved = deps.worldAuthoring.resolveCapability(ledger.canvasId, contextId);
    if ("ok" in resolved) return resolved;
    if (resolved.context.runId !== ledger.runId || resolved.context.epoch !== ledger.epoch) {
      return failure("stale-epoch", "工具上下文与运行身份不一致");
    }
    return { ledger, context: resolved.context, capability: resolved.capability };
  }

  async function issue(input: AssistantWorldRunRequest): Promise<AssistantWorldIssueOutcome> {
    if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.requestId) || !nonEmpty(input.runId) ||
      !nonEmpty(input.executionId) || !Number.isSafeInteger(input.epoch) || input.epoch < 0 || !input.scope) {
      return failure("invalid-data", "工具运行身份无效");
    }
    const base = {
      canvasId: input.canvasId,
      requestId: input.requestId,
      runId: input.runId,
      epoch: input.epoch,
      executionId: input.executionId
    };
    const issued = await deps.worldAuthoring.issueContext({ ...base, scope: input.scope });
    if (!issued.ok) return issued;
    const completionId = stableAuthorityVersion("assistant-world-completion", {
      canvasId: input.canvasId,
      runId: issued.run.runId,
      epoch: issued.run.epoch,
      scope: issued.context.scope
    });
    const existing = ledgers.get(issued.context.contextId);
    if (existing) {
      return {
        ok: true,
        run: runView({
          intent: {
            canvasId: existing.canvasId,
            requestId: existing.requestId,
            runId: existing.runId,
            epoch: existing.epoch,
            executionId: existing.executionId,
            scope: issued.context.scope,
            writable: issued.context.writableTargets.map(entry => entry.target),
            readOnly: issued.context.readOnlyReferences
          },
          state: existing.cancelled ? "cancelled" : existing.settled ? "stopped" : "active"
        }),
        context: issued.context,
        completionId: existing.completionId,
        retry: true
      };
    }
    const ledger: RunLedger = {
      canvasId: input.canvasId,
      contextId: issued.context.contextId,
      requestId: issued.run.requestId,
      runId: issued.run.runId,
      epoch: issued.run.epoch,
      executionId: issued.run.executionId,
      completionId,
      writes: new Map(),
      chunkIntents: new Map(),
      cancelled: false,
      settled: false
    };
    ledgers.set(issued.context.contextId, ledger);
    const run: AssistantWorldRunView = {
      ...runView({
        intent: {
          canvasId: input.canvasId,
          requestId: issued.run.requestId,
          runId: issued.run.runId,
          epoch: issued.run.epoch,
          executionId: issued.run.executionId,
          scope: issued.context.scope,
          writable: issued.context.writableTargets.map(entry => entry.target),
          readOnly: issued.context.readOnlyReferences
        },
        state: issued.run.state
      })
    };
    return { ok: true, run, context: issued.context, completionId, retry: issued.retry };
  }

  async function read(input: { canvasId: string; contextId: string }): Promise<{ ok: true; view: import("@woohaa3/contracts").AssistantWorldContextView } | AssistantWorldFailure> {
    let resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    if (resolved.ledger.canvasId !== input.canvasId || resolved.context.canvasId !== input.canvasId) return failure("stale-epoch", "工具上下文不属于当前画布");
    const inspected = await inspect(input.canvasId);
    // A queued published read can outlive cancellation or context revocation.
    resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    if (!inspected.ok) return inspected;
    const { ledger, context } = resolved;
    if (ledger.canvasId !== input.canvasId || context.canvasId !== input.canvasId) return failure("stale-epoch", "工具上下文不属于当前画布");
    let sceneArea: import("@woohaa3/contracts").AssistantWorldContextView["sceneArea"];
    let bounds: import("@woohaa3/contracts").AssistantWorldContextView["bounds"];
    if (context.scope.scope.kind === "scene-area") {
      const areaId = context.scope.scope.areaId;
      for (const node of inspected.canvas.document.nodes) {
        if (node.type !== "scene-area") continue;
        const decoded = decodeSceneAreaData(inspected.canvas.nodeData[node.id]?.sceneArea);
        if (!decoded.ok || decoded.value.areaId !== areaId) continue;
        if (decoded.value.scopeVersion !== context.scope.scopeVersion) return failure("version-conflict", "导演区范围已变化");
        const writableInstances = new Set(context.writableTargets.flatMap(({ target }) => target.kind === "instance" ? [target.instanceId] : []));
        const writableCameras = new Set(context.writableTargets.flatMap(({ target }) => target.kind === "camera" ? [target.cameraId] : []));
        let animationScript = decoded.value.animationScript ?? null;
        if (decoded.value.animationScript) {
          const script = decoded.value.animationScript;
          const compiled = executeWorldAnimationScript(script.script, {
            duration: script.duration,
            loop: script.loop
          });
          if (!compiled.ok) {
            return failure("outside-scope", "导演区动画脚本无法编译，原动画未修改");
          }
          // Tracks whose target no longer exists reference a deleted instance or
          // camera. They cannot animate or be preserved, but refusing the whole
          // context would permanently lock the area (a later create-camera or
          // animation write could never read the scope again). Drop only those
          // dead tracks; a live target outside the writable set still refuses.
          const existing = existingWorldTargets(inspected.canvas);
          const instanceTracks = compiled.ir.instanceTracks.filter(track => existing.instances.has(track.targetId));
          const partTracks = (compiled.ir.partTracks ?? []).filter(track => existing.instances.has(track.targetId));
          const somaTracks = (compiled.ir.somaTracks ?? []).filter(track => existing.instances.has(track.targetId));
          const walkTracks = (compiled.ir.walkTracks ?? []).filter(track => existing.instances.has(track.targetId));
          const cameraTracks = compiled.ir.cameraTracks.filter(track => existing.cameras.has(track.targetId));
          const outside = somaTracks.some(track => !writableInstances.has(track.targetId)) || walkTracks.some(track => !writableInstances.has(track.targetId)) || partTracks.some(track => !writableInstances.has(track.targetId))
            || instanceTracks.some(track => !writableInstances.has(track.targetId))
            || cameraTracks.some(track => !writableCameras.has(track.targetId));
          if (outside) {
            // The write tool replaces the whole script: a filtered read would
            // silently delete hidden tracks on a later local revision.
            return failure("outside-scope", "导演区动画包含本轮不可写的部件，无法安全读取并局部返修；原动画未修改");
          }
          if (somaTracks.length !== (compiled.ir.somaTracks?.length ?? 0)
            || walkTracks.length !== (compiled.ir.walkTracks?.length ?? 0)
            || instanceTracks.length !== compiled.ir.instanceTracks.length
            || cameraTracks.length !== compiled.ir.cameraTracks.length
            || partTracks.length !== (compiled.ir.partTracks ?? []).length) {
            animationScript = instanceTracks.length === 0 && cameraTracks.length === 0 && partTracks.length === 0 && walkTracks.length === 0 && somaTracks.length === 0
              ? null
              : createWorldAnimationScript({
                  script: serializeWorldAnimationScript({ ...compiled.ir, instanceTracks, cameraTracks, partTracks, walkTracks, somaTracks }),
                  duration: script.duration,
                  loop: script.loop,
                  revision: script.revision
                });
          }
        }
        bounds = decoded.value.bounds;
        sceneArea = {
          nodeId: node.id,
          revision: inspected.canvas.revision,
          scopeVersion: decoded.value.scopeVersion,
          animationOrigin: sceneAreaAnimationOrigin(decoded.value),
          ...(decoded.value.animationQuarterTurns !== undefined ? { animationQuarterTurns: decoded.value.animationQuarterTurns } : {}),
          animationScript
        };
        break;
      }
      if (!sceneArea) return failure("outside-scope", "导演区不存在");
    }
    let cameraView: Pick<import("@woohaa3/contracts").AssistantWorldContextView, "camera" | "sceneModels" | "modelScripts"> = {};
    if (context.scope.scope.kind === "scene-area" && deps.authority.cacheFor) {
      // 助手需要书架等模型的世界变换、朝向与本地包围盒来推导倒下支点和镜头取景。
      const cache = deps.authority.cacheFor(ledger.canvasId, context.scope);
      if (cache) {
        const targets = [...context.writableTargets.map((entry) => entry.target), ...context.readOnlyReferences];
        cameraView = {
          sceneModels: targets.flatMap((target) => {
            const model = target.kind === "instance" ? cache.instances.get(target.instanceId) : undefined;
            if (!model) return [];
            return [{
              instanceId: model.identity.instanceId,
              nodeId: model.nodeId,
              title: String(inspected.canvas.nodeData[model.nodeId]?.title ?? model.nodeId),
              transform: model.data.transform,
              localBounds: model.localAabb
            }];
          })
        };
      }
    }
    if (context.scope.scope.kind === "world-camera") {
      const cameraId = context.scope.scope.cameraId;
      if (!deps.authority.prepareCamera || !deps.authority.cacheFor) return failure("capability-unsupported", "宿主未装配镜头范围权威");
      const prepared = await deps.authority.prepareCamera(inspected.canvas, cameraId);
      if (!prepared.ok) return failure(prepared.code, prepared.message);
      const stillIssued = resolve(input.contextId);
      if ("ok" in stillIssued) return stillIssued;
      const cache = deps.authority.cacheFor(ledger.canvasId, context.scope);
      const record = cache?.cameras.get(cameraId);
      const granted = findWritable(context, { kind: "camera", cameraId });
      if (!record || !granted || record.version !== granted.version) return failure("version-conflict", "镜头配置已变化，请重新提交调整");
      cameraView = {
        camera: { nodeId: record.nodeId, settings: record.data },
        sceneModels: context.readOnlyReferences.flatMap(target => {
          const model = target.kind === "instance" ? cache?.instances.get(target.instanceId) : undefined;
          if (!model) return [];
          return [{ instanceId: model.identity.instanceId, nodeId: model.nodeId,
            title: String(inspected.canvas.nodeData[model.nodeId]?.title ?? model.nodeId),
            transform: model.data.transform, localBounds: model.localAabb }];
        })
      };
    }
    if (cameraView.sceneModels) {
      for (const model of cameraView.sceneModels) {
        const rig = await animationRigOf(inspected.canvas.nodeData[model.nodeId] as Record<string, unknown>);
        if (rig) model.animationRig = rig;
      }
      const stillIssued = resolve(input.contextId);
      if ("ok" in stillIssued) return stillIssued;
    }
    // Authoritative scripts for chunked authoring: `get_world_model_script` serves
    // `includeSource` from here so a caller can verify the real tail before appending.
    {
      const modelScripts: Record<string, string> = {};
      for (const target of [...context.writableTargets.map(entry => entry.target), ...context.readOnlyReferences]) {
        if (target.kind !== "instance") continue;
        const located = findInstanceNode(inspected.canvas, target.instanceId);
        const script = located ? scriptOfNode(located.fields) : null;
        if (script !== null) modelScripts[target.instanceId] = script;
      }
      if (Object.keys(modelScripts).length > 0) cameraView = { ...cameraView, modelScripts };
    }
    return {
      ok: true,
      view: {
        version: "assistant-world-authority-v1",
        canvasId: ledger.canvasId,
        contextId: context.contextId,
        runId: context.runId,
        epoch: context.epoch,
        scope: context.scope,
        writable: context.writableTargets.map(entry => entry.target),
        readOnly: context.readOnlyReferences,
        objects: [
          ...context.writableTargets.map(entry => ({ identity: entry.target, nodeId: null, version: entry.target.version, containment: "writable" as const })),
          ...context.readOnlyReferences.map(entry => ({ identity: entry, nodeId: null, version: entry.version, containment: "read-only" as const }))
        ],
        ...(bounds ? { bounds } : {}),
        ...(sceneArea ? { sceneArea } : {}),
        ...cameraView,
        worldWritable: context.scope.scope.kind === "scene-area" || context.scope.scope.kind === "world-camera"
      }
    };
  }

  async function write(input: AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome> {
    const resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    const { ledger, context, capability } = resolved;
    const operation = input.operation;
    if (context.scope.scope.kind === "workflow-group-2d") {
      return failure("capability-unsupported", "2D 组成员不授予世界写资格");
    }
    if (context.scope.scope.kind === "world-camera" && (operation.kind !== "set-world-camera" || operation.cameraId !== context.scope.scope.cameraId)) {
      return failure("outside-scope", "本轮只允许调整所选镜头");
    }
    const inspected = await inspect(ledger.canvasId);
    if (!inspected.ok) return inspected;
    if (context.scope.scope.kind === "scene-area") {
      const refreshed = await deps.authority.prepareCanvas(inspected.canvas, {
        kind: "scene-area",
        areaId: context.scope.scope.areaId
      });
      if (!refreshed.ok) return failure(refreshed.code, refreshed.message);
    } else if (context.scope.scope.kind === "world-camera") {
      if (!deps.authority.prepareCamera) return failure("capability-unsupported", "宿主未装配镜头范围权威");
      const refreshed = await deps.authority.prepareCamera(inspected.canvas, context.scope.scope.cameraId);
      if (!refreshed.ok) return failure(refreshed.code, refreshed.message);
      if (operation.kind !== "set-world-camera") return failure("invalid-data", "本轮只允许调整所选镜头");
      const nodeId = findWorldCameraNodeId(inspected.canvas, operation.cameraId);
      const current = decodeWorldCamera(nodeId ? inspected.canvas.nodeData[nodeId]?.worldCamera : null);
      if (!current.ok) return failure("not-found", "镜头不存在");
      const merged = mergeWorldCameraSettings(worldCameraSettingsOf(current.value), operation.settings);
      if (merged.projection.kind !== "perspective") return failure("invalid-data", "镜头调整须使用透视投影");
      if (merged.boundInstanceId !== current.value.boundInstanceId || merged.captureMode.kind !== current.value.captureMode.kind) {
        return failure("outside-scope", "本轮只调整机位、视野和画幅，请保留镜头的拍摄内容与输出方式");
      }
    }
    if (operation.kind === "create-model") {
      return createModel(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "replace-model-content") {
      return replaceContent(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "append-model-script") {
      return appendModelScript(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "patch-model-script") {
      return patchModelScript(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "set-model-transform") {
      return moveModel(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "set-scene-animation-script") {
      return setSceneAnimationScript(ledger, context, operation, inspected);
    }
    if (operation.kind === "resize-scene-area") {
      return resizeSceneArea(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "create-world-camera") {
      return createCamera(ledger, context, capability, operation, inspected);
    }
    return writeCamera(ledger, context, operation, inspected);
  }


  async function setSceneAnimationScript(
    ledger: RunLedger,
    context: WorldToolContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "set-scene-animation-script" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    if (context.scope.scope.kind !== "scene-area") {
      return failure("capability-unsupported", "2D 组没有导演区动画能力");
    }
    const areaId = context.scope.scope.areaId;
    const located = findArea(inspected.canvas, areaId);
    if (!located) return failure("outside-scope", "导演区不存在");
    if(operation.motionAsset && (located.area.animationScript?.revision??0)!==operation.motionBaseRevision)return failure("version-conflict","导演区动画已变化，请重新读取后应用动作");
    // 脚本必须先编译成功，且目标只允许本轮可写的导演区内部部件（实例与镜头）。
    const compiled = executeWorldAnimationScript(operation.script, { duration: operation.duration, loop: operation.loop });
    if (!compiled.ok) return failure("invalid-data", `动画脚本编译失败：${compiled.message}`);
    const writableInstances = new Set(context.writableTargets
      .map((entry) => entry.target)
      .filter((target) => target.kind === "instance")
      .map((target) => target.instanceId));
    const writableCameras = new Set(context.writableTargets
      .map((entry) => entry.target)
      .filter((target) => target.kind === "camera")
      .map((target) => target.cameraId));
    const outsideInstance = compiled.ir.instanceTracks.find((track) => !writableInstances.has(track.targetId));
    if (outsideInstance) return failure("outside-scope", `实例 ${outsideInstance.targetId} 不在本轮可写范围`);
    const outsideCamera = compiled.ir.cameraTracks.find((track) => !writableCameras.has(track.targetId));
    if (outsideCamera) return failure("outside-scope", `镜头 ${outsideCamera.targetId} 不在本轮可写范围`);
    for (const track of compiled.ir.partTracks ?? []) {
      if (!writableInstances.has(track.targetId)) return failure("outside-scope", `实例 ${track.targetId} 不在本轮可写范围`);
      const model = findInstanceNode(inspected.canvas, track.targetId);
      const rig = model ? await animationRigOf(model.fields) : null;
      if (!rig?.groups.some(group => group.id === track.partId)) return failure("invalid-data", `模型 ${track.targetId} 没有可动画部件 ${track.partId}`);
    }
    const validateWalkTargets = async (canvas:ServerCanvas, writable:(id:string)=>boolean) => {
      for(const track of compiled.ir.walkTracks ?? []){
        if(!writable(track.targetId))return {code:"outside-scope" as const,message:"行走模型不在本轮可写范围"};
        const model=findInstanceNode(canvas,track.targetId);
        const rig=model ? await animationRigOf(model.fields) : null;
        const instance=decodeWorldInstanceData(model?.fields.sharedWorldInstance);
        const actual=rig?.walkProfile;
        if(!actual||stableStringify(actual)!==stableStringify(track.profile))return {code:"invalid-data" as const,message:"行走参数与模型实际骨架或脚底几何不匹配；请重新 get_world_model_rig"};
        if(!instance.ok)return {code:"invalid-data" as const,message:"行走模型变换不可用"};
        const transform=instance.value.transform,q=transform.rotation;
        const yaw=2*Math.atan2(q[2],q[3])*180/Math.PI;
        const difference=((track.baseYawDegrees-yaw+180)%360+360)%360-180;
        if(Math.abs(q[0])+Math.abs(q[1])>1e-6||Math.abs(difference)>1e-5||Math.abs(track.scale-transform.scale)>1e-6)
          return {code:"invalid-data" as const,message:"行走只支持直立模型，scale/baseYawDegrees 必须匹配当前基础变换"};
      }
      return null;
    };
    const validateSomaTargets = async (canvas: ServerCanvas, writable: (id:string)=>boolean) => {
      if (operation.motionTarget) {
        const target=operation.motionTarget;
        if(target.canvasRevision!==undefined&&canvas.revision!==target.canvasRevision)return {code:"version-conflict" as const,message:"场景在绕场校验后发生变化，请重新规划"};
        if(target.scopeVersion!==undefined&&findArea(canvas,areaId)?.area.scopeVersion!==target.scopeVersion)return {code:"version-conflict" as const,message:"导演区范围已变化，请重新校验动作路径"};
        if (!writable(target.instanceId)) return {code:"outside-scope" as const,message:"动作模型不在本轮可写范围"};
        if (worldObjectVersion(canvas,{kind:"instance",instanceId:target.instanceId})!==target.expectedVersion) return {code:"version-conflict" as const,message:"动作模型内容或变换已变化，请重新读取版本"};
      }
      if(operation.motionAsset && !(compiled.ir.somaTracks??[]).some(track=>track.assetId===operation.motionAsset!.id)) return {code:"invalid-data" as const,message:"动作资产必须被本次片段引用"};
      const priorAnimation=findArea(canvas,areaId)?.area.animationScript;
      const priorCompiled=priorAnimation?executeWorldAnimationScript(priorAnimation.script,priorAnimation):null;
      for(const track of compiled.ir.somaTracks??[]) {
        if((track.rootMotion==='translate'||track.route)&&operation.motionAsset?.id!==track.assetId){
          const persisted=priorCompiled?.ok&&priorCompiled.ir.somaTracks?.some(previous=>JSON.stringify(previous)===JSON.stringify(track));
          if(!persisted)return {code:"invalid-data" as const,message:"新位移动作必须通过宿主校验稳定 NPZ 路径后应用"};
        }
        if(!writable(track.targetId))return {code:"outside-scope" as const,message:"SOMA模型不在本轮可写范围"};
        const model=findInstanceNode(canvas,track.targetId);
        const rig=model?await animationRigOf(model.fields):null;
        if(!rig||somaSkeletonPrefix(rig.groups,track.jointPrefix)!==track.jointPrefix)return {code:"invalid-data" as const,message:"SOMA片段需要匹配真实77关节绑定骨架"};
        if(track.route&&operation.motionTarget?.instanceId===track.targetId&&operation.motionAsset?.id===track.assetId){
          const instance=decodeWorldInstanceData(model?.fields.sharedWorldInstance),bounds=findArea(canvas,areaId)?.area.bounds,anchor=rig.spatial?.groundAnchorLocal;
          if(!instance.ok||!bounds||!anchor)return {code:"invalid-data" as const,message:"绕场缺少实际模型与范围"};
          const transform=instance.value.transform,route=track.route,area=findArea(canvas,areaId)!.area;
          if(route.referenceFrame&&(stableStringify(route.referenceFrame.origin)!==stableStringify(sceneAreaAnimationOrigin(area))||route.referenceFrame.quarterTurns!==(area.animationQuarterTurns??0)))return {code:"version-conflict" as const,message:"绕场参考坐标已变化"};
          const start=projectSomaRootTranslation(anchor,transform.rotation,transform.scale,transform.position);
          if(Math.abs(route.scale-transform.scale)>1e-6||Math.abs(route.rootHeight-transform.position.h)>1e-6||stableStringify(route.groundAnchorLocal)!==stableStringify(anchor)||stableStringify(route.baseRotation)!==stableStringify(transform.rotation)||Math.hypot(route.startAnchor.u-start.u,route.startAnchor.v-start.v)>1e-5)return {code:"version-conflict" as const,message:"绕场路线与当前模型变换不一致"};
          if([...route.path,route.startAnchor].some(p=>p.u<bounds.min.u||p.u>bounds.max.u||p.v<bounds.min.v||p.v>bounds.max.v))return {code:"outside-scope" as const,message:"绕场路线超出导演区范围"};
        }
        const added=operation.motionAsset?.id===track.assetId?operation.motionAsset:undefined;
        const existing=canvas.assets.find(asset=>asset.id===track.assetId);
        if(added&&existing&&existing.metadata?.checksum!==added.metadata?.checksum)return {code:"invalid-data" as const,message:"动作资产身份冲突"};
        const asset=added??existing,meta=asset?.metadata?.motion;
        if(!asset||asset.mediaKind!=="motion"||asset.status!=="ready"||!asset.metadata?.storageKey||asset.metadata.checksum!==track.checksum||!isSomaMotionMetadata(meta)||meta.fps!==track.fps||meta.frameCount!==track.frameCount)return {code:"invalid-data" as const,message:"SOMA动作资产的身份或采样信息不匹配"};
      }
      return null;
    };
    const somaFailure=await validateSomaTargets(inspected.canvas,id=>writableInstances.has(id));
    if(somaFailure)return failure(somaFailure.code,somaFailure.message);
    const walkFailure=await validateWalkTargets(inspected.canvas,id=>writableInstances.has(id));
    if(walkFailure)return failure(walkFailure.code,walkFailure.message);
    const animationScript = createWorldAnimationScript({
      script: operation.script,
      duration: operation.duration,
      loop: operation.loop,
      ...(located.area.animationScript ? { revision: located.area.animationScript.revision + 1 } : {})
    });
    const commandId = intentCommandId("assistant-world-animation-script", operation);
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        const current = findArea(canvas, areaId);
        if (!current) return { ok: false as const, code: "outside-scope", message: "导演区不存在" };
        const stillIssued = resolve(context.contextId);
        if ("ok" in stillIssued) return { ok: false as const, code: "outside-scope", message: stillIssued.message };
        if(operation.motionAsset && (current.area.animationScript?.revision??0)!==operation.motionBaseRevision)return {ok:false as const,code:"version-conflict" as const,message:"导演区动画已变化，请重新读取后应用动作"};
        const somaFailure=await validateSomaTargets(canvas,id=>!!findWritable(stillIssued.context,{kind:"instance",instanceId:id}));
        if(somaFailure)return {ok:false as const,...somaFailure};
        const walkFailure=await validateWalkTargets(canvas,id=>!!findWritable(stillIssued.context,{kind:"instance",instanceId:id}));
        if(walkFailure)return {ok:false as const,...walkFailure};
        for (const track of compiled.ir.partTracks ?? []) {
          if (!findWritable(stillIssued.context, { kind: "instance", instanceId: track.targetId })) return { ok: false as const, code: "outside-scope", message: "动画部件不在本轮可写范围" };
          const model = findInstanceNode(canvas, track.targetId);
          const rig = model ? await animationRigOf(model.fields) : null;
          if (!rig?.groups.some(group => group.id === track.partId)) return { ok: false as const, code: "invalid-data", message: `模型没有动画部件 ${track.partId}` };
        }
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands: [...(operation.motionAsset ? [{type:"asset.upsert" as const,asset:operation.motionAsset}] : []), {
              type: "nodeData.patch" as const,
              nodeId: current.node.id,
              value: {
                sceneArea: {
                  ...current.area,
                  animationOrigin: sceneAreaAnimationOrigin(current.area),
                  animationScript
                }
              } as unknown as CanvasNodeData
            }]
          }
        };
      }
    });
    if (!result.ok) return commandFailure(result);
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.duplicate === true,
      noop: result.noop === true,
      version: located.area.scopeVersion
    };
  }

  /**
   * Explicit director-area range change. It only patches the area bounds (and the
   * derived scope version); models and cameras are never moved or scaled by this
   * operation. Shrinking may leave objects outside the range, which makes them
   * read-only for later writes — the author asked for that range.
   */
  async function resizeSceneArea(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "resize-scene-area" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    if (context.scope.scope.kind !== "scene-area") {
      return failure("capability-unsupported", "2D 组没有导演区范围能力");
    }
    const areaId = context.scope.scope.areaId;
    const located = findArea(inspected.canvas, areaId);
    if (!located) return failure("outside-scope", "导演区不存在");
    if (located.area.scopeVersion !== operation.expectedScopeVersion) {
      return failure("version-conflict", `导演区范围已变化（当前 ${located.area.scopeVersion}），请使用该版本重试`);
    }
    const bounds = {
      min: { u: operation.bounds.min.u, v: operation.bounds.min.v },
      max: { u: operation.bounds.max.u, v: operation.bounds.max.v }
    };
    const scopeVersion = nextSceneAreaScopeVersion(areaId, bounds);
    const commandId = intentCommandId("assistant-world-resize-area", operation);
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        const current = findArea(canvas, areaId);
        if (!current) return { ok: false as const, code: "outside-scope", message: "导演区不存在" };
        if (current.area.scopeVersion !== operation.expectedScopeVersion) {
          return { ok: false as const, code: "version-conflict", message: "导演区范围已变化" };
        }
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands: [{
              type: "nodeData.patch" as const,
              nodeId: current.node.id,
              value: {
                sceneArea: {
                  ...current.area,
                  bounds,
                  scopeVersion,
                  animationOrigin: sceneAreaAnimationOrigin(current.area)
                }
              } as unknown as CanvasNodeData
            }]
          }
        };
      }
    }, { spatialContext: capability });
    if (!result.ok) return commandFailure(result);
    // The run's context and durable lease advanced to the new scope version inside
    // the commit; mirror it in-process so later writes in this run keep working.
    deps.worldAuthoring.refreshContextScope({
      canvasId: ledger.canvasId,
      contextId: ledger.contextId,
      scope: { scope: { kind: "scene-area", areaId }, scopeVersion }
    });
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.duplicate === true,
      noop: result.noop === true,
      version: scopeVersion
    };
  }

  async function createModel(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "create-model" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const instanceId = operation.instanceId ?? `instance-${stableAuthorityVersion("assistant-model", {
      nodeId: operation.nodeId,
      operationId: operation.operationId
    })}`;
    if (hasNode(inspected.canvas, operation.nodeId) || findInstanceNode(inspected.canvas, instanceId)) {
      return failure("operation-conflict", `新模型身份已存在（nodeId=${operation.nodeId}, instanceId=${instanceId}）`);
    }
    let definition: Record<string, unknown>;
    const skeleton = operation.content.modelScript === "";
    try {
      definition = skeleton ? skeletonContentFields(operation.content) : contentFields(operation.content);
    } catch (error) {
      return failure("invalid-data", error instanceof Error ? error.message : "模型脚本无效");
    }
    const fields = instanceFields(definition, instanceId, operation.transform);
    // A skeleton has no geometry yet; it still gets its canonical identity in the
    // same commit and is classified read-only/not-ready until chunks arrive.
    const prepared = skeleton ? null : await deps.authority.prepareContent(fields);
    if (!skeleton && !prepared) return failure("invalid-data", "模型脚本无法执行或无法确定占地；请先调用 get_model_api，并使用 woohaa-model-js-v2 的 scene.* API");
    // 卡片落点由 AI 能力中心或画布决定；缺省时用画布原点，随后按非重叠规则修正。
    // 落点由调用方给出；宿主在这里统一成画布坐标，供后续插入节点与回执使用。
    const cardPosition = operation.content.cardPosition ?? { x: 0, y: 0 };
    void cardPosition;
    const commandId = intentCommandId("assistant-world-create", operation);
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        if (hasNode(canvas, operation.nodeId) || findInstanceNode(canvas, instanceId)) {
          return { ok: false as const, code: "operation-conflict", message: `新模型身份已存在（nodeId=${operation.nodeId}, instanceId=${instanceId}）` };
        }
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands: [{
              type: "node.add" as const,
              node: { id: operation.nodeId, type: "model3d" },
              nodeData: fields as unknown as CanvasNodeData
            }]
          }
        };
      }
    }, { spatialContext: capability });
    if (!result.ok) return commandFailure(result);
    const identity: WorldObjectIdentity = { kind: "instance", instanceId };
    const after = await inspected.room.inspectPublished(value => value);
    const version = after.ok ? worldObjectVersion(after.canvas, identity) : null;
    if (version) {
      ledger.writes.set(objectKey(identity), { identity, version });
      deps.worldAuthoring.refreshContextVersions({ canvasId: ledger.canvasId, contextId: ledger.contextId, targets: [{ ...identity, version }] });
    }
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      instanceId,
      nodeId: operation.nodeId,
      ...(version ? { version } : {})
    };
  }

  async function replaceContent(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "replace-model-content" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const identity: WorldObjectIdentity = { kind: "instance", instanceId: operation.instanceId };
    const granted = findWritable(context, identity);
    if (!granted) return failure("outside-scope", "模型不在本次可写集合");
    const current = findInstanceNode(inspected.canvas, operation.instanceId);
    if (!current) return failure("not-found", "模型不存在");
    if (worldObjectVersion(inspected.canvas, identity) !== operation.expectedVersion) {
      return failure("version-conflict", "模型版本已变化");
    }
    let definition: Record<string, unknown>;
    try {
      definition = contentFields(operation.content, current.fields.modelRig);
    } catch (error) {
      return failure("invalid-data", error instanceof Error ? error.message : "模型脚本无效");
    }
    const previous = current.fields.modelContentVersion as { revision?: number; contentHash?: string } | undefined;
    const nextDefinition = normalizeModelDefinition({
      modelScript: operation.content.modelScript,
      modelScriptLanguage: definition.modelScriptLanguage as string,
      modelScriptVersion: operation.content.modelScriptVersion ?? "woohaa-model-js-v2",
      placement: current.fields.modelPlacement ?? DEFAULT_MODEL_PLACEMENT,
      rig: definition.modelRig,
      previous: previous && typeof previous.revision === "number" && typeof previous.contentHash === "string"
        ? { revision: previous.revision, sourceHash: String((previous as { sourceHash?: string }).sourceHash ?? ""), contentHash: previous.contentHash }
        : null
    });
    if (!nextDefinition.ok) return failure("invalid-data", nextDefinition.reason);
    const patch: Record<string, unknown> = {
      modelScript: nextDefinition.value.modelScript,
      modelScriptLanguage: nextDefinition.value.modelScriptLanguage,
      modelScriptVersion: nextDefinition.value.modelScriptVersion,
      modelContentVersion: nextDefinition.value.contentVersion,
      modelPlacement: nextDefinition.value.placement,
      ...(nextDefinition.value.rig ? { modelRig: nextDefinition.value.rig } : {})
    };
    const decodedCurrent = decodeWorldInstanceData(current.fields.sharedWorldInstance);
    if (!decodedCurrent.ok) return failure("not-ready", "模型共享世界身份无效");
    const fields = instanceFields(patch, operation.instanceId, operation.transform ?? decodedCurrent.value.transform);
    const prepared = await deps.authority.prepareContent({ ...current.fields, ...fields });
    if (!prepared) return failure("not-ready", "无法确定替换后模型的权威占地");
    const commandId = intentCommandId("assistant-world-replace", operation);
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        const node = findInstanceNode(canvas, operation.instanceId);
        if (!node) return { ok: false as const, code: "not-found", message: "模型不存在" };
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands: [{ type: "nodeData.patch" as const, nodeId: node.nodeId, value: fields as unknown as CanvasNodeData }]
          }
        };
      }
    }, { spatialContext: capability });
    if (!result.ok) return commandFailure(result);
    const after = await inspected.room.inspectPublished(value => value);
    const version = after.ok ? worldObjectVersion(after.canvas, identity) : null;
    if (version) {
      ledger.writes.set(objectKey(identity), { identity, version });
      deps.worldAuthoring.refreshContextVersions({ canvasId: ledger.canvasId, contextId: ledger.contextId, targets: [{ ...identity, version }] });
    }
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      instanceId: operation.instanceId,
      nodeId: current.nodeId,
      ...(version ? { version } : {})
    };
  }

  /** Current authoritative version for a version-conflict receipt, when readable. */
  function versionConflict(current: string | null): AssistantWorldFailure {
    return failure("version-conflict", current
      ? `模型内容版本已变化（当前 ${current}），请使用该版本重试，不要复用旧版本`
      : "模型内容版本已变化；请重新 get_world_model_script 取真实版本后重试",
    current ? { currentVersion: current } : {});
  }

  /**
   * Compose the post-state content fields of a chunk or patch result.
   *
   * Skeleton → first chunk and chunk → next chunk both need a fresh rig decision
   * (a chunk may introduce `rig.joint`), a fresh content version, an atomic pose
   * and a re-derived footprint. Every failure is reported before the commit, so
   * a rejected chunk never leaves partial content behind.
   */
  async function composeContent(input: {
    previousFields: Record<string, unknown>;
    script: string;
    identity: WorldObjectIdentity;
  }): Promise<{ composed: true; fields: Record<string, unknown> } | AssistantWorldFailure> {
    const previous = input.previousFields.modelContentVersion as { revision?: number; contentHash?: string; sourceHash?: string } | undefined;
    // An empty skeleton contributes no rig, so its first chunk may still introduce one.
    const hadScript = typeof input.previousFields.modelScript === "string" && input.previousFields.modelScript !== "";
    let definition: Record<string, unknown>;
    try {
      definition = contentFields({ modelScript: input.script }, hadScript ? input.previousFields.modelRig : undefined);
    } catch (error) {
      return failure("invalid-data", error instanceof Error ? error.message : "模型脚本无效");
    }
    const nextDefinition = normalizeModelDefinition({
      modelScript: input.script,
      modelScriptLanguage: definition.modelScriptLanguage as string,
      modelScriptVersion: (input.previousFields.modelScriptVersion as string | undefined) ?? "woohaa-model-js-v2",
      placement: input.previousFields.modelPlacement ?? DEFAULT_MODEL_PLACEMENT,
      rig: definition.modelRig,
      previous: previous && typeof previous.revision === "number" && typeof previous.contentHash === "string"
        ? { revision: previous.revision, sourceHash: String(previous.sourceHash ?? ""), contentHash: previous.contentHash }
        : null
    });
    if (!nextDefinition.ok) return failure("invalid-data", nextDefinition.reason);
    const decodedCurrent = decodeWorldInstanceData(input.previousFields.sharedWorldInstance);
    if (!decodedCurrent.ok) return failure("not-ready", "模型共享世界身份无效");
    const fields = instanceFields({
      modelScript: nextDefinition.value.modelScript,
      modelScriptLanguage: nextDefinition.value.modelScriptLanguage,
      modelScriptVersion: nextDefinition.value.modelScriptVersion,
      modelContentVersion: nextDefinition.value.contentVersion,
      modelPlacement: nextDefinition.value.placement,
      ...(nextDefinition.value.rig ? { modelRig: nextDefinition.value.rig } : {})
    }, decodedCurrent.value.instanceId, decodedCurrent.value.transform);
    // The composed script must still compile into a real footprint before it
    // becomes authoritative. A chunk that breaks the tail fails here and the
    // committed content is untouched.
    const prepared = await deps.authority.prepareContent({ ...input.previousFields, ...fields });
    if (!prepared) {
      return failure("invalid-data", "拼接后的完整脚本无法编译或无法确定占地；该段没有写入，已提交内容保持不变。每次追加必须是可在尾部拼接的完整语句块，请拆分或修正该段后重试");
    }
    return { composed: true, fields };
  }

  /**
   * Commit one composed script and report the advanced version.
   *
   * The derive step re-checks inside the authority queue that the run is still
   * issued, the target is still writable and the presented version is still the
   * current one, so a concurrent整段 replacement or a revoke rejects the chunk
   * instead of splicing onto content the caller never saw.
   */
  async function commitComposedScript(input: {
    room: CanvasRoom;
    ledger: RunLedger;
    context: WorldToolContext;
    capability: SpatialWriteContext;
    operation: Extract<AssistantWorldWriteOperation, { kind: "append-model-script" | "patch-model-script" }>;
    tag: string;
    identity: WorldObjectIdentity;
    nodeId: string;
    fields: Record<string, unknown>;
  }): Promise<AssistantWorldWriteOutcome> {
    const { room, ledger, context, operation, identity } = input;
    const commandId = intentCommandId(input.tag, operation);
    const result = await room.submitDerived({
      commandId,
      // Freeze the exact intent with the receipt: a retry carrying the same
      // commandId but a different chunk/patch is a reused identity, not a replay.
      expectedWorldAuthoringHash: stableAuthorityVersion("assistant-world-intent", operation),
      async derive(canvas) {
        const node = findInstanceNode(canvas, operation.instanceId);
        if (!node) return { ok: false as const, code: "not-found", message: "模型不存在" };
        const stillIssued = resolve(context.contextId);
        if ("ok" in stillIssued) return { ok: false as const, code: "outside-scope", message: stillIssued.message };
        if (!findWritable(stillIssued.context, identity)) return { ok: false as const, code: "outside-scope", message: "模型不在本次可写集合" };
        if (worldObjectVersion(canvas, identity) !== operation.expectedVersion) {
          return { ok: false as const, code: "version-conflict", message: "模型内容版本已变化" };
        }
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands: [{ type: "nodeData.patch" as const, nodeId: node.nodeId, value: input.fields as unknown as CanvasNodeData }]
          }
        };
      }
    }, { spatialContext: input.capability });
    if (!result.ok) {
      const rejected = commandFailure(result);
      if (rejected.code === "version-conflict") {
        // Report the real current version so the caller can retry from the
        // content it actually reads next, never from the stale one it sent.
        const after = await room.inspectPublished(value => value);
        return versionConflict(after.ok ? worldObjectVersion(after.canvas, identity) : null);
      }
      return rejected;
    }
    const after = await room.inspectPublished(value => value);
    const version = after.ok ? worldObjectVersion(after.canvas, identity) : null;
    if (version) {
      ledger.writes.set(objectKey(identity), { identity, version });
      deps.worldAuthoring.refreshContextVersions({ canvasId: ledger.canvasId, contextId: ledger.contextId, targets: [{ ...identity, version }] });
    }
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      instanceId: operation.instanceId,
      nodeId: input.nodeId,
      scriptLength: String(input.fields.modelScript ?? "").length,
      ...(version ? { version } : {})
    };
  }

  /** Scope-only pre-check shared by chunk writes: nothing here depends on content versions. */
  function chunkScope(
    context: WorldToolContext,
    canvas: ServerCanvas,
    identity: WorldObjectIdentity
  ): { target: true; node: { nodeId: string; fields: Record<string, unknown> } } | AssistantWorldFailure {
    if (!findWritable(context, identity)) return failure("outside-scope", "模型不在本次可写集合");
    const node = findInstanceNode(canvas, identity.kind === "instance" ? identity.instanceId : "");
    if (!node) return failure("not-found", "模型不存在");
    return { target: true, node };
  }

  /**
   * Resolve a chunk operation against the *frozen receipt* first.
   *
   * A transport retry of an already committed chunk must return the original
   * receipt even though its `expectedVersion` is now stale and the composed
   * content no longer matches — that is what idempotency means. Reusing one
   * operation id for a different chunk is a different identity: refuse it up
   * front so the caller cannot mistake it for an ordinary version conflict.
   */
  async function replayChunk(input: {
    room: CanvasRoom;
    ledger: RunLedger;
    identity: WorldObjectIdentity;
    operation: Extract<AssistantWorldWriteOperation, { kind: "append-model-script" | "patch-model-script" }>;
    commandId: string;
  }): Promise<AssistantWorldWriteOutcome | null> {
    const { room, ledger, identity, operation } = input;
    const intentHash = stableAuthorityVersion("assistant-world-intent", operation);
    const seen = ledger.chunkIntents.get(operation.operationId);
    if (seen !== undefined && seen !== intentHash) {
      return failure("operation-conflict", "相同 operationId 使用了不同意图：同一次请求只能重试完全相同的片段或修补");
    }
    // Remember the identity before attempting anything else, so a later reuse of
    // the same id is caught even when this attempt itself failed.
    ledger.chunkIntents.set(operation.operationId, intentHash);
    if (typeof room.lookupCommand !== "function") return null;
    let receipt: Awaited<ReturnType<CanvasRoom["lookupCommand"]>>;
    try {
      receipt = await room.lookupCommand(input.commandId);
    } catch {
      return null;
    }
    if (!receipt) return null;
    // The chunk of this receipt is already in the canonical content, so the
    // reported length is read from the truth and the version is re-derived.
    const after = await room.inspectPublished(value => value);
    const version = after.ok ? worldObjectVersion(after.canvas, identity) : null;
    if (version) {
      ledger.writes.set(objectKey(identity), { identity, version });
      deps.worldAuthoring.refreshContextVersions({ canvasId: ledger.canvasId, contextId: ledger.contextId, targets: [{ ...identity, version }] });
    }
    const located = after.ok ? findInstanceNode(after.canvas, operation.instanceId) : null;
    const script = located ? scriptOfNode(located.fields) : null;
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId: input.commandId,
      revision: receipt.revision,
      duplicate: true,
      noop: receipt.changed !== true,
      instanceId: operation.instanceId,
      ...(script !== null ? { scriptLength: script.length } : {}),
      ...(operation.kind === "patch-model-script" ? { replaced: 1 } : {}),
      ...(version ? { version } : {})
    };
  }

  async function appendModelScript(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "append-model-script" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const identity: WorldObjectIdentity = { kind: "instance", instanceId: operation.instanceId };
    // 重试优先：已冻结的回执直接返回，不重复拼接（此时 expectedVersion 必然已经过期）。
    const replayed = await replayChunk({
      room: inspected.room,
      ledger,
      identity,
      operation,
      commandId: intentCommandId("assistant-world-append", operation)
    });
    if (replayed) return replayed;
    const target = chunkScope(context, inspected.canvas, identity);
    if (!("target" in target)) return target;
    const current = worldObjectVersion(inspected.canvas, identity);
    if (current !== operation.expectedVersion) return versionConflict(current);
    const script = scriptOfNode(target.node.fields);
    if (script === null) return failure("not-ready", "模型没有可编辑的脚本内容");
    const composed = await composeContent({
      previousFields: target.node.fields,
      script: appendWorldModelChunk(script, operation.chunk),
      identity
    });
    if (!("composed" in composed)) return composed;
    return commitComposedScript({
      room: inspected.room,
      ledger,
      context,
      capability,
      operation,
      tag: "assistant-world-append",
      identity,
      nodeId: target.node.nodeId,
      fields: composed.fields
    });
  }

  async function patchModelScript(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "patch-model-script" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const identity: WorldObjectIdentity = { kind: "instance", instanceId: operation.instanceId };
    const replayed = await replayChunk({
      room: inspected.room,
      ledger,
      identity,
      operation,
      commandId: intentCommandId("assistant-world-patch", operation)
    });
    if (replayed) return replayed;
    const target = chunkScope(context, inspected.canvas, identity);
    if (!("target" in target)) return target;
    const current = worldObjectVersion(inspected.canvas, identity);
    if (current !== operation.expectedVersion) return versionConflict(current);
    const script = scriptOfNode(target.node.fields);
    if (script === null) return failure("not-ready", "模型没有可编辑的脚本内容");
    const planned = planWorldModelScriptPatch(script, operation.oldString, operation.newString);
    if (!planned.ok) {
      const message = planned.code === "patch-noop"
        ? "oldString 与 newString 相同，内容与版本都没有变化"
        : planned.code === "patch-not-found"
          ? "oldString 未在模型脚本中命中；回执给出了最近相似片段与脚本长度，请带上更长的上下文后重试"
          : `oldString 命中了 ${planned.diagnostic.occurrences} 处，无法确定要修补哪一处；请带上更长的上下文使其唯一`;
      return failure(planned.code, message, { patchDiagnostic: planned.diagnostic });
    }
    const composed = await composeContent({ previousFields: target.node.fields, script: planned.script, identity });
    if (!("composed" in composed)) return composed;
    const outcome = await commitComposedScript({
      room: inspected.room,
      ledger,
      context,
      capability,
      operation,
      tag: "assistant-world-patch",
      identity,
      nodeId: target.node.nodeId,
      fields: composed.fields
    });
    return outcome.ok ? { ...outcome, replaced: planned.replaced } : outcome;
  }

  async function moveModel(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "set-model-transform" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const identity: WorldObjectIdentity = { kind: "instance", instanceId: operation.instanceId };
    const granted = findWritable(context, identity);
    if (!granted) return failure("outside-scope", "模型不在本次可写集合");
    const current = findInstanceNode(inspected.canvas, operation.instanceId);
    if (!current) return failure("not-found", "模型不存在");
    if (worldObjectVersion(inspected.canvas, identity) !== operation.expectedVersion) {
      return failure("version-conflict", "模型版本已变化");
    }
    const decoded = decodeWorldInstanceData(current.fields.sharedWorldInstance);
    if (!decoded.ok) return failure("not-ready", "模型共享世界身份无效");
    const currentInstance = current.fields.sharedWorldInstance as Record<string, unknown>;
    const fields = { sharedWorldInstance: { ...currentInstance, transform: operation.transform } };
    const prepared = await deps.authority.prepareContent({ ...current.fields, ...fields }, inspected.canvas);
    if (!prepared) return failure("not-ready", `模型 ${operation.instanceId} 移动后的权威占地未知，请等待模型资源就绪后重试`);
    const commandId = intentCommandId("assistant-world-move", operation);
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        const node = findInstanceNode(canvas, operation.instanceId);
        if (!node) return { ok: false as const, code: "not-found", message: "模型不存在" };
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands: [{ type: "nodeData.patch" as const, nodeId: node.nodeId, value: fields as unknown as CanvasNodeData }]
          }
        };
      }
    }, { spatialContext: capability });
    if (!result.ok) {
      const rejected = commandFailure(result);
      if (rejected.code === "outside-scope" && context.scope.scope.kind === "scene-area") {
        const areaId = context.scope.scope.areaId;
        const area = findArea(inspected.canvas, areaId)?.area;
        const actual = instanceFootprint(prepared.localAabb, operation.transform);
        const axes = area ? outsideGroundAxes(actual, area.bounds) : [];
        if (area && axes.length > 0) {
          // Keep the authority's own geometry when it reported some; otherwise the
          // footprint just classified here is the actionable diagnostic.
          const diagnostic = spatialDiagnostic(result, { actual, bounds: area.bounds, outsideAxes: axes });
          return {
            ...rejected,
            spatialDiagnostic: diagnostic,
            message: `模型 ${operation.instanceId} 移动后占地 u=[${actual.min.u}, ${actual.max.u}]，v=[${actual.min.v}, ${actual.max.v}] 超出导演区 ${areaId}：u=[${area.bounds.min.u}, ${area.bounds.max.u}]，v=[${area.bounds.min.v}, ${area.bounds.max.v}]。请调整位置，或先手动调整范围后重新授权`
          };
        }
      }
      return rejected;
    }
    const after = await inspected.room.inspectPublished(value => value);
    const version = after.ok ? worldObjectVersion(after.canvas, identity) : null;
    if (version) {
      ledger.writes.set(objectKey(identity), { identity, version });
      deps.worldAuthoring.refreshContextVersions({ canvasId: ledger.canvasId, contextId: ledger.contextId, targets: [{ ...identity, version }] });
    }
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      instanceId: operation.instanceId,
      nodeId: current.nodeId,
      ...(version ? { version } : {})
    };
  }

  function adoptIntentIntoLedger(
    ledger: RunLedger,
    intent: AssistantWorldWriteIntent,
    result: { revision: number; duplicate: boolean; noop: boolean }
  ): AssistantWorldWriteOutcome {
    const identity: WorldObjectIdentity = { kind: "camera", cameraId: intent.cameraId };
    ledger.writes.set(objectKey(identity), {
      identity,
      version: intent.settingsVersion,
      snapshot: intent.snapshot
    });
    deps.worldAuthoring.refreshContextVersions({
      canvasId: ledger.canvasId,
      contextId: ledger.contextId,
      targets: [{ ...identity, version: intent.settingsVersion }]
    });
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId: intent.commandId,
      revision: result.revision,
      duplicate: result.duplicate,
      noop: result.noop,
      cameraId: intent.cameraId,
      settingsVersion: intent.settingsVersion,
      version: intent.settingsVersion,
      view: worldCameraView(intent.snapshot)
    };
  }

  async function createCamera(
    ledger: RunLedger,
    context: WorldToolContext,
    capability: SpatialWriteContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "create-world-camera" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    if (context.scope.scope.kind !== "scene-area") {
      return failure("capability-unsupported", "2D 组没有创建镜头能力");
    }
    const areaId = context.scope.scope.areaId;
    const area = (() => {
      for (const node of inspected.canvas.document.nodes) {
        if (node.type !== "scene-area") continue;
        const decoded = decodeSceneAreaData(inspected.canvas.nodeData[node.id]?.sceneArea);
        if (decoded.ok && decoded.value.areaId === areaId) return { node, area: decoded.value };
      }
      return null;
    })();
    if (!area) return failure("outside-scope", "导演区不存在");
    if (hasNode(inspected.canvas, operation.nodeId) || findWorldCameraNodeId(inspected.canvas, operation.cameraId)) {
      return failure("operation-conflict", `新镜头身份已存在（nodeId=${operation.nodeId}, cameraId=${operation.cameraId}）`);
    }
    const planned = planWorldCameraSettings(operation.cameraId, operation.settings);
    if ("ok" in planned) return failure(planned.code === "not-ready" ? "not-ready" : "invalid-data", planned.message);
    // Creating a camera cannot silently enlarge the user's issued scope.
    const bounds = area.area.bounds;
    const inside = planned.position.u >= bounds.min.u && planned.position.u <= bounds.max.u
      && planned.position.v >= bounds.min.v && planned.position.v <= bounds.max.v;
    if (!inside) {
      const axes: Array<"u" | "v"> = [];
      if (planned.position.u < bounds.min.u || planned.position.u > bounds.max.u) axes.push("u");
      if (planned.position.v < bounds.min.v || planned.position.v > bounds.max.v) axes.push("v");
      const anchor = { u: planned.position.u, v: planned.position.v };
      return failure("outside-scope", `镜头 ${operation.cameraId} 定位点 (u=${planned.position.u}, v=${planned.position.v}) 超出导演区 ${areaId}：u=[${bounds.min.u}, ${bounds.max.u}]，v=[${bounds.min.v}, ${bounds.max.v}]。请调整机位，或先手动调整导演区范围后重新授权`, {
        spatialDiagnostic: { anchor, actual: { min: anchor, max: anchor }, bounds, outsideAxes: axes }
      });
    }
    const commandId = intentCommandId("assistant-world-create-camera", operation);
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        if (hasNode(canvas, operation.nodeId) || findWorldCameraNodeId(canvas, operation.cameraId)) {
          return { ok: false as const, code: "operation-conflict", message: `新镜头身份已存在（nodeId=${operation.nodeId}, cameraId=${operation.cameraId}）` };
        }
        const commands: unknown[] = [];
        commands.push({
          type: "node.add",
          node: {
            id: operation.nodeId,
            type: "world-camera",
            position: operation.cardPosition ?? findNonOverlappingNodePosition(
              initialCameraCardPosition(planned),
              WORLD_CAMERA_CARD_SIZE,
              canvas.document.nodes
            ),
            width: WORLD_CAMERA_CARD_SIZE.width,
            height: WORLD_CAMERA_CARD_SIZE.height
          },
          nodeData: { worldCamera: planned } as unknown as CanvasNodeData
        });
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: ledger.canvasId,
            commandId,
            actorId: `assistant-world:${context.runId}`,
            baseRevision: canvas.revision,
            commands
          } as never
        };
      }
    }, { spatialContext: capability });
    if (!result.ok) return commandFailure(result);
    const identity: WorldObjectIdentity = { kind: "camera", cameraId: operation.cameraId };
    const after = await inspected.room.inspectPublished(value => value);
    const version = after.ok ? worldObjectVersion(after.canvas, identity) : null;
    if (version) {
      ledger.writes.set(objectKey(identity), { identity, version });
      deps.worldAuthoring.refreshContextVersions({ canvasId: ledger.canvasId, contextId: ledger.contextId, targets: [{ ...identity, version }] });
    }
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId,
      revision: result.revision,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      cameraId: operation.cameraId,
      nodeId: operation.nodeId,
      settingsVersion: planned.settingsVersion,
      view: worldCameraView(planned),
      ...(version ? { version } : {})
    };
  }

  async function writeCamera(
    ledger: RunLedger,
    context: WorldToolContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "set-world-camera" }>,
    inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const identity: WorldObjectIdentity = { kind: "camera", cameraId: operation.cameraId };
    const granted = findWritable(context, identity);
    if (!granted) return failure("outside-scope", "镜头不在本次可写集合");
    if (granted.version !== operation.expectedSettingsVersion) {
      return failure("version-conflict", `镜头配置已变化（当前 ${granted.version}），请使用该版本重试`);
    }
    const nodeId = findWorldCameraNodeId(inspected.canvas, operation.cameraId);
    if (!nodeId) {
      // No canonical camera node to bind a durable payload hash to. The
      // authoritative save remains the only judge (it reports not-found for a
      // real missing camera); embedded/test stores may still return a result.
      let direct: Awaited<ReturnType<typeof deps.cameraSettings.save>>;
      try {
        direct = await deps.cameraSettings.save({
          canvasId: ledger.canvasId,
          cameraId: operation.cameraId,
          expectedSettingsVersion: operation.expectedSettingsVersion,
          settings: operation.settings,
          contextId: ledger.contextId,
          actorId: `assistant-world:${context.runId}`,
          operationId: operation.operationId
        });
      } catch (error) {
        return failure("not-ready", error instanceof Error ? error.message : "镜头保存失败");
      }
      if (!direct.ok) return direct;
      try {
        await rememberCommittedWrite({
          canvasId: ledger.canvasId,
          requestId: ledger.requestId,
          runId: ledger.runId,
          epoch: ledger.epoch,
          executionId: ledger.executionId,
          contextId: ledger.contextId,
          completionId: ledger.completionId,
          cameraId: operation.cameraId,
          settingsVersion: direct.settingsVersion,
          snapshot: direct.camera
        });
      } catch (error) {
        return failure("not-ready", error instanceof Error ? error.message : "世界写入事实保存失败");
      }
      ledger.writes.set(objectKey(identity), {
        identity,
        version: direct.settingsVersion,
        snapshot: direct.camera
      });
      deps.worldAuthoring.refreshContextVersions({
        canvasId: ledger.canvasId,
        contextId: ledger.contextId,
        targets: [{ ...identity, version: direct.settingsVersion }]
      });
      return {
        ok: true,
        canvasId: ledger.canvasId,
        commandId: direct.commandId,
        revision: direct.revision,
        duplicate: direct.duplicate,
        noop: false,
        cameraId: operation.cameraId,
        settingsVersion: direct.settingsVersion,
        version: direct.settingsVersion,
        view: worldCameraView(direct.camera)
      };
    }
    const currentCamera = decodeWorldCamera(inspected.canvas.nodeData[nodeId]?.worldCamera);
    if (!currentCamera.ok) return failure("not-found", "镜头不存在");
    const settings = mergeWorldCameraSettings(worldCameraSettingsOf(currentCamera.value), operation.settings);
    const planned = planWorldCameraSettings(operation.cameraId, settings);
    if ("ok" in planned) return failure(planned.code === "not-ready" ? "not-ready" : "invalid-data", planned.message);
    const intentHash = stableAuthorityVersion("assistant-world-camera-intent", {
      expectedSettingsVersion: operation.expectedSettingsVersion,
      settings
    });
    // Exact command identity and frozen payload. camera-service derives the
    // same commandId from the operation id + intent hash and is given the same
    // expected hash, so the durable receipt can only resolve this payload.
    const commandId = `world-camera-save:${operation.operationId}:${intentHash}`;
    const payloadHash = await computeCommandPayloadHash({
      canvasId: ledger.canvasId,
      commands: [{
        type: "nodeData.patch",
        nodeId,
        value: { worldCamera: planned } as unknown as CanvasNodeData
      }]
    });
    const intent: AssistantWorldWriteIntent = {
      canvasId: ledger.canvasId,
      requestId: ledger.requestId,
      runId: ledger.runId,
      epoch: ledger.epoch,
      executionId: ledger.executionId,
      contextId: ledger.contextId,
      completionId: ledger.completionId,
      cameraId: operation.cameraId,
      commandId,
      expectedSettingsVersion: operation.expectedSettingsVersion,
      nodeId,
      settingsVersion: planned.settingsVersion,
      snapshot: planned,
      payloadHash
    };
    try {
      // Durable intent *before* the canonical commit. A crash after the commit
      // but before the independent outbox insert leaves this row; recovery can
      // then resolve the original command receipt instead of losing history.
      await persistWriteIntent(intent);
    } catch (error) {
      return failure("not-ready", error instanceof Error ? error.message : "世界写入意图保存失败");
    }

    // Same-intent retry: the previous attempt may have committed canonically
    // while the outbox insert failed (or the process died). Resolve the real
    // receipt first; only then adopt it. This avoids a false version-conflict
    // from expectedSettingsVersion having already advanced.
    const existing = await resolveWriteIntent(intent);
    if (existing.status === "unknown") return existing.failure;
    if (existing.status === "committed") {
      const adopted = await adoptVerifiedIntent(intent);
      if (!adopted.ok) return adopted;
      return adoptIntentIntoLedger(ledger, intent, {
        revision: existing.revision,
        duplicate: true,
        noop: !existing.changed
      });
    }

    let saved: Awaited<ReturnType<typeof deps.cameraSettings.save>>;
    try {
      saved = await deps.cameraSettings.save({
        canvasId: ledger.canvasId,
        cameraId: operation.cameraId,
        expectedSettingsVersion: operation.expectedSettingsVersion,
        settings,
        contextId: ledger.contextId,
        actorId: `assistant-world:${context.runId}`,
        operationId: `${operation.operationId}:${intentHash}`,
        expectedPayloadHash: payloadHash
      });
    } catch (error) {
      // The commit may still have happened before an exception crossed the
      // service boundary; never assume failure without checking the receipt.
      const resolved = await resolveWriteIntent(intent);
      if (resolved.status === "committed") {
        const adopted = await adoptVerifiedIntent(intent);
        if (!adopted.ok) return adopted;
        return adoptIntentIntoLedger(ledger, intent, {
          revision: resolved.revision,
          duplicate: true,
          noop: !resolved.changed
        });
      }
      if (resolved.status === "uncommitted") {
        try {
          await deleteWriteIntent(intent.commandId);
        } catch {
          // The next recovery re-checks the same absent receipt.
        }
      }
      return resolved.status === "unknown"
        ? resolved.failure
        : failure("not-ready", error instanceof Error ? error.message : "镜头保存失败");
    }
    if (!saved.ok) {
      const resolved = await resolveWriteIntent(intent);
      if (resolved.status === "committed") {
        const adopted = await adoptVerifiedIntent(intent);
        if (!adopted.ok) return adopted;
        return adoptIntentIntoLedger(ledger, intent, {
          revision: resolved.revision,
          duplicate: true,
          noop: !resolved.changed
        });
      }
      if (resolved.status === "uncommitted") {
        try {
          await deleteWriteIntent(intent.commandId);
        } catch {
          // The next recovery re-checks the same absent receipt.
        }
        return saved;
      }
      return resolved.failure;
    }
    // The canonical save returned success. Prefer the planned snapshot when it
    // matches the canonical result; otherwise the save result is authoritative
    // (an embedded/test store has no receipt to cross-check). A later
    // concurrent edit can only have happened after this commit, so it must
    // never replace the write this run actually made.
    const matchesPlan = saved.camera.cameraId === planned.cameraId
      && saved.settingsVersion === planned.settingsVersion;
    let committedIntent: AssistantWorldWriteIntent = intent;
    if (!matchesPlan) {
      const verified = await resolveWriteIntent(intent);
      if (verified.status !== "committed") {
        committedIntent = { ...intent, settingsVersion: saved.settingsVersion, snapshot: saved.camera };
      }
    }
    const adopted = await adoptVerifiedIntent(committedIntent);
    if (!adopted.ok) return adopted;
    return adoptIntentIntoLedger(ledger, committedIntent, {
      revision: saved.revision,
      duplicate: saved.duplicate,
      noop: false
    });
  }

  async function verifyCompletion(
    completion: AssistantWorldCompletionInput["completion"],
    _evidence: unknown
  ): Promise<WorldCameraCompletionVerification> {
    // Completion is trusted only after the host recorded the durable terminal
    // turn fact plus the exact camera/version this run wrote. A model reply,
    // transport boolean, capture refresh or later generation never inserts it.
    const recorded = recordedCompletions.get(hostCompletionKey(completion));
    if (recorded) {
      if (recorded.settingsVersion !== completion.settingsVersion || recorded.cameraId !== completion.cameraId) return false;
      // The frozen settings travel with the trusted fact so the history row can
      // still be written after a later edit, delete or restart.
      return recorded.snapshot ? { snapshot: recorded.snapshot } : true;
    }
    const host = await loadHostCompletion(completion);
    if (!host) return false;
    if (host.settingsVersion !== completion.settingsVersion || host.cameraId !== completion.cameraId) return false;
    const ledger = [...ledgers.values()].find(entry => entry.runId === completion.runId && entry.canvasId === completion.canvasId);
    if (ledger) {
      if (ledger.completionId !== completion.completionId) return false;
      const identity: WorldObjectIdentity = { kind: "camera", cameraId: completion.cameraId };
      const write = ledger.writes.get(objectKey(identity));
      if (!write) return false;
      if (!sameIdentity(write.identity, identity) || write.version !== completion.settingsVersion) return false;
      const snapshot = host.snapshot ?? write.snapshot;
      return snapshot ? { snapshot } : true;
    }
    // Reopened process: the durable host fact itself carries the exact issued
    // identities (its key includes canvas/run/completion/camera), the
    // settingsVersion and the frozen camera settings this run committed.
    if (host.canvasId !== completion.canvasId
      || host.runId !== completion.runId
      || host.completionId !== completion.completionId) return false;
    return host.snapshot ? { snapshot: host.snapshot } : true;
  }

  async function complete(input: AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome> {
    if (!input || !input.completion || !nonEmpty(input.contextId)) {
      return failure("invalid-data", "镜头完成身份无效");
    }
    // Retried completion of an already host-recorded run stays idempotent even
    // after the process marked the run settled.
    const recorded = recordedCompletions.get(hostCompletionKey(input.completion));
    if (recorded) {
      if (recorded.settingsVersion !== input.completion.settingsVersion) {
        return failure("operation-conflict", "相同完成身份携带了不同镜头版本");
      }
      return {
        ok: true,
        duplicate: true,
        settingsVersion: recorded.settingsVersion,
        completionId: recorded.completionId
      };
    }
    // A durable host fact without a history row is the recoverable case: the
    // lease may already be released and the in-process ledger gone, yet the
    // exact host-confirmed completion must still be recorded.
    const pending = await loadHostCompletion(input.completion);
    if (pending) {
      if (pending.settingsVersion !== input.completion.settingsVersion || pending.cameraId !== input.completion.cameraId) {
        return failure("operation-conflict", "相同完成身份携带了不同镜头版本");
      }
      const written = await writeHostCompletion(pending, input.evidence);
      if (!written.ok) return written;
      return {
        ok: true,
        duplicate: false,
        settingsVersion: pending.settingsVersion,
        completionId: pending.completionId
      };
    }
    // After a reopen the in-process ledger is gone, but a durable T08 row is
    // itself proof that the host already accepted this exact completion. The
    // host adapter checks every identity field before answering true.
    if (deps.findRecordedCompletion) {
      try {
        if (await deps.findRecordedCompletion(input.completion)) {
          return {
            ok: true,
            duplicate: true,
            settingsVersion: input.completion.settingsVersion,
            completionId: input.completion.completionId
          };
        }
      } catch {
        // Unknown history state stays fail-closed.
      }
    }
    const resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    const { ledger, context } = resolved;
    if (input.completion.canvasId !== ledger.canvasId || input.completion.runId !== ledger.runId) {
      return failure("unverified-run", "完成身份不属于本次运行");
    }
    if (input.completion.completionId !== ledger.completionId) return failure("unverified-run", "完成身份不是宿主签发");
    const camera = context.writableTargets.find(entry => entry.target.kind === "camera" && entry.target.cameraId === input.completion.cameraId);
    if (!camera) return failure("outside-scope", "镜头不在本次可写集合");
    if (!(await verifyCompletion(input.completion, input.evidence))) return failure("unverified-run", "宿主尚未确认本轮完成");
    const completed = await deps.cameraSettings.complete({ completion: input.completion, evidence: input.evidence });
    if (!completed.ok) return completed;
    return {
      ok: true,
      duplicate: completed.duplicate,
      settingsVersion: completed.entry.settingsVersion,
      completionId: completed.entry.completionId
    };
  }

  function stopFailure(error: unknown): AssistantWorldFailure {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "unverified-stop") return failure("unverified-stop", "停止证据未通过宿主核对");
    if (code === "stale-epoch") return failure("stale-epoch", "停止身份与原运行不一致");
    if (code === "cancelled") return failure("cancelled", "运行已取消但无法确认停止");
    return failure("cancelled", error instanceof Error ? error.message : "确认停止失败");
  }

  /**
   * Record the single trusted completion fact for a successful terminal turn.
   * The camera/version comes from the writes this run actually committed; the
   * host turn status comes from the durable application ledger, never from the
   * model or a browser request.
   */
  async function recordHostCompletion(
    ledger: RunLedger,
    status: "succeeded" | "partial",
    evidence: unknown
  ): Promise<{ ok: true } | AssistantWorldFailure> {
    const cameraWrites = [...ledger.writes.values()].filter(
      (entry): entry is { identity: Extract<WorldObjectIdentity, { kind: "camera" }>; version: string; snapshot?: WorldCameraData } =>
        entry.identity.kind === "camera"
    );
    if (cameraWrites.length === 0) return { ok: true };
    let firstFailure: AssistantWorldFailure | null = null;
    for (const cameraWrite of cameraWrites) {
      const fact: HostCompletion = {
        canvasId: ledger.canvasId,
        requestId: ledger.requestId,
        runId: ledger.runId,
        completionId: ledger.completionId,
        cameraId: cameraWrite.identity.cameraId,
        settingsVersion: cameraWrite.version,
        status,
        ...(cameraWrite.snapshot ? { snapshot: cameraWrite.snapshot } : {})
      };
      const key = hostCompletionKey(fact);
      if (recordedCompletions.has(key)) continue;
      try {
        // Persist the trusted fact before the history write: a failure below
        // must leave recoverable evidence, not a settled run with no history.
        await rememberHostCompletion(fact);
        try {
          await deps.hostCompletions?.deleteCommitted?.({
            canvasId: fact.canvasId,
            runId: fact.runId,
            completionId: fact.completionId,
            cameraId: fact.cameraId
          });
        } catch {
          // The durable fact already covers this write; a lingering outbox row
          // is idempotent to promote again.
        }
      } catch (error) {
        // The fact is still cached in-process; a second settle in this process
        // can retry, but missing durable evidence is reported as a failure.
        firstFailure ??= failure("not-ready", error instanceof Error ? error.message : "助手完成事实保存失败");
      }
      const written = await writeHostCompletion(fact, evidence);
      if (!written.ok) firstFailure ??= written;
    }
    return firstFailure ?? { ok: true };
  }

  async function cancel(input: AssistantWorldCancelInput): Promise<void> {
    const ledger = ledgers.get(input.contextId);
    if (!ledger || ledger.canvasId !== input.canvasId) return;
    if (!ledger.settled) ledger.cancelled = true;
    // Grant first, then stop: the context resolution necessarily fails immediately,
    // while the lease store keeps occupancy until exact stop is confirmed.
    await deps.worldAuthoring.revokeContext({ canvasId: input.canvasId, contextId: input.contextId });
  }

  async function confirmStopped(input: AssistantWorldStopInput): Promise<{ ok: true } | AssistantWorldFailure> {
    const ledger = ledgers.get(input.contextId);
    if (!ledger || ledger.canvasId !== input.canvasId) return failure("not-issued", "工具运行不是宿主签发的");
    if (ledger.runId !== input.runId || ledger.epoch !== input.epoch || ledger.executionId !== input.executionId) {
      return failure("stale-epoch", "停止身份与原运行不一致");
    }
    if (ledger.settled) return { ok: true };
    try {
      await deps.confirmStopped({ ...input, requestId: ledger.requestId });
      ledger.settled = true;
      return { ok: true };
    } catch (error) {
      return stopFailure(error);
    }
  }

  async function settleRun(input: {
    canvasId: string;
    runId: string;
    status?: "queued" | "running" | "committing" | "succeeded" | "partial" | "failed" | "cancelled";
    evidence: unknown;
  }): Promise<{ ok: true } | AssistantWorldFailure> {
    const ledger = [...ledgers.values()].find(entry => entry.canvasId === input.canvasId && entry.runId === input.runId);
    if (ledger) {
      let completionFailure: AssistantWorldFailure | null = null;
      // Verify the exact stop before promoting anything: an unverified host
      // execution must leave occupancy, the outbox and history untouched.
      if (!ledger.settled) {
        const stopped = await confirmStopped({
          canvasId: ledger.canvasId,
          contextId: ledger.contextId,
          runId: ledger.runId,
          epoch: ledger.epoch,
          executionId: ledger.executionId,
          evidence: input.evidence
        });
        if (!stopped.ok) return stopped;
      }
      if (input.status === "succeeded" || input.status === "partial") {
        // Resolve intents left by a commit that outlived the outbox insert (or
        // the previous process) against their original command receipts before
        // promoting anything for this run.
        const reconciled = await reconcileRunIntents({ canvasId: input.canvasId, runId: input.runId });
        if (!reconciled.ok) completionFailure ??= reconciled;
        // Always retry outstanding host facts, including after the run was
        // already settled. A settled run must still be able to补记 a failed
        // history write without re-running the assistant.
        const completed = await recordHostCompletion(ledger, input.status, input.evidence);
        if (!completed.ok) completionFailure = completed;
        // A ledger reissued after a restart has no in-memory writes. Reconcile
        // durable outbox rows left by the previous process for this run before
        // releasing the lease, so a committed camera write is never lost.
        let committed: AssistantWorldCommittedWrite[] = [];
        try {
          committed = await listCommittedWrites({ canvasId: input.canvasId, runId: input.runId });
        } catch (error) {
          completionFailure ??= failure("not-ready", error instanceof Error ? error.message : "无法读取待核对的世界写入");
        }
        for (const write of committed) {
          if (write.canvasId !== input.canvasId || write.runId !== input.runId) continue;
          const promoted = await promoteCommittedWrite(write, input.status, input.evidence);
          if (!promoted.ok) completionFailure ??= promoted;
        }
      }
      if (input.status === "failed" || input.status === "cancelled") {
        await discardCommittedWrites({ canvasId: ledger.canvasId, runId: ledger.runId });
        await discardWriteIntents({ canvasId: ledger.canvasId, runId: ledger.runId });
      }
      return completionFailure ?? { ok: true };
    }
    // Reopened process: the in-process ledger is gone, but the durable outbox
    // carries every camera write this run already committed and the durable
    // lease carries the original run identity. Verify the exact stop first (an
    // unverified turn keeps occupancy and the outbox), then promote committed
    // writes to trusted completion facts and retry any facts left by a failed
    // history write.
    let completionFailure: AssistantWorldFailure | null = null;
    const successStatus = input.status === "succeeded" || input.status === "partial" ? input.status : null;
    const pending = await deps.pending();
    const record = pending.find(entry => entry.intent.canvasId === input.canvasId && entry.intent.runId === input.runId);
    if (record) {
      try {
        await deps.confirmStopped({
          canvasId: record.intent.canvasId,
          requestId: record.intent.requestId,
          runId: record.intent.runId,
          epoch: record.intent.epoch,
          executionId: record.intent.executionId,
          evidence: input.evidence
        });
      } catch (error) {
        return stopFailure(error);
      }
    }
    if (input.status === "failed" || input.status === "cancelled") {
      await discardCommittedWrites({ canvasId: input.canvasId, runId: input.runId });
      await discardWriteIntents({ canvasId: input.canvasId, runId: input.runId });
    }
    if (successStatus) {
      // A previous process may have committed canonically and died before the
      // outbox insert. Resolve the durable intent against the original receipt
      // before listing the outbox; an intent alone never promotes.
      const reconciled = await reconcileRunIntents({ canvasId: input.canvasId, runId: input.runId });
      if (!reconciled.ok) completionFailure ??= reconciled;
      const facts = await listHostCompletions({ canvasId: input.canvasId, runId: input.runId });
      for (const fact of facts) {
        const written = await writeHostCompletion(fact, input.evidence);
        if (!written.ok) completionFailure ??= written;
      }
      let committed: AssistantWorldCommittedWrite[] = [];
      try {
        committed = await listCommittedWrites({ canvasId: input.canvasId, runId: input.runId });
      } catch (error) {
        return failure("not-ready", error instanceof Error ? error.message : "无法读取待核对的世界写入");
      }
      for (const write of committed) {
        if (write.canvasId !== input.canvasId || write.runId !== input.runId) continue;
        const written = await promoteCommittedWrite(write, successStatus, input.evidence);
        if (!written.ok) completionFailure ??= written;
      }
    }
    return completionFailure ?? { ok: true };
  }

  async function resumePendingCompletions(): Promise<{ ok: true; attempted: number; remaining: number } | AssistantWorldFailure> {
    if (!deps.hostCompletions) return { ok: true, attempted: 0, remaining: 0 };
    // Reconcile orphaned pre-commit intents at host start. This only creates
    // outbox rows from verified receipts; it never promotes history without a
    // trusted terminal turn.
    if (deps.hostCompletions.listIntents) {
      let intents: AssistantWorldWriteIntent[];
      try {
        intents = await deps.hostCompletions.listIntents();
      } catch (error) {
        return failure("not-ready", error instanceof Error ? error.message : "无法读取待核对的世界写入意图");
      }
      const runs = new Map<string, { canvasId: string; runId: string }>();
      for (const intent of intents) runs.set(`${intent.canvasId}\u0000${intent.runId}`, { canvasId: intent.canvasId, runId: intent.runId });
      for (const run of runs.values()) {
        const reconciled = await reconcileRunIntents(run);
        if (!reconciled.ok) return reconciled;
      }
    }
    let facts: HostCompletion[];
    try {
      facts = await deps.hostCompletions.list();
    } catch (error) {
      return failure("not-ready", error instanceof Error ? error.message : "无法读取待补记完成事实");
    }
    let firstFailure: AssistantWorldFailure | null = null;
    for (const fact of facts) {
      const written = await writeHostCompletion(fact, { source: "host-startup-resume" });
      if (!written.ok) firstFailure ??= written;
    }
    let remaining = 0;
    try {
      remaining = (await deps.hostCompletions.list()).length;
    } catch {
      remaining = firstFailure ? 1 : 0;
    }
    return firstFailure ?? { ok: true, attempted: facts.length, remaining };
  }

  async function recover(input: { canvasId: string }): Promise<AssistantWorldRecoveryOutcome> {
    if (!nonEmpty(input?.canvasId)) return failure("invalid-data", "画布身份无效");
    const pending = await deps.pending();
    const runs = pending
      .filter(entry => entry.intent.canvasId === input.canvasId)
      .map(runView);
    return { ok: true, runs, capability: null };
  }

  return {
    issue,
    read,
    write,
    complete,
    cancel,
    confirmStopped,
    settleRun,
    resumePendingCompletions,
    recover,
    verifyCompletion,
    close() {
      rigCache.clear();
      ledgers.clear();
      hostCompletions.clear();
      recordedCompletions.clear();
    }
  };
}

export { assistantWorldToolsForScope };
