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
  DEFAULT_MODEL_PLACEMENT,
  SHARED_WORLD_VERSION,
  assistantWorldToolsForScope,
  decodeWorldInstanceData,
  normalizeModelDefinition,
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
  type ServerCanvas,
  type WorldObjectIdentity,
  type WorldObjectVersion,
  type WorldTransform,
  type WorldToolContext
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/room.js";
import type { RoomCommandResult } from "../sync/room-types.js";
import { stableAuthorityVersion, worldObjectVersion, type WorldAuthoringAuthority } from "./authority.js";
import type { WorldCameraSettingsService } from "./camera-service.js";
import type { WorldAuthoringService } from "./scene-area-service.js";
import { objectKey, type LeaseRecord, type SpatialWriteContext } from "./spatial-leases.js";

export type AssistantWorldServiceDeps = {
  authority: Pick<WorldAuthoringAuthority, "prepareContent" | "prepareCanvas">;
  worldAuthoring: Pick<WorldAuthoringService, "issueContext" | "revokeContext" | "resolveCapability" | "refreshContextVersions">;
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
  writes: Map<string, { identity: WorldObjectIdentity; version: string }>;
  cancelled: boolean;
};

export type AssistantWorldService = {
  issue(input: AssistantWorldRunRequest): Promise<AssistantWorldIssueOutcome>;
  /** Read the issued context and its object containment summary without writing. */
  read(input: { canvasId: string; contextId: string }): { ok: true; view: import("@woohaa3/contracts").AssistantWorldContextView } | AssistantWorldFailure;
  write(input: AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
  cancel(input: AssistantWorldCancelInput): Promise<void>;
  confirmStopped(input: AssistantWorldStopInput): Promise<{ ok: true } | AssistantWorldFailure>;
  /**
   * Host turn-settled hook: release the matching run only after the application
   * ledger recorded a terminal status. Evidence carries the owner/request the
   * canvas authority re-checks; an unverified call leaves occupancy in place.
   */
  settleRun(input: { canvasId: string; runId: string; evidence: unknown }): Promise<{ ok: true } | AssistantWorldFailure>;
  recover(input: { canvasId: string }): Promise<AssistantWorldRecoveryOutcome>;
  /** Host-internal camera completion verifier. The canvas composition wires it to T08. */
  verifyCompletion(completion: AssistantWorldCompletionInput["completion"], evidence: unknown): boolean;
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

function commandFailure(result: Extract<RoomCommandResult, { ok: false }>): AssistantWorldFailure {
  switch (result.code) {
    case "spatial-rejected": {
      switch (result.spatialReason) {
        case "version-conflict": return failure("version-conflict", "模型或镜头版本已变化");
        case "lease-conflict": return failure("lease-conflict", "目标正被其他运行占用");
        case "stale-epoch": return failure("stale-epoch", "写能力已失效");
        case "cancelled": return failure("cancelled", "运行已取消");
        case "outside-scope":
        case "version-unknown":
          return failure("outside-scope", result.message, { ...(result.spatialReason ? { spatialReason: result.spatialReason } : {}) });
        default: return failure("invalid-data", result.message, { ...(result.spatialReason ? { spatialReason: result.spatialReason } : {}) });
      }
    }
    case "lease-conflict": return { ...failure("lease-conflict", result.message), ...(result.conflict ? { conflicts: [{ target: result.conflict.target, version: null, runId: result.conflict.runId, epoch: result.conflict.epoch }] } : {}) };
    case "outside-scope": return failure("outside-scope", result.message, { ...(result.spatialReason ? { spatialReason: result.spatialReason } : {}) });
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

function contentFields(content: AssistantWorldModelContent): Record<string, unknown> {
  const definition = normalizeModelDefinition({
    modelScript: content.modelScript,
    modelScriptLanguage: "javascript",
    modelScriptVersion: content.modelScriptVersion ?? "woohaa-model-js-v2",
    placement: DEFAULT_MODEL_PLACEMENT
  });
  if (!definition.ok) throw new Error(definition.reason);
  return {
    modelScript: definition.value.modelScript,
    modelScriptLanguage: definition.value.modelScriptLanguage,
    modelScriptVersion: definition.value.modelScriptVersion,
    modelContentVersion: definition.value.contentVersion,
    modelPlacement: definition.value.placement
  };
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

function findInstanceNode(canvas: ServerCanvas, instanceId: string): { nodeId: string; fields: Record<string, unknown> } | null {
  for (const node of canvas.document.nodes) {
    const fields = canvas.nodeData[node.id];
    if (!record(fields)) continue;
    const decoded = decodeWorldInstanceData(fields.sharedWorldInstance);
    if (decoded.ok && decoded.value.instanceId === instanceId) return { nodeId: node.id, fields };
  }
  return null;
}

function hasNode(canvas: ServerCanvas, nodeId: string): boolean {
  return canvas.document.nodes.some(node => node.id === nodeId);
}

export function createAssistantWorldService(deps: AssistantWorldServiceDeps): AssistantWorldService {
  const ledgers = new Map<string, RunLedger>();

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
    const issued = input.scope.kind === "scene-area"
      ? await deps.worldAuthoring.issueContext({ ...base, scope: { kind: "scene-area", areaId: input.scope.areaId } })
      : await deps.worldAuthoring.issueContext({ ...base, scope: { kind: "workflow-group-2d", groupId: input.scope.groupId } });
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
          state: existing.cancelled ? "cancelled" : "active"
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
      cancelled: false
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

  function read(input: { canvasId: string; contextId: string }): { ok: true; view: import("@woohaa3/contracts").AssistantWorldContextView } | AssistantWorldFailure {
    const resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    const { ledger, context } = resolved;
    if (ledger.canvasId !== input.canvasId || context.canvasId !== input.canvasId) return failure("stale-epoch", "工具上下文不属于当前画布");
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
        worldWritable: context.scope.scope.kind === "scene-area"
      }
    };
  }

  async function write(input: AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome> {
    const resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    const { ledger, context, capability } = resolved;
    const operation = input.operation;
    if (context.scope.scope.kind !== "scene-area") {
      return failure("capability-unsupported", "2D 组成员不授予世界写资格");
    }
    const inspected = await inspect(ledger.canvasId);
    if (!inspected.ok) return inspected;
    if (context.scope.scope.kind === "scene-area") {
      const refreshed = await deps.authority.prepareCanvas(inspected.canvas, {
        kind: "scene-area",
        areaId: context.scope.scope.areaId
      });
      if (!refreshed.ok) return failure(refreshed.code, refreshed.message);
    }
    if (operation.kind === "create-model") {
      return createModel(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "replace-model-content") {
      return replaceContent(ledger, context, capability, operation, inspected);
    }
    if (operation.kind === "set-model-transform") {
      return moveModel(ledger, context, capability, operation, inspected);
    }
    return writeCamera(ledger, context, operation, inspected);
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
      return failure("operation-conflict", "新模型身份已存在");
    }
    let definition: Record<string, unknown>;
    try {
      definition = contentFields(operation.content);
    } catch (error) {
      return failure("invalid-data", error instanceof Error ? error.message : "模型脚本无效");
    }
    const fields = instanceFields(definition, instanceId, operation.transform);
    const prepared = await deps.authority.prepareContent(fields);
    if (!prepared) return failure("not-ready", "无法确定新模型的权威占地");
    const cardPosition = operation.content.cardPosition ?? { x: 0, y: 0 };
    const commandId = `assistant-world-create:${operation.operationId}`;
    const result = await inspected.room.submitDerived({
      commandId,
      async derive(canvas) {
        if (hasNode(canvas, operation.nodeId) || findInstanceNode(canvas, instanceId)) {
          return { ok: false as const, code: "operation-conflict", message: "新模型身份已存在" };
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
              node: { id: operation.nodeId, type: "model3d", position: cardPosition },
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
      definition = contentFields(operation.content);
    } catch (error) {
      return failure("invalid-data", error instanceof Error ? error.message : "模型脚本无效");
    }
    const previous = current.fields.modelContentVersion as { revision?: number; contentHash?: string } | undefined;
    const nextDefinition = normalizeModelDefinition({
      modelScript: operation.content.modelScript,
      modelScriptLanguage: definition.modelScriptLanguage as string,
      modelScriptVersion: operation.content.modelScriptVersion ?? "woohaa-model-js-v2",
      placement: current.fields.modelPlacement ?? DEFAULT_MODEL_PLACEMENT,
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
      modelPlacement: nextDefinition.value.placement
    };
    const decodedCurrent = decodeWorldInstanceData(current.fields.sharedWorldInstance);
    if (!decodedCurrent.ok) return failure("not-ready", "模型共享世界身份无效");
    const fields = instanceFields(patch, operation.instanceId, operation.transform ?? decodedCurrent.value.transform);
    const prepared = await deps.authority.prepareContent({ ...current.fields, ...fields });
    if (!prepared) return failure("not-ready", "无法确定替换后模型的权威占地");
    const commandId = `assistant-world-replace:${operation.operationId}`;
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
    const prepared = await deps.authority.prepareContent({ ...current.fields, ...fields });
    if (!prepared) return failure("not-ready", "无法确定移动后模型的权威占地");
    const commandId = `assistant-world-move:${operation.operationId}`;
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

  async function writeCamera(
    ledger: RunLedger,
    context: WorldToolContext,
    operation: Extract<AssistantWorldWriteOperation, { kind: "set-world-camera" }>,
    _inspected: { ok: true; room: CanvasRoom; canvas: ServerCanvas }
  ): Promise<AssistantWorldWriteOutcome> {
    const identity: WorldObjectIdentity = { kind: "camera", cameraId: operation.cameraId };
    const granted = findWritable(context, identity);
    if (!granted) return failure("outside-scope", "镜头不在本次可写集合");
    if (granted.version !== operation.expectedSettingsVersion) return failure("version-conflict", "镜头配置已变化");
    const saved = await deps.cameraSettings.save({
      canvasId: ledger.canvasId,
      cameraId: operation.cameraId,
      expectedSettingsVersion: operation.expectedSettingsVersion,
      settings: operation.settings,
      contextId: ledger.contextId,
      actorId: `assistant-world:${context.runId}`,
      operationId: operation.operationId
    });
    if (!saved.ok) return saved;
    ledger.writes.set(objectKey(identity), { identity, version: saved.settingsVersion });
    deps.worldAuthoring.refreshContextVersions({
      canvasId: ledger.canvasId,
      contextId: ledger.contextId,
      targets: [{ ...identity, version: saved.settingsVersion }]
    });
    return {
      ok: true,
      canvasId: ledger.canvasId,
      commandId: saved.commandId,
      revision: saved.revision,
      duplicate: saved.duplicate,
      noop: false,
      cameraId: operation.cameraId,
      settingsVersion: saved.settingsVersion,
      version: saved.settingsVersion
    };
  }

  function verifyCompletion(completion: AssistantWorldCompletionInput["completion"], _evidence: unknown): boolean {
    const ledger = [...ledgers.values()].find(entry => entry.runId === completion.runId && entry.canvasId === completion.canvasId);
    if (!ledger || ledger.cancelled) return false;
    if (ledger.completionId !== completion.completionId) return false;
    const identity: WorldObjectIdentity = { kind: "camera", cameraId: completion.cameraId };
    const write = ledger.writes.get(objectKey(identity));
    if (!write) return false;
    return sameIdentity(write.identity, identity) && write.version === completion.settingsVersion;
  }

  async function complete(input: AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome> {
    const resolved = resolve(input.contextId);
    if ("ok" in resolved) return resolved;
    const { ledger, context } = resolved;
    if (input.completion.canvasId !== ledger.canvasId || input.completion.runId !== ledger.runId) {
      return failure("unverified-run", "完成身份不属于本次运行");
    }
    if (input.completion.completionId !== ledger.completionId) return failure("unverified-run", "完成身份不是宿主签发");
    const camera = context.writableTargets.find(entry => entry.target.kind === "camera" && entry.target.cameraId === input.completion.cameraId);
    if (!camera) return failure("outside-scope", "镜头不在本次可写集合");
    if (!verifyCompletion(input.completion, input.evidence)) return failure("unverified-run", "本轮没有对应镜头的可信写入");
    const completed = await deps.cameraSettings.complete({ completion: input.completion, evidence: input.evidence });
    if (!completed.ok) return completed;
    return {
      ok: true,
      duplicate: completed.duplicate,
      settingsVersion: completed.entry.settingsVersion,
      completionId: completed.entry.completionId
    };
  }

  async function cancel(input: AssistantWorldCancelInput): Promise<void> {
    const ledger = ledgers.get(input.contextId);
    if (!ledger || ledger.canvasId !== input.canvasId) return;
    ledger.cancelled = true;
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
    try {
      await deps.confirmStopped({ ...input, requestId: ledger.requestId });
      ledgers.delete(input.contextId);
      return { ok: true };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "unverified-stop") return failure("unverified-stop", "停止证据未通过宿主核对");
      if (code === "stale-epoch") return failure("stale-epoch", "停止身份与原运行不一致");
      return failure("cancelled", error instanceof Error ? error.message : "确认停止失败");
    }
  }

  async function settleRun(input: { canvasId: string; runId: string; evidence: unknown }): Promise<{ ok: true } | AssistantWorldFailure> {
    const ledger = [...ledgers.values()].find(entry => entry.canvasId === input.canvasId && entry.runId === input.runId);
    if (!ledger) return { ok: true };
    return confirmStopped({
      canvasId: ledger.canvasId,
      contextId: ledger.contextId,
      runId: ledger.runId,
      epoch: ledger.epoch,
      executionId: ledger.executionId,
      evidence: input.evidence
    });
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
    recover,
    verifyCompletion,
    close() {
      ledgers.clear();
    }
  };
}

export { assistantWorldToolsForScope };
