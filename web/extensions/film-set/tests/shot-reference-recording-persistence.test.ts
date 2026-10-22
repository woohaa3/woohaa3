import { describe, expect, it, vi } from "vitest";
import {
  canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot,
  decodeFilmSetNodeData, filmSetAnimationsOf, shotReferenceContentIdentity,
  DEFAULT_SHOT_REFERENCE_RECORD_PROFILE, shotReferenceProfileKey,
  type CanvasCommand
} from "@woohaa3/contracts";
import { persistShotReferenceRecording } from "../src/frontend/shot-reference-recording-persistence.js";
import { ShotReferenceVersionCache, hydrateShotReferenceCacheFromCanvas } from "../src/frontend/shot-reference-version-cache.js";
import { ShotReferenceRecordingScheduler } from "../src/frontend/shot-reference-recording-scheduler.js";

const asset = { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), mediaType: "video/mp4", size: 10 };

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("c1");
  const fields = canonicalFilmSetFields(createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: 'scene.box({ id: "body" });', modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: 'motion.model.rotate("body", { speed: 1 });',
    timeline: { duration: 4, loop: false }
  }));
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } } as never);
  canvas.nodeData.film = fields as never;
  const decoded = decodeFilmSetNodeData(fields);
  if (!decoded.ok) throw new Error(decoded.reason);
  const clipId = filmSetAnimationsOf(decoded.value).clips[0]!.id;
  const ref = {
    canvasId: canvas.id, filmSetNodeId: "film", clipId,
    contentIdentity: shotReferenceContentIdentity({ animation: decoded.value, clipId })!,
    profileKey: shotReferenceProfileKey(DEFAULT_SHOT_REFERENCE_RECORD_PROFILE)
  };
  const submitCommands = vi.fn((commands: CanvasCommand[]) => {
    for (const command of commands) if (command.type === "asset.upsert") canvas.assets.push(command.asset);
    return { ok: true, handle: { settled: Promise.resolve({ state: "applied" }) } };
  });
  const isWritable = vi.fn(() => true);
  const ctx = {
    canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas },
    canvasSession: { isWritable, submitCommands }
  };
  return { canvas, ref, ctx, submitCommands, isWritable };
}

describe("录制完成即登记资产", () => {
  it("没有下游引用也保存，刷新后回填且不再录制", async () => {
    const { canvas, ref, ctx, submitCommands } = fixture();
    expect(canvas.document.edges).toHaveLength(0);
    expect(await persistShotReferenceRecording(ctx as never, ref, asset, "镜头")).toEqual({ ok: true });
    expect(submitCommands).toHaveBeenCalledTimes(1);
    expect(canvas.assets).toHaveLength(1);

    const reloaded = JSON.parse(JSON.stringify(canvas));
    const cache = new ShotReferenceVersionCache();
    expect(hydrateShotReferenceCacheFromCanvas(cache, reloaded)).toBe(1);
    expect(cache.readyAsset(ref)).toEqual(asset);
    const recorder = vi.fn(async () => ({ ok: true as const }));
    const scheduler = new ShotReferenceRecordingScheduler({
      canvasId: () => reloaded.id, canvas: () => reloaded, focusedFilmSetId: () => null,
      recorder, isCachedReady: request => cache.readyAsset(request) !== null
    });
    scheduler.reconcile();
    expect(scheduler.snapshot().dirty).toHaveLength(0);
    expect(recorder).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("等待权威提交完成后才报告成功", async () => {
    const { ctx, ref, submitCommands } = fixture();
    let settle!: (result: { state: string; error?: string }) => void;
    const pending = new Promise<{ state: string; error?: string }>(resolve => { settle = resolve; });
    submitCommands.mockImplementation(() => ({ ok: true, handle: { settled: pending } }));
    let done = false;
    const saving = persistShotReferenceRecording(ctx as never, ref, asset, "镜头").then(result => { done = true; return result; });
    await Promise.resolve();
    expect(done).toBe(false);
    settle({ state: "rejected", error: "资产校验失败" });
    expect(await saving).toEqual({ ok: false, error: "镜头视频登记失败：资产校验失败" });
  });

  it("同版本同资产幂等，不重复提交", async () => {
    const { ctx, ref, submitCommands } = fixture();
    await persistShotReferenceRecording(ctx as never, ref, asset, "镜头");
    await persistShotReferenceRecording(ctx as never, ref, asset, "镜头");
    expect(submitCommands).toHaveBeenCalledTimes(1);
  });

  it("工作副本里尚未确认的资产不算保存成功", async () => {
    const { ctx, canvas, ref, submitCommands } = fixture();
    await persistShotReferenceRecording(ctx as never, ref, asset, "镜头");
    const optimistic = structuredClone(canvas);
    canvas.assets.length = 0;
    ctx.canvasState.getWorkingCanvas = () => optimistic;
    await persistShotReferenceRecording(ctx as never, ref, asset, "镜头");
    expect(submitCommands).toHaveBeenCalledTimes(2);
  });

  it("切换画布或不可写时不误报保存成功", async () => {
    const { ctx, ref, submitCommands, isWritable } = fixture();
    expect((await persistShotReferenceRecording(ctx as never, { ...ref, canvasId: "other" }, asset, "镜头")).ok).toBe(false);
    isWritable.mockReturnValue(false);
    expect((await persistShotReferenceRecording(ctx as never, ref, asset, "镜头")).ok).toBe(false);
    expect(submitCommands).not.toHaveBeenCalled();
  });

  it("提交同步拒绝时保留失败原因", async () => {
    const { ctx, ref, submitCommands } = fixture();
    submitCommands.mockReturnValue({ ok: false, reason: "连接已断开" } as never);
    expect(await persistShotReferenceRecording(ctx as never, ref, asset, "镜头"))
      .toEqual({ ok: false, error: "镜头视频登记失败：连接已断开" });
  });
});
