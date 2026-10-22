/**
 * 独立镜头录制（任务 8.4 / design D9）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 把「按内容版本录制一段镜头视频」从显式导出里拆成可复用的录制能力：接收**已固定**的
 * `ShotReferenceRecordTarget`（画布 + 片场 + clipId + 视觉内容身份 + 录制 profile），用固定采样
 * 时钟逐帧渲染、编码、上传，最后把资产交回给调用方（版本缓存）发布。
 *
 * 关键不变量：
 * - **固定源版本**：每帧前后都用 `isCurrent` 复核内容身份；不一致立即以 `stale` 结束，绝不把
 *   混合版本的帧组成可用视频；
 * - **同一 T**：`capture` 只接收一个 `time`，对象/媒体/相机都必须在同一时刻渲染（renderer 契约）；
 * - **固定采样时钟**：时间戳只由 `fps` 与序号决定，慢渲染不改变影片时长与运动速度；
 * - **不改变用户播放头**：本模块不驱动共享播放时钟，`capture` 负责在不改变用户播放头的前提下取帧；
 * - **交互让路**：与截图/显式导出共用 `acquire` 独占门；`shouldYield` 为真时 `awaitIdle` 暂停采样，
 *   而不是抢 GPU；
 * - **低优先级串行有界**：串行由调度器保证，本模块一次只录一个版本。
 *
 * 纯编排：不 import DOM/Zustand/Yjs，可在 node 环境用替身单测。
 */
import type { FilmSetVideoEncoder, VideoFrame } from "./film-set-video-export.js";

/** 采样帧率；时间戳 = 序号 / fps。 */
export const SHOT_REFERENCE_FPS = 30;

/** 一次录制任务的固定身份（不含播放状态，因此不依赖打开工作区或当前选中镜头）。 */
export type ShotReferenceRecordTarget = {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  /**
   * 该镜头的拍摄预览节点 id（由 `(片场, clip)` 确定性派生）。
   *
   * renderer 按它把截图请求路由到卡片 rig：**非聚焦**片场没有 adapter rig，只有卡片 rig 有独立
   * 渲染层与当前 T 的相机姿态（change: 2026-10-15，任务 8.4）。
   */
  previewNodeId: string;
  /** 视觉内容身份：录制期间必须保持不变。 */
  contentIdentity: string;
  /** 录制 profile key：编码参数变化即新版本。 */
  profileKey: string;
  /** 影片时长（秒，>0）。 */
  duration: number;
  /** 画幅，如 `16:9`。 */
  aspect: string;
  /** 展示标题（仅用于文件名，不参与身份）。 */
  title: string;
  /** 输出像素尺寸（与 profile 一致）。 */
  width: number;
  height: number;
};

/** 录制得到的真实视频资产（尚未发布到版本缓存）。 */
export type ShotReferenceRecordedAsset = {
  storageKey: string;
  /** 内容 sha256；画布资产必须携带，服务端会用它与 storageKey 内嵌哈希互相校验。 */
  checksum: string;
  mediaType: string;
  size: number;
};

export type ShotReferenceRecordOutcome =
  | { ok: true; asset: ShotReferenceRecordedAsset }
  | { ok: false; code: "canceled" | "stale" | "yielded" | "failed"; message: string };

export type ShotReferenceRecordProgress = { completed: number; total: number };

export type ShotReferenceRecordDeps = {
  /** 内容身份是否仍是当前权威版本；不一致立即失效。 */
  isCurrent(target: ShotReferenceRecordTarget): boolean;
  /** 在不改变用户播放头的前提下渲染 `time` 秒的一帧（对象/媒体/相机同 T）。 */
  capture(target: ShotReferenceRecordTarget, time: number, signal: AbortSignal): Promise<VideoFrame>;
  /** 上传完成或失败后把渲染时钟恢复到用户原状态。 */
  restore(target: ShotReferenceRecordTarget): void;
  createEncoder(target: ShotReferenceRecordTarget): Promise<FilmSetVideoEncoder>;
  /** 与截图/显式导出共用的独占捕捉门。 */
  acquire(): Promise<() => void>;
  upload(file: File, signal: AbortSignal): Promise<{ ok: true; asset: ShotReferenceRecordedAsset } | { ok: false; error: string }>;
  /** 交互/播放/截图/显式导出是否需要让路。 */
  shouldYield(): boolean;
  /** 等到可以继续（低优先级）；`signal` 中止时 reject。 */
  awaitIdle(signal: AbortSignal): Promise<void>;
  /** 文件命名用的时间戳。 */
  now(): string;
  /** 采样进度（可选）。 */
  onProgress?(progress: ShotReferenceRecordProgress): void;
};

/** 固定采样时钟：把 `duration` 秒切成长度恒定的 `fps` 帧时间戳。 */
export function shotReferenceTimestamps(duration: number, fps = SHOT_REFERENCE_FPS): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const total = Math.ceil(duration * fps);
  return Array.from({ length: total }, (_, index) => (index === total - 1 ? duration : index / fps));
}

/**
 * 录制一段镜头视频。成功返回真实资产；失败给出可区分原因，由调用方决定重试（`failed`/`yielded`）
 * 或按失效处理（`stale`/`canceled`）。不发布、不写画布——发布由版本缓存原子完成。
 */
export async function recordShotReference(
  deps: ShotReferenceRecordDeps,
  target: ShotReferenceRecordTarget,
  signal: AbortSignal
): Promise<ShotReferenceRecordOutcome> {
  if (!(Number.isFinite(target.duration) && target.duration > 0)) {
    return { ok: false, code: "failed", message: "该镜头没有可录制的动画时长" };
  }
  const timestamps = shotReferenceTimestamps(target.duration);
  if (!timestamps.length) return { ok: false, code: "failed", message: "该镜头没有可录制的动画时长" };

  let encoder: FilmSetVideoEncoder | undefined;
  let release: (() => void) | undefined;
  let restored = false;
  const stale = () => signal.aborted || !deps.isCurrent(target);
  const check = () => {
    if (signal.aborted) throw new ShotReferenceRecordError("canceled", "镜头录制已取消");
    if (!deps.isCurrent(target)) throw new ShotReferenceRecordError("stale", "镜头内容已变化，本次录制作废");
  };
  try {
    check();
    // 交互/截图/显式导出优先：要门不成就让路，不抢 GPU。
    if (deps.shouldYield()) return { ok: false, code: "yielded", message: "交互进行中，镜头录制让路" };
    release = await deps.acquire();
    check();
    encoder = await deps.createEncoder(target);
    check();
    deps.onProgress?.({ completed: 0, total: timestamps.length });
    for (let index = 0; index < timestamps.length; index++) {
      check();
      if (deps.shouldYield()) {
        await deps.awaitIdle(signal);
        check();
      }
      const time = timestamps[index]!;
      const frame = await deps.capture(target, time, signal);
      check();
      await encoder.add(frame, index / SHOT_REFERENCE_FPS, Math.min(1 / SHOT_REFERENCE_FPS, target.duration - index / SHOT_REFERENCE_FPS));
      deps.onProgress?.({ completed: index + 1, total: timestamps.length });
    }
    const blob = await encoder.finish();
    release();
    release = undefined;
    deps.restore(target);
    restored = true;
    if (!blob.size) throw new ShotReferenceRecordError("failed", "视频编码没有生成有效文件");
    // 发布前再复核一次：上传期间内容变化则作废，绝不冒充新版本。
    check();
    const file = new File([blob], `${target.title || "镜头参考"}.mp4`, { type: "video/mp4" });
    const uploaded = await deps.upload(file, signal);
    if (!uploaded.ok) throw new ShotReferenceRecordError("failed", `视频上传失败：${uploaded.error}`);
    check();
    return { ok: true, asset: uploaded.asset };
  } catch (cause) {
    if (cause instanceof ShotReferenceRecordError) return { ok: false, code: cause.code, message: cause.message };
    return { ok: false, code: stale() ? "stale" : "failed", message: cause instanceof Error ? cause.message : "镜头录制失败" };
  } finally {
    try {
      await encoder?.cancel();
    } catch {
      /* 释放失败不能把录制方卡在占用状态。 */
    }
    release?.();
    if (!restored) deps.restore(target);
  }
}

class ShotReferenceRecordError extends Error {
  constructor(readonly code: "canceled" | "stale" | "failed", message: string) {
    super(message);
  }
}
