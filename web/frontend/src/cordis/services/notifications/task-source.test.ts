/**
 * 任务结果事实源与授权范围（change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.1/7.2）。
 *
 * 覆盖规格里最容易被实现「顺手简化」掉的规则：
 * - 首次快照的终态只建基线，不发旧通知；
 * - 基线之后首次出现的终态可提醒（不要求先见过 running）；
 * - resync 重建基线，不遍历历史补发；
 * - recordRevision 变化不重复提醒；真实重试（新 attempt）可再次提醒；
 * - 取消/过程进度不提醒；
 * - 受控部署只提醒当前主体的任务，缺失 actor 不猜归属。
 *
 * 全为纯逻辑，不采集渲染。
 */
import { describe, expect, it } from "vitest";
import type { TaskExecutionSummary, TaskHistoryPage } from "@woohaa3/contracts";
import type { TaskHistoryConnectionStatus, TaskHistoryReader } from "../../../shared/task-history/client.js";
import { createTaskResultSource, type TaskResultEvent } from "./task-source.js";
import { decideNotificationScope } from "./scope.js";

function summary(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskKey: "t1",
    state: "succeeded",
    providerId: "p",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:01:00.000Z",
    durationMs: 60_000,
    recordRevision: 1,
    ...overrides
  };
}

/** 可编程 reader 替身：手动交付快照与增量。 */
function fakeReader(options: { baseline: TaskExecutionSummary[]; watermark?: number; nextCursor?: string; listError?: Error } = { baseline: [] }) {
  let onRecord: ((record: TaskExecutionSummary, cursor: number) => void) | null = null;
  let onStatus: ((status: TaskHistoryConnectionStatus) => void) | null = null;
  let onResync: (() => void) | null = null;
  let cursor = 0;
  let listCalls = 0;
  const reader: TaskHistoryReader = {
    async list(): Promise<TaskHistoryPage> {
      listCalls += 1;
      if (options.listError) throw options.listError;
      return {
        items: options.baseline,
        watermark: options.watermark ?? 10,
        ...(options.nextCursor ? { nextCursor: options.nextCursor } : {})
      };
    },
    async detail() {
      return { ok: false as const, code: "not-found", message: "n/a" };
    },
    async candidates() {
      return { providers: [], models: [] } as never;
    },
    subscribe(input) {
      cursor = input.cursor;
      onRecord = input.onRecord;
      onStatus = input.onStatus ?? null;
      onResync = input.onResync ?? null;
      return () => {
        onRecord = null;
      };
    }
  };
  return {
    reader,
    listCalls: () => listCalls,
    subscribedCursor: () => cursor,
    deliver: (record: TaskExecutionSummary, next = ++cursor) => onRecord?.(record, next),
    status: (connection: TaskHistoryConnectionStatus) => onStatus?.(connection),
    resync: () => onResync?.(),
    isSubscribed: () => onRecord !== null
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("任务结果事实源", () => {
  it("首次快照的终态只建基线，不通知", async () => {
    const events: TaskResultEvent[] = [];
    const fake = fakeReader({ baseline: [summary({ taskKey: "old-1" }), summary({ taskKey: "old-2", state: "failed" })] });
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: (event) => events.push(event)
    });
    await source.start();
    await flush();
    expect(events).toEqual([]);
    expect(source.getStatus().status).toBe("live");
    expect(fake.subscribedCursor()).toBe(10);
  });

  it("基线之后首次出现的终态可提醒，不必先观察到 running", async () => {
    const events: TaskResultEvent[] = [];
    const fake = fakeReader({ baseline: [] });
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: (event) => events.push(event)
    });
    await source.start();
    // 直接交付一个已成功记录（连接空隙内完成）。
    fake.deliver(summary({ taskKey: "t-new", state: "succeeded", canvasId: "c1", nodeId: "n1" }), 11);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskKey: "t-new", state: "succeeded", attempt: null });
    // 目标只带稳定身份。
    expect(events[0]!.target).toEqual({ taskKey: "t-new", canvasId: "c1", nodeId: "n1" });
  });

  it("同轮终态的 recordRevision 更新不重复提醒；真实重试（新 attempt）可再次提醒", async () => {
    const events: TaskResultEvent[] = [];
    const fake = fakeReader({ baseline: [] });
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: (event) => events.push(event)
    });
    await source.start();
    fake.deliver(summary({ taskKey: "t1", attempt: 1, recordRevision: 1 }), 11);
    // 元数据更新（同轮）。
    fake.deliver(summary({ taskKey: "t1", attempt: 1, recordRevision: 2 }), 12);
    // 真实重试：新 attempt。
    fake.deliver(summary({ taskKey: "t1", attempt: 2, recordRevision: 3 }), 13);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
  });

  it("取消与过程进度不提醒", async () => {
    const events: TaskResultEvent[] = [];
    const fake = fakeReader({ baseline: [] });
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: (event) => events.push(event)
    });
    await source.start();
    fake.deliver(summary({ taskKey: "running", state: "running", progress: 40 }), 11);
    fake.deliver(summary({ taskKey: "cancelled", state: "cancelled" }), 12);
    fake.deliver(summary({ taskKey: "queued", state: "queued" }), 13);
    expect(events).toEqual([]);
  });

  it("resync 重建基线：不把存量历史当新完成", async () => {
    const events: TaskResultEvent[] = [];
    const baseline: TaskExecutionSummary[] = [];
    let firstList = true;
    const fake = fakeReader({ baseline });
    const list = fake.reader.list.bind(fake.reader);
    (fake.reader as { list: TaskHistoryReader["list"] }).list = async (input, signal) => {
      if (firstList) {
        firstList = false;
        return list(input, signal);
      }
      // resync 时历史里已有一批终态：都只应进入新基线。
      return { items: [summary({ taskKey: "during-gap" })], watermark: 20 };
    };
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: (event) => events.push(event)
    });
    await source.start();
    fake.resync();
    await flush();
    expect(events).toEqual([]);
    // 新基线之后的新完成仍可提醒。
    fake.deliver(summary({ taskKey: "after-resync" }), 21);
    expect(events.map((event) => event.taskKey)).toEqual(["after-resync"]);
  });

  it("读面不可用：状态为 unavailable 且给出安全原因，不抛错", async () => {
    const source = createTaskResultSource({
      reader: null,
      scope: () => "scope",
      onResult: () => undefined
    });
    await source.start();
    expect(source.getStatus()).toEqual({
      status: "unavailable",
      reason: "任务历史读面不可用，通知暂不生效"
    });
  });

  it("读取抛错（授权不足）：保留 unavailable 与真实原因", async () => {
    const fake = fakeReader({ baseline: [], listError: new Error("需要 operator/admin 身份") });
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: () => undefined
    });
    await source.start();
    expect(source.getStatus()).toEqual({ status: "unavailable", reason: "需要 operator/admin 身份" });
  });

  it("数据范围切换：旧基线与去重键不带到新范围", async () => {
    const events: TaskResultEvent[] = [];
    const fake = fakeReader({ baseline: [] });
    let scope = "user-a";
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => scope,
      onResult: (event) => events.push(event)
    });
    await source.start();
    fake.deliver(summary({ taskKey: "t1" }), 11);
    expect(events).toHaveLength(1);

    scope = "user-b";
    await source.restart();
    await flush();
    // 新范围的相同 taskKey 是新事实（旧去重键已清空，且新范围重新建基线）。
    fake.deliver(summary({ taskKey: "t1" }), 12);
    expect(events.map((event) => event.taskKey)).toEqual(["t1", "t1"]);
    expect(source.trackedCount()).toBeGreaterThan(0);
  });

  it("dispose 后迟到交付不产生事件", async () => {
    const events: TaskResultEvent[] = [];
    const fake = fakeReader({ baseline: [] });
    const source = createTaskResultSource({
      reader: fake.reader,
      scope: () => "scope",
      onResult: (event) => events.push(event)
    });
    await source.start();
    source.stop();
    fake.deliver(summary({ taskKey: "late" }), 11);
    expect(events).toEqual([]);
  });
});

describe("通知的数据范围授权", () => {
  const own = summary({ taskKey: "own", actor: { subject: "alice" } });
  const other = summary({ taskKey: "other", actor: { subject: "bob" } });
  const unknownActor = summary({ taskKey: "legacy" });

  it("本地个人实例：单主体数据空间，全部属于当前使用者", () => {
    const session = { accessControl: false as const, dataScopeId: "local" };
    expect(decideNotificationScope(session, own)).toEqual({ accepted: true });
    expect(decideNotificationScope(session, unknownActor)).toEqual({ accepted: true });
  });

  it("受控部署：只接受当前 subject 的任务", () => {
    const session = {
      accessControl: true as const,
      dataScopeId: "d1",
      subject: "alice",
      identityProvider: "site",
      allowedActions: [] as never,
      policyVersion: "1"
    };
    expect(decideNotificationScope(session, own)).toEqual({ accepted: true });
    expect(decideNotificationScope(session, other)).toEqual({ accepted: false, reason: "not-own-task" });
    // 旧记录缺失 actor：不猜归属。
    expect(decideNotificationScope(session, unknownActor)).toEqual({ accepted: false, reason: "not-own-task" });
    expect(decideNotificationScope(session, summary({ actor: { unknown: true } }))).toEqual({
      accepted: false,
      reason: "not-own-task"
    });
  });

  it("身份未知：不放宽范围也不回退成全局", () => {
    expect(decideNotificationScope(null, own)).toEqual({ accepted: false, reason: "identity-unknown" });
    expect(decideNotificationScope(null, unknownActor)).toEqual({ accepted: false, reason: "identity-unknown" });
  });

  it("管理员可读他人任务不等于自动接收其通知", () => {
    const admin = {
      accessControl: true as const,
      dataScopeId: "d1",
      subject: "admin",
      identityProvider: "site",
      allowedActions: ["tasks.inspect"] as never,
      policyVersion: "1"
    };
    expect(decideNotificationScope(admin, other).accepted).toBe(false);
    // 管理员自己的任务仍然提醒。
    expect(decideNotificationScope(admin, summary({ actor: { subject: "admin" } })).accepted).toBe(true);
  });
});
