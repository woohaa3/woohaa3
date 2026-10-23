/**
 * Agent authoring 工具面：依赖与审计
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05；
 *  change: 2026-10-22-remove-agent-execution-limits，任务 3.4 / 4.2 —— 删除固定窗口频率与
 *  响应字符总量拒绝）。
 */
import type { AgentCanvasError } from "@woohaa3/contracts";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";

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
  audit?: (event: AgentAuditEvent) => void;
  auditTool?: string;
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

/**
 * 审计包装（任务 7.5）。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 3.4：这里原本先做固定窗口频率门禁
 * （read 120、write 30、run 60 每分钟）。频率不是权限，已删除；越权/非法请求仍由下游权限与
 * schema 在副作用前拒绝。
 */
export async function auditWrap<T>(
  deps: AgentAuthoringToolDeps,
  tool: string,
  context: { canvasId?: string; requestId?: string },
  run: () => Promise<{ result: T; code?: string | undefined; revision?: number; nodes?: number; edges?: number; duplicate?: boolean; noop?: boolean }>
): Promise<T> {
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
