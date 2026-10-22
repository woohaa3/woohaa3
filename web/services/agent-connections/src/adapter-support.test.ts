/**
 * 适配器共享运行支持测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.2/5.3/7.3 验收）。
 *
 * 覆盖：回合预算（循环/工具/输出/时长）、逐次工具授权、取消登记、发送前能力预检、原生会话索引。
 */
import { describe, expect, it } from "vitest";
import type { ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import {
  authorizeToolCall,
  connectionCapabilities,
  createNativeSessionIndex,
  createTurnBudget,
  createTurnOutcomeJournal,
  createTurnRegistry,
  preflightInput
} from "./adapter-support.js";

const fullCapabilities = connectionCapabilities({ discussion: true, tools: true, imageInput: true, structuredResult: true });

describe("回合预算（任务 5.2）", () => {
  it("默认长时间与大正文不会在完成后被判超预算", () => {
    let now = 0;
    const budget = createTurnBudget({}, () => now);
    now = 30 * 24 * 60 * 60_000;
    expect(budget.expired()).toBe(false);
    expect(budget.addOutput(4 * 1024 * 1024)).toBe(true);
    expect(budget.exceededReason()).toBeUndefined();
    expect(createTurnBudget({ maxDurationMs: 0 }, () => now).expired(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
  it("循环/工具/输出分别超限并给出原因", () => {
    const budget = createTurnBudget({ maxIterations: 1, maxToolCalls: 1, maxOutputBytes: 8 });
    expect(budget.nextIteration()).toBe(true);
    expect(budget.nextIteration()).toBe(false);

    const toolBudget = createTurnBudget({ maxToolCalls: 1 });
    expect(toolBudget.useToolCall()).toBe(true);
    expect(toolBudget.useToolCall()).toBe(false);

    const outputBudget = createTurnBudget({ maxOutputBytes: 8 });
    expect(outputBudget.addOutput(4)).toBe(true);
    expect(outputBudget.addOutput(8)).toBe(false);
  });

  it("时长超限由注入时钟判定", () => {
    let now = 0;
    const budget = createTurnBudget({ maxDurationMs: 1000 }, () => now);
    expect(budget.expired()).toBe(false);
    now = 2000;
    expect(budget.expired()).toBe(true);
    expect(budget.exceededReason()).toContain("时长");
  });
});

describe("逐次工具授权（任务 5.2/7.3）", () => {
  const facade = (allow: (tool: string) => boolean): ApplicationToolDelegationFacade => ({
    issue: async () => ({ token: "t", canvasIds: [], nodeIds: [], tools: [], maxCalls: 1, expiresAt: Date.now() + 1000 }),
    revoke: () => undefined,
    authorize: ({ tool }) => (allow(tool) ? { ok: true } : { ok: false, reason: `工具 ${tool} 越权` })
  });

  it("每次调用都重新校验同一冻结范围；越权拒绝", () => {
    const gate = facade((tool) => tool === "read_node");
    expect(authorizeToolCall(gate, { token: "t", tool: "read_node" })).toEqual({ ok: true });
    const denied = authorizeToolCall(gate, { token: "t", tool: "write_node" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("capability-unsupported");
  });

  it("未配置 facade 时 fail closed", () => {
    const denied = authorizeToolCall(undefined, { token: "t", tool: "write_node" });
    expect(denied.ok).toBe(false);
  });
});

describe("取消登记（任务 4.3/7.3）", () => {
  it("同一 requestId 复用控制器，release 后不再命中", () => {
    const registry = createTurnRegistry();
    const first = registry.register("req-1");
    expect(registry.register("req-1")).toBe(first);
    expect(registry.active()).toEqual(["req-1"]);
    registry.release("req-1");
    expect(registry.get("req-1")).toBeUndefined();
  });
});

describe("发送前输入预检（任务 5.3）", () => {
  it("未声明图片/工具能力时按能力拒绝", () => {
    const noImage = connectionCapabilities({ tools: true });
    expect(preflightInput({ capabilities: noImage, wantTools: true, imageCount: 0, wantStructuredResult: false })).toEqual({ ok: true });
    const imageDenied = preflightInput({ capabilities: noImage, wantTools: false, imageCount: 1, wantStructuredResult: false });
    expect(imageDenied.ok).toBe(false);
    const toolDenied = preflightInput({ capabilities: connectionCapabilities({}), wantTools: true, imageCount: 0, wantStructuredResult: false });
    expect(toolDenied.ok).toBe(false);
  });

  it("支持时放行", () => {
    expect(preflightInput({ capabilities: fullCapabilities, wantTools: true, imageCount: 2, wantStructuredResult: true })).toEqual({ ok: true });
  });
});

describe("回合终态日志（任务 4.3/5.4）", () => {
  it("记录已落定终态；无记录返回 null（不重跑推理）", () => {
    const journal = createTurnOutcomeJournal();
    expect(journal.get("req-1")).toBeNull();
    journal.set("req-1", { status: "succeeded", assistantText: "done" });
    expect(journal.get("req-1")).toEqual({ status: "succeeded", assistantText: "done" });
    expect(journal.settled()).toEqual(["req-1"]);
    journal.release("req-1");
    expect(journal.get("req-1")).toBeNull();
  });
});

describe("原生会话索引（任务 2.2/7.1）", () => {
  it("按连接 + credentialEpoch 归属；epoch 变化不复用", () => {
    const index = createNativeSessionIndex();
    index.set("c1", 1, "thread-1");
    expect(index.get("c1", 1)).toBe("thread-1");
    expect(index.get("c1", 2)).toBeNull();
    index.clear("c1");
    expect(index.get("c1", 1)).toBeNull();
  });
});
