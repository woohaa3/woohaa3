/**
 * Task Activity Event Bridge 测试
 * （change: formalize-frontend-event-bus，任务 5.1 / 5.4）。
 *
 * 覆盖：snapshot active → updated(snapshot)、live active → updated、live/recovery terminal →
 * finished、malformed 记录在 emit 前拒绝、session 错误触发有限 /changes 补偿。
 */
import { describe, expect, it } from "vitest";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import { createTaskActivityEventBridge } from "../src/frontend/bridge.js";
import type { TaskActivityFinishedRemote, TaskActivityUpdated } from "@woohaa3/contracts";

function record(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): CanvasTaskActivity {
  return {
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 0,
    ...patch
  };
}

function sink() {
  const updated: TaskActivityUpdated[] = [];
  const finished: TaskActivityFinishedRemote[] = [];
  return {
    updated,
    finished,
    sink: {
      updated: (payload: TaskActivityUpdated) => updated.push(payload),
      finished: (payload: TaskActivityFinishedRemote) => finished.push(payload)
    }
  };
}

describe("TaskActivityEventBridge（任务 5.1）", () => {
  it("进入页面只取快照高水位，不展示历史；从高水位订阅新活动", async () => {
    const s = sink();
    let subscribed: number | null = null;
    const bridge = createTaskActivityEventBridge({
      sink: s.sink,
      sources: {
        readSnapshot: async () => ({ cursor: 42, active: [record({ taskKey: "a", runId: "ra", nodeId: "n1", state: "running" })], recent: [record({ taskKey: "old", runId: "old", nodeId: "n1", state: "succeeded" })] }),
        subscribe: (input) => {
          subscribed = input.cursor;
          return () => undefined;
        }
      }
    });
    await bridge.start();
    expect(s.updated).toEqual([]);
    expect(s.finished).toEqual([]);
    expect(subscribed).toBe(42);
    bridge.stop();
  });

  it("高水位读取失败时不从零订阅历史", async () => {
    const s = sink();
    let subscribed = false;
    const bridge = createTaskActivityEventBridge({ sink: s.sink, sources: {
      readSnapshot: async () => { throw new Error("offline"); },
      subscribe: () => { subscribed = true; return () => undefined; }
    } });
    await bridge.start();
    expect(subscribed).toBe(false);
    expect(s.updated).toEqual([]);
    expect(s.finished).toEqual([]);
    bridge.stop();
  });

  it("live terminal 记录分类为 finished", async () => {
    const s = sink();
    let emit: ((record: CanvasTaskActivity, cursor: number) => void) | null = null;
    const bridge = createTaskActivityEventBridge({
      sink: s.sink,
      sources: {
        readSnapshot: async () => ({ cursor: 0 }),
        subscribe: (input) => {
          emit = input.onRecord;
          return () => undefined;
        }
      }
    });
    await bridge.start();
    emit!(record({ taskKey: "t", runId: "r", nodeId: "n1", state: "succeeded" }), 7);
    expect(s.finished).toEqual([{ source: "live", cursor: 7, activity: expect.objectContaining({ taskKey: "t" }) }]);
    bridge.stop();
    // stop 后迟到记录被忽略。
    emit!(record({ taskKey: "late", runId: "rl", nodeId: "n1", state: "running" }), 8);
    expect(s.updated).toEqual([]);
  });

  it("malformed 记录在 emit 前被拒绝", async () => {
    const s = sink();
    let emit: ((record: CanvasTaskActivity, cursor: number) => void) | null = null;
    const rejected: string[] = [];
    const bridge = createTaskActivityEventBridge({
      sink: s.sink,
      sources: {
        readSnapshot: async () => ({ cursor: 0 }),
        subscribe: (input) => {
          emit = input.onRecord;
          return () => undefined;
        }
      },
      logger: (event) => rejected.push(event.code ?? "")
    });
    await bridge.start();
    // 缺 runId 的记录不是合法安全活动项。
    emit!({ taskKey: "t", nodeId: "n", state: "running", createdAt: "x", updatedAt: "y", durationMs: 0 } as never, 1);
    expect(s.updated).toEqual([]);
    expect(s.finished).toEqual([]);
    expect(rejected).toContain("malformed-record");
    bridge.stop();
  });

  it("session 错误触发有限 /changes 补偿", async () => {
    const s = sink();
    let fail: ((error: unknown) => void) | null = null;
    const changeCalls: number[] = [];
    const bridge = createTaskActivityEventBridge({
      sink: s.sink,
      sources: {
        readSnapshot: async () => ({ cursor: 0 }),
        readChanges: async (after) => {
          changeCalls.push(after);
          return { items: [record({ taskKey: "recovered", runId: "rr", nodeId: "n1", state: "failed" })], cursor: 9 };
        },
        subscribe: (input) => {
          fail = input.onError ?? null;
          return () => undefined;
        }
      }
    });
    await bridge.start();
    fail!(new Error("session down"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(changeCalls).toEqual([0]);
    expect(s.finished).toHaveLength(1);
    bridge.stop();
  });
});
