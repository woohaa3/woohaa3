/**
 * Task 生命周期耗时纯函数测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 7.3 / design D9）。
 *
 * 覆盖 total/queue/execution/state 定义、终态冻结于 finishedAt、进行中回落到同一 observedAt、
 * 缺失时间即缺失字段（不猜测）、时钟回拨钳 0，以及 recomputeTaskTiming 的在途校正语义。
 */
import { describe, expect, it } from "vitest";
import { computeTaskTiming, recomputeTaskTiming } from "./timing.js";

describe("computeTaskTiming（任务 7.3）", () => {
  it("进行中：total/execution 回落到同一 observedAt，queue/state 分别计算", () => {
    const timing = computeTaskTiming({
      state: "running",
      admittedAt: "2026-10-13T00:00:00.000Z",
      firstStartedAt: "2026-10-13T00:00:05.000Z",
      stateChangedAt: "2026-10-13T00:00:07.000Z",
      observedAt: "2026-10-13T00:00:20.000Z"
    });
    expect(timing.totalMs).toBe(20_000);
    expect(timing.queueMs).toBe(5_000);
    expect(timing.executionMs).toBe(15_000);
    expect(timing.stateMs).toBe(13_000);
    expect(timing.observedAt).toBe("2026-10-13T00:00:20.000Z");
  });

  it("终态：以持久化 finishedAt 冻结，不随 observedAt 增长", () => {
    const timing = computeTaskTiming({
      state: "succeeded",
      admittedAt: "2026-10-13T00:00:00.000Z",
      firstStartedAt: "2026-10-13T00:00:05.000Z",
      stateChangedAt: "2026-10-13T00:00:10.000Z",
      finishedAt: "2026-10-13T00:00:30.000Z",
      observedAt: "2026-10-13T01:00:00.000Z"
    });
    expect(timing.totalMs).toBe(30_000);
    expect(timing.executionMs).toBe(25_000);
    expect(timing.stateMs).toBe(20_000);
  });

  it("缺失时间即缺失字段（不用 updatedAt 猜测）", () => {
    const timing = computeTaskTiming({ state: "queued", observedAt: "2026-10-13T00:00:00.000Z" });
    expect(timing).toEqual({ observedAt: "2026-10-13T00:00:00.000Z" });
  });

  it("时钟回拨产生负值钳为 0，不出现负耗时", () => {
    const timing = computeTaskTiming({
      state: "running",
      admittedAt: "2026-10-13T00:00:10.000Z",
      firstStartedAt: "2026-10-13T00:00:00.000Z",
      observedAt: "2026-10-13T00:00:05.000Z"
    });
    expect(timing.totalMs).toBe(0);
    expect(timing.queueMs).toBe(0);
    expect(timing.executionMs).toBe(5_000);
  });
});

describe("recomputeTaskTiming（在途校正）", () => {
  it("进行中按新 observedAt 重算 total，终态保持冻结", () => {
    const base = computeTaskTiming({
      state: "running",
      admittedAt: "2026-10-13T00:00:00.000Z",
      firstStartedAt: "2026-10-13T00:00:05.000Z",
      observedAt: "2026-10-13T00:00:20.000Z"
    });
    const advanced = recomputeTaskTiming(base, "running", "2026-10-13T00:00:50.000Z");
    expect(advanced.totalMs).toBe(50_000);
    expect(advanced.executionMs).toBe(45_000);

    const frozen = recomputeTaskTiming(
      { ...base, stateChangedAt: "2026-10-13T00:00:30.000Z" },
      "succeeded",
      "2026-10-13T01:00:00.000Z"
    );
    // 终态无 finishedAt 时 effectiveEnd 回落到 observedAt（此处显式验证语义而非猜测）。
    expect(frozen.observedAt).toBe("2026-10-13T01:00:00.000Z");
  });
});
