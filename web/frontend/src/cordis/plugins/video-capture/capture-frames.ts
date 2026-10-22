/**
 * `<video>` 元素解码源 + 打开/关闭/截取提交管理器
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 3.1–3.3）。
 *
 * 从原 `frame-capture-dialog.tsx` 抽出：
 * - `videoElementSource`：把可见 `<video>` 包装成共享 `FrameCaptureSource`；
 * - `OpenCaptureFrames`：打开时记录当前 source identity 与目标帧身份；仅从 canonical ready
 *   视频解析稳定身份；逐帧 Blob → Media Remote 上传 → 既有 asset/node 命令 pipeline；
 *   逐项回执、部分失败可重试（同一 frameId 不重复导入）；只读写入门禁。
 *
 * 所有网络与写入都经注入的 `mediaRemote` / `canvasSession`；本模块不拼 API path、不把 Blob
 * 之外的临时表示写入规范状态。
 */
import type { CanvasCommand, CanvasNodeData, StoredAsset } from "@woohaa3/contracts";
import { VIDEO_FRAME_EPSILON_SECONDS } from "@woohaa3/contracts";
import { planInsertNode } from "../../../extension-api/command-planner.js";
import { mediaUrlFor } from "../../services/paths.js";
import type { FrameCaptureSource } from "./capture-source.js";
import type { CapturedFrameEntry, FrameAddReceipt } from "./types.js";
import type { CanvasSession, MediaRemoteService } from "../../contracts.js";

/** 浏览器安全错误 → 可恢复的用户提示。 */
export function toSafeCaptureError(error: unknown): string {
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "视频来源受跨域限制，无法读取画面像素。请使用已导入画布的同源视频。";
  }
  if (error instanceof Error && error.message) return error.message;
  return "截取视频帧失败";
}

/** 从 `<video>` 读取当前帧为 PNG Blob；失败抛出（含 SecurityError）。 */
export async function captureVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("视频画面尚未就绪");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建截帧画布");
  context.drawImage(video, 0, 0, width, height);
  // 读取像素会触发 tainted canvas 检查；跨域视频在此抛 SecurityError。
  context.getImageData(0, 0, 1, 1);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("生成截帧图片失败");
  return blob;
}

/** 把可见 `<video>` 包装成共享截帧源；状态只读会话内元素。 */
export function videoElementSource(video: HTMLVideoElement): FrameCaptureSource {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const events = ["loadedmetadata", "loadeddata", "canplay", "durationchange", "timeupdate", "seeked", "play", "pause", "volumechange"];
  return {
    state: () => readVideoState(video),
    subscribe: (listener) => {
      if (listeners.size === 0) for (const event of events) video.addEventListener(event, notify);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) for (const event of events) video.removeEventListener(event, notify);
      };
    },
    play: async () => { await video.play(); },
    pause: () => video.pause(),
    seek: (time) => seekVideo(video, time),
    setMuted: (muted) => { video.muted = muted; notify(); },
    capture: () => captureVideoFrame(video)
  };
}

export function readVideoState(video: HTMLVideoElement) {
  return {
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    currentTime: video.currentTime,
    playing: !video.paused && !video.ended,
    muted: video.muted,
    ready: video.readyState >= 2,
    width: video.videoWidth,
    height: video.videoHeight
  };
}

export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(time, 0), Math.max(0, duration));
}

/** seek 到目标时间并等待 `seeked`（已就位时立即完成）。 */
export function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const target = clampTime(time, Number.isFinite(video.duration) ? video.duration : 0);
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = target;
  });
}

/** 稳定尾帧时间：不超过 duration，且不落在 ended 空白帧。 */
export function lastFrameTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, duration - VIDEO_FRAME_EPSILON_SECONDS);
}

/**
 * 聚焦与 Dialog 共享的“打开帧集合”管理器。
 *
 * 拥有当前 source identity、帧集合（含 object URL）与添加动作；不渲染 UI，不持有对话框。
 * `addFrames` 幂等（同一 frameId 不重复导入）。
 */
export class OpenCaptureFrames {
  private disposed = false;
  /** 已成功导入的帧（幂等重试：同一 frameId 不重复创建节点）。 */
  private readonly addedFrames = new Map<string, FrameAddReceipt>();

  constructor(
    private readonly deps: {
      mediaRemote: MediaRemoteService;
      session: CanvasSession;
      /** 解析某个节点当前位置；缺失时回退到原点偏移。 */
      resolveNodePosition?: (nodeId: string) => { x: number; y: number } | null;
      /** 当前画布身份：截帧上传要带画布提示（POST /api/media?canvas=<id>）。 */
      canvasId?: () => string | null;
    }
  ) {}

  /**
   * 截帧添加动作：逐帧独立上传 + 原子提交；返回逐项回执。
   * 成功项保留在 `addedFrames`，重试时直接返回既有回执，不重复导入（design D3）。
   */
  async addFrames(frames: readonly CapturedFrameEntry[], targetNodeId: string, signal?: AbortSignal): Promise<readonly FrameAddReceipt[]> {
    if (this.disposed) {
      return frames.map((frame) => failedReceipt(frame.id, frame.timeSeconds, "视频截帧能力已释放"));
    }
    const receipts: FrameAddReceipt[] = [];
    for (const [index, frame] of frames.entries()) {
      const cached = this.addedFrames.get(frame.id);
      if (cached) {
        receipts.push(cached);
        continue;
      }
      receipts.push(await this.addOneFrame(frame, index, targetNodeId, signal));
    }
    return receipts;
  }

  private async addOneFrame(
    frame: CapturedFrameEntry,
    index: number,
    targetNodeId: string,
    signal?: AbortSignal
  ): Promise<FrameAddReceipt> {
    if (this.disposed || signal?.aborted || (this.deps.resolveNodePosition && !this.deps.resolveNodePosition(targetNodeId))) {
      return failedReceipt(frame.id, frame.timeSeconds, "截帧来源已失效，请重新进入");
    }
    if (!this.deps.session.isWritable()) {
      return failedReceipt(frame.id, frame.timeSeconds, "网络不可用，画布只读");
    }
    let file: File;
    try {
      file = new File([frame.blob], `video-frame-${formatStamp(frame.timeSeconds)}.png`, { type: "image/png" });
    } catch {
      return failedReceipt(frame.id, frame.timeSeconds, "无法读取截取帧");
    }
    const uploaded = await this.deps.mediaRemote.upload({
      file,
      canvasId: this.deps.canvasId?.() ?? undefined,
      ...(signal ? { signal } : {})
    });
    if (!uploaded.ok) return failedReceipt(frame.id, frame.timeSeconds, uploaded.error);
    const asset = frameAsset(uploaded.media, frame.timeSeconds);
    // 上传完成后目标可能已被删除/会话释放：再次核对可写性，阻止迟到提交。
    if (this.disposed || signal?.aborted || (this.deps.resolveNodePosition && !this.deps.resolveNodePosition(targetNodeId))) {
      return failedReceipt(frame.id, frame.timeSeconds, "截帧来源已失效，请重新进入");
    }
    if (!this.deps.session.isWritable()) {
      return failedReceipt(frame.id, frame.timeSeconds, "网络不可用，画布只读");
    }
    const nodeId = `video-frame-${frame.id}`;
    const base = this.deps.resolveNodePosition?.(targetNodeId) ?? null;
    const position = base
      ? { x: base.x + 24 * (index + 1), y: base.y + 24 * (index + 1) }
      : { x: 240 + 24 * index, y: 160 + 24 * index };
    const commands: CanvasCommand[] = [
      { type: "asset.upsert", asset },
      ...planInsertNode({
        nodeType: "image",
        position,
        nodeId,
        nodeData: { title: asset.title, outputAssetId: asset.id, resourceKind: "image", taskStatus: "successed" }
      })
    ];
    const result = this.deps.session.submitCommands(commands, `web-video-frame-${frame.id}`);
    if (!result.ok) return failedReceipt(frame.id, frame.timeSeconds, result.reason);
    const receipt: FrameAddReceipt = { frameId: frame.id, timeSeconds: frame.timeSeconds, ok: true, nodeId, assetId: asset.id };
    this.addedFrames.set(frame.id, receipt);
    return receipt;
  }

  /** dispose：阻止之后的上传结果提交；丢弃幂等缓存。 */
  dispose(): void {
    this.disposed = true;
    this.addedFrames.clear();
  }
}

export function frameAsset(media: { storageKey: string; checksum: string; contentType: string; size: number; url: string }, timeSeconds: number): StoredAsset {
  return {
    id: `asset-video-frame-${media.checksum}`,
    title: `截帧 ${formatStamp(timeSeconds)}`,
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: new Date().toISOString(),
    url: media.url || mediaUrlFor(media.storageKey),
    metadata: { storageKey: media.storageKey, checksum: media.checksum, contentType: media.contentType, size: media.size }
  };
}

export function failedReceipt(frameId: string, timeSeconds: number, error: string): FrameAddReceipt {
  return { frameId, timeSeconds, ok: false, error };
}

function formatStamp(seconds: number): string {
  return Math.max(0, Number.isFinite(seconds) ? seconds : 0).toFixed(2).replace(".", "_");
}

/** 保留：nodeData 校验占位类型（供调用方显式引用，避免未使用告警）。 */
export type FrameCaptureNodeData = CanvasNodeData;
