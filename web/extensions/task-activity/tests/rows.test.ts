/**
 * 统一记录模型与三个来源适配器
 * （change: 2026-10-22-unify-task-activity-rows，任务 1.1 / 1.2）。
 *
 * 覆盖：三个适配器各自的「是否进行中」判定、主行/次行文案、进度提取，以及「来源不决定
 * 寿命」这一点——同一份 `active: false` 在三种来源上产出同一种可关闭、可计时的记录。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import type { CanvasGroupRun } from "@woohaa3/frontend/extension-api";
import { adaptTaskRow } from "../src/frontend/adapt-task-row.js";
import { adaptJobRow, jobRowKey } from "../src/frontend/adapt-job-row.js";
import { adaptGroupRow, canRetryGroupRun, canStopGroupRun, groupRowKey } from "../src/frontend/adapt-group-row.js";
import { compareRows, groupRunTone } from "../src/frontend/rows.js";
import type { ActivityFeedItem, BackgroundFeedJob } from "../src/frontend/store.js";

function task(patch: Partial<CanvasTaskActivity> & { taskKey: string; runId: string; nodeId: string }): ActivityFeedItem {
  return {
    state: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 0,
    optimistic: false,
    localFailure: false,
    ...patch
  };
}

const job = (patch: Partial<BackgroundFeedJob> = {}): BackgroundFeedJob => ({
  id: "shot-reference:c1:film:clip-1",
  canvasId: "c1",
  kind: "shot-reference-recording",
  title: "片场 · 镜头 1",
  status: "running",
  updatedAt: "2026-01-01T00:00:02Z",
  createdAt: "2026-01-01T00:00:02Z",
  ...patch
});

const groupRun = (patch: Partial<CanvasGroupRun> = {}): CanvasGroupRun => ({
  creation: {
    requestId: "creation-g1", canvasId: "c", rootGroupId: "g1", commandId: "cmd", turnRequestId: "request-g1",
    scopeEpoch: 1, stage: "accepted", conversationId: "conversation-g1", turnId: "turn-g1"
  },
  requestId: "request-g1",
  status: "running",
  label: "创作中",
  active: true,
  createdAt: "2026-01-01T00:00:03Z",
  ...patch
});

describe("任务记录适配器", () => {
  it("进行中判定来自任务状态，进度只在进行中暴露", () => {
    const running = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", state: "queued", progress: 0.4 }));
    expect(running.active).toBe(true);
    expect(running.progress).toBeCloseTo(0.4);
    expect(running.status).toBe("排队中");
    expect(running.tone).toBe("active");
    expect(running.actions.close).toBe(false);

    const done = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", state: "succeeded", progress: 1 }));
    expect(done.active).toBe(false);
    // 终态不再展示进度，且可关闭。
    expect(done.progress).toBeUndefined();
    expect(done.status).toBe("已完成");
    expect(done.tone).toBe("success");
    expect(done.actions.close).toBe(true);
  });

  it("主行优先使用注入的展示解析，缺省回退 modelKey / 模型类型 / 通用文案", () => {
    const resolved = adaptTaskRow(
      task({ taskKey: "t", runId: "r", nodeId: "n", modelKey: "gpt-image-2" }),
      { resolveTaskDisplay: () => ({ primary: "生成图片 · 海边日落", secondary: "图片主模型" }) }
    );
    expect(resolved.title).toBe("生成图片 · 海边日落");
    expect(resolved.secondary).toBe("图片主模型");

    expect(adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelKey: "gpt-image-2" })).title).toBe("gpt-image-2");
    expect(adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelType: "video" })).title).toBe("视频");
    expect(adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n" })).title).toBe("任务");
  });

  it("主行点击先按确切 run 打开 Agent 详情，无关联时回退作品生成历史", async () => {
    const openHistory = vi.fn();
    const openAgent = vi.fn(async () => false);
    const row = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n" }), { openTaskDetail: openAgent, openHistory });
    row.actions.openDetail?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(openHistory).toHaveBeenCalledTimes(1);

    const locate = vi.fn();
    const located = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n" }), { locateNode: locate });
    located.actions.locate?.();
    expect(locate).toHaveBeenCalledWith("n");
  });
});

describe("后台活动记录适配器", () => {
  it("queued|running 才算进行中；失败原因进入统一详情字段", () => {
    expect(adaptJobRow(job({ status: "queued" })).active).toBe(true);
    expect(adaptJobRow(job({ status: "running", progress: 0.4 })).progress).toBeCloseTo(0.4);
    const cancelled = adaptJobRow(job({ status: "cancelled" }));
    expect(cancelled.active).toBe(false);
    expect(cancelled.tone).toBe("muted");
    expect(cancelled.actions.close).toBe(true);
    expect(adaptJobRow(job({ status: "failed" })).detail).toBe("镜头录制失败，未返回具体原因。");
    expect(adaptJobRow(job({ status: "failed", detail: "第 0 秒超时" })).detail).toBe("第 0 秒超时");
    expect(adaptJobRow(job()).title).toBe("录制镜头参考 · 片场 · 镜头 1");
    expect(jobRowKey(job())).toBe("job:shot-reference:c1:film:clip-1");
  });
});

describe("组创作记录适配器", () => {
  it("进行中直接取组读模型的 active，状态文案与语义色按阶段映射", () => {
    const active = adaptGroupRow(groupRun(), { locateNode: vi.fn(), group: { writable: () => true } });
    expect(active.active).toBe(true);
    expect(active.status).toBe("创作中");
    expect(active.actions.pinOnOpen).toBe(true);
    expect(active.actions.autoOpenOnSelect).toBe(true);

    expect(adaptGroupRow(groupRun({ status: "succeeded", label: "已完成", active: false })).tone).toBe("success");
    expect(groupRunTone("partial")).toBe("danger");
    expect(groupRunTone("unknown")).toBe("danger");
    expect(groupRunTone("cancelled")).toBe("muted");
    expect(groupRowKey(groupRun())).toBe("group:creation-g1");
  });

  it("组动作只在装配能力与来源条件允许时出现", () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const writable = adaptGroupRow(groupRun(), {
      locateNode: vi.fn(),
      group: { action, openConversation: vi.fn(), writable: () => true, resolveTitle: () => "故事组" }
    });
    expect(writable.title).toBe("故事组");
    expect(writable.actions.stop).toBeTypeOf("function");
    expect(writable.actions.verify).toBeTypeOf("function");
    expect(writable.actions.openConversation).toBeTypeOf("function");
    // turnId 已落地：不允许重试原请求。
    expect(writable.actions.retry).toBeUndefined();

    // 没有装配能力时只有关闭/（可选的）定位，不伪造动作。
    const bare = adaptGroupRow(groupRun({ active: false, status: "succeeded", label: "已完成" }));
    expect(bare.actions.stop).toBeUndefined();
    expect(bare.actions.close).toBe(true);
    expect(bare.actions.locate).toBeUndefined();
  });

  it("停止与重试的条件由来源语义给出", () => {
    expect(canStopGroupRun(groupRun({ status: "unknown" }))).toBe(true);
    expect(canStopGroupRun(groupRun({ status: "succeeded", active: false }))).toBe(false);
    expect(canStopGroupRun(groupRun({ creation: { ...groupRun().creation, conversationId: undefined } }))).toBe(false);
    expect(canRetryGroupRun(groupRun({ creation: { ...groupRun().creation, turnId: undefined } }))).toBe(true);
    expect(canRetryGroupRun(groupRun())).toBe(false);
    expect(canRetryGroupRun(groupRun({
      creation: { ...groupRun().creation, turnId: undefined, error: { code: "group-target-missing", message: "目标缺失" } }
    }))).toBe(false);
  });
});

describe("统一排序", () => {
  it("按开始时间从新到旧，同一时刻用稳定 key 兜底", () => {
    const older = adaptJobRow(job({ id: "a", updatedAt: "2026-01-01T00:00:01Z", createdAt: "2026-01-01T00:00:01Z" }));    const newer = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", createdAt: "2026-01-01T00:00:05Z" }));
    expect([older, newer].sort(compareRows).map((row) => row.key)).toEqual(["task:r", "job:a"]);
    const sameA = adaptTaskRow(task({ taskKey: "b", runId: "b", nodeId: "n" }));
    const sameB = adaptTaskRow(task({ taskKey: "a", runId: "a", nodeId: "n" }));
    expect([sameA, sameB].sort(compareRows).map((row) => row.key)).toEqual(["task:a", "task:b"]);
  });
});
