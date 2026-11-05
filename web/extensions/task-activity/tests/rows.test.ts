/**
 * 统一记录模型与三个来源适配器
 * （change: 2026-10-22-unify-task-activity-rows，任务 1.1 / 1.2）。
 *
 * 覆盖：三个适配器各自的「是否进行中」判定、主行/次行文案、进度提取，以及「来源不决定
 * 寿命」这一点——同一份 `active: false` 在三种来源上产出同一种可关闭、可计时的记录。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import { adaptTaskRow } from "../src/frontend/adapt-task-row.js";
import { adaptJobRow, jobRowKey } from "../src/frontend/adapt-job-row.js";
import { compareRows, displayedProgressPercent } from "../src/frontend/rows.js";
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

describe("面板显示的进度（与节点进度环同一公式）", () => {
  const startedAt = "2026-01-01T00:00:00Z";
  const at = (seconds: number) => Date.parse(startedAt) + seconds * 1000;

  it("有上报值时不低于估算，且按百分比理解 0..1 分数", () => {
    const row = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelType: "image", progress: 0.42 }));
    expect(displayedProgressPercent(row, at(1))).toBe(42);
  });

  it("没有上报值时按节点种类估算经过时间", () => {
    const row = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelType: "image" }));
    // 图片 45s：22.5s ≈ 50%。
    expect(displayedProgressPercent(row, at(22.5))).toBe(50);
    // 视频 180s：同样的 22.5s 只有 12.5%。
    const video = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelType: "video" }));
    expect(displayedProgressPercent(video, at(22.5))).toBe(13);
  });

  it("缺 modelType 时用节点类型兜底，与节点估算同一个时长", () => {
    const row = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n" }));
    const capabilities = { resolveNodeType: () => "video" };
    expect(displayedProgressPercent(row, at(22.5), capabilities)).toBe(13);
    expect(displayedProgressPercent(row, at(22.5))).toBe(50);
  });

  it("终态不显示进度；非任务来源只用上报值", () => {
    const done = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", state: "succeeded" }));
    expect(displayedProgressPercent(done, at(10))).toBeUndefined();
    expect(displayedProgressPercent(adaptJobRow(job({ status: "running", progress: 0.4 })), at(1_000))).toBe(40);
  });

  it("运行中封顶 95%，不显示 100%", () => {
    const row = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelType: "image", progress: 1 }));
    expect(displayedProgressPercent(row, at(10_000))).toBe(95);
  });

  it("上报值是 0..100 百分比时按百分比理解，不夹成 100%", () => {
    // 部分 Provider 直接回 0..100；先夹到 0..1 会把 42 变成 1（100% → 封顶 95%），
    // 与节点读模型的 42% 对不上。
    const row = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", modelType: "image", progress: 42 }));
    expect(row.progress).toBeCloseTo(0.42, 10);
    expect(displayedProgressPercent(row, at(1))).toBe(42);
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

describe("统一排序", () => {
  it("按开始时间从新到旧，同一时刻用稳定 key 兜底", () => {
    const older = adaptJobRow(job({ id: "a", updatedAt: "2026-01-01T00:00:01Z", createdAt: "2026-01-01T00:00:01Z" }));    const newer = adaptTaskRow(task({ taskKey: "t", runId: "r", nodeId: "n", createdAt: "2026-01-01T00:00:05Z" }));
    expect([older, newer].sort(compareRows).map((row) => row.key)).toEqual(["task:r", "job:a"]);
    const sameA = adaptTaskRow(task({ taskKey: "b", runId: "b", nodeId: "n" }));
    const sameB = adaptTaskRow(task({ taskKey: "a", runId: "a", nodeId: "n" }));
    expect([sameA, sameB].sort(compareRows).map((row) => row.key)).toEqual(["task:a", "task:b"]);
  });
});
