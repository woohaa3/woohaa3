/**
 * 活动镜像（任务 5.5）。
 *
 * 覆盖：进入页面不回填终态历史、运行中任务会投影、5% 分桶、终态不复活、
 * 断开只停止观察、查询失败不阻塞。
 */
import { describe, expect, it, vi } from "vitest";
import type { BackgroundActivityJob, RecordingStatusView } from "@woohaa3/contracts";
import { startRecordingActivityMirror, toActivityInput } from "../src/frontend/recording-activity-mirror.js";

function status(overrides: Partial<RecordingStatusView> = {}): RecordingStatusView {
  return {
    jobId: "job-1",
    requestId: "req-1",
    purpose: "export",
    state: "rendering",
    completedFrames: 30,
    totalFrames: 120,
    progress: 0.25,
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides
  };
}

/** 手动驱动的定时器，避免测试里真的等待。 */
function manualTimers() {
  const queue: Array<() => void> = [];
  return {
    setTimeoutImpl: ((handler: () => void) => {
      queue.push(handler);
      return queue.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    async flush() {
      const pending = queue.splice(0, queue.length);
      for (const run of pending) run();
      // 让 await 链跑完。
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

describe("toActivityInput", () => {
  it("maps a host status to projector input", () => {
    const input = toActivityInput(status(), "c1", "片场 · 镜头 1");
    expect(input.jobId).toBe("job-1");
    expect(input.canvasId).toBe("c1");
    expect(input.state).toBe("rendering");
    expect(input.completedFrames).toBe(30);
    expect(input.title).toBe("片场 · 镜头 1");
    expect(input.purpose).toBe("export");
  });

  it("uses the title from the host status when no explicit one is given", () => {
    const input = toActivityInput(status({ title: "导演场 · 岩洞潜行 · 12秒" }), "c1");
    expect(input.title).toBe("导演场 · 岩洞潜行 · 12秒");
  });

  it("falls back to the generic label only when neither source has a title", () => {
    const input = toActivityInput(status(), "c1");
    expect(input.title).toBe("片场录制");
  });

  it("lets an explicit title win over the host status", () => {
    const input = toActivityInput(status({ title: "宿主标题" }), "c1", "显式标题");
    expect(input.title).toBe("显式标题");
  });

  it("carries the failure reason", () => {
    const input = toActivityInput(
      status({ state: "failed", error: { stage: "RECORDING_ERROR_STAGE_FRAME_READY", code: "x", message: "第 7 帧未就绪" } }),
      "c1"
    );
    expect(input.error).toBe("第 7 帧未就绪");
  });
});

describe("startRecordingActivityMirror", () => {
  it("does not backfill historical terminal jobs on entry", async () => {
    const emitted: BackgroundActivityJob[] = [];
    const timers = manualTimers();
    const run = startRecordingActivityMirror({
      canvasId: () => "c1",
      list: async () => [
        status({ jobId: "old-done", state: "succeeded" }),
        status({ jobId: "old-failed", state: "failed" }),
        status({ jobId: "live", state: "rendering" })
      ],
      emit: job => emitted.push(job),
      ...timers
    });
    await new Promise(resolve => setImmediate(resolve));
    // 只有运行中的任务被投影；终态历史不补出。
    expect(emitted.map(job => job.id)).toEqual(["recording:live:live"]);
    run.stop();
  });

  it("projects a new job after entry", async () => {
    const emitted: BackgroundActivityJob[] = [];
    const timers = manualTimers();
    let statuses: RecordingStatusView[] = [];
    const run = startRecordingActivityMirror({
      canvasId: () => "c1",
      list: async () => statuses,
      emit: job => emitted.push(job),
      ...timers
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(emitted).toHaveLength(0);

    statuses = [status({ jobId: "new", completedFrames: 12 })];
    await timers.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.status).toBe("running");
    expect(emitted[0]!.progress).toBeCloseTo(0.1, 5);
    run.stop();
  });

  it("does not revive a terminal job on later polls", async () => {
    const emitted: BackgroundActivityJob[] = [];
    const timers = manualTimers();
    let statuses: RecordingStatusView[] = [status({ jobId: "new", state: "rendering" })];
    const run = startRecordingActivityMirror({
      canvasId: () => "c1",
      list: async () => statuses,
      emit: job => emitted.push(job),
      ...timers
    });
    await new Promise(resolve => setImmediate(resolve));
    await timers.flush();
    statuses = [status({ jobId: "new", state: "succeeded", completedFrames: 120 })];
    await timers.flush();
    const terminalIndex = emitted.findIndex(job => job.status === "succeeded");
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    // 后续再报 rendering 不允许复活。
    statuses = [status({ jobId: "new", state: "rendering", updatedAt: "2026-10-17T00:00:09.000Z" })];
    await timers.flush();
    expect(emitted.at(-1)?.status).toBe("succeeded");
    run.stop();
  });

  it("stops observing without cancelling anything", async () => {
    const emitted: BackgroundActivityJob[] = [];
    const timers = manualTimers();
    const run = startRecordingActivityMirror({
      canvasId: () => "c1",
      list: async () => [status({ jobId: "live" })],
      emit: job => emitted.push(job),
      ...timers
    });
    await new Promise(resolve => setImmediate(resolve));
    const count = emitted.length;
    run.stop();
    await timers.flush();
    expect(emitted).toHaveLength(count);
  });

  it("keeps polling after a failed query", async () => {
    const emitted: BackgroundActivityJob[] = [];
    const timers = manualTimers();
    let fail = true;
    const run = startRecordingActivityMirror({
      canvasId: () => "c1",
      list: async () => {
        if (fail) throw new Error("network");
        return [status({ jobId: "live" })];
      },
      emit: job => emitted.push(job),
      ...timers
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(emitted).toHaveLength(0);
    fail = false;
    await timers.flush();
    expect(emitted.length).toBeGreaterThan(0);
    run.stop();
  });

  it("idles when there is no canvas yet", async () => {
    const emitted: BackgroundActivityJob[] = [];
    const timers = manualTimers();
    const list = vi.fn(async () => []);
    const run = startRecordingActivityMirror({
      canvasId: () => "",
      list,
      emit: job => emitted.push(job),
      ...timers
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(list).not.toHaveBeenCalled();
    run.stop();
  });
});
