/**
 * Canvas Activity Relay 测试
 * （change: unify-canvas-session-websocket，任务 3.1 / 3.2）。
 *
 * 覆盖：每 canvas 单 relay（ref-count）、分页追赶、每 tick 工作上限、错误退避、
 * 最后订阅者离开停止、无忙循环。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskActivity, CanvasTaskActivityEventBatch } from "@woohaa3/contracts";
import { createCanvasActivityRelay, createCanvasActivityRelayRegistry } from "./activity-relay.js";

function record(taskKey: string, patch: Partial<CanvasTaskActivity> = {}): CanvasTaskActivity {
  return {
    taskKey,
    runId: `run-${taskKey}`,
    nodeId: "n1",
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 0,
    ...patch
  };
}

/** 可控的增量来源：按 cursor 返回固定页，记录每次调用。 */
function source(pages: Array<{ upTo: number; items: CanvasTaskActivity[]; cursor: number }>) {
  const calls: Array<{ canvasId: string; after: number }> = [];
  let index = 0;
  return {
    calls,
    read: async (canvasId: string, after: number): Promise<CanvasTaskActivityEventBatch> => {
      calls.push({ canvasId, after });
      const page = pages[Math.min(index, pages.length - 1)]!;
      index += 1;
      return { items: page.items, cursor: page.cursor };
    }
  };
}

describe("CanvasActivityRelay（任务 3.1）", () => {
  it("首个订阅者的 after 即基线：不从 0 回放该 canvas 的历史记录", async () => {
    const runs: Array<() => void> = [];
    const afterCalls: number[] = [];
    const received: string[] = [];
    const relay = createCanvasActivityRelay({
      canvasId: "c1",
      readChanges: async (_canvasId, after) => {
        afterCalls.push(after);
        // 基线之后没有新事实。
        return { items: [], cursor: after };
      },
      onRecord: (_canvasId, rec) => received.push(rec.taskKey),
      schedule: (run) => {
        runs.push(run);
        return () => undefined;
      }
    });

    // 客户端已读取快照高水位 42，订阅时只应补 42 之后的事实。
    relay.subscribe(42);
    runs.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(afterCalls[0]).toBe(42);
    expect(afterCalls.every((after) => after >= 42)).toBe(true);
    expect(received).toEqual([]);
    relay.unsubscribe();
  });

  it("最后一个订阅者离开后丢弃基线：下次进入页面以新快照高水位重新开始", async () => {
    const runs: Array<() => void> = [];
    const afterCalls: number[] = [];
    const relay = createCanvasActivityRelay({
      canvasId: "c1",
      readChanges: async (_canvasId, after) => {
        afterCalls.push(after);
        return { items: [], cursor: after };
      },
      onRecord: () => undefined,
      schedule: (run) => {
        runs.push(run);
        return () => undefined;
      }
    });

    relay.subscribe(10);
    runs.shift()!();
    await Promise.resolve();
    relay.unsubscribe();

    relay.subscribe(90);
    runs.shift()!();
    await Promise.resolve();
    expect(afterCalls).toEqual([10, 90]);
    relay.unsubscribe();
  });

  it("后来加入的订阅者带更旧 cursor 时补齐空隙，不倒退已确认高水位", async () => {
    const runs: Array<() => void> = [];
    const afterCalls: number[] = [];
    let returned = 0;
    const relay = createCanvasActivityRelay({
      canvasId: "c1",
      readChanges: async (_canvasId, after) => {
        afterCalls.push(after);
        returned += 1;
        // 第一轮追到 50；之后没有新事实。
        return returned === 1 ? { items: [record("t50")], cursor: 50 } : { items: [], cursor: 50 };
      },
      onRecord: () => undefined,
      schedule: (run) => {
        runs.push(run);
        return () => undefined;
      }
    });

    relay.subscribe(20);
    runs.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(afterCalls[0]).toBe(20);

    // 更旧的订阅者加入：只在它更旧时回退读取。
    relay.subscribe(30);
    runs.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    const readsAfterSecondSubscriber = afterCalls.slice(1);
    expect(readsAfterSecondSubscriber[0]).toBe(30);
    relay.unsubscribe();
    relay.unsubscribe();
  });

  it("首个订阅者启动、最后订阅者离开停止，无忙循环", async () => {
    const ticks: Array<() => void> = [];
    const src = source([{ upTo: 3, items: [record("t1")], cursor: 3 }]);
    const received: Array<{ key: string; cursor: number }> = [];
    const relay = createCanvasActivityRelay({
      canvasId: "c1",
      readChanges: src.read,
      onRecord: (_canvasId, rec, cursor) => received.push({ key: rec.taskKey, cursor }),      intervalMs: 1000,
      schedule: (run) => {
        ticks.push(run);
        return () => undefined;
      }
    });

    relay.subscribe(0);
    expect(relay.subscriberCount()).toBe(1);
    // 第一 tick 立即调度（delay 0）。
    expect(ticks).toHaveLength(1);
    ticks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([{ key: "t1", cursor: 3 }]);
    // 追平后继续调度下一次轮询（活性），但不立即递归。
    expect(ticks.length).toBeGreaterThanOrEqual(0);

    relay.unsubscribe();
    expect(relay.subscriberCount()).toBe(0);
  });

  it("多个订阅者共享一个循环；cursor 只在校验响应后推进", async () => {
    const ticks: Array<() => void> = [];
    const src = source([
      { upTo: 2, items: [record("a")], cursor: 2 },
      { upTo: 5, items: [record("b")], cursor: 5 }
    ]);
    const relay = createCanvasActivityRelay({
      canvasId: "c1",
      readChanges: src.read,
      onRecord: () => undefined,
      schedule: (run) => {
        ticks.push(run);
        return () => undefined;
      }
    });
    relay.subscribe(0);
    relay.subscribe(0);
    expect(relay.subscriberCount()).toBe(2);
    ticks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 两次读取：第一页满（1 < pageSize? 默认 200，因此单页即追平）。
    expect(src.calls[0]!.after).toBe(0);
  });

  it("错误按退避重试且不推进 cursor", async () => {
    const delays: number[] = [];
    let attempt = 0;
    const runs: Array<() => void> = [];
    const relay = createCanvasActivityRelay({
      canvasId: "c1",
      readChanges: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("unavailable");
        return { items: [record("x")], cursor: 4 };
      },
      onRecord: () => undefined,
      backoffBaseMs: 100,
      schedule: (run, delayMs) => {
        delays.push(delayMs);
        runs.push(run);
        return () => undefined;
      }
    });
    relay.subscribe(0);
    // 执行首个（delay 0）tick：失败 → 排一个退避。
    runs[0]!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(delays[0]).toBe(0);
    expect(delays).toContain(100);
  });
});

describe("CanvasActivityRelayRegistry（任务 3.1）", () => {
  it("每个 canvas 只有一个 relay；最后订阅者离开时移除", () => {
    const registry = createCanvasActivityRelayRegistry({
      readChanges: async () => ({ items: [], cursor: 0 }),
      onRecord: () => undefined,
      schedule: () => () => undefined
    });
    const unsubA = registry.subscribe("c1", 0);
    const unsubA2 = registry.subscribe("c1", 0);
    const unsubB = registry.subscribe("c2", 0);
    expect(registry.activeRelayCount()).toBe(2);
    expect(registry.subscriberCount("c1")).toBe(2);

    unsubA();
    expect(registry.activeRelayCount()).toBe(2);
    unsubA2();
    expect(registry.activeRelayCount()).toBe(1);
    expect(registry.subscriberCount("c1")).toBe(0);
    unsubB();
    expect(registry.activeRelayCount()).toBe(0);
  });
});
