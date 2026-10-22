/**
 * 独立镜头录制测试（任务 8.4 / design D9）。
 *
 * 覆盖：固定采样时钟、固定源版本（内容变化立即失效、不混版）、交互让路、取消、编码/上传失败、
 * 渲染后恢复时钟。
 */
import { describe, expect, it, vi } from "vitest";
import {
  recordShotReference,
  shotReferenceTimestamps,
  SHOT_REFERENCE_FPS,
  type ShotReferenceRecordDeps,
  type ShotReferenceRecordTarget
} from "../src/frontend/shot-reference-recorder.js";

const target: ShotReferenceRecordTarget = {
  canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1",
  previewNodeId: "shot-preview:test",
  contentIdentity: "id-a", profileKey: "v1-1280x720@30",
  duration: 0.1, aspect: "16:9", title: "镜头 1", width: 1280, height: 720
};

function fixture(overrides: Partial<ShotReferenceRecordDeps> = {}) {
  const frame = { rgba: new Uint8Array(4), width: 1280, height: 720 };
  const encoder = { add: vi.fn(async () => {}), finish: vi.fn(async () => new Blob(["movie"], { type: "video/mp4" })), cancel: vi.fn(async () => {}) };
  const deps: ShotReferenceRecordDeps = {
    isCurrent: () => true,
    capture: vi.fn(async () => frame),
    restore: vi.fn(),
    createEncoder: vi.fn(async () => encoder),
    acquire: vi.fn(async () => () => {}),
    upload: vi.fn(async () => ({ ok: true as const, asset: { storageKey: "sha256-movie", checksum: "b".repeat(64), mediaType: "video/mp4", size: 5 } })),
    shouldYield: () => false,
    awaitIdle: async () => {},
    now: () => "2026-10-17T00:00:00.000Z",
    ...overrides
  };
  return { deps, encoder };
}

describe("shotReferenceTimestamps（固定采样时钟）", () => {
  it("时长切成固定帧，最后一帧落在端点", () => {
    const times = shotReferenceTimestamps(1, 30);
    expect(times).toHaveLength(30);
    expect(times[0]).toBe(0);
    expect(times[29]).toBe(1);
  });

  it("非正/非法时长不产生帧", () => {
    expect(shotReferenceTimestamps(0)).toEqual([]);
    expect(shotReferenceTimestamps(-1)).toEqual([]);
    expect(shotReferenceTimestamps(Number.NaN)).toEqual([]);
  });

  it("慢渲染不改变时间戳（时长与运动速度稳定）", () => {
    expect(shotReferenceTimestamps(0.2, SHOT_REFERENCE_FPS)).toEqual([0, 1 / 30, 2 / 30, 3 / 30, 4 / 30, 0.2]);
  });
});

describe("recordShotReference（独立录制）", () => {
  it("成功：逐帧渲染、编码、上传并返回真实资产", async () => {
    const { deps, encoder } = fixture();
    const outcome = await recordShotReference(deps, target, new AbortController().signal);
    expect(outcome).toEqual({ ok: true, asset: { storageKey: "sha256-movie", checksum: "b".repeat(64), mediaType: "video/mp4", size: 5 } });
    expect(encoder.add).toHaveBeenCalledTimes(3);
    expect(deps.restore).toHaveBeenCalledWith(target);
  });

  it("内容变化立即失效，不混版、不发布会话", async () => {
    let current = true;
    const { deps, encoder } = fixture({ isCurrent: () => current });
    const capture = deps.capture as ReturnType<typeof vi.fn>;
    capture.mockImplementation(async () => { current = false; return { rgba: new Uint8Array(4), width: 1280, height: 720 }; });
    const outcome = await recordShotReference(deps, target, new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("stale");
    expect(encoder.finish).not.toHaveBeenCalled();
  });

  it("交互进行中让路：不取门、不抓帧", async () => {
    const { deps } = fixture({ shouldYield: () => true });
    const outcome = await recordShotReference(deps, target, new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("yielded");
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("渲染中途交互到来：暂停等待后再继续", async () => {
    let yields = 1;
    let captures = 0;
    const awaited: number[] = [];
    const { deps, encoder } = fixture({
      capture: async () => { captures += 1; return { rgba: new Uint8Array(4), width: 1280, height: 720 }; },
      shouldYield: () => captures >= 1 && yields > 0,
      awaitIdle: async () => { awaited.push(1); yields -= 1; }
    });
    const outcome = await recordShotReference(deps, target, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(awaited).toHaveLength(1);
    expect(encoder.add).toHaveBeenCalledTimes(3);
  });

  it("取消：中止信号结束本次录制", async () => {
    const controller = new AbortController();
    const { deps } = fixture({ capture: async () => { controller.abort(); return { rgba: new Uint8Array(4), width: 1280, height: 720 }; } });
    const outcome = await recordShotReference(deps, target, controller.signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("canceled");
  });

  it("编码空文件或上传失败：报 failed 且可重试", async () => {
    const empty = fixture({ createEncoder: async () => ({ add: async () => {}, finish: async () => new Blob([]), cancel: async () => {} }) });
    const emptyOutcome = await recordShotReference(empty.deps, target, new AbortController().signal);
    expect(emptyOutcome.ok).toBe(false);
    const upload = fixture({ upload: async () => ({ ok: false as const, error: "网络中断" }) });
    const uploadOutcome = await recordShotReference(upload.deps, target, new AbortController().signal);
    expect(uploadOutcome.ok).toBe(false);
    if (!uploadOutcome.ok) expect(uploadOutcome.message).toContain("网络中断");
  });

  it("无时长可直接拒绝", async () => {
    const { deps } = fixture();
    const outcome = await recordShotReference(deps, { ...target, duration: 0 }, new AbortController().signal);
    expect(outcome.ok).toBe(false);
    expect(deps.capture).not.toHaveBeenCalled();
  });
});
