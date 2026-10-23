/**
 * Agent 工具容量与分页参数测试
 * （change: add-agent-canvas-authoring-mcp，任务 2.5 / 5.6；
 *  change: 2026-10-22-remove-agent-execution-limits，任务 3.4 / 4.2）。
 *
 * 原固定窗口频率门禁（read 120 / write 30 / run 60 每分钟）与 20 万字符响应总量拒绝已删除：
 * 这里只保留实现调度/传输的分页参数，不构成拒绝完整工作的额度。
 */
import { describe, expect, it } from "vitest";
import { AGENT_PAGING } from "./limits.js";

describe("Agent 分页参数（任务 3.4）", () => {
  it("只保留传输分页大小，不暴露频率或响应总量额度", async () => {
    expect(AGENT_PAGING.graphPageSize).toBeGreaterThan(0);
    expect(AGENT_PAGING.maxKeys).toBeGreaterThan(0);
    // 旧额度常量与检查函数已在源码中删除（此处断言模块不导出它们）。
    const module = await import("./limits.js");
    expect("AGENT_RATE_LIMITS" in module).toBe(false);
    expect("AgentRateLimiter" in module).toBe(false);
    expect("checkResponseBudget" in module).toBe(false);
  });
});
