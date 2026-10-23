/**
 * 适配器共享运行支持测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.2/5.3/7.3 验收；
 *  change: 2026-10-22-remove-agent-execution-limits，任务 2.2 改为观察量）。
 *
 * 覆盖：回合观察（不计额度）、逐次工具授权、取消登记、发送前能力预检、原生会话索引。
 */
import { describe, expect, it } from "vitest";
import type { ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import {
  authorizeToolCall,
  connectionCapabilities,
  createNativeSessionIndex,
  createTurnObserver,
  createTurnOutcomeJournal,
  createTurnRegistry,
  preflightInput
} from "./adapter-support.js";

const fullCapabilities = connectionCapabilities({ discussion: true, tools: true, imageInput: true, structuredResult: true });

describe("回合观察（任务 2.2）", () => {
  it("长时间与大量输出不会被判超限（不存在额度判定）", () => {
    let now = 0;
    const observation = createTurnObserver(() => now);
    now = 30 * 24 * 60 * 60_000;
    observation.addOutput(64 * 1024 * 1024);
    const snapshot = observation.observe();
    expect(snapshot.elapsedMs).toBe(30 * 24 * 60 * 60_000);
    expect(snapshot.outputBytes).toBe(64 * 1024 * 1024);
    expect("expired" in observation).toBe(false);
    expect("exceededReason" in observation).toBe(false);
  });

  it("超过原 24 次工具事件仍只累计观察量", () => {
    const observation = createTurnObserver();
    for (let index = 0; index < 200; index += 1) observation.noteToolCall();
    expect(observation.observe().toolCalls).toBe(200);
  });
});

describe("逐次工具授权（任务 5.2/7.3）", () => {
  const facade = (allow: (tool: string) => boolean): ApplicationToolDelegationFacade => ({
    issue: async () => ({ token: "t", canvasIds: [], nodeIds: [], tools: [], workId: "w" }),
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
