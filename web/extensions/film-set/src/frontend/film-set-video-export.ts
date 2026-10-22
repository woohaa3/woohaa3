import { buildUploadedAsset, planUploadedNode, type UploadedMedia } from "@woohaa3/frontend/extension-api";
import type { CanvasCommand } from "@woohaa3/contracts";

export type FilmSetVideoTarget = {
  canvasId: string; nodeId: string; clipId: string; sourceIdentity: string; generation: number;
  title: string; duration: number; aspect: string; time: number; playing: boolean;
  layoutIdentity: string;
};
export type VideoExportProgress = { phase: "rendering" | "uploading" | "saving"; completed: number; total: number };
export type VideoFrame = { rgba: Uint8Array; width: number; height: number };
export type FilmSetVideoEncoder = {
  add(frame: VideoFrame, timestamp: number, duration: number): Promise<void>;
  finish(): Promise<Blob>;
  cancel(): Promise<void>;
};
export type FilmSetVideoExportDeps = {
  isCurrent(target: FilmSetVideoTarget): boolean;
  seek(time: number): void;
  restore(target: FilmSetVideoTarget): void;
  capture(target: FilmSetVideoTarget, time: number, signal: AbortSignal): Promise<VideoFrame>;
  createEncoder(target: FilmSetVideoTarget): Promise<FilmSetVideoEncoder>;
  acquire(): Promise<() => void>;
  upload(file: File, signal: AbortSignal): Promise<{ ok: true; media: UploadedMedia } | { ok: false; error: string }>;
  sourcePosition(nodeId: string): { x: number; y: number; width: number } | null;
  submit(commands: CanvasCommand[], commandId: string): Promise<{ ok: true } | { ok: false; error: string }>;
};
export type FilmSetVideoExportResult = { ok: true; nodeId: string }
  | { ok: false; code: "canceled" | "export-failed" | "busy"; message: string };

/** Fixed timestamps make slow rendering produce the same movie duration and motion speed. */
export class FilmSetVideoExportSession {
  private active: AbortController | null = null;
  constructor(private readonly deps: FilmSetVideoExportDeps) {}
  cancel(): void { this.active?.abort(); }
  get busy(): boolean { return this.active !== null; }

  async run(target: FilmSetVideoTarget, progress: (value: VideoExportProgress) => void): Promise<FilmSetVideoExportResult> {
    if (this.active) return { ok: false, code: "busy", message: "已有视频正在生成" };
    const controller = new AbortController(); this.active = controller;
    let release: (() => void) | undefined;
    let encoder: FilmSetVideoEncoder | undefined;
    let restored = false;
    const check = () => {
      if (controller.signal.aborted) throw new Error("视频生成已取消");
      if (!this.deps.isCurrent(target)) throw new Error("片段、场景或写入权限已变化，视频生成已停止，请重新生成");
    };
    try {
      check();
      if (!(Number.isFinite(target.duration) && target.duration > 0)) throw new Error("当前片段没有可导出的动画时长");
      encoder = await this.deps.createEncoder(target); check();
      release = await this.deps.acquire(); check();
      const fps = 30, total = Math.ceil(target.duration * fps);
      progress({ phase: "rendering", completed: 0, total });
      for (let index = 0; index < total; index++) {
        check();
        const timestamp = index / fps;
        // The last sample shows the endpoint, while its duration ends exactly at the timeline end.
        const time = index === total - 1 ? target.duration : timestamp;
        this.deps.seek(time);
        const frame = await this.deps.capture(target, time, controller.signal); check();
        await encoder.add(frame, timestamp, Math.min(1 / fps, target.duration - timestamp)); check();
        progress({ phase: "rendering", completed: index + 1, total });
      }
      const blob = await encoder.finish(); check();
      release(); release = undefined;
      this.deps.restore(target);
      restored = true;
      if (!blob.size) throw new Error("视频编码没有生成有效文件，请重试");
      progress({ phase: "uploading", completed: total, total });
      const captureId = crypto.randomUUID();
      const file = new File([blob], `${target.title || "片场动画"}.mp4`, { type: "video/mp4" });
      const uploaded = await this.deps.upload(file, controller.signal); check();
      if (!uploaded.ok) throw new Error(`视频上传失败：${uploaded.error}`);
      const source = this.deps.sourcePosition(target.nodeId);
      if (!source) throw new Error("源片场已移除，无法放置视频节点");
      const asset = buildUploadedAsset({ media: uploaded.media, mediaKind: "video", file });
      asset.metadata = { ...asset.metadata, duration: target.duration, width: videoSize(target.aspect).width, height: videoSize(target.aspect).height, frameRate: fps };
      const nodeId = `film-set-video-${captureId}`;
      const commands = planUploadedNode({ nodeType: "video", nodeId, position: { x: source.x + source.width + 16, y: source.y }, file, asset });
      const add = commands.find(command => command.type === "node.add");
      if (add?.type === "node.add") {
        const data = add.nodeData ?? {};
        data.filmSetVideoOrigin = {
        filmSetNodeId: target.nodeId, clipId: target.clipId, sourceIdentity: target.sourceIdentity,
        duration: target.duration, aspect: target.aspect, frameRate: fps, capturedAt: new Date().toISOString()
        };
        add.nodeData = data;
      }
      check(); progress({ phase: "saving", completed: total, total });
      const result = await this.deps.submit(commands, `web-film-set-video-${captureId}`);
      if (!result.ok) throw new Error(`视频节点保存失败：${result.error}`);
      return { ok: true, nodeId };
    } catch (cause) {
      return { ok: false, code: controller.signal.aborted ? "canceled" : "export-failed", message: cause instanceof Error ? cause.message : "视频生成失败，请重试" };
    } finally {
      try { await encoder?.cancel(); } catch { /* Release failures must not keep the player busy. */ }
      release?.();
      if (!restored) this.deps.restore(target);
      this.active = null;
    }
  }
}

/** 720p landscape / portrait, preserve the selected shot aspect and even codec dimensions. */
export function videoSize(aspect: string): { width: number; height: number } {
  const [w, h] = aspect.split(":").map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
  return ratio >= 1 ? { width: Math.round(720 * ratio / 2) * 2, height: 720 }
    : { width: 720, height: Math.round(720 / ratio / 2) * 2 };
}
