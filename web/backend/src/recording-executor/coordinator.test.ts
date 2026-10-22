/**
 * 宿主录制任务协调器（任务 5.1 / 5.3 / 5.5 / 6.4）。
 *
 * 纯内存状态机测试：幂等提交、终态不复活、乱序/重复事件、取消与 committing 线性化、
 * 5% 进度节流、执行器失联、记录上限与 TTL。不需要 GPU 或真实 socket。
 */
import { describe, expect, it } from "vitest";
import type { BackgroundActivityJob } from "@woohaa3/contracts";
import {
  RecordingJobCoordinator,
  RECORDING_TERMINAL_STATES,
  isTerminalState,
  statusFor,
  type RecordingJobIdentity
} from "./coordinator.js";

function identity(overrides: Partial<RecordingJobIdentity> = {}): RecordingJobIdentity {
  return {
    jobId: "job-1",
    attemptId: "attempt-1",
    executorInstanceId: "exec-1",
    executionEpoch: 1,
    snapshotHash: "snap",
    contentIdentity: "content",
    profileKey: "profile",
    ...overrides
  };
}

function accept(coordinator: RecordingJobCoordinator, overrides: {
  purpose?: "reference" | "export";
  totalFrames?: number;
  job?: RecordingJobIdentity;
} = {}) {
  return coordinator.accept({
    identity: overrides.job ?? identity(),
    purpose: overrides.purpose ?? "export",
    canvasId: "c1",
    nodeId: "film",
    clipId: "clip",
    totalFrames: overrides.totalFrames ?? 90,
    title: "片场 · 镜头 1"
  });
}

describe("RecordingJobCoordinator", () => {
  it("accepts a job once and returns the same record for a duplicate request", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    const first = accept(coordinator);
    const second = accept(coordinator);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.job.activityId).toBe(first.job.activityId);
    expect(coordinator.list()).toHaveLength(1);
  });

  it("marks the previous attempt stale when a new attempt starts", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator);
    accept(coordinator, { job: identity({ attemptId: "attempt-2", executionEpoch: 2 }) });
    // 同一 jobId 只会保留一条当前记录；被取代的 attempt 以独立记录保留用于诊断。
    expect(coordinator.get("job-1")!.identity.attemptId).toBe("attempt-2");
    expect(coordinator.get("job-1")!.state).toBe("queued");
    const previous = coordinator.list().find(job => job.identity.attemptId === "attempt-1");
    expect(previous?.state).toBe("stale");
    // 旧 attempt 的事件不再影响新记录。
    expect(coordinator.apply("job-1", identity(), { kind: "terminal", state: "succeeded" })).toEqual({
      ok: false,
      reason: "stale-identity"
    });
  });

  it("ignores events from a stale attempt or epoch", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator);
    const stale = coordinator.apply("job-1", identity({ attemptId: "attempt-0" }), {
      kind: "state",
      state: "rendering"
    });
    expect(stale).toEqual({ ok: false, reason: "stale-identity" });
    const otherEpoch = coordinator.apply("job-1", identity({ executionEpoch: 9 }), {
      kind: "state",
      state: "rendering"
    });
    expect(otherEpoch).toEqual({ ok: false, reason: "stale-identity" });
    expect(coordinator.get("job-1")!.state).toBe("queued");
  });

  it("never revives a terminal job from late progress or duplicate terminal events", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator);
    coordinator.apply("job-1", identity(), { kind: "progress", completedFrames: 10, totalFrames: 90, sampleTime: 0.3 });
    coordinator.apply("job-1", identity(), { kind: "terminal", state: "failed", error: {
      stage: "RECORDING_ERROR_STAGE_FRAME_READY",
      code: "capture-readiness-timeout",
      message: "frame 10",
      transient: true
    } });
    expect(coordinator.get("job-1")!.state).toBe("failed");
    const late = coordinator.apply("job-1", identity(), {
      kind: "progress",
      completedFrames: 80,
      totalFrames: 90,
      sampleTime: 2.6
    });
    expect(late).toEqual({ ok: false, reason: "terminal" });
    coordinator.apply("job-1", identity(), { kind: "terminal", state: "succeeded" });
    expect(coordinator.get("job-1")!.state).toBe("failed");
    expect(coordinator.get("job-1")!.completedFrames).toBe(10);
  });

  it("linearizes cancel against committing", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator);
    expect(coordinator.beginCommit("job-1")).toBe(true);
    const late = coordinator.cancel("job-1");
    expect(late).toEqual({ ok: false, code: "recording-too-late", message: "任务已进入保存阶段，无法取消" });

    accept(coordinator, { job: identity({ jobId: "job-2" }) });
    expect(coordinator.cancel("job-2")).toEqual({ ok: true, cancelled: true });
    expect(coordinator.get("job-2")!.state).toBe("cancelled");
    // 取消后不能进入提交。
    expect(coordinator.beginCommit("job-2")).toBe(false);
  });

  it("reports an unknown job instead of pretending cancellation", () => {
    const coordinator = new RecordingJobCoordinator();
    expect(coordinator.cancel("nope")).toEqual({
      ok: false,
      code: "recording-unknown-job",
      message: "任务不存在或已过期"
    });
  });

  it("throttles progress to 5% buckets", () => {
    const published: BackgroundActivityJob[] = [];
    const coordinator = new RecordingJobCoordinator({
      now: () => 1_000,
      publishActivity: job => published.push(job)
    });
    accept(coordinator, { totalFrames: 100 });
    const rendering = coordinator.apply("job-1", identity(), { kind: "state", state: "rendering" });
    expect(rendering.ok).toBe(true);
    const before = published.length;
    for (let frames = 1; frames <= 20; frames += 1) {
      coordinator.apply("job-1", identity(), { kind: "progress", completedFrames: frames, totalFrames: 100, sampleTime: frames / 30 });
    }
    const progressEvents = published.slice(before).filter(job => job.status === "running");
    // 20% → 只有 5/10/15/20 四个桶（外加可能的 0）；不能每帧都发。
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.length).toBeLessThanOrEqual(6);
    expect(progressEvents.at(-1)?.progress ?? 0).toBeCloseTo(0.2, 5);
  });

  it("creates one activity per attempt and keeps terminal statuses distinct", () => {
    const published: BackgroundActivityJob[] = [];
    const coordinator = new RecordingJobCoordinator({
      now: () => 1_000,
      publishActivity: job => published.push(job)
    });
    accept(coordinator);
    coordinator.apply("job-1", identity(), { kind: "terminal", state: "succeeded" });
    const activityIds = new Set(published.map(job => job.id));
    expect(activityIds.size).toBe(1);
    expect(published.at(-1)?.status).toBe("succeeded");

    accept(coordinator, { job: identity({ jobId: "job-2", attemptId: "attempt-7" }) });
    expect(published.at(-1)?.id).not.toBe([...activityIds][0]);
  });

  it("pauses and resumes reference jobs only", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator, { purpose: "reference" });
    coordinator.apply("job-1", identity(), { kind: "state", state: "rendering" });
    expect(coordinator.pause("job-1")).toBe(true);
    expect(coordinator.get("job-1")!.state).toBe("paused");
    expect(coordinator.resume("job-1")).toBe(true);
    expect(coordinator.get("job-1")!.state).toBe("rendering");
    // 非 rendering 时不能暂停。
    coordinator.apply("job-1", identity(), { kind: "state", state: "encoding" });
    expect(coordinator.pause("job-1")).toBe(false);
  });

  it("fails every live job of a lost executor", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator);
    accept(coordinator, { job: identity({ jobId: "job-2" }) });
    coordinator.apply("job-1", identity(), { kind: "terminal", state: "succeeded" });
    const affected = coordinator.executorLost("exec-1");
    expect(affected).toBe(1);
    expect(coordinator.get("job-2")!.state).toBe("failed");
    expect(coordinator.get("job-2")!.error?.stage).toBe("RECORDING_ERROR_STAGE_EXECUTOR_LOST");
    // 已成功的不受影响。
    expect(coordinator.get("job-1")!.state).toBe("succeeded");
    // 别的执行器不受影响。
    accept(coordinator, { job: identity({ jobId: "job-3", executorInstanceId: "exec-2" }) });
    expect(coordinator.executorLost("exec-1")).toBe(0);
    expect(coordinator.get("job-3")!.state).toBe("queued");
  });

  it("bounds terminal records by count and TTL", () => {
    let now = 1_000;
    const coordinator = new RecordingJobCoordinator({
      now: () => now,
      terminalLimit: 2,
      terminalTtlMs: 1_000
    });
    for (let index = 0; index < 4; index += 1) {
      accept(coordinator, { job: identity({ jobId: `job-${index}` }) });
      coordinator.apply(`job-${index}`, identity({ jobId: `job-${index}` }), {
        kind: "terminal",
        state: "succeeded"
      });
      now += 10;
    }
    expect(coordinator.list().length).toBeLessThanOrEqual(2);
    // TTL 到期后全部清空。
    now += 2_000;
    coordinator.reap();
    expect(coordinator.list()).toHaveLength(0);
  });

  it("rejects reference jobs beyond the queue bound but never merges explicit exports", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000, maxQueued: 1 });
    expect(accept(coordinator, { purpose: "reference" }).ok).toBe(true);
    const second = accept(coordinator, { purpose: "reference", job: identity({ jobId: "job-2" }) });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("recording-busy");
    // 显式导出不受此上限影响。
    const exportJob = accept(coordinator, { purpose: "export", job: identity({ jobId: "job-3" }) });
    expect(exportJob.ok).toBe(true);
  });

  it("lists jobs per canvas for reconnection queries", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    accept(coordinator);
    accept(coordinator, { job: identity({ jobId: "job-2" }) });
    const other = coordinator.accept({
      identity: identity({ jobId: "job-3" }),
      purpose: "export",
      canvasId: "c2",
      nodeId: "film",
      clipId: "clip",
      totalFrames: 10,
      title: "另一画布"
    });
    expect(other.ok).toBe(true);
    expect(coordinator.listForCanvas("c1")).toHaveLength(2);
    expect(coordinator.listForCanvas("c2")).toHaveLength(1);
  });

  it("maps every state to an activity status", () => {
    expect(statusFor("queued")).toBe("queued");
    expect(statusFor("rendering")).toBe("running");
    expect(statusFor("committing")).toBe("running");
    expect(statusFor("succeeded")).toBe("succeeded");
    expect(statusFor("cancelled")).toBe("cancelled");
    expect(statusFor("stale")).toBe("cancelled");
    expect(statusFor("failed")).toBe("failed");
    expect(RECORDING_TERMINAL_STATES.every(isTerminalState)).toBe(true);
    expect(isTerminalState("committing")).toBe(false);
  });
});
