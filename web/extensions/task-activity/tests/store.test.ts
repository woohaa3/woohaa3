/**
 * Task activity store（change: 2026-09-29-add-canvas-task-activity-feed，任务 2.2 / 2.4；
 *   change: formalize-frontend-event-bus，任务 4.1–4.4）。
 *
 * 覆盖：started/updated/finished 统一入口、optimistic 后权威、updated 无 started、finished
 * 无 started、重复记录幂等、单调 cursor、taskKey 优先/runId 兜底、首提交排序稳定、本地拒绝、
 * 终态显示 10 秒、dismiss/clearTerminal、dispose 丢弃迟到。
 */
import { describe, expect, it, vi } from "vitest";
import type { BackgroundActivityJob, CanvasTaskActivity } from "@woohaa3/contracts";
import { ACTIVITY_EXIT_DURATION_MS, TaskActivityStore } from "../src/frontend/store.js";
import type { TaskActivityFinished, TaskActivityUpdated } from "@woohaa3/contracts";

function record(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): CanvasTaskActivity {
  return {
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 0,
    ...patch
  };
}

function updated(activity: CanvasTaskActivity, cursor: number): { name: "task.activity.updated"; payload: TaskActivityUpdated } {
  return {
    name: "task.activity.updated",
    payload: {
      source: "live",
      cursor,
      activity: activity as TaskActivityUpdated["activity"]
    }
  };
}

function finished(activity: CanvasTaskActivity, cursor: number): { name: "task.activity.finished"; payload: TaskActivityFinished } {
  return {
    name: "task.activity.finished",
    payload: {
      source: "live",
      cursor,
      activity: activity as never
    }
  };
}

function localRejected(input: { runId: string; nodeId: string; error: string }): { name: "task.activity.finished"; payload: TaskActivityFinished } {
  return {
    name: "task.activity.finished",
    payload: {
      source: "local-rejection",
      activity: {
        runId: input.runId,
        nodeId: input.nodeId,
        state: "failed",
        error: { message: input.error },
        updatedAt: "2026-01-01T00:00:02Z"
      }
    }
  };
}

/** 受控 store harness：手动抛事件。 */
function harness() {
  const store = new TaskActivityStore();
  return {
    store,
    start: (payload: { runId: string; jobId?: string; nodeId: string; modelType?: "language" | "image" | "video" | "audio"; modelKey?: string; createdAt?: string }) => {
      store.applyEvent({
        name: "task.activity.started",
        payload: {
          runId: payload.runId,
          jobId: payload.jobId ?? `job-${payload.runId}`,
          nodeId: payload.nodeId,
          state: "queued",
          ...(payload.modelType ? { modelType: payload.modelType } : {}),
          ...(payload.modelKey ? { modelKey: payload.modelKey } : {}),
          createdAt: payload.createdAt ?? "2026-01-01T00:00:00Z"
        }
      });
    },
    fire: (activity: CanvasTaskActivity, cursor: number) => store.applyEvent(updated(activity, cursor)),
    finish: (activity: CanvasTaskActivity, cursor: number) => store.applyEvent(finished(activity, cursor)),
    reject: (input: { runId: string; nodeId: string; error: string }) => store.applyEvent(localRejected(input))
  };
}

describe("TaskActivityStore（任务 4.1–4.4）", () => {
  it("started 插入乐观项；权威 updated 按 taskKey 合并升级为权威值", () => {
    const { store, start, fire } = harness();
    start({ runId: "r1", nodeId: "n1", modelType: "image" });
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0].optimistic).toBe(true);
    expect(store.getSnapshot().items[0].state).toBe("queued");

    fire(record({ taskKey: "worker-r1", runId: "r1", nodeId: "n1", state: "running", progress: 0.3 }), 1);
    expect(store.getSnapshot().items).toHaveLength(1);
    const item = store.getSnapshot().items[0];
    expect(item.taskKey).toBe("worker-r1");
    expect(item.optimistic).toBe(false);
    expect(item.progress).toBe(0.3);
    store.dispose();
  });

  it("updated 在没有 started 时也可权威 upsert（刷新/跨标签页/恢复）", () => {
    const { store, fire } = harness();
    fire(record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "running" }), 3);
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(["t1"]);
    expect(store.getSnapshot().cursor).toBe(3);
    store.dispose();
  });

  it("finished 在没有 started 时创建终态项并记未读", () => {
    const { store, finish } = harness();
    finish(record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "succeeded" }), 4);
    expect(store.getSnapshot().items[0].state).toBe("succeeded");
    expect(store.getSnapshot().unread).toBe(1);
    store.dispose();
  });

  it("重复记录幂等；权威进度更新替换而不新增", () => {
    const { store, fire } = harness();
    fire(record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "running", progress: 0.3 }), 1);
    fire(record({ taskKey: "t1", runId: "r1", nodeId: "n1", state: "running", progress: 0.6 }), 2);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0].progress).toBe(0.6);
    store.dispose();
  });

  it("新任务在顶部，迟到记录和状态更新保持首次提交排序", () => {
    const { store, start, fire, finish } = harness();
    start({ runId: "r1", nodeId: "n1", createdAt: "2026-01-01T00:00:01Z" });
    start({ runId: "r2", nodeId: "n1", createdAt: "2026-01-01T00:00:02Z" });
    expect(store.getSnapshot().items.map((item) => item.runId)).toEqual(["r2", "r1"]);
    // 迟到的旧记录应排在底部。
    fire(record({ taskKey: "r0", runId: "r0", nodeId: "n1", createdAt: "2026-01-01T00:00:00Z" }), 1);
    // 后提交的先完成。
    finish(record({ taskKey: "r2", runId: "r2", nodeId: "n1", state: "succeeded", createdAt: "2026-01-01T00:00:02Z" }), 1);
    finish(record({ taskKey: "r1", runId: "r1", nodeId: "n1", state: "failed", createdAt: "2026-01-01T00:00:01Z" }), 2);
    expect(store.getSnapshot().items.map((item) => item.runId)).toEqual(["r2", "r1", "r0"]);
    store.dispose();
  });

  it("local-rejection finished 只结算匹配的乐观 run，不伪造 taskKey", () => {
    const { store, start, reject } = harness();
    start({ runId: "r1", nodeId: "n1" });
    reject({ runId: "r1", nodeId: "n1", error: "被拒绝" });
    const item = store.getSnapshot().items[0];
    expect(item.localFailure).toBe(true);
    expect(item.state).toBe("failed");
    expect(item.taskKey).toBe("r1");
    expect(item.error).toEqual({ message: "被拒绝" });
    // 不匹配的 run 不受影响。
    reject({ runId: "ghost", nodeId: "n1", error: "x" });
    expect(store.getSnapshot().items).toHaveLength(1);
    store.dispose();
  });

  it("终态显示十秒后退出再移除，重复投递不续期或复活", () => {
    vi.useFakeTimers();
    const { store, finish } = harness();
    try {
      const done = record({ taskKey: "t", runId: "rt", nodeId: "n1", state: "succeeded" });
      finish(done, 1);
      vi.advanceTimersByTime(9999);
      expect(store.getSnapshot().items).toHaveLength(1);
      expect(store.getSnapshot().exitingKeys).toEqual([]);
      finish(done, 2);
      vi.advanceTimersByTime(1);
      expect(store.getSnapshot().items).toHaveLength(1);
      expect(store.getSnapshot().exitingKeys).toEqual(["task:rt"]);
      finish({ ...done, state: "running" }, 3);
      expect(store.getSnapshot().items[0].state).toBe("succeeded");
      vi.advanceTimersByTime(ACTIVITY_EXIT_DURATION_MS - 1);
      expect(store.getSnapshot().items).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.getSnapshot().items).toHaveLength(0);
      expect(store.getSnapshot().exitingKeys).toEqual([]);
      expect(store.getSnapshot().unread).toBe(0);
      finish(done, 3);
      expect(store.getSnapshot().items).toHaveLength(0);
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });

  it("dismiss / clearTerminal 不删除 active 项", () => {
    const { store, fire, finish } = harness();
    fire(record({ taskKey: "a", runId: "ra", nodeId: "n1", state: "running" }), 1);
    finish(record({ taskKey: "b", runId: "rb", nodeId: "n1", state: "succeeded" }), 2);
    store.dismiss("a");
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(["a", "b"]);
    store.clearTerminal();
    expect(store.getSnapshot().items.map((item) => item.taskKey)).toEqual(["a"]);
    store.dispose();
  });

  it("dispose 后迟到事件不再改变状态", () => {
    const { store, start, finish } = harness();
    start({ runId: "r1", nodeId: "n1" });
    const before = store.getSnapshot().items.length;
    store.dispose();
    finish(record({ taskKey: "late", runId: "late", nodeId: "n1", state: "succeeded" }), 9);
    expect(store.getSnapshot().items.length).toBe(before);
  });

  it("较旧 cursor 的记录不覆盖较新权威状态（补偿/live 乱序）", () => {
    const { store, fire, finish } = harness();
    fire(record({ taskKey: "t", runId: "rt", nodeId: "n1", state: "running", progress: 0.2 }), 5);
    // 更旧的 cursor 带着终态到达：不得回退状态。
    finish(record({ taskKey: "t", runId: "rt", nodeId: "n1", state: "succeeded" }), 4);
    expect(store.getSnapshot().items[0].state).toBe("running");
    expect(store.getSnapshot().items[0].progress).toBe(0.2);
    // 更高 cursor 的终态正常应用。
    finish(record({ taskKey: "t", runId: "rt", nodeId: "n1", state: "succeeded" }), 6);
    expect(store.getSnapshot().items[0].state).toBe("succeeded");
    store.dispose();
  });

  it("taskKey 优先、runId 兜底合并，只保留一条", () => {
    const { store, start, fire } = harness();
    start({ runId: "r1", nodeId: "n1" });
    // 服务端还没有 taskKey 概念时的 runId 兜底合并。
    fire(record({ taskKey: "worker-r1", runId: "r1", nodeId: "n1", state: "running", progress: 0.3 }), 1);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0].taskKey).toBe("worker-r1");
    store.dispose();
  });
});

describe("后台活动（扩展发布的非任务记录）", () => {
  const job = (patch: Partial<BackgroundActivityJob> = {}): BackgroundActivityJob => ({
    id: "shot-reference:c1:film:clip-1",
    canvasId: "c1",
    kind: "shot-reference-recording",
    title: "片场 · 镜头 1",
    status: "queued",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch
  });

  it("按 id 幂等 upsert，迟到旧时间戳不回退", () => {
    const store = new TaskActivityStore();
    store.applyJob(job());
    store.applyJob(job({ status: "running", progress: 0.4, updatedAt: "2026-01-01T00:00:02Z" }));
    store.applyJob(job({ status: "queued", updatedAt: "2026-01-01T00:00:01Z" }));
    expect(store.getSnapshot().jobs).toHaveLength(1);
    expect(store.getSnapshot().jobs[0]).toMatchObject({ status: "running", progress: 0.4 });
    expect(store.getSnapshot().hasActive).toBe(true);
    store.dispose();
  });

  it("active 不可关闭，终态可关闭；clearTerminal 一并清理", () => {
    const store = new TaskActivityStore();
    store.applyJob(job());
    store.dismissJob(job().id);
    expect(store.getSnapshot().jobs).toHaveLength(1);

    store.applyJob(job({ status: "succeeded", progress: 1, updatedAt: "2026-01-01T00:00:03Z" }));
    store.applyJob(job({ id: "shot-reference:c1:film:clip-2", status: "failed", updatedAt: "2026-01-01T00:00:03Z" }));
    store.dismissJob(job().id);
    expect(store.getSnapshot().jobs.map((entry) => entry.id)).toEqual(["shot-reference:c1:film:clip-2"]);

    store.clearTerminal();
    expect(store.getSnapshot().jobs).toHaveLength(0);
    expect(store.getSnapshot().hasActive).toBe(false);
    store.dispose();
  });
});


describe("统一活动显示期限", () => {
  it("运行超过十秒仍保留，成功、失败与取消从结束时计时", () => {
    vi.useFakeTimers();
    const store = new TaskActivityStore();
    try {
      for (let index = 0; index < 3; index++) {
        store.applyServerRecord(record({ taskKey: `t${index}`, runId: `r${index}`, nodeId: "n" }), 1);
      }
      vi.advanceTimersByTime(20_000);
      expect(store.getSnapshot().items).toHaveLength(3);
      for (const [index, state] of (["succeeded", "failed", "cancelled"] as const).entries()) {
        store.applyServerRecord(record({ taskKey: `t${index}`, runId: `r${index}`, nodeId: "n", state }), 2);
      }
      vi.advanceTimersByTime(9999);
      expect(store.getSnapshot().items).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(store.getSnapshot().exitingKeys).toHaveLength(3);
      vi.advanceTimersByTime(ACTIVITY_EXIT_DURATION_MS);
      expect(store.getSnapshot().items).toHaveLength(0);
    } finally { store.dispose(); vi.useRealTimers(); }
  });

  it("后台活动结束十秒后退出再移除，重试独立计时，保留首次开始时间", () => {
    vi.useFakeTimers();
    const store = new TaskActivityStore();
    const job: BackgroundActivityJob = {
      id: "attempt-1", canvasId: "c", kind: "shot-reference-recording",
      title: "镜头", status: "running", updatedAt: "2026-01-01T00:00:00Z"
    };
    try {
      store.applyJob(job);
      vi.advanceTimersByTime(20_000);
      expect(store.getSnapshot().jobs).toHaveLength(1);
      store.applyJob({ ...job, status: "failed", updatedAt: "2026-01-01T00:00:20Z" });
      expect(store.getSnapshot().jobs[0].createdAt).toBe(job.updatedAt);
      vi.advanceTimersByTime(5000);
      store.applyJob({ ...job, id: "attempt-2", status: "succeeded" });
      store.applyJob({ ...job, status: "failed", updatedAt: "2026-01-01T00:00:25Z" });
      vi.advanceTimersByTime(5000);
      expect(store.getSnapshot().exitingKeys).toEqual(["job:attempt-1"]);
      vi.advanceTimersByTime(ACTIVITY_EXIT_DURATION_MS);
      expect(store.getSnapshot().jobs.map(job => job.id)).toEqual(["attempt-2"]);
      store.applyJob({ ...job, status: "failed", updatedAt: "2026-01-01T00:00:30Z" });
      expect(store.getSnapshot().jobs).toHaveLength(1);
      vi.advanceTimersByTime(5000);
      expect(store.getSnapshot().jobs).toHaveLength(0);
    } finally { store.dispose(); vi.useRealTimers(); }
  });

  it("dispose 撤销活动计时器，手动清除也不留计时器", () => {
    vi.useFakeTimers();
    const store = new TaskActivityStore();
    try {
      store.applyServerRecord(record({ taskKey: "t", runId: "r", nodeId: "n", state: "failed" }), 1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(10_000);
      expect(store.getSnapshot().exitingKeys).toEqual(["task:r"]);
      store.clearTerminal();
      expect(vi.getTimerCount()).toBe(0);
      expect(store.getSnapshot().exitingKeys).toEqual([]);
      store.applyServerRecord(record({ taskKey: "t2", runId: "r2", nodeId: "n", state: "cancelled" }), 2);
      vi.advanceTimersByTime(10_000);
      store.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { store.dispose(); vi.useRealTimers(); }
  });
});
