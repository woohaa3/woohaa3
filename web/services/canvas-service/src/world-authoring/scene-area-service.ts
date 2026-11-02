/**
 * Scene-area authority service (T06).
 *
 * This is the production semantic entry behind the host HTTP routes:
 *
 * - `prepare` returns the exact gesture-start snapshot (writable / read-only /
 *   object versions) from the canonical room projection;
 * - `issueContext` acquires the atomic run lease and returns a revocable
 *   `WorldToolContext`; the process-local capability never leaves the host;
 * - `execute` revalidates scope, members, source versions, context and occupancy
 *   inside the real `CanvasRoom` serial queue before one atomic command batch;
 * - `undo` / `redo` replay the frozen receipt through the same queue, requiring
 *   the current state to match the receipt's produced versions. New objects are
 *   never absorbed and generated media/assets are never touched.
 */
import {
  planSceneAreaOperation,
  stableStringify,
  type SceneAreaPlan,
  type ServerCanvas,
  type WorldAuthoringCommandReceipt,
  type WorldAuthoringConflict,
  type WorldAuthoringExecuteInput,
  type WorldAuthoringExecuteOutcome,
  type WorldAuthoringFailure,
  type WorldAuthoringFailureCode,
  type WorldAuthoringHistoryInput,
  type WorldAuthoringHistoryOutcome,
  type WorldAuthoringPrepareOutcome,
  type WorldObjectIdentity,
  type WorldObjectVersion,
  type WorldToolContext,
  type WorldToolContextOutcome,
  type WorldToolContextRequest,
  type WorldToolContextRevokeInput
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/room.js";
import type { RoomCommandResult } from "../sync/room-types.js";
import type { YjsCommandRecord } from "../sync/yjs-repository.js";
import {
  sceneAreaScopeVersion,
  stableAuthorityVersion,
  worldObjectVersion,
  type WorldAuthoringAuthority
} from "./authority.js";
import { buildForwardCommands, buildInverseCommands } from "./scene-area-command-mapping.js";
import type { LeaseConflict, LeaseIntent, SpatialAcquireResult, SpatialWriteContext } from "./spatial-leases.js";

export type WorldAuthoringServiceDeps = {
  authority: WorldAuthoringAuthority;
  resolveRoom(canvasId: string): Promise<CanvasRoom | null>;
  acquire(intent: LeaseIntent): Promise<SpatialAcquireResult>;
  cancel(canvasId: string, requestId: string): Promise<void>;
  findLatest(canvasId: string, operationId: string): Promise<YjsCommandRecord | null>;
  now?: () => string;
};

export type WorldAuthoringService = {
  prepare(input: { canvasId: string; areaId: string }, options?: { signal?: AbortSignal }): Promise<WorldAuthoringPrepareOutcome>;
  issueContext(input: WorldToolContextRequest): Promise<WorldToolContextOutcome>;
  revokeContext(input: WorldToolContextRevokeInput): Promise<void>;
  /**
   * Host-internal resolution of an issued context and its process-local write
   * capability. It is deliberately absent from `BackendWorldAuthoringPort`, so
   * the capability can never be requested over a transport.
   */
  resolveCapability(canvasId: string, contextId: string): { context: WorldToolContext; capability: SpatialWriteContext } | WorldAuthoringFailure;
  /**
   * Advance the in-process context's versions after this exact run committed a
   * write. The durable lease store already advanced in the same transaction; this
   * keeps subsequent tool calls in the same run from using pre-write versions.
   */
  refreshContextVersions(input: { canvasId: string; contextId: string; targets: WorldObjectVersion[] }): void;
  execute(input: WorldAuthoringExecuteInput, options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }): Promise<WorldAuthoringExecuteOutcome>;
  undo(input: WorldAuthoringHistoryInput, options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }): Promise<WorldAuthoringHistoryOutcome>;
  redo(input: WorldAuthoringHistoryInput, options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }): Promise<WorldAuthoringHistoryOutcome>;
  close(): void;
};

type IssuedContext = {
  context: WorldToolContext;
  capability: SpatialWriteContext;
  requestId: string;
  canvasId: string;
};

const OBJECT_KEY = (target: WorldObjectIdentity): string =>
  JSON.stringify([target.kind, target.kind === "instance" ? target.instanceId : target.cameraId]);

function failure(code: WorldAuthoringFailureCode, message: string, extra: Partial<WorldAuthoringFailure> = {}): WorldAuthoringFailure {
  return { ok: false, code, message, ...extra };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function planFailure(code: string, operationId: string): WorldAuthoringFailure {
  switch (code) {
    case "unknown-input": return failure("not-ready", "场景快照缺少权威数据");
    case "unsupported-version": return failure("unsupported-version", "不支持的场景计划版本");
    case "source-version-conflict": return failure("version-conflict", "场景快照自身版本矛盾");
    case "operation-conflict": return failure("operation-conflict", `操作 ${operationId} 已被其他意图使用`);
    default: return failure("invalid-data", "场景计划输入无效");
  }
}

/** Map plan members against the canonical writable set (and optional tool context). */
function validatePlanSource(
  snapshot: Extract<WorldAuthoringPrepareOutcome, { ok: true }>["snapshot"],
  plan: SceneAreaPlan,
  context: WorldToolContext | null
): WorldAuthoringFailure | null {
  if (plan.canvasId !== snapshot.canvasId) return failure("invalid-data", "画布身份不一致");
  if (plan.source.area.areaId !== snapshot.area.areaId) return failure("outside-scope", "场景区身份不一致");
  if (plan.source.area.scopeVersion !== snapshot.scope.scopeVersion) {
    return failure("version-conflict", "场景区范围版本已变化");
  }
  if (stableStringify(plan.source.area.bounds) !== stableStringify(snapshot.bounds)) {
    return failure("version-conflict", "场景区范围已变化");
  }

  const writable = new Map(snapshot.writable.map(target => [OBJECT_KEY(target), target.version]));
  const readOnly = new Map(snapshot.readOnly.map(target => [OBJECT_KEY(target), target.version]));
  const seen = new Set<string>();
  for (const member of plan.source.members.instances) {
    const key = OBJECT_KEY(member.identity);
    if (seen.has(key)) return failure("invalid-data", "重复的实例目标");
    seen.add(key);
    if (readOnly.has(key)) return failure("outside-scope", "部分包含的参考模型只读");
    if (!writable.has(key)) return failure("outside-scope", "实例不在可写范围内");
    if (writable.get(key) !== member.version) return failure("version-conflict", "实例源版本或资格已变化");
  }
  for (const member of plan.source.members.cameras) {
    const key = OBJECT_KEY(member.identity);
    if (seen.has(key)) return failure("invalid-data", "重复的镜头目标");
    seen.add(key);
    if (readOnly.has(key)) return failure("outside-scope", "只读镜头不能写入");
    if (!writable.has(key)) return failure("outside-scope", "镜头不在可写范围内");
    if (writable.get(key) !== member.version) return failure("version-conflict", "镜头源版本或资格已变化");
  }

  if (context) {
    if (context.canvasId !== snapshot.canvasId) return failure("stale-epoch", "工具上下文画布不一致");
    if (context.scope.scope.kind !== "scene-area" || context.scope.scope.areaId !== snapshot.area.areaId) {
      return failure("outside-scope", "工具上下文范围不一致");
    }
    if (context.scope.scopeVersion !== snapshot.scope.scopeVersion) {
      return failure("version-conflict", "工具上下文范围版本已变化");
    }
    const granted = new Map(context.writableTargets.map(entry => [OBJECT_KEY(entry.target), entry.target.version]));
    const references = new Set(context.readOnlyReferences.map(OBJECT_KEY));
    for (const member of [...plan.source.members.instances, ...plan.source.members.cameras]) {
      const key = OBJECT_KEY(member.identity);
      if (references.has(key)) return failure("outside-scope", "工具上下文只允许读取该目标");
      if (granted.get(key) !== member.version) return failure("outside-scope", "工具上下文未授予该目标");
    }
    for (const entry of context.writableTargets) {
      if (entry.lease.canvasId !== context.canvasId ||
        entry.lease.runId !== context.runId ||
        entry.lease.epoch !== context.epoch ||
        OBJECT_KEY(entry.lease.target) !== OBJECT_KEY(entry.target)) {
        return failure("stale-epoch", "工具上下文占用身份不一致");
      }
    }
  }
  return null;
}

/**
 * Probe projection for undoing a delete: the area (and its members) will be
 * restored, so eligibility must be computed against the frozen source area.
 * This only feeds the authority cache; the real canvas is never mutated.
 */
function withRestoredArea(
  canvas: ServerCanvas,
  source: WorldAuthoringCommandReceipt["source"]
): ServerCanvas {
  return {
    ...canvas,
    document: {
      ...canvas.document,
      nodes: [...canvas.document.nodes, source.area.node as never]
    },
    nodeData: {
      ...canvas.nodeData,
      [source.area.nodeId]: source.area.nodeData as never,
      ...Object.fromEntries(source.members.map(member => [member.nodeId, member.nodeData as never]))
    }
  };
}

function matchesReceiptState(
  canvas: ServerCanvas,
  receipt: WorldAuthoringCommandReceipt
): WorldAuthoringFailure | null {  const areaVersion = sceneAreaScopeVersion(canvas, receipt.plan.source.area.areaId);
  if (receipt.produced.areaScopeVersion === null) {
    if (areaVersion !== null) return failure("version-conflict", "场景区状态已变化");
  } else if (areaVersion !== receipt.produced.areaScopeVersion) {
    return failure("version-conflict", "场景区状态已变化");
  }
  for (const target of receipt.produced.targets) {
    const current = worldObjectVersion(canvas, target);
    if (target.version === "absent") {
      if (current !== null) return failure("version-conflict", "目标状态已变化");
    } else if (current !== target.version) {
      return failure("version-conflict", "目标状态已变化");
    }
  }
  return null;
}


/** Conflict target plus the run that currently occupies it; never drop the run identity. */
function conflictsFor(
  conflict: LeaseConflict | undefined,
  canvas?: ServerCanvas
): WorldAuthoringConflict[] | undefined {
  if (!conflict) return undefined;
  return [{
    target: conflict.target,
    version: canvas ? worldObjectVersion(canvas, conflict.target) : null,
    runId: conflict.runId,
    epoch: conflict.epoch
  }];
}

function resultFailure(result: RoomCommandResult, canvas?: ServerCanvas): WorldAuthoringFailure {
  if (result.ok) return failure("invalid-data", "unexpected");
  const domainCodes: WorldAuthoringFailureCode[] = [
    "invalid-data", "not-ready", "outside-scope", "version-conflict", "operation-conflict",
    "stale-epoch", "cancelled", "not-found", "unsupported-version"
  ];
  if (domainCodes.includes(result.code as WorldAuthoringFailureCode)) {
    return failure(result.code as WorldAuthoringFailureCode, result.message);
  }
  if (result.code === "lease-conflict") {
    return failure("lease-conflict", "目标正在被其他运行占用", {
      conflicts: conflictsFor(result.conflict, canvas)
    });
  }
  if (result.code === "spatial-rejected") {
    return failure("spatial-rejected", "空间写入资格无效", {
      spatialReason: result.spatialReason,
      conflicts: conflictsFor(result.conflict, canvas)
    });
  }
  if (result.code === "command-id-reused" || result.code === "request-id-reused") return failure("operation-conflict", "相同 operationId 使用了不同意图");
  if (result.code === "edit-precondition-failed") return failure("version-conflict", "源对象或范围已变化");
  if (result.code === "write-forbidden") return failure("write-forbidden", "无权写入该画布");
  if (result.code === "cancelled") return failure("cancelled", "提交已取消");
  return failure("invalid-data", result.message);
}

export function createWorldAuthoringService(deps: WorldAuthoringServiceDeps): WorldAuthoringService {
  const issued = new Map<string, IssuedContext>();
  const now = deps.now ?? (() => new Date().toISOString());

  async function roomSnapshot(canvasId: string): Promise<{ ok: true; room: CanvasRoom; canvas: ServerCanvas } | WorldAuthoringFailure> {
    const room = await deps.resolveRoom(canvasId);
    if (!room) return failure("not-found", "画布不存在");
    const inspected = await room.inspectPublished(value => value);
    if (!inspected.ok) return failure("not-ready", inspected.message);
    return { ok: true, room, canvas: inspected.canvas };
  }

  async function prepare(
    input: { canvasId: string; areaId: string },
    options?: { signal?: AbortSignal }
  ): Promise<WorldAuthoringPrepareOutcome> {
    if (!nonEmpty(input?.canvasId) || !nonEmpty(input?.areaId)) return failure("invalid-data", "画布或场景区身份无效");
    if (options?.signal?.aborted) return failure("cancelled", "准备已取消");
    const snapshot = await roomSnapshot(input.canvasId);
    if (!("room" in snapshot)) return snapshot;
    const prepared = await deps.authority.prepareCanvas(snapshot.canvas, { kind: "scene-area", areaId: input.areaId });
    if (!prepared.ok) return failure(prepared.code, prepared.message);
    return prepared;
  }

  async function issueContext(input: WorldToolContextRequest): Promise<WorldToolContextOutcome> {
    if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.requestId) || !nonEmpty(input.runId) ||
      !nonEmpty(input.executionId) || !Number.isSafeInteger(input.epoch) || input.epoch < 0 || !input.scope) {
      return failure("invalid-data", "工具上下文身份无效");
    }
    const snapshot = await roomSnapshot(input.canvasId);
    if (!("room" in snapshot)) return snapshot;

    let writable: WorldToolContext["writableTargets"] = [];
    let readOnly: WorldToolContext["readOnlyReferences"] = [];
    let scope: WorldToolContext["scope"];
    if (input.scope.kind === "scene-area") {
      const prepared = await deps.authority.prepareCanvas(snapshot.canvas, { kind: "scene-area", areaId: input.scope.areaId });
      if (!prepared.ok) return failure(prepared.code, prepared.message);
      scope = prepared.snapshot.scope;
      readOnly = prepared.snapshot.readOnly;
      // Writable entries are filled after the persistent run identity is known.
      writable = prepared.snapshot.writable.map(target => ({ target, lease: null as never }));
    } else {
      const prepared = await deps.authority.prepareGroup(snapshot.canvas, input.scope.groupId);
      if (!prepared.ok) return failure(prepared.code, prepared.message);
      scope = prepared.snapshot.scope;
      readOnly = prepared.snapshot.readOnly;
      writable = [];
    }

    let acquired: SpatialAcquireResult;
    try {
      acquired = await deps.acquire({
        requestId: input.requestId,
        canvasId: input.canvasId,
        runId: input.runId,
        epoch: input.epoch,
        executionId: input.executionId,
        scope,
        writable: writable.map(entry => entry.target),
        readOnly
      });
    } catch (error) {
      return leaseFailure(error, snapshot.canvas);
    }
    if (!acquired.capability) {
      return failure(acquired.retry ? "stale-epoch" : "not-ready", "运行尚未取得写能力，需先核对执行");
    }
    const contextId = stableAuthorityVersion("world-tool-context", {
      canvasId: input.canvasId,
      requestId: input.requestId,
      runId: acquired.run.runId,
      epoch: acquired.run.epoch,
      scope
    });
    const context: WorldToolContext = {
      contextId,
      canvasId: input.canvasId,
      runId: acquired.run.runId,
      epoch: acquired.run.epoch,
      scope,
      writableTargets: writable.map(entry => ({
        target: entry.target,
        lease: {
          canvasId: input.canvasId,
          runId: acquired.run.runId,
          epoch: acquired.run.epoch,
          target: entry.target.kind === "instance"
            ? { kind: "instance", instanceId: entry.target.instanceId }
            : { kind: "camera", cameraId: entry.target.cameraId }
        }
      })),
      readOnlyReferences: readOnly
    };
    const existing = issued.get(contextId);
    if (existing) return { ok: true, context: existing.context, run: acquired.run, retry: true };
    issued.set(contextId, { context, capability: acquired.capability, requestId: input.requestId, canvasId: input.canvasId });
    return { ok: true, context, run: acquired.run, retry: acquired.retry };
  }

  async function revokeContext(input: WorldToolContextRevokeInput): Promise<void> {
    if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.contextId)) return;
    const entry = issued.get(input.contextId);
    if (!entry || entry.canvasId !== input.canvasId) return;
    issued.delete(input.contextId);
    // Cancellation invalidates the grant; locks remain until exact stop is confirmed.
    await deps.cancel(input.canvasId, entry.requestId);
  }

  function contextFor(canvasId: string, contextId: string | undefined): { context: WorldToolContext; capability: SpatialWriteContext } | WorldAuthoringFailure {
    if (!contextId) return failure("stale-epoch", "缺少工具上下文");
    const entry = issued.get(contextId);
    if (!entry || entry.canvasId !== canvasId) return failure("stale-epoch", "工具上下文已失效");
    return { context: entry.context, capability: entry.capability };
  }

  async function runExecute(
    input: WorldAuthoringExecuteInput,
    options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }
  ): Promise<WorldAuthoringExecuteOutcome> {
    if (!input || !nonEmpty(input.canvasId) || !input.request) return failure("invalid-data", "请求无效");
    const planned = planSceneAreaOperation(input.request);
    if (!planned.ok) return planFailure(planned.code, planned.operationId);
    const plan = planned.plan;
    if (input.operationId && input.operationId !== plan.operationId) return failure("invalid-data", "operationId 不一致");

    const context = input.contextId ? contextFor(input.canvasId, input.contextId) : null;
    if (context && "ok" in context) return context;

    const snapshot = await roomSnapshot(input.canvasId);
    if (!("room" in snapshot)) return snapshot;
    const commandId = `scene-area:${plan.operationId}`;
    const intentHash = stableAuthorityVersion("scene-area-intent", { canvasId: input.canvasId, request: input.request });
    const derived = await snapshot.room.submitDerived({
      commandId,
      expectedWorldAuthoringHash: intentHash,
      async derive(canvas) {
        if (options?.signal?.aborted) return { ok: false as const, code: "cancelled", message: "提交已取消" };
        const prepared = await deps.authority.prepareCanvas(canvas, { kind: "scene-area", areaId: plan.source.area.areaId });
        if (!prepared.ok) return { ok: false as const, code: prepared.code, message: prepared.message };
        const invalid = validatePlanSource(prepared.snapshot, plan, context && "context" in context ? context.context : null);
        if (invalid) return { ok: false as const, code: invalid.code, message: invalid.message };
        const mapped = buildForwardCommands(canvas, plan);
        if (!mapped.ok) return { ok: false as const, code: mapped.code, message: mapped.message };
        const receipt: WorldAuthoringCommandReceipt = {
          version: "world-authoring-receipt-v1",
          canvasId: input.canvasId,
          operationId: plan.operationId,
          intent: plan.intent,
          direction: "forward",
          intentHash,
          previousCommandId: null,
          plan,
          source: mapped.source,
          deletedNodes: mapped.deleted,
          produced: mapped.produced,
          revision: canvas.revision,
          createdAt: now()
        };
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: input.canvasId,
            commandId,
            actorId: input.actorId ?? "scene-area",
            baseRevision: canvas.revision,
            commands: mapped.commands
          },
          worldAuthoring: receipt
        };
      }
    }, {
      ...(context && "capability" in context ? { spatialContext: context.capability } : {}),
      ...(options?.authorize ? { authorize: options.authorize } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    });
    if (!derived.ok) return resultFailure(derived, snapshot.canvas);
    let receipt = derived.worldAuthoring;
    if (!receipt) {
      const record = await snapshot.room.lookupCommand(commandId);
      receipt = record?.worldAuthoring;
    }
    if (!receipt) return failure("not-ready", "权威回执不可用");
    return {
      ok: true,
      canvasId: input.canvasId,
      operationId: plan.operationId,
      commandId,
      revision: derived.revision,
      duplicate: derived.status === "duplicate",
      plan: receipt.plan,
      receipt
    };
  }

  async function runHistory(
    direction: "undo" | "redo",
    input: WorldAuthoringHistoryInput,
    options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }
  ): Promise<WorldAuthoringHistoryOutcome> {
    if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.operationId)) return failure("invalid-data", "撤销/重做请求无效");
    const latest = await deps.findLatest(input.canvasId, input.operationId);
    if (!latest?.worldAuthoring) return failure("not-found", "找不到可撤销的操作");
    if (direction === "undo" && latest.worldAuthoring.direction === "undo") {
      return failure("operation-conflict", "该操作已经撤销");
    }
    if (direction === "redo" && latest.worldAuthoring.direction !== "undo") {
      return failure("operation-conflict", "该操作没有可重做的撤销");
    }

    const context = input.contextId ? contextFor(input.canvasId, input.contextId) : null;
    if (context && "ok" in context) return context;

    const snapshot = await roomSnapshot(input.canvasId);
    if (!("room" in snapshot)) return snapshot;
    const receiptSource = latest.worldAuthoring;
    const commandId = `scene-area-${direction}:${input.operationId}:${stableAuthorityVersion("history", latest.commandId)}`;
    const intentHash = stableAuthorityVersion("scene-area-intent", {
      canvasId: input.canvasId,
      operationId: input.operationId,
      direction,
      previousCommandId: latest.commandId
    });
    const derived = await snapshot.room.submitDerived({
      commandId,
      expectedWorldAuthoringHash: intentHash,
      async derive(canvas) {
        if (options?.signal?.aborted) return { ok: false as const, code: "cancelled", message: "提交已取消" };
        let prepared = await deps.authority.prepareCanvas(canvas, { kind: "scene-area", areaId: receiptSource.plan.source.area.areaId });
        if (!prepared.ok && direction === "undo" && prepared.code === "outside-scope" && receiptSource.deletedNodes.some(snapshot => snapshot.nodeId === receiptSource.source.area.nodeId)) {
          // Undoing a delete restores the area itself; prepare against a probe
          // projection that includes the frozen source snapshot.
          prepared = await deps.authority.prepareCanvas(
            withRestoredArea(canvas, receiptSource.source),
            { kind: "scene-area", areaId: receiptSource.plan.source.area.areaId }
          );
        }
        if (!prepared.ok) return { ok: false as const, code: prepared.code, message: prepared.message };
        const stateInvalid = matchesReceiptState(canvas, receiptSource);
        if (stateInvalid) return { ok: false as const, code: stateInvalid.code, message: stateInvalid.message };
        if (context && "context" in context) {
          const granted = new Map(context.context.writableTargets.map(entry => [OBJECT_KEY(entry.target), entry.target.version]));
          for (const target of receiptSource.produced.targets) {
            if (target.version !== "absent" && granted.get(OBJECT_KEY(target)) !== target.version) {
              return { ok: false as const, code: "outside-scope", message: "工具上下文未授予撤销目标" };
            }
          }
        }
        const mapped = direction === "undo"
          ? buildInverseCommands(canvas, receiptSource.plan, receiptSource.source, receiptSource.deletedNodes)
          : buildForwardCommands(canvas, receiptSource.plan, {
              frozenSource: receiptSource.source,
              frozenDeleted: receiptSource.deletedNodes
            });
        if (!mapped.ok) return { ok: false as const, code: mapped.code, message: mapped.message };
        const receipt: WorldAuthoringCommandReceipt = {
          version: "world-authoring-receipt-v1",
          canvasId: input.canvasId,
          operationId: input.operationId,
          intent: receiptSource.intent,
          direction,
          intentHash,
          previousCommandId: latest.commandId,
          plan: receiptSource.plan,
          source: receiptSource.source,
          deletedNodes: receiptSource.deletedNodes,
          produced: mapped.produced,
          revision: canvas.revision,
          createdAt: now()
        };
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: input.canvasId,
            commandId,
            actorId: input.actorId ?? `scene-area-${direction}`,
            baseRevision: canvas.revision,
            commands: mapped.commands
          },
          worldAuthoring: receipt
        };
      }
    }, {
      ...(context && "capability" in context ? { spatialContext: context.capability } : {}),
      ...(options?.authorize ? { authorize: options.authorize } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    });
    if (!derived.ok) return resultFailure(derived, snapshot.canvas);
    let receipt = derived.worldAuthoring;
    if (!receipt) receipt = (await snapshot.room.lookupCommand(commandId))?.worldAuthoring;
    if (!receipt) return failure("not-ready", "权威回执不可用");
    return {
      ok: true,
      canvasId: input.canvasId,
      operationId: input.operationId,
      commandId,
      revision: derived.revision,
      duplicate: derived.status === "duplicate",
      direction,
      plan: receipt.plan,
      receipt
    };
  }

  return {
    prepare,
    issueContext,
    revokeContext,
    resolveCapability(canvasId: string, contextId: string) {
      const entry = issued.get(contextId);
      if (!entry || entry.canvasId !== canvasId) return failure("stale-epoch", "工具上下文已失效");
      return { context: entry.context, capability: entry.capability };
    },
    refreshContextVersions(input) {
      const entry = issued.get(input.contextId);
      if (!entry || entry.canvasId !== input.canvasId) return;
      const next = new Map(input.targets.map(target => [OBJECT_KEY(target), target.version]));
      const known = new Set(entry.context.writableTargets.map(item => OBJECT_KEY(item.target)));
      const additions = entry.context.scope.scope.kind === "scene-area"
        ? input.targets
            .filter(target => !known.has(OBJECT_KEY(target)))
            .map(target => ({
              target,
              lease: {
                canvasId: entry.context.canvasId,
                runId: entry.context.runId,
                epoch: entry.context.epoch,
                target: target.kind === "instance"
                  ? { kind: "instance" as const, instanceId: target.instanceId }
                  : { kind: "camera" as const, cameraId: target.cameraId }
              }
            }))
        : [];
      const writableTargets = entry.context.writableTargets.map(item => {
        const version = next.get(OBJECT_KEY(item.target));
        return version === undefined ? item : { ...item, target: { ...item.target, version } };
      });
      entry.context = {
        ...entry.context,
        writableTargets: [...writableTargets, ...additions]
      };
    },
    execute: runExecute,
    undo: (input, options) => runHistory("undo", input, options),
    redo: (input, options) => runHistory("redo", input, options),
    close() {
      issued.clear();
    }
  };
}

function mapLeaseErrorCode(code: string): WorldAuthoringFailureCode {
  switch (code) {
    case "lease-conflict": return "lease-conflict";
    case "outside-scope": return "outside-scope";
    case "stale-epoch": return "stale-epoch";
    case "request-conflict": return "operation-conflict";
    case "cancelled": return "cancelled";
    case "invalid-data":
    case "unavailable": return "not-ready";
    default: return "not-ready";
  }
}

/** Lease acquisition failures keep the occupying run and conflict target for the caller. */
function leaseFailure(error: unknown, canvas?: ServerCanvas): WorldAuthoringFailure {
  const record = error && typeof error === "object" ? error as { code?: unknown; conflict?: LeaseConflict } : {};
  const code = mapLeaseErrorCode(typeof record.code === "string" ? record.code : "");
  return failure(code, code === "lease-conflict" ? "目标正在被其他运行占用" : "无法取得范围写占用", {
    conflicts: conflictsFor(record.conflict, canvas)
  });
}
