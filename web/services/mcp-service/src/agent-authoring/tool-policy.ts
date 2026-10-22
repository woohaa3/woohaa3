/**
 * Agent authoring 工具面：依赖、审计与共享工具结果/限流/预算
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05）。
 */
import { agentCanvasError, type AgentCanvasError } from "@woohaa3/contracts";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { AgentToolCategory } from "./limits.js";
import { AgentRateLimiter, checkResponseBudget } from "./limits.js";

/** 工具面依赖的能力：只有下游 client。 */
export type AgentAuthoringToolDeps = {
  client: AgentCanvasClient;
  runAvailability?: { available: boolean; reason?: string } & (
    | { available: true }
    | { available: false }
  );
  /** Canvas script 能力可用性（由 `get_canvas_capabilities` 探测后注入；缺省视为未接入）。 */
  scriptAvailability?: { available: boolean; reason?: string };
  now?: () => number;
  validationTokenTtlMs?: number;
  audit?: (event: AgentAuditEvent) => void;
  auditTool?: string;
  rateLimiter?: AgentRateLimiter;
  principalId?: string;
};

/** 安全审计事件字段（任务 7.5）。只含可追责字段，绝不含 prompt/凭据/URL。 */
export type AgentAuditEvent = {
  event: "agent-tool";
  tool: string;
  principalId?: string;
  canvasId?: string;
  requestId?: string;
  code?: string;
  retryable?: boolean;
  revision?: number;
  latencyMs: number;
  nodeCount?: number;
  edgeCount?: number;
  duplicate?: boolean;
  noop?: boolean;
};

export function structured(value: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(value, null, 2)}` }],
    structuredContent: value
  };
}

export function errorResult(error: AgentCanvasError) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(error) }],
    structuredContent: { ok: false, ...error } as Record<string, unknown>,
    isError: true as const
  };
}

export function now(deps: AgentAuthoringToolDeps): number {
  return deps.now?.() ?? Date.now();
}

/** 速率限制器（复用注入的；未注入时按 deps 创建一个有界实例）。 */
const fallbackLimiters = new WeakMap<AgentAuthoringToolDeps, AgentRateLimiter>();

export function limiterFor(deps: AgentAuthoringToolDeps): AgentRateLimiter {
  if (deps.rateLimiter) return deps.rateLimiter;
  let existing = fallbackLimiters.get(deps);
  if (!existing) {
    existing = new AgentRateLimiter({ ...(deps.now ? { now: deps.now } : {}) });
    fallbackLimiters.set(deps, existing);
  }
  return existing;
}

/**
 * 速率限制门（任务 2.5）：在调用下游前校验。拒绝时不触达 Canvas，因此无副作用。
 */
export function rateLimitGate(
  deps: AgentAuthoringToolDeps,
  category: AgentToolCategory,
  canvasId?: string
): ReturnType<typeof errorResult> | null {
  const decision = limiterFor(deps).check({
    ...(deps.principalId ? { principalId: deps.principalId } : {}),
    ...(canvasId !== undefined ? { canvasId } : {}),
    category
  });
  if (decision.allowed) return null;
  return errorResult(
    agentCanvasError(decision.code, decision.message, {
      retryable: decision.code === "rate-limited",
      ...(decision.suggestion ? { suggestion: decision.suggestion } : {}),
      ...(decision.retryAfterMs !== undefined ? { details: { retryAfterMs: decision.retryAfterMs } } : {})
    })
  );
}

/** 响应预算诊断（任务 5.6）：超限返回可执行的缩小查询建议，不截断成非法结构。 */
export function budgetGate(payload: unknown): ReturnType<typeof errorResult> | null {
  const decision = checkResponseBudget(payload);
  if (decision.allowed) return null;
  return errorResult(
    agentCanvasError(decision.code, decision.message, {
      retryable: false,
      ...(decision.suggestion ? { suggestion: decision.suggestion } : {})
    })
  );
}

/**
 * 审计包装（任务 7.5）。
 */
export async function auditWrap<T>(
  deps: AgentAuthoringToolDeps,
  tool: string,
  context: { canvasId?: string; requestId?: string },
  run: () => Promise<{ result: T; code?: string | undefined; revision?: number; nodes?: number; edges?: number; duplicate?: boolean; noop?: boolean }>
): Promise<T> {
  const limited = rateLimitGate(deps, "run", context.canvasId);
  if (limited) return limited as T;
  const startedAt = now(deps);
  const outcome = await run();
  if (deps.audit) {
    deps.audit({
      event: "agent-tool",
      tool,
      ...(context.canvasId !== undefined ? { canvasId: context.canvasId } : {}),
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(outcome.code !== undefined ? { code: outcome.code } : {}),
      ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
      ...(outcome.nodes !== undefined ? { nodeCount: outcome.nodes } : {}),
      ...(outcome.edges !== undefined ? { edgeCount: outcome.edges } : {}),
      ...(outcome.duplicate !== undefined ? { duplicate: outcome.duplicate } : {}),
      ...(outcome.noop !== undefined ? { noop: outcome.noop } : {}),
      latencyMs: Math.max(0, now(deps) - startedAt)
    });
  }
  return outcome.result;
}
