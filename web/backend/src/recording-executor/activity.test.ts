/**
 * 宿主录制任务的活动投影（任务 5.5）。
 *
 * 覆盖：每 attempt 一条、5% 分桶、终态不复活、乱序不覆盖、有界、错误原因透出、
 * 仓库内「不写 durable 历史」的形状保证。
 */
import { describe, expect, it } from "vitest";
import type { BackgroundActivityJob } from "@woohaa3/contracts";
import {
  RecordingActivityProjector,
  activityDetail,
  activityStatus,
  recordingActivityId,
  toActivityJob,
  type HostRecordingActivityInput
} from "./activity.js";

const AT = "2026-10-17T00:00:00.000Z";

function input(overrides: Partial<HostRecordingActivityInput> = {}): HostRecordingActivityInput {
  return {
    jobId: "job-1",
    attemptId: "attempt-1",
    canvasId: "c1",
    nodeId: "film",
    title: "片场 · 镜头 1",
    purpose: "export",
    state: "rendering",
    completedFrames: 30,
    totalFrames: 120,
    updatedAt: AT,
    ...overrides
  };
}

describe("toActivityJob", () => {
  it("maps every host state to a feed status", () => {
    expect(activityStatus("queued")).toBe("queued");
    expect(activityStatus("preparing")).toBe("queued");
    expect(activityStatus("rendering")).toBe("running");
    expect(activityStatus("paused")).toBe("running");
    expect(activityStatus("encoding")).toBe("running");
    expect(activityStatus("uploading")).toBe("running");
    expect(activityStatus("committing")).toBe("running");
    expect(activityStatus("succeeded")).toBe("succeeded");
    expect(activityStatus("cancelled")).toBe("cancelled");
    expect(activityStatus("stale")).toBe("cancelled");
    expect(activityStatus("failed")).toBe("failed");
  });

  it("uses one stable id per attempt", () => {
    expect(recordingActivityId({ jobId: "j", attemptId: "a" })).toBe("recording:j:a");
    expect(recordingActivityId({ jobId: "j", attemptId: "b" })).not.toBe(
      recordingActivityId({ jobId: "j", attemptId: "a" })
    );
  });

  it("buckets progress to 5%", () => {
    expect(toActivityJob(input({ completedFrames: 3 })).progress).toBeCloseTo(0, 5);
    expect(toActivityJob(input({ completedFrames: 30 })).progress).toBeCloseTo(0.25, 5);
    // 47/100 落到 45% 桶，不会把 47% 这种抖动值发给 UI。
    expect(toActivityJob(input({ completedFrames: 47, totalFrames: 100 })).progress).toBeCloseTo(0.45, 5);
    expect(toActivityJob(input({ completedFrames: 120 })).progress).toBeCloseTo(1, 5);
  });

  it("omits progress for non-running states", () => {
    expect(toActivityJob(input({ state: "succeeded" })).progress).toBeUndefined();
    expect(toActivityJob(input({ state: "failed" })).progress).toBeUndefined();
  });

  it("carries readable stage details and failure reason", () => {
    expect(toActivityJob(input({ state: "uploading" })).detail).toBe("上传视频中");
    expect(toActivityJob(input({ state: "stale" })).detail).toContain("作废");
    expect(toActivityJob(input({ state: "failed", error: "第 7 帧未就绪" })).detail).toBe("第 7 帧未就绪");
    expect(activityDetail("queued")).toBeUndefined();
  });

  it("never writes durable task fields", () => {
    const job = toActivityJob(input());
    // 后台活动不是 durable 任务：不应带 runId/taskKey。
    expect(job).not.toHaveProperty("runId");
    expect(job).not.toHaveProperty("taskKey");
    expect(job.kind).toBe("shot-reference-recording");
    expect(job.canvasId).toBe("c1");
    expect(job.nodeId).toBe("film");
  });
});

describe("RecordingActivityProjector", () => {
  it("publishes progress and terminal states once", () => {
    const published: BackgroundActivityJob[] = [];
    const projector = new RecordingActivityProjector(job => published.push(job));
    expect(projector.publish(input())).toBe(true);
    expect(projector.publish(input({ updatedAt: "2026-10-17T00:00:01.000Z", completedFrames: 60 }))).toBe(true);
    expect(projector.publish(input({ state: "succeeded", updatedAt: "2026-10-17T00:00:02.000Z" }))).toBe(true);
    expect(published.map(job => job.status)).toEqual(["running", "running", "succeeded"]);
  });

  it("ignores duplicate events with identical payloads", () => {
    const published: BackgroundActivityJob[] = [];
    const projector = new RecordingActivityProjector(job => published.push(job));
    projector.publish(input());
    expect(projector.publish(input())).toBe(false);
    expect(published).toHaveLength(1);
  });

  it("never revives a terminal record", () => {
    const published: BackgroundActivityJob[] = [];
    const projector = new RecordingActivityProjector(job => published.push(job));
    projector.publish(input({ state: "failed", error: "boom" }));
    expect(projector.publish(input({ updatedAt: "2026-10-17T00:00:05.000Z" }))).toBe(false);
    expect(published.at(-1)?.status).toBe("failed");
  });

  it("rejects out-of-order events", () => {
    const published: BackgroundActivityJob[] = [];
    const projector = new RecordingActivityProjector(job => published.push(job));
    projector.publish(input({ updatedAt: "2026-10-17T00:00:10.000Z", completedFrames: 90 }));
    expect(projector.publish(input({ updatedAt: "2026-10-17T00:00:01.000Z", completedFrames: 10 }))).toBe(false);
    expect(published.at(-1)?.progress).toBeCloseTo(0.75, 5);
  });

  it("keeps separate records per attempt", () => {
    const published: BackgroundActivityJob[] = [];
    const projector = new RecordingActivityProjector(job => published.push(job));
    projector.publish(input({ attemptId: "attempt-1" }));
    projector.publish(input({ attemptId: "attempt-2", updatedAt: "2026-10-17T00:00:02.000Z" }));
    expect(new Set(published.map(job => job.id)).size).toBe(2);
  });

  it("stays bounded", () => {
    const projected: BackgroundActivityJob[] = [];
    const projector = new RecordingActivityProjector(job => projected.push(job), 3);
    for (let index = 0; index < 8; index += 1) {
      projector.publish(input({ attemptId: `attempt-${index}`, updatedAt: `2026-10-17T00:00:0${index}.000Z` }));
    }
    expect(projector.entries()).toHaveLength(3);
  });
});
