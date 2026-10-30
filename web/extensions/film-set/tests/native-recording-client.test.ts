/**
 * 桌面「生成视频」的宿主任务适配（任务 7.1 / 7.3）。
 *
 * 覆盖：提交幂等、能力缺失给出具体原因、进度/终态、超时不取消任务、取消失败不谎报、
 * 阶段文案。全部用替身，不触网、不需要 GPU。
 */
import { describe, expect, it } from "vitest";
import type { RecordingStatusView } from "@woohaa3/contracts";
import {
  createRecordingDriver,
  describeRecordingFailure,
  isTerminal,
  recordingStageLabel
} from "../src/authoring/browser/native-recording-client.js";

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

/** 按顺序返回给定状态的替身。 */
function remoteWith(states: Array<RecordingStatusView | { code: string; error: string }>, options: {
  submit?: { ok: true; jobId: string; state: RecordingStatusView["state"]; duplicate: boolean } | { ok: false; code: string; error: string };
  cancel?: { ok: true; value: { cancelled: true } } | { ok: false; code: string; error: string };
} = {}) {
  let index = 0;
  return {
    calls: { submit: 0, status: 0, cancel: 0 },
    async recordingSubmit() {
      this.calls.submit += 1;
      return options.submit ?? { ok: true as const, value: { jobId: "job-1", state: "queued" as const, duplicate: false } };
    },
    async recordingStatus() {
      this.calls.status += 1;
      const next = states[Math.min(index, states.length - 1)]!;
      index += 1;
      return "code" in next
        ? { ok: false as const, code: next.code, error: next.error }
        : { ok: true as const, value: { status: next } };
    },
    async recordingCancel() {
      this.calls.cancel += 1;
      return options.cancel ?? { ok: true as const, value: { cancelled: true as const } };
    }
  };
}

describe("createRecordingDriver.submit", () => {
  it("submits an export with the submitted version", async () => {
    const remote = remoteWith([status()]);
    const driver = createRecordingDriver({ remote: remote as never, canvasId: "c1" });
    const result = await driver.submit({
      requestId: "req-1",
      nodeId: "film",
      clipId: "clip",
      profileKey: "native-v1",
      displayVersion: "v3"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.jobId).toBe("job-1");
    expect(result.submission.submittedVersion).toBe("v3");
    expect(result.submission.initialState).toBe("queued");
  });

  it("gives a specific reason when the executor is missing", async () => {
    const remote = remoteWith([], {
      submit: { ok: false, code: "recording-executor-unavailable", error: "本机录制执行器未就绪" }
    });
    const driver = createRecordingDriver({ remote: remote as never, canvasId: "c1" });
    const result = await driver.submit({ requestId: "r", nodeId: "film", clipId: "clip" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-executor-unavailable");
    expect(result.message).toContain("桌面应用");
    // 不能引导用户「换个浏览器」。
    expect(result.message).not.toContain("浏览器");
  });
});

describe("createRecordingDriver.wait", () => {
  it("returns the terminal status", async () => {
    const remote = remoteWith([
      status({ state: "rendering", completedFrames: 60, progress: 0.5 }),
      status({ state: "uploading", completedFrames: 120, progress: 1 }),
      status({ state: "succeeded", completedFrames: 120, progress: 1 })
    ]);
    const driver = createRecordingDriver({
      remote: remote as never,
      canvasId: "c1",
      pollIntervalMs: 1,
      sleep: async () => undefined
    });
    const progress: number[] = [];
    const result = await driver.wait("job-1", value => progress.push(value.completedFrames));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.state).toBe("succeeded");
    expect(progress).toEqual([60, 120, 120]);
  });

  it("reports a failed job with its stage message", async () => {
    const remote = remoteWith([
      status({
        state: "failed",
        error: { stage: "RECORDING_ERROR_STAGE_FRAME_READY", code: "capture-readiness-timeout", message: "第 7 帧未就绪" }
      })
    ]);
    const driver = createRecordingDriver({ remote: remote as never, canvasId: "c1", sleep: async () => undefined });
    const result = await driver.wait("job-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("capture-readiness-timeout");
    expect(result.message).toContain("第 7 帧");
  });

  it("does not cancel the job when the local wait times out", async () => {
    let clock = 0;
    const remote = remoteWith([status({ state: "rendering" })]);
    const driver = createRecordingDriver({
      remote: remote as never,
      canvasId: "c1",
      now: () => clock,
      timeoutMs: 1_000,
      sleep: async () => {
        clock += 600;
      }
    });
    const result = await driver.wait("job-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-still-running");
    // 关键：超时不调用 cancel，任务仍在后台跑。
    expect(remote.calls.cancel).toBe(0);
  });

  it("surfaces a lost connection as a stable code", async () => {
    const remote = remoteWith([{ code: "unavailable", error: "无法连接画布服务" }]);
    const driver = createRecordingDriver({ remote: remote as never, canvasId: "c1", sleep: async () => undefined });
    const result = await driver.wait("job-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unavailable");
  });
});

describe("createRecordingDriver.cancel", () => {
  it("reports too-late instead of pretending success", async () => {
    const remote = remoteWith([], {
      cancel: { ok: false, code: "recording-too-late", error: "任务已进入保存阶段" }
    });
    const driver = createRecordingDriver({ remote: remote as never, canvasId: "c1" });
    const result = await driver.cancel("job-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-too-late");
    expect(result.message).toContain("保存");
  });

  it("succeeds for a cancellable job", async () => {
    const driver = createRecordingDriver({ remote: remoteWith([]) as never, canvasId: "c1" });
    await expect(driver.cancel("job-1")).resolves.toEqual({ ok: true });
  });
});

describe("helpers", () => {
  it("classifies terminal states", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("stale")).toBe(true);
    expect(isTerminal("rendering")).toBe(false);
    expect(isTerminal("committing")).toBe(false);
  });

  it("labels every stage", () => {
    expect(recordingStageLabel(status({ state: "queued" }))).toBe("排队中");
    expect(recordingStageLabel(status({ state: "rendering", progress: 0.42 }))).toContain("42%");
    expect(recordingStageLabel(status({ state: "uploading" }))).toBe("上传视频中");
    expect(recordingStageLabel(status({ state: "committing" }))).toBe("保存视频中");
    expect(recordingStageLabel(status({ state: "succeeded" }))).toBe("视频已生成");
    expect(recordingStageLabel(status({ state: "stale" }))).toContain("作废");
  });

  it("keeps profile rejection separate from codec errors", () => {
    const detail = "录制规格与片段比例不匹配：16:9；当前片段需要 3:4";
    expect(describeRecordingFailure("recording-profile-unsupported", detail)).toBe(detail);
    expect(describeRecordingFailure("recording-capability-missing", "缺少 H.264 解码器")).toBe("缺少 H.264 解码器");
  });

  it("maps capability codes to distinct reasons", () => {
    const codes = [
      "recording-unavailable",
      "recording-executor-unavailable",
      "recording-executor-software-gpu",
      "recording-capability-missing",
      "recording-source-invalid",
      "recording-source-removed",
      "recording-budget-exceeded",
      "recording-too-late",
      "recording-cancelled"
    ];
    const messages = codes.map(code => describeRecordingFailure(code, ""));
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) {
      expect(message).not.toContain("换个浏览器");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("passes through backend messages for unknown codes", () => {
    expect(describeRecordingFailure("recording-upload-failed", "媒体服务拒绝写入")).toBe("媒体服务拒绝写入");
    expect(describeRecordingFailure("something-new", "")).toBe("视频生成失败，请重试");
  });
});

it("unmount or hiding stops observation without cancelling or resubmitting the accepted native job", async () => {
  const remote = remoteWith([status(), status({ state: "succeeded" })]);
  let observing = true;
  const driver = createRecordingDriver({ remote: remote as never, canvasId: "c1", sleep: async () => { observing = false; } });
  const result = await driver.wait("job-1", undefined, () => observing);
  expect(result).toMatchObject({ ok: false, code: "recording-observation-stopped" });
  expect(remote.calls).toEqual({ submit: 0, status: 1, cancel: 0 });
  const current = await driver.status("job-1");
  expect(current).toMatchObject({ ok: true, value: { status: { state: "succeeded" } } });
});
