/**
 * 独立镜头录制的生产接线（任务 8.4 / design D9）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 把调度器的 `recorder` seam 接到既有捕捉/编码/上传能力：
 * - 从权威画布按 `(片场, clipId)` 取时长与画幅，构造**与播放状态无关**的固定目标；
 * - 每帧前后复核内容身份，内容一变立即作废（不混版）；
 * - 与截图/显式导出共用 `acquireCapture` 独占门；显式捕捉进行中让路；
 * - 编码上传校验后 `publish` 到版本缓存，ready 前不可作为下游参考；
 * - 结束时把渲染时钟恢复到用户原状态。
 *
 * 取帧后端：renderer 按预览节点 id 路由到该镜头的卡片 rig，并**离屏**按请求尺寸
 * （1280×720）回读——浏览器已切到 WebGPU，不再退回窗口截图与卡片屏幕裁剪
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.10）。
 * 真实 GPU 上的画面一致性与逐帧时机仍待 8.9 人工验证。
 *
 * 播放时钟通过**显式注入**获得（`ShotReferencePlaybackPort`），不走 `ctx.filmSetPlayback`
 * 服务解析：本扩展插件不声明该服务的 inject，装配时同步触发的第一次录制会抛
 * `cannot get property "filmSetPlayback" without inject`（2026-10-17 缺陷修复）。
 */
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { decodeFilmSetNodeData, DEFAULT_SHOT_REFERENCE_RECORD_PROFILE, filmSetAnimationsOf, shotPreviewNodeId, shotReferenceContentIdentity, shotReferenceProfileKey } from "@woohaa3/contracts";
import { persistShotReferenceRecording } from "./shot-reference-recording-persistence.js";
import { createFilmSetVideoEncoder } from "./film-set-video-encoder.js";
import { videoSize } from "./film-set-video-export.js";
import { recordShotReference, type ShotReferenceRecordDeps, type ShotReferenceRecordProgress, type ShotReferenceRecordTarget } from "./shot-reference-recorder.js";
import type { ShotReferenceRecorder } from "./shot-reference-recording-scheduler.js";
import type { ShotReferenceRecordingJob } from "./shot-reference-recording-queue.js";
import type { ShotReferenceVersionCache } from "./shot-reference-version-cache.js";

function canvasNow(ctx: Context) {
  return ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
}

/**
 * 录制驱动播放时钟与**离屏录制会话**的最小端口；`FilmSetPlaybackService` 满足。
 *
 * `beginCaptureSession` 把播放投影锁到该镜头的拍摄预览卡片（`shot-node-preview` 模式，输出
 * 目标卡片）：卡片 rig 独占所属片场的渲染层与当前 T 的相机姿态，renderer 因此能在片场**非聚焦**
 * 时按 T 离屏出画面（change: 2026-10-15，任务 8.4）。结束时必须 `endCaptureSession` 交还投影。
 */
export type ShotReferencePlaybackPort = {
  seek(time: number): void;
  play(): void;
  beginCaptureSession(input: { filmSetNodeId: string; clipId: string; previewNodeId: string }): void;
  endCaptureSession(): void;
};

/** 当前权威画布上该镜头的视觉内容身份；用于录制期间复核「是否还是同一版本」。 */
function contentIdentityNow(ctx: Context, filmSetNodeId: string, clipId: string): string | null {
  const canvas = canvasNow(ctx);
  if (!canvas) return null;
  const decoded = decodeFilmSetNodeData(canvas.nodeData[filmSetNodeId]);
  if (!decoded.ok) return null;
  return shotReferenceContentIdentity({ animation: decoded.value, clipId });
}

/** 目标：与播放状态无关的固定录制身份。 */
export function shotReferenceTargetFor(ctx: Context, job: ShotReferenceRecordingJob): ShotReferenceRecordTarget | null {
  const canvas = canvasNow(ctx);
  if (!canvas || canvas.id !== job.canvasId) return null;
  const decoded = decodeFilmSetNodeData(canvas.nodeData[job.filmSetNodeId]);
  if (!decoded.ok) return null;
  const clip = filmSetAnimationsOf(decoded.value).clips.find((entry) => entry.id === job.clipId);
  if (!clip) return null;
  const size = videoSize(clip.initialCamera.aspect);
  return {
    canvasId: canvas.id,
    filmSetNodeId: job.filmSetNodeId,
    clipId: job.clipId,
    // 预览节点 id 由 (片场, clip) 确定性派生：截图请求按它路由到该卡片的 rig（renderer 侧契约）。
    previewNodeId: shotPreviewNodeId(job.filmSetNodeId, job.clipId),
    contentIdentity: job.contentIdentity,
    profileKey: job.profileKey,
    duration: clip.timeline.duration,
    aspect: clip.initialCamera.aspect,
    title: `${decoded.value.title || "片场"} · ${clip.name}`,
    width: size.width,
    height: size.height
  };
}

/**
 * 构造生产录制器：串行由调度器保证，本函数只负责单次「固定版本 → 编码上传 → 原子发布」。
 *
 * `playback` 是录制驱动的播放时钟端口（`FilmSetPlaybackService` 满足）；显式传入避免依赖插件
 * 服务解析的装配时机。
 */
export function createShotReferenceRecorder(
  ctx: Context,
  cache: ShotReferenceVersionCache,
  playback: ShotReferencePlaybackPort,
  options: {
    /** 采样进度（可选）；把任务身份一并带回，供活动面板按 job 展示。 */
    onProgress?: (job: ShotReferenceRecordingJob, progress: ShotReferenceRecordProgress) => void;
  } = {}
): ShotReferenceRecorder {
  let captureGeneration = 2_000_000;
  return async (job) => {
    const target = shotReferenceTargetFor(ctx, job);
    if (!target) {
      cache.markFailed(job, "片场或镜头已不存在");
      return { ok: false, error: "片场或镜头已不存在" };
    }
    // 已 ready 的同版本直接复用，不重复录制。
    if (cache.isReadyCurrent(target)) return { ok: true };
    cache.markRecording(target);
    // 记住用户原播放状态，录完恢复（现有 renderer 只能捕捉当前时钟）。
    const before = ctx.canvasRuntime.animationPlaybackState();
    const controller = new AbortController();
    const timing = createShotReferenceRecordTiming();
    const startedAt = clock();
    const deps = createShotReferenceRecordDeps({
      ctx,
      playback,
      target,
      timing,
      ...(options.onProgress ? { onProgress: (progress) => options.onProgress!(job, progress) } : {}),
      nextCaptureGeneration: () => captureGeneration++,
      original: { time: before?.time ?? 0, playing: before?.playing ?? false }
    });
    const outcome = await recordShotReference(deps, target, controller.signal);
    reportShotReferenceTiming(target, timing, outcome, clock() - startedAt);
    if (outcome.ok) {
      // 上传只保存了字节；必须独立登记版本映射，未被下游引用的镜头也能在刷新后恢复。
      const persisted = await persistShotReferenceRecording(ctx, target, outcome.asset, `${target.title} · 镜头参考`);
      if (!persisted.ok) {
        cache.markFailed(target, persisted.error);
        return persisted;
      }
      cache.publish(target, outcome.asset);
      return { ok: true };
    }
    cache.markFailed(target, outcome.message);
    return { ok: false, error: outcome.message };
  };
}

/**
 * 构造**单次录制**的注入依赖（任务 8.4）。
 *
 * 独立导出便于用替身 `ctx` 单测接线：`playback` 显式传入，不读 `ctx.filmSetPlayback`
 * 服务（本扩展插件不声明该 inject，装配时同步触发会抛 inject 错误）。
 */
export function createShotReferenceRecordDeps(input: {
  ctx: Context;
  playback: ShotReferencePlaybackPort;
  /** 本次录制目标（会话身份与截图路由都用它）。 */
  target: ShotReferenceRecordTarget;
  /** 采样帧捕获用的 generation 序列。 */
  nextCaptureGeneration: () => number;
  /** 录制开始时的用户播放状态，录后恢复。 */
  original: { time: number; playing: boolean };
  /** 阶段耗时累计（可选，只用于诊断）。 */
  timing?: ShotReferenceRecordTiming;
  /** 采样进度（可选；供活动面板显示录制百分比）。 */
  onProgress?: (progress: ShotReferenceRecordProgress) => void;
  now?: () => string;
}): ShotReferenceRecordDeps {
  const { ctx, playback, target, nextCaptureGeneration, original, timing, onProgress } = input;
  // 录制会话：把播放投影锁到该镜头的预览卡片，renderer 才能按 T 离屏出该镜头的画面。
  // `restore` 一定在录制结束时交还投影（`recordShotReference` 的 finally）。
  playback.beginCaptureSession({
    filmSetNodeId: target.filmSetNodeId,
    clipId: target.clipId,
    previewNodeId: target.previewNodeId
  });
  return {
    isCurrent: (candidate: ShotReferenceRecordTarget) =>
      contentIdentityNow(ctx, candidate.filmSetNodeId, candidate.clipId) === candidate.contentIdentity,
    capture: async (candidate: ShotReferenceRecordTarget, time: number, signal: AbortSignal) => {
      const startedAt = timing ? clock() : 0;
      playback.seek(time);
      const seekedAt = timing ? clock() : 0;
      await nextPaint(signal);
      const paintedAt = timing ? clock() : 0;
      const ready = await (ctx.canvasRuntime.compositeAssetMediaSessions?.()?.waitForTime(candidate.filmSetNodeId, time, 5000, 0.001) ?? Promise.resolve(true));
      const mediaAt = timing ? clock() : 0;
      if (!ready) throw new Error(`第 ${time.toFixed(2)} 秒的片场媒体帧未就绪`);
      const runtime = ctx.canvasRuntime.runtime();
      if (!runtime?.isReady()) throw new Error("画布渲染器未就绪，请稍后重试");
      // 请求按**预览节点 id** 路由到该卡片的 rig；renderer 建立临时离屏相机按请求尺寸回读，
      // 不依赖卡片是否在屏幕上的实际大小。
      //
      // nextPaint 不保证 GPU 就绪；Rust 等捕捉相机自身完成渲染准备后才回读。
      const frame = await runtime.requestCapture({ nodeId: candidate.previewNodeId, generation: nextCaptureGeneration(), width: candidate.width, height: candidate.height })
        .catch((cause: unknown) => {
          throw new Error(`第 ${time.toFixed(2)} 秒：${cause instanceof Error ? cause.message : String(cause)}`);
        });
      if (timing) {
        const capturedAt = clock();
        timing.seekMs += seekedAt - startedAt;
        timing.paintMs += paintedAt - seekedAt;
        timing.mediaMs += mediaAt - paintedAt;
        timing.captureMs += capturedAt - mediaAt;
        timing.captureMaxMs = Math.max(timing.captureMaxMs, capturedAt - mediaAt);
      }
      if (!frame) throw new Error(`第 ${time.toFixed(2)} 秒的镜头捕捉失败或超时`);
      return frame as { rgba: Uint8Array; width: number; height: number };
    },
    restore: (candidate: ShotReferenceRecordTarget) => {
      // 先交还播放投影，再恢复用户播放头：录制会话不得残留。
      void candidate;
      playback.endCaptureSession();
      playback.seek(original.time);
      if (original.playing && !document.hidden) playback.play();
    },
    createEncoder: async (candidate) => {
      const encoder = await createFilmSetVideoEncoder({
        canvasId: candidate.canvasId,
        nodeId: candidate.filmSetNodeId,
        clipId: candidate.clipId,
        sourceIdentity: candidate.contentIdentity,
        generation: 0,
        title: candidate.title,
        duration: candidate.duration,
        aspect: candidate.aspect,
        time: 0,
        playing: false,
        layoutIdentity: candidate.profileKey
      });
      if (!timing) return encoder;
      return {
        add: async (frame, timestamp, duration) => {
          const startedAt = clock();
          try {
            await encoder.add(frame, timestamp, duration);
          } finally {
            timing.encodeMs += clock() - startedAt;
          }
        },
        finish: () => encoder.finish(),
        cancel: () => encoder.cancel()
      };
    },
    acquire: () => ctx.modelWorkspace.acquireCapture(),
    upload: async (file: File, signal: AbortSignal) => {
      const startedAt = timing ? clock() : 0;
      const result = await ctx.mediaRemote.upload({ file, signal, canvasId: ctx.canvasScope.canvasId() });
      if (timing) timing.uploadMs += clock() - startedAt;
      if (!result.ok) return { ok: false as const, error: result.error };
      return { ok: true as const, asset: { storageKey: result.media.storageKey, checksum: result.media.checksum, mediaType: result.media.contentType, size: result.media.size } };
    },
    onProgress: (progress) => {
      if (timing) timing.frames = progress.completed;
      onProgress?.(progress);
    },
    shouldYield: () => document.hidden || ctx.modelWorkspace.captureSession.busy,
    awaitIdle: (signal: AbortSignal) => waitUntilIdle(() => !document.hidden && !ctx.modelWorkspace.captureSession.busy, signal),
    now: input.now ?? (() => new Date().toISOString())
  };
}

/** 供观察/接线复用的 profile key。 */
export const SHOT_REFERENCE_PROFILE_KEY = shotReferenceProfileKey(DEFAULT_SHOT_REFERENCE_RECORD_PROFILE);

/** 单次录制的阶段耗时（毫秒），用于判断慢在取帧、编码还是上传。 */
export type ShotReferenceRecordTiming = {
  frames: number;
  seekMs: number;
  paintMs: number;
  mediaMs: number;
  captureMs: number;
  captureMaxMs: number;
  encodeMs: number;
  uploadMs: number;
};

export function createShotReferenceRecordTiming(): ShotReferenceRecordTiming {
  return { frames: 0, seekMs: 0, paintMs: 0, mediaMs: 0, captureMs: 0, captureMaxMs: 0, encodeMs: 0, uploadMs: 0 };
}

function clock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * 每次录制输出一行诊断：帧数、总耗时与各阶段耗时。
 *
 * 只在录制结束/失败时输出一次，不参与产品逻辑；慢在哪一侧看这行即可。
 */
function reportShotReferenceTiming(
  target: ShotReferenceRecordTarget,
  timing: ShotReferenceRecordTiming,
  outcome: { ok: boolean; code?: string },
  totalMs: number
): void {
  try {
    console.info("[shot-reference]", JSON.stringify({
      clipId: target.clipId,
      filmSetNodeId: target.filmSetNodeId,
      duration: target.duration,
      ok: outcome.ok,
      failed: outcome.ok ? null : outcome.code ?? "failed",
      frames: timing.frames,
      totalMs: Math.round(totalMs),
      msPerFrame: timing.frames ? Math.round(totalMs / timing.frames) : null,
      seekMs: Math.round(timing.seekMs),
      paintMs: Math.round(timing.paintMs),
      mediaMs: Math.round(timing.mediaMs),
      captureMs: Math.round(timing.captureMs),
      captureMaxMs: Math.round(timing.captureMaxMs),
      encodeMs: Math.round(timing.encodeMs),
      uploadMs: Math.round(timing.uploadMs)
    }));
  } catch {
    /* 诊断输出失败不能影响录制结果。 */
  }
}

function nextPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("镜头录制已取消"));
      return;
    }
    const abort = () => {
      cancelAnimationFrame(frame);
      reject(new Error("镜头录制已取消"));
    };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitUntilIdle(ready: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (signal.aborted) {
        reject(new Error("镜头录制已取消"));
        return;
      }
      if (ready()) {
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}
