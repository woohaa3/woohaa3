/**
 * 模型历史缩略图轮询适配
 * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
 *
 * 请求一次页面内离屏渲染并轮询匹配 (requestId, generation) 的结果帧；帧布局：
 * `[u32 LE width][u32 LE height][u32 LE status][payload...]`，status 0 = 成功 RGBA，
 * status 1 = 失败码（UTF-8）。桥接槽是 latest-wins 单槽，调用方必须串行发送
 * （见 `model-capture-shared.ts` 的共享捕获锁）。
 */
import type { BevyModule } from "./bevy-runtime.js";

/** 缩略图输出尺寸：历史卡片按 2x 屏下仍清晰的四比三小图渲染。 */
export const HISTORY_THUMBNAIL_WIDTH = 320;
export const HISTORY_THUMBNAIL_HEIGHT = 240;
export const HISTORY_THUMBNAIL_POLL_INTERVAL_MS = 16;
/** 首次离屏作业要等管线编译，留足余量；超时后卡片进入可重试失败态。 */
export const HISTORY_THUMBNAIL_TIMEOUT_MS = 30000;

export type HistoryThumbnailFrame =
  | { ok: true; rgba: Uint8Array; width: number; height: number }
  | { ok: false; code: string };

export async function pollHistoryThumbnail(
  module: BevyModule,
  input: { requestId: number; generation: number; sceneVersion: string; ops: readonly unknown[]; width?: number; height?: number },
  current: () => boolean = () => true
): Promise<HistoryThumbnailFrame> {
  if (!current() || !module.request_history_thumbnail || !module.poll_history_thumbnail) {
    return { ok: false, code: "renderer-unavailable" };
  }
  try {
    module.request_history_thumbnail(
      JSON.stringify({
        requestId: input.requestId,
        generation: input.generation,
        sceneVersion: input.sceneVersion,
        ops: input.ops,
        width: input.width ?? HISTORY_THUMBNAIL_WIDTH,
        height: input.height ?? HISTORY_THUMBNAIL_HEIGHT
      })
    );
  } catch {
    return { ok: false, code: "thumbnail-invalid-request" };
  }
  const deadline = Date.now() + HISTORY_THUMBNAIL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, HISTORY_THUMBNAIL_POLL_INTERVAL_MS));
    if (!current()) return { ok: false, code: "thumbnail-cancelled" };
    const frame = module.poll_history_thumbnail(input.requestId, input.generation);
    if (!frame || frame.length < 12) continue;
    const view = new DataView(frame.buffer, frame.byteOffset, 12);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const status = view.getUint32(8, true);
    if (status !== 0) {
      const code = new TextDecoder().decode(frame.subarray(12)).trim();
      return { ok: false, code: code || "thumbnail-render-failed" };
    }
    const rgba = frame.subarray(12);
    if (width > 0 && height > 0 && rgba.length >= width * height * 4) {
      return { ok: true, rgba: rgba.slice(0, width * height * 4), width, height };
    }
    return { ok: false, code: "thumbnail-empty-image" };
  }
  return { ok: false, code: "thumbnail-poll-timeout" };
}
