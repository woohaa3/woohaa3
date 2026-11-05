/**
 * 共享世界镜头捕获轮询适配。
 *
 * 请求一次页面内离屏渲染并轮询匹配 (requestId, generation) 的结果帧；帧布局与历史缩略图
 * 一致：`[u32 LE width][u32 LE height][u32 LE status][payload...]`，status 0 = 成功 RGBA，
 * status 1 = 失败码（UTF-8）。桥接槽是 latest-wins 单槽，调用方必须串行发送
 * （见 `model-capture-shared.ts` 的共享捕获锁）。
 */
import type { BevyModule } from "./bevy-runtime.js";

export const WORLD_CAPTURE_POLL_INTERVAL_MS = 16;
/** 首次离屏作业要等管线编译，留足余量；超时后取景冻结返回可重试失败码。 */
export const WORLD_CAPTURE_TIMEOUT_MS = 30000;

export type WorldCaptureFrame =
  | { ok: true; rgba: Uint8Array; width: number; height: number }
  | { ok: false; code: string };

export async function pollWorldCapture(
  module: BevyModule,
  input: { requestId: number; generation: number; cameraId: string; width: number; height: number },
  current: () => boolean = () => true
): Promise<WorldCaptureFrame> {
  if (!current() || !module.request_world_capture || !module.poll_world_capture) {
    return { ok: false, code: "renderer-unavailable" };
  }
  try {
    module.request_world_capture(
      JSON.stringify({
        requestId: input.requestId,
        generation: input.generation,
        cameraId: input.cameraId,
        width: input.width,
        height: input.height
      })
    );
  } catch {
    return { ok: false, code: "capture-invalid-request" };
  }
  const deadline = Date.now() + WORLD_CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WORLD_CAPTURE_POLL_INTERVAL_MS));
    if (!current()) return { ok: false, code: "capture-cancelled" };
    const frame = module.poll_world_capture(input.requestId, input.generation);
    if (!frame || frame.length < 12) continue;
    const view = new DataView(frame.buffer, frame.byteOffset, 12);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const status = view.getUint32(8, true);
    if (status !== 0) {
      const code = new TextDecoder().decode(frame.subarray(12)).trim();
      return { ok: false, code: code || "capture-render-failed" };
    }
    const rgba = frame.subarray(12);
    if (width > 0 && height > 0 && rgba.length >= width * height * 4) {
      return { ok: true, rgba: rgba.slice(0, width * height * 4), width, height };
    }
    return { ok: false, code: "capture-empty-image" };
  }
  return { ok: false, code: "capture-poll-timeout" };
}
