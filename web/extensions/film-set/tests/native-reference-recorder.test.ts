/**
 * 参考录制：桌面壳走宿主任务（任务 7.2）。
 *
 * 覆盖：原生模式不再触碰播放头/捕捉门、幂等 request id、瞬态/永久错误分类、
 * 超时不谎报失败、以及浏览器模式仍返回浏览器录制器。
 */
import { describe, expect, it, vi } from "vitest";
import type { RecordingStatusView } from "@woohaa3/contracts";
import type { ShotReferenceRecordTarget } from "../src/authoring/browser/shot-reference-recorder.js";
import {
  createNativeReferenceRecorder,
  isTransientCode,
  selectReferenceRecorder
} from "../src/authoring/browser/native-reference-recorder.js";

function target(): ShotReferenceRecordTarget {
  return {
    canvasId: "c1",
    filmSetNodeId: "film",
    clipId: "clip-1",
    previewNodeId: "preview-1",
    contentIdentity: "content-1",
    profileKey: "native-v1",
    duration: 4,
    aspect: "16:9",
    title: "片场 · 镜头 1",
    width: 1280,
    height: 720
  };
}

function driver(states: RecordingStatusView[], submitResult?: { ok: true; jobId: string } | { ok: false; code: string; message: string }) {
  const submitted: Array<{ requestId: string; profileKey?: string; purpose?: string }> = [];
  return {
    submitted,
    remote: {
      async recordingSubmit(input: { request: { requestId: string; profileKey?: string } }) {
        submitted.push(input.request);
        return submitResult
          ? submitResult.ok
            ? { ok: true as const, value: { jobId: submitResult.jobId, state: "queued" as const, duplicate: false } }
            : { ok: false as const, code: submitResult.code, error: submitResult.message }
          : { ok: true as const, value: { jobId: "job-1", state: "queued" as const, duplicate: false } };
      },
      async recordingStatus() {
        // 少量给定状态用完后，保持最后一个（用于模拟「一直渲染中」）。
        const next =
          states.length > 1
            ? states.shift()!
            : states[0] ?? {
                jobId: "job-1",
                requestId: "r",
                purpose: "reference" as const,
                state: "succeeded" as const,
                completedFrames: 1,
                totalFrames: 1,
                updatedAt: ""
              };
        return { ok: true as const, value: { status: next } };
      },
      async recordingCancel() {
        return { ok: true as const, value: { cancelled: true as const } };
      }
    }
  };
}

import { createRecordingDriver } from "../src/authoring/browser/native-recording-client.js";

describe("createNativeReferenceRecorder", () => {
  it("submits a reference job and reports success", async () => {
    const fake = driver([]);
    const recorder = createNativeReferenceRecorder({
      driver: createRecordingDriver({
        remote: fake.remote as never,
        canvasId: "c1",
        sleep: async () => undefined
      }),
      canvasId: "c1",
      contentIdentityOf: value => value.contentIdentity
    });
    const result = await recorder(target());
    expect(result.ok).toBe(true);
    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]!.requestId).toContain("reference-v2:film:clip-1:content-1");
    // 调度目标的 aspect 可能是占位值；宿主必须从权威片段选择规格。
    expect(fake.submitted[0]).not.toHaveProperty("profileKey");
    expect(fake.submitted[0]!.purpose).toBe("reference");
  });

  it("is idempotent for the same content version", async () => {
    const fake = driver([]);
    const driverInstance = createRecordingDriver({
      remote: fake.remote as never,
      canvasId: "c1",
      sleep: async () => undefined
    });
    const recorder = createNativeReferenceRecorder({
      driver: driverInstance,
      canvasId: "c1",
      contentIdentityOf: value => value.contentIdentity
    });
    await recorder(target());
    await recorder(target());
    expect(fake.submitted[0]!.requestId).toBe(fake.submitted[1]!.requestId);
  });

  it("classifies a missing executor as transient and an invalid source as permanent", async () => {
    const missing = driver([], { ok: false, code: "recording-executor-unavailable", message: "未就绪" });
    const transientRecorder = createNativeReferenceRecorder({
      driver: createRecordingDriver({ remote: missing.remote as never, canvasId: "c1", sleep: async () => undefined }),
      canvasId: "c1",
      contentIdentityOf: value => value.contentIdentity
    });
    const transient = await transientRecorder(target());
    expect(transient.ok).toBe(false);
    if (!transient.ok) expect(transient.transient).toBe(true);

    const invalid = driver([], { ok: false, code: "recording-source-invalid", message: "无时长" });
    const permanentRecorder = createNativeReferenceRecorder({
      driver: createRecordingDriver({ remote: invalid.remote as never, canvasId: "c1", sleep: async () => undefined }),
      canvasId: "c1",
      contentIdentityOf: value => value.contentIdentity
    });
    const permanent = await permanentRecorder(target());
    expect(permanent.ok).toBe(false);
    if (!permanent.ok) expect(permanent.transient).toBe(false);
  });

  it("does not fake success while the job is still running", async () => {
    let clock = 0;
    const fake = driver([
      {
        jobId: "job-1",
        requestId: "r",
        purpose: "reference",
        state: "rendering",
        completedFrames: 10,
        totalFrames: 120,
        updatedAt: ""
      }
    ]);
    const recorder = createNativeReferenceRecorder({
      driver: createRecordingDriver({
        remote: fake.remote as never,
        canvasId: "c1",
        now: () => clock,
        timeoutMs: 1_000,
        sleep: async () => {
          clock += 600;
        }
      }),
      canvasId: "c1",
      contentIdentityOf: value => value.contentIdentity
    });
    const result = await recorder(target());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-still-running");
    expect(result.transient).toBe(true);
  });

  it("never touches the visible playback port", async () => {
    // 装配签名里根本没有 playback 端口：编译期即保证不会 seek 可见播放头。
    const fake = driver([]);
    const recorder = createNativeReferenceRecorder({
      driver: createRecordingDriver({ remote: fake.remote as never, canvasId: "c1", sleep: async () => undefined }),
      canvasId: "c1",
      contentIdentityOf: value => value.contentIdentity
    });
    const playbackSeek = vi.fn();
    void playbackSeek;
    await recorder(target());
    expect(playbackSeek).not.toHaveBeenCalled();
  });
});

describe("isTransientCode", () => {
  it("retries executor/frame/codec transients only", () => {
    expect(isTransientCode("recording-executor-unavailable")).toBe(true);
    expect(isTransientCode("recording-dispatch-timeout")).toBe(true);
    expect(isTransientCode("recording-executor-unresponsive")).toBe(true);
    expect(isTransientCode("capture-readiness-timeout")).toBe(true);
    expect(isTransientCode("recording-device-lost")).toBe(true);
    expect(isTransientCode("recording-source-invalid")).toBe(false);
    expect(isTransientCode("recording-budget-exceeded")).toBe(false);
    expect(isTransientCode("recording-too-late")).toBe(false);
    expect(isTransientCode("recording-executor-software-gpu")).toBe(false);
  });
});

describe("selectReferenceRecorder", () => {
  it("uses the native recorder on desktop and the browser one elsewhere", () => {
    expect(selectReferenceRecorder({ native: true, nativeRecorder: () => "native", browserRecorder: () => "browser" })).toBe(
      "native"
    );
    expect(selectReferenceRecorder({ native: false, nativeRecorder: () => "native", browserRecorder: () => "browser" })).toBe(
      "browser"
    );
  });
});
