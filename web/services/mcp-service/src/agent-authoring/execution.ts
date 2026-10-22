/**
 * Agent authoring 工具面：读快照、编译与提交
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05）。
 */
import {
  AGENT_CANVAS_LIMITS,
  agentCanvasError,
  agentProtocolVersion,
  type AgentCanvasError,
  type AgentPlanOperation
} from "@woohaa3/contracts";
import {
  AGENT_CAPABILITY_VERSION,
  compileAgentPlanWithHash,
  readValidationToken,
  type PlanCompileResult,
  type PlanScope,
  type PlannerSnapshot
} from "./planner.js";
import {
  auditWrap,
  errorResult,
  now,
  rateLimitGate,
  structured,
  type AgentAuthoringToolDeps
} from "./tool-policy.js";

export type CompiledPlan = PlanCompileResult & { ok: true; canvasId: string };

/** 读取完整 planner 快照：分页直到无 nextCursor，超出上限则报错要求缩小查询。 */
export async function readPlannerSnapshot(
  deps: AgentAuthoringToolDeps,
  canvasId: string | undefined
): Promise<{ ok: true; snapshot: PlannerSnapshot } | { ok: false; error: AgentCanvasError }> {
  const nodes: Array<PlannerSnapshot["nodes"][number]> = [];
  const edges: Array<PlannerSnapshot["edges"][number]> = [];
  let cursor: string | undefined;
  let revision = 0;
  for (let page = 0; page < 100; page += 1) {
    const outcome = await deps.client.getGraph({
      ...(canvasId !== undefined ? { canvasId } : {}),
      includePrompt: false,
      limit: AGENT_CANVAS_LIMITS.maxGraphNodes,
      ...(cursor !== undefined ? { cursor } : {})
    });
    if (!outcome.ok) {
      return {
        ok: false,
        error: agentCanvasError(outcome.code, outcome.message, {
          retryable: outcome.code === "unavailable" || outcome.code === "timeout",
          ...(outcome.currentRevision !== undefined ? { currentRevision: outcome.currentRevision } : {})
        })
      };
    }
    revision = outcome.graph.revision;
    for (const node of outcome.graph.nodes) {
      nodes.push({
        id: node.nodeId,
        type: node.canonicalType,
        position: node.position,
        width: node.size.width,
        height: node.size.height
        ,parentId: node.parentId ?? undefined,
        ...(node.nodeId === outcome.graph.rootGroupId ? { retainWhenEmpty: true } : {})
      });
    }
    for (const edge of outcome.graph.edges) {
      edges.push({ id: edge.edgeId, source: edge.source, target: edge.target });
    }
    if (!outcome.graph.nextCursor) {
      return { ok: true, snapshot: { canvasId: outcome.graph.canvasId, revision, nodes, edges, rootGroupId: outcome.graph.rootGroupId } };
    }
    cursor = outcome.graph.nextCursor;
  }
  return {
    ok: false,
    error: agentCanvasError("limit-exceeded", "画布过大，无法获取完整 planner 快照", {
      retryable: false,
      suggestion: "请对局部邻域使用 aroundNodeId/depth 缩小写入范围"
    })
  };
}

export async function compileForTool(
  deps: AgentAuthoringToolDeps,
  canvasIdInput: string | undefined,
  scope: PlanScope,
  operations: readonly AgentPlanOperation[],
  requestId?: string
): Promise<{ ok: true; compiled: CompiledPlan } | { ok: false; error: AgentCanvasError }> {
  const snapshot = await readPlannerSnapshot(deps, canvasIdInput);
  if (!snapshot.ok) return { ok: false, error: snapshot.error };
  // 传入 requestId 时用其派生实体 ID，使 dry-run 回显与随后 apply 的 canonical ID 一致。
  const compiled = await compileAgentPlanWithHash({
    canvasId: snapshot.snapshot.canvasId,
    scope,
    requestId: requestId ?? "validate",
    operations,
    snapshot: snapshot.snapshot
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };
  return { ok: true, compiled: { ...compiled, canvasId: snapshot.snapshot.canvasId } };
}

export async function applyOperations(
  deps: AgentAuthoringToolDeps,
  input: {
    canvasId?: string;
    requestId: string;
    operations: readonly AgentPlanOperation[];
    validationToken?: string;
    scope: PlanScope;
  }
): Promise<any> {
  const limited = rateLimitGate(deps, "write", input.canvasId);
  if (limited) return limited;
  const startedAt = now(deps);
  const emitted = await applyOperationsInner(deps, input);
  if (deps.audit) {
    const result = emitted.raw as Record<string, unknown>;
    const ok = result.ok === true;
    deps.audit({
      event: "agent-tool",
      tool: input.scope,
      ...(input.canvasId !== undefined ? { canvasId: input.canvasId } : {}),
      requestId: input.requestId,
      ...(ok
        ? {
            revision: typeof result.revision === "number" ? result.revision : undefined,
            nodeCount: Array.isArray(result.nodes) ? result.nodes.length : undefined,
            edgeCount: Array.isArray(result.edges) ? result.edges.length : undefined,
            duplicate: typeof result.duplicate === "boolean" ? result.duplicate : undefined,
            noop: typeof result.noop === "boolean" ? result.noop : undefined
          }
        : { code: typeof result.code === "string" ? result.code : "unknown", retryable: result.retryable === true }),
      latencyMs: Math.max(0, now(deps) - startedAt)
    });
  }
  return emitted.result;
}

export async function applyOperationsInner(
  deps: AgentAuthoringToolDeps,
  input: {
    canvasId?: string;
    requestId: string;
    operations: readonly AgentPlanOperation[];
    validationToken?: string;
    scope: PlanScope;
  }
) {
  const snapshot = await readPlannerSnapshot(deps, input.canvasId);
  if (!snapshot.ok) return { result: errorResult(snapshot.error), raw: { ok: false, code: snapshot.error.code, retryable: snapshot.error.retryable } };

  // validationToken 绑定 basisRevision/capability version；过期或 basis 变化返回 plan-stale。
  const token = input.validationToken ? readValidationToken(input.validationToken) : null;
  if (input.validationToken && !token) {
    return { result: errorResult(agentCanvasError("plan-stale", "validationToken 非法", { retryable: false, suggestion: "请重新 validate_canvas_plan" })), raw: { ok: false, code: "plan-stale" } };
  }
  if (token) {
    if (token.canvasId !== snapshot.snapshot.canvasId) {
      return { result: errorResult(agentCanvasError("plan-stale", "validationToken 属于其它画布", { retryable: false, suggestion: "请重新 validate_canvas_plan" })), raw: { ok: false, code: "plan-stale" } };
    }
    if (token.expiresAtMs < now(deps)) {
      return { result: errorResult(agentCanvasError("plan-stale", "validationToken 已过期", { retryable: false, suggestion: "请重新 validate_canvas_plan" })), raw: { ok: false, code: "plan-stale" } };
    }
    if (token.capabilityVersion !== AGENT_CAPABILITY_VERSION || token.basisRevision !== snapshot.snapshot.revision) {
      return { result: errorResult(
        agentCanvasError("plan-stale", "画布 revision 或能力版本已变化", {
          retryable: false,
          currentRevision: snapshot.snapshot.revision,
          suggestion: "请重新 validate_canvas_plan 后在最新状态提交"
        })
      ), raw: { ok: false, code: "plan-stale" } };
    }
  }

  const requestId = input.requestId;
  const compiled = await compileWithIdentity({
    snapshot: snapshot.snapshot,
    scope: input.scope,
    requestId,
    operations: input.operations
  });
  if (!compiled.ok) return { result: errorResult(compiled.error), raw: { ok: false, code: compiled.error.code, retryable: compiled.error.retryable } };

  if (token && token.planHash !== compiled.payloadHash) {
    return { result: errorResult(
      agentCanvasError("plan-stale", "提交计划与 validationToken 不一致", { retryable: false, suggestion: "请重新 validate_canvas_plan" })
    ), raw: { ok: false, code: "plan-stale" } };
  }

  const outcome = await deps.client.applyPlan({
    canvasId: snapshot.snapshot.canvasId,
    requestId,
    commandId: compiled.commandId,
    payloadHash: compiled.payloadHash,
    baseRevision: snapshot.snapshot.revision,
    commands: compiled.commands,
    ...(compiled.preconditions.length > 0 ? { preconditions: compiled.preconditions } : {})
  });
  if (!outcome.ok) {
    return { result: errorResult(
      agentCanvasError(outcome.code, outcome.message, {
        retryable: outcome.retryable ?? false,
        ...(outcome.currentRevision !== undefined ? { currentRevision: outcome.currentRevision } : {}),
        ...(outcome.preconditionIndex !== undefined ? { operationIndex: outcome.preconditionIndex } : {})
      })
    ), raw: { ok: false, code: outcome.code, retryable: outcome.retryable ?? false } };
  }

  const result = {
    ok: true as const,
    protocolVersion: agentProtocolVersion(),
    canvasId: outcome.canvasId,
    requestId,
    revision: outcome.revision,
    duplicate: outcome.duplicate,
    noop: outcome.noop,
    refs: compiled.refs,
    nodes: outcome.nodes,
    edges: outcome.edges
  };
  const summary = outcome.duplicate
    ? `重复请求，返回首次回执（revision ${outcome.revision}）`
    : `提交成功：revision ${outcome.revision}，${outcome.nodes.length} 节点 / ${outcome.edges.length} 边`;
  return { result: structured(result, summary), raw: result };
}

/** requestId 参与 command identity（design D3）：不同 requestId 视为新意图，即使 payload 相同。 */
export async function compileWithIdentity(input: {
  snapshot: PlannerSnapshot;
  scope: PlanScope;
  requestId: string;
  operations: readonly AgentPlanOperation[];
}): Promise<PlanCompileResult> {
  return compileAgentPlanWithHash({
    canvasId: input.snapshot.canvasId,
    scope: input.scope,
    requestId: input.requestId,
    operations: [...input.operations],
    snapshot: input.snapshot
  });
}

/**
 * 供旧工具（`set_node_prompt`）迁移复用的最小 plan 提交入口（任务 7.2）。
 */
export async function runToolPlan(
  deps: AgentAuthoringToolDeps,
  input: { canvasId: string; requestId: string; scope: "set_node_prompt"; operations: AgentPlanOperation[] }
): Promise<
  | { ok: true; canvasId: string; revision: number; duplicate: boolean; noop: boolean }
  | { ok: false; code: string; message: string }
> {
  const snapshot = await readPlannerSnapshot(deps, input.canvasId);
  if (!snapshot.ok) return { ok: false, code: snapshot.error.code, message: snapshot.error.message };
  const compiled = await compileAgentPlanWithHash({
    canvasId: snapshot.snapshot.canvasId,
    scope: input.scope,
    requestId: input.requestId,
    operations: input.operations,
    snapshot: snapshot.snapshot
  });
  if (!compiled.ok) return { ok: false, code: compiled.error.code, message: compiled.error.message };
  const outcome = await deps.client.applyPlan({
    canvasId: snapshot.snapshot.canvasId,
    requestId: input.requestId,
    commandId: compiled.commandId,
    payloadHash: compiled.payloadHash,
    baseRevision: snapshot.snapshot.revision,
    commands: compiled.commands,
    ...(compiled.preconditions.length > 0 ? { preconditions: compiled.preconditions } : {})
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  return { ok: true, canvasId: outcome.canvasId, revision: outcome.revision, duplicate: outcome.duplicate, noop: outcome.noop };
}

export { auditWrap };
