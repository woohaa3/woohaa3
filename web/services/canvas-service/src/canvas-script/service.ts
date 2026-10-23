import { currentCanvasGroupScope } from "../agent-authoring/group-scope.js";
import { validateCanvasGroupChange } from "@woohaa3/contracts";
/**
 * Canvas script service
 * （change: 2026-10-13-add-canvas-script-authoring，任务 3.1–3.7 / design D1、D3、D5、D6）。
 *
 * Canvas 侧的脚本提交权威入口，职责与边界：
 *
 * 1. **授权前置**：`validate` 与 `submit` 在执行前做读/写授权；缺授权、只读、跨画布在产生
 *    任何副作用前拒绝。授权端口或隔离执行器缺失时 fail-closed（`script-unavailable`），
 *    绝不回退「存在性放行」。身份由 MCP 连接期的受认证 principal 决定，本服务不再持有任何
 *    提交凭证机制。
 * 2. **受限执行在队列外**：脚本在进入 room 提交队列**之前**记录为 `AgentPlanOperation[]`，
 *    避免长时间占用权威队列（design D1）。执行失败零写入、不占 requestId。
 * 3. **队列内派生**：进入 room 串行队列后才按**最新 published** 编译计划、复核
 *    expectedRevision/局部条件/领域规则并生成实际命令（design D5）。
 * 4. **原子提交与首次回执**：脚本元数据与画布 update 同事务持久化；noop 也保存首次回执；
 *    重试相同身份 + hash 返回**冻结**回执，不重执行、不重布局（design D6）。
 *
 * **不持久化源码**：源码只存在于本方法的栈与临时执行内存；回执/元数据/日志都不含源码。
 */
import type { CanvasRoom } from "../sync/index.js";
import type { ServerCanvas, AgentPlanOperation } from "@woohaa3/contracts";
import {
  AGENT_CANVAS_LIMITS,
  applyCanvasCommands,
  projectAgentNode,
  AGENT_NODE_DESCRIPTORS,
  CANVAS_SCRIPT_API_VERSION,
  CANVAS_SCRIPT_PROTOCOL_VERSION,
  canvasScriptError,
  canvasScriptSubmissionHash,
  compileAgentPlanWithHash,
  decodeCanvasScriptRequest,
  hashText,
  type CanvasScriptError,
  type CanvasScriptSubmissionMeta,
  type CanvasScriptSubmitReceipt,
  type CanvasScriptValidateReceipt
} from "@woohaa3/contracts";
import { CanvasScriptRecorder } from "./recorder.js";
import { CanvasScriptConcurrencyGate, type CanvasScriptCapability } from "./availability.js";
import { checkPreconditions, collectCascade, stageForCode, toPlannerSnapshot, toScriptError } from "./plan-projection.js";
import { frozenReceipt, summarizeEdges } from "./receipt.js";
import type { CanvasAuthorizer, CanvasPermission } from "../agent-authoring/authorization.js";

/** 上游（内部协议）传入的已认证主体与请求。 */
export type CanvasScriptRequestContext = {
  principalId: string;
  canvasId: string;
  requestId: string;
  version: string;
  source: string;
  expectedRevision?: number;
  /** 外部取消信号（change: 2026-10-22-remove-agent-execution-limits，任务 6.1）。 */
  signal?: AbortSignal;
};

export type CanvasScriptValidateOutcome =
  | { ok: true; receipt: CanvasScriptValidateReceipt }
  | { ok: false; error: CanvasScriptError };

export type CanvasScriptSubmitOutcome =
  | { ok: true; receipt: CanvasScriptSubmitReceipt }
  | { ok: false; error: CanvasScriptError };

export type CanvasScriptNodeKind = {
  kind: string;
  canonicalType: string;
  label: string;
  supportsPrompt: boolean;
  executable: boolean;
  defaultSize: { width: number; height: number };
};

export type CanvasScriptServiceDependencies = {
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  /** 写/读授权端口；缺失 → 能力 fail-closed。 */
  authorizer?: CanvasAuthorizer;
  /** 受限执行器可用性；`available:false` 时能力明确不可用。 */
  engine?: { available: boolean; reason?: string };
  /** 授权后可用节点种类；省略时用全部语义种类。 */
  nodeKinds?: readonly CanvasScriptNodeKind[];
  recorder?: CanvasScriptRecorder;
  gate?: CanvasScriptConcurrencyGate;
  /**
   * 队列内全量影响范围复核（任务 3.6）。
   *
   * 在命令生成前，对**全部实际影响目标**（含级联删除的后代与关联边端点）复核当前权限与
   * grant；返回 `{ ok:false }` 时整批拒绝。生产装配接 grant allowlist。
   */
  verifyScope?: (input: {
    principalId: string;
    canvasId: string;
    existingNodeIds: readonly string[];
    deletesExisting: boolean;
  }) => { ok: true } | { ok: false; code: string; message: string }
    | Promise<{ ok: true } | { ok: false; code: string; message: string }>;
};

/** 脚本请求身份（design D6）：principal + canvas + 工具 scope + requestId。 */
function scriptCommandId(principalId: string, canvasId: string, requestId: string): string {
  return `canvas-script:${hashText([principalId, canvasId, "submit_canvas_script", requestId].join("\u0000"))}`;
}

/**
 * 提取严格 codec 需要的**请求体形状**。
 *
 * `principalId` 来自受认证上下文，不参与请求体字段校验（codec 拒绝未知字段 `principalId`）。
 */
function scriptRequestShape(input: CanvasScriptRequestContext): Record<string, unknown> {
  return {
    canvasId: input.canvasId,
    requestId: input.requestId,
    version: input.version,
    source: input.source,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
  };
}

export class CanvasScriptService {
  private readonly deps: CanvasScriptServiceDependencies;
  private readonly recorder: CanvasScriptRecorder;
  private readonly gate: CanvasScriptConcurrencyGate;

  constructor(deps: CanvasScriptServiceDependencies) {
    this.deps = deps;
    this.recorder = deps.recorder ?? new CanvasScriptRecorder();
    this.gate = deps.gate ?? new CanvasScriptConcurrencyGate();
  }

  /** 能力声明：授权端口或隔离执行器不可用时明确 unavailable（spec）。 */
  capability(): CanvasScriptCapability {
    if (!this.deps.authorizer) return { available: false, reason: "授权端口未装配（fail-closed）" };
    if (this.deps.engine && !this.deps.engine.available) {
      return { available: false, reason: this.deps.engine.reason ?? "隔离执行器不可用" };
    }
    return { available: true };
  }

  /** 授权后的可用节点种类（进入 API 指南与执行 prelude，保证能力声明与实际执行一致）。 */
  availableNodeKinds(): readonly CanvasScriptNodeKind[] {
    if (this.deps.nodeKinds) return this.deps.nodeKinds;
    return AGENT_NODE_DESCRIPTORS.map((descriptor) => ({
      kind: descriptor.kind,
      canonicalType: descriptor.canonicalType,
      label: descriptor.label,
      supportsPrompt: descriptor.supportsPrompt,
      executable: descriptor.executable,
      defaultSize: descriptor.defaultSize
    }));
  }

  /**
   * 预检（任务 4.1）：与提交一致的语法/引用/权限/预算/领域预检，但**无持久副作用**：
   * 不写画布、不占 requestId、不推进 revision、不保存源码。
   */
  async validate(input: CanvasScriptRequestContext): Promise<CanvasScriptValidateOutcome> {
    const ready = this.requireCapability();
    if (!ready.ok) return ready;
    const decoded = decodeCanvasScriptRequest(scriptRequestShape(input));
    if (!decoded.ok) return { ok: false, error: decoded.error };

    const readable = await this.authorize(input.principalId, decoded.value.canvasId, "read");
    if (!readable.ok) return readable;
    const writable = await this.authorize(input.principalId, decoded.value.canvasId, "write");
    if (!writable.ok) return writable;

    const room = await this.deps.resolveRoom(decoded.value.canvasId);
    if (!room) return { ok: false, error: canvasScriptError("canvas-not-found", "authorize", `画布 ${decoded.value.canvasId} 不存在`) };
    const recorded = await this.recordScript(decoded.value.source);
    if (!recorded.ok) return recorded;

    return room.inspectPublished(async (exported): Promise<CanvasScriptValidateOutcome> => {
      if (!exported.ok) return { ok: false, error: canvasScriptError("canvas-unavailable", "commit", exported.message, { retryable: true }) };

      const compiled = await compileAgentPlanWithHash({
        canvasId: decoded.value.canvasId,
        requestId: decoded.value.requestId,
        scope: "submit_canvas_script",
        principalId: input.principalId,
        operations: recorded.operations,
        snapshot: toPlannerSnapshot(exported.canvas)
      });
      if (!compiled.ok) {
        return { ok: false, error: toScriptError(compiled.error.code, compiled.error.message, compiled.error.operationIndex, compiled.error.field) };
      }
      if (decoded.value.expectedRevision !== undefined && decoded.value.expectedRevision !== exported.canvas.revision) return { ok: false, error: canvasScriptError("revision-conflict", "precondition", "画布 revision 已变化") };
      const preconditionFailure = checkPreconditions(exported.canvas, compiled.preconditions);
      if (preconditionFailure) return { ok: false, error: canvasScriptError("precondition-failed", "precondition", preconditionFailure.message) };
      const projected = applyCanvasCommands(exported.canvas, compiled.commands);
      if (projected.ok && currentCanvasGroupScope()) { const reason = validateCanvasGroupChange(exported.canvas, projected.canvas, currentCanvasGroupScope()!.rootGroupId); if (reason) return { ok: false, error: canvasScriptError("forbidden", "authorize", reason) }; }
      if (!projected.ok) return { ok: false, error: toScriptError(projected.rejection.code, projected.rejection.message) };
      if (this.deps.verifyScope) {
        const scope = await this.deps.verifyScope({
          principalId: input.principalId,
          canvasId: decoded.value.canvasId,
          existingNodeIds: compiled.touchedExistingNodeIds,
          deletesExisting: compiled.commands.some((command) => command.type === "node.remove")
        });
        if (!scope.ok) return { ok: false, error: canvasScriptError(scope.code, "authorize", scope.message) };
      }

      return {
        ok: true,
        receipt: {
          ok: true,
          protocolVersion: CANVAS_SCRIPT_PROTOCOL_VERSION,
          version: decoded.value.version,
          canvasId: decoded.value.canvasId,
          basisRevision: exported.canvas.revision,
          normalized: compiled.normalized,
          refs: compiled.refs,
          warnings: compiled.warnings,
          predicted: compiled.predicted,
          organization: compiled.organization
        }
      };
    });
  }

  /**
   * 提交（任务 3.1–3.7）：队列内派生并原子提交；首次回执与画布 update 同事务保存。
   * **不保存源码**。
   */
  async submit(input: CanvasScriptRequestContext): Promise<CanvasScriptSubmitOutcome> {
    const ready = this.requireCapability();
    if (!ready.ok) return ready;
    const decoded = decodeCanvasScriptRequest(scriptRequestShape(input));
    if (!decoded.ok) return { ok: false, error: decoded.error };

    // 授权在任何副作用之前（任务 3.1）。
    const readable = await this.authorize(input.principalId, decoded.value.canvasId, "read");
    if (!readable.ok) return readable;
    const writable = await this.authorize(input.principalId, decoded.value.canvasId, "write");
    if (!writable.ok) return writable;

    const room = await this.deps.resolveRoom(decoded.value.canvasId);
    if (!room) return { ok: false, error: canvasScriptError("canvas-not-found", "authorize", `画布 ${decoded.value.canvasId} 不存在`) };

    const submissionHash = await canvasScriptSubmissionHash({
      version: decoded.value.version,
      source: decoded.value.source,
      ...(decoded.value.expectedRevision !== undefined ? { expectedRevision: decoded.value.expectedRevision } : {})
    });
    const commandId = scriptCommandId(input.principalId, decoded.value.canvasId, decoded.value.requestId);

    // 已授权幂等预查（任务 3.4/3.7）：命中已成功身份时先返回冻结回执，不重执行、不重新布局。
    // 授权已在上面按当前权限复核，不因历史成功越权。
    const existing = await room.lookupCommand(commandId);
    if (existing?.script) {
      if (existing.script.submissionHash !== submissionHash) {
        return { ok: false, error: canvasScriptError("request-id-reused", "commit", "相同 requestId 使用了不同脚本或 expectedRevision") };
      }
      return { ok: true, receipt: frozenReceipt(existing.script, decoded.value, existing.revision, true, !existing.changed) };
    }

    // change: 2026-10-22-remove-agent-execution-limits，任务 5.2 / 6.1：这里原本在并发/排队
    // 超限时返回不可重试的 busy。并发数量不是权限，已删除；`acquire` 只做观察性计数，
    // 执行仍承载于可终止的隔离故障域，用户停止可达。
    const slot = this.gate.acquire(input.principalId);

    try {
      const recorded = await this.recordScript(decoded.value.source, input.signal);
      if (!recorded.ok) return recorded;

      const outcome = await room.submitDerived({
        commandId,
        expectedPayloadHash: submissionHash,
        derive: (canvas) => this.deriveInQueue({
          canvas,
          principalId: input.principalId,
          requestId: decoded.value.requestId,
          operations: recorded.operations,
          expectedRevision: decoded.value.expectedRevision,
          version: decoded.value.version,
          submissionHash
        })
      });

      if (!outcome.ok) {
        return {
          ok: false,
          error: canvasScriptError(outcome.code, stageForCode(outcome.code), outcome.message, {
            ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
            ...(outcome.currentRevision !== undefined ? { currentRevision: outcome.currentRevision } : {}),
            ...(outcome.preconditionIndex !== undefined ? { operationIndex: outcome.preconditionIndex } : {})
          })
        };
      }

      const script = outcome.script;
      if (!script) return { ok: false, error: canvasScriptError("storage-failed", "commit", "提交成功但缺少首次回执元数据", { retryable: true }) };
      return { ok: true, receipt: frozenReceipt(script, decoded.value, outcome.revision, Boolean(outcome.duplicate) || outcome.status === "duplicate", outcome.noop) };
    } finally {
      slot.release();
    }
  }

  /** 受限执行 + host 侧严格解码（队列外；无应用侧时长上限，可外部取消）。 */
  private async recordScript(source: string, signal?: AbortSignal): Promise<{ ok: true; operations: AgentPlanOperation[] } | { ok: false; error: CanvasScriptError }> {
    const kinds = this.availableNodeKinds();
    const recorded = await this.recorder.record({
      source,
      nodeKinds: kinds.map((entry) => entry.kind),
      positionAbsMax: AGENT_CANVAS_LIMITS.maxPositionAbs,
      ...(signal ? { signal } : {})
    });
    if (!recorded.ok) return { ok: false, error: recorded.error };
    return { ok: true, operations: recorded.operations };
  }

  /**
   * 队列内派生（任务 3.5/3.6）：最新 published 上编译、复核条件与范围，产出命令与首次回执
   * 元数据。**不写源码**。
   */
  private async deriveInQueue(input: {
    canvas: ServerCanvas;
    principalId: string;
    requestId: string;
    operations: readonly AgentPlanOperation[];
    expectedRevision?: number;
    version: CanvasScriptSubmissionMeta["version"];
    submissionHash: string;
  }): Promise<
    | { ok: true; batch: import("@woohaa3/contracts/canvas-yjs").CanvasCommandBatch; script: CanvasScriptSubmissionMeta }
    | { ok: false; code: string; message: string }
  > {
    // expectedRevision：权威队列内严格复核（不做全局 CAS）。
    if (input.expectedRevision !== undefined && input.canvas.revision !== input.expectedRevision) {
      return { ok: false, code: "revision-conflict", message: `画布已是 revision ${input.canvas.revision}，与 expectedRevision ${input.expectedRevision} 不一致` };
    }

    const compiled = await compileAgentPlanWithHash({
      canvasId: input.canvas.id,
      requestId: input.requestId,
      scope: "submit_canvas_script",
      principalId: input.principalId,
      operations: input.operations,
      snapshot: toPlannerSnapshot(input.canvas)
    });
    if (!compiled.ok) return { ok: false, code: compiled.error.code, message: compiled.error.message };

    // 局部前置条件在权威 snapshot 上、命令批次提交前复核。
    const preconditionFailure = checkPreconditions(input.canvas, compiled.preconditions);
    if (preconditionFailure) return { ok: false, code: "precondition-failed", message: preconditionFailure.message };

    // 全量影响范围复核（任务 3.6）：含级联删除的后代与关联边端点。
    if (this.deps.verifyScope) {
      const cascade = collectCascade(input.canvas, compiled.commands);
      const scope = await this.deps.verifyScope({
        principalId: input.principalId,
        canvasId: input.canvas.id,
        existingNodeIds: [...new Set([...compiled.touchedExistingNodeIds, ...cascade])],
        deletesExisting: compiled.commands.some((command) => command.type === "node.remove")
      });
      if (!scope.ok) return { ok: false, code: scope.code, message: scope.message };
    }

    const projected = applyCanvasCommands(input.canvas, compiled.commands);
    if (!projected.ok) return { ok: false, code: projected.rejection.code, message: projected.rejection.message };
    if (currentCanvasGroupScope()) { const reason = validateCanvasGroupChange(input.canvas, projected.canvas, currentCanvasGroupScope()!.rootGroupId); if (reason) return { ok: false, code: "group-scope-forbidden", message: reason }; }
    const affected = new Set(compiled.organization.affectedNodeIds);
    const script: CanvasScriptSubmissionMeta = {
      submissionHash: input.submissionHash,
      version: input.version,
      apiVersion: CANVAS_SCRIPT_API_VERSION,
      refs: compiled.refs,
      nodes: projected.canvas.document.nodes.filter(n => affected.has(n.id)).map(n => projectAgentNode(projected.canvas, n, { includePrompt: true })),
      organization: compiled.organization,
      edges: summarizeEdges(input.canvas, compiled.commands),
      deletedNodeIds: [...new Set([...input.canvas.document.nodes.map(n => n.id), ...compiled.entities.flatMap(e => e.nodeId ? [e.nodeId] : [])])].filter(id => !projected.canvas.document.nodes.some(n => n.id === id)),
      deletedEdgeIds: input.canvas.document.edges.filter(e => !projected.canvas.document.edges.some(n => n.id === e.id)).map(e => e.id)
    };

    return {
      ok: true,
      script,
      batch: {
        protocolVersion: 1,
        canvasId: input.canvas.id,
        commandId: scriptCommandId(input.principalId, input.canvas.id, input.requestId),
        baseRevision: input.canvas.revision,
        actorId: "mcp-service",
        commands: compiled.commands
      }
    };
  }

  private async authorize(principalId: string, canvasId: string, permission: CanvasPermission): Promise<{ ok: true } | { ok: false; error: CanvasScriptError }> {
    const scope = currentCanvasGroupScope();
    if (scope && (!scope.valid() || scope.canvasId !== canvasId)) return { ok: false, error: canvasScriptError("group-scope-revoked", "authorize", "组创作授权已撤销") };
    principalId = scope?.owner ?? principalId;
    if (this.deps.accessRuntime?.enabled !== false && principalId.trim() === "") {
      return { ok: false, error: canvasScriptError("unauthorized", "authorize", "缺少已认证 principal") };
    }
    if (!this.deps.authorizer) {
      return { ok: false, error: canvasScriptError("script-unavailable", "authorize", "授权端口未装配（fail-closed）") };
    }
    const decision = await this.deps.authorizer.authorize({ principalId, canvasId, permission });
    if (!decision.allowed) {
      return { ok: false, error: canvasScriptError(permission === "write" ? "forbidden" : "unauthorized", "authorize", decision.reason) };
    }
    return { ok: true };
  }

  private requireCapability(): { ok: true } | { ok: false; error: CanvasScriptError } {
    const capability = this.capability();
    if (capability.available) return { ok: true };
    return { ok: false, error: canvasScriptError("script-unavailable", "decode", capability.reason) };
  }

}
