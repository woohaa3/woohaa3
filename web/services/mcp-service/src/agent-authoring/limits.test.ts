/**
 * Agent 速率与容量限制测试
 * （change: add-agent-canvas-authoring-mcp，任务 2.5 / 5.6）。
 */
import { describe, expect, it } from "vitest";
import { AgentRateLimiter, checkResponseBudget } from "./limits.js";

describe("AgentRateLimiter（任务 2.5）", () => {
  it("写工具超过每窗口上限即拒绝，且不影响其它维度", () => {
    let at = 0;
    const limiter = new AgentRateLimiter({ now: () => at });
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.check({ principalId: "u1", canvasId: "c1", category: "write" }).allowed).toBe(true);
    }
    const denied = limiter.check({ principalId: "u1", canvasId: "c1", category: "write" });
    expect(denied).toMatchObject({ allowed: false, code: "rate-limited" });
    // 其它 principal / 维度不受影响。
    expect(limiter.check({ principalId: "u2", canvasId: "c1", category: "write" }).allowed).toBe(true);
    expect(limiter.check({ principalId: "u1", canvasId: "c1", category: "read" }).allowed).toBe(true);
  });

  it("窗口结束后恢复", () => {
    let at = 0;
    const limiter = new AgentRateLimiter({ now: () => at });
    for (let i = 0; i < 30; i += 1) limiter.check({ principalId: "u1", canvasId: "c1", category: "write" });
    at += 60_001;
    expect(limiter.check({ principalId: "u1", canvasId: "c1", category: "write" }).allowed).toBe(true);
  });

  it("匿名调用按 anonymous 维度计数（不无限放行）", () => {
    let at = 0;
    const limiter = new AgentRateLimiter({ now: () => at });
    for (let i = 0; i < 30; i += 1) limiter.check({ category: "write" });
    expect(limiter.check({ category: "write" }).allowed).toBe(false);
  });

  it("key 数量有界（不因海量 principal 膨胀）", () => {
    const limiter = new AgentRateLimiter({
      now: () => 0,
      limits: {
        read: { windowMs: 60_000, max: 1 },
        write: { windowMs: 60_000, max: 1 },
        run: { windowMs: 60_000, max: 1 },
        maxResponseChars: 1,
        maxKeys: 5
      }
    });
    for (let i = 0; i < 100; i += 1) limiter.check({ principalId: `u-${i}`, category: "write" });
    expect(limiter.size).toBeLessThanOrEqual(5);
  });
});

describe("响应预算诊断（任务 5.6）", () => {
  it("超限返回可执行建议而非截断", () => {
    const big = { nodes: Array.from({ length: 100 }, () => ({ text: "x".repeat(5000) })) };
    const decision = checkResponseBudget(big);
    expect(decision).toMatchObject({ allowed: false, code: "limit-exceeded" });
    if (!decision.allowed) expect(decision.suggestion).toContain("nodeIds");
  });

  it("小响应放行", () => {
    expect(checkResponseBudget({ ok: true })).toEqual({ allowed: true });
  });
});
