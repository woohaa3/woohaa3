/**
 * Agent 工具速率与容量限制
 * （change: add-agent-canvas-authoring-mcp，任务 2.5 / 5.6）。
 *
 * 在 MCP 工具边界、**下游副作用之前**按 (principal, canvas, tool 类别) 维度做固定窗口计数，
 * 并对响应字符数做 token 预算诊断。拒绝发生在调用 Canvas 之前，因此不会产生任何写入。
 *
 * 进程内、有界：每个窗口最多保留 `maxKeys` 个 key，避免无界的 principal/canvas 组合撑爆内存。
 * MCP Service 无状态，速率限制是**尽力而为的入口保护**，不是权威配额。
 */

/** 窗口与配额（按工具类别）。 */
export const AGENT_RATE_LIMITS: AgentLimits = {
  /** discovery/read（capabilities/list/graph/changes）每窗口次数。 */
  read: { windowMs: 60_000, max: 120 },
  /** 写（validate/apply/create/connect/delete/set_node_prompt）每窗口次数。 */
  write: { windowMs: 60_000, max: 30 },
  /** 执行（run/status/cancel/output）每窗口次数。 */
  run: { windowMs: 60_000, max: 60 },
  /** 单响应文本字符预算；超出时返回可执行的缩小查询建议（任务 5.6）。 */
  maxResponseChars: 200_000,
  /** 单 key 维度数量上限（防内存膨胀）。 */
  maxKeys: 10_000
} as const;

export type AgentToolCategory = keyof Pick<typeof AGENT_RATE_LIMITS, "read" | "write" | "run">;

export type AgentLimitDecision =
  | { allowed: true }
  | { allowed: false; code: "rate-limited" | "limit-exceeded"; message: string; retryAfterMs?: number; suggestion?: string };

export type AgentLimitQuota = { windowMs: number; max: number };

export type AgentLimits = {
  read: AgentLimitQuota;
  write: AgentLimitQuota;
  run: AgentLimitQuota;
  maxResponseChars: number;
  maxKeys: number;
};

export type AgentRateLimiterOptions = {
  now?: () => number;
  limits?: AgentLimits;
};

/** 固定窗口计数器；key 维度有界。 */
export class AgentRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  private readonly limits: AgentLimits;

  constructor(options: AgentRateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.limits = options.limits ?? AGENT_RATE_LIMITS;
  }

  /**
   * 校验一次工具调用。`scope` 组合 principal/canvas/tool 类别；未认证 principal 用 `anonymous`
   * 维度但仍计数，避免匿名请求无限刷。
   */
  check(input: { principalId?: string; canvasId?: string; category: AgentToolCategory }): AgentLimitDecision {
    const quota = this.limits[input.category];
    const key = `${input.category}\u0000${input.principalId ?? "anonymous"}\u0000${input.canvasId ?? "*"}`;
    const at = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= at) {
      this.prune(at);
      this.buckets.set(key, { count: 1, resetAt: at + quota.windowMs });
      return { allowed: true };
    }
    if (existing.count >= quota.max) {
      return {
        allowed: false,
        code: "rate-limited",
        message: `${input.category} 调用超过每 ${Math.round(quota.windowMs / 1000)} 秒 ${quota.max} 次上限`,
        retryAfterMs: Math.max(0, existing.resetAt - at),
        suggestion: "请降低调用频率后重试"
      };
    }
    existing.count += 1;
    return { allowed: true };
  }

  /** 释放过期窗口，必要时按最旧窗口裁剪，保持 key 数有界。 */
  private prune(at: number): void {
    if (this.buckets.size < this.limits.maxKeys) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.limits.maxKeys) {
      const excess = this.buckets.size - this.limits.maxKeys + 1;
      let removed = 0;
      for (const key of this.buckets.keys()) {
        this.buckets.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * 响应字符预算诊断（任务 5.6）。
 *
 * 超限时不返回被截断的非法结构，而是给出可执行的缩小查询建议。
 */
export function checkResponseBudget(payload: unknown): AgentLimitDecision {
  const chars = JSON.stringify(payload)?.length ?? 0;
  if (chars <= AGENT_RATE_LIMITS.maxResponseChars) return { allowed: true };
  return {
    allowed: false,
    code: "limit-exceeded",
    message: `响应 ${chars} 字符超过 ${AGENT_RATE_LIMITS.maxResponseChars} 上限`,
    suggestion: "请使用 nodeIds/aroundNodeId+depth 缩小读取范围，或使用 limit/cursor 分页"
  };
}
