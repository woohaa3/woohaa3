/**
 * 镜头截图轮询适配
 * （change: refactor-frontend-file-size；从 `bevy-runtime.ts` 拆出以遵守文件体积守卫）。
 *
 * 请求一次镜头截图并轮询匹配 (requestId, generation) 的结果帧；帧布局：
 * `[u32 LE width][u32 LE height][u32 LE status][payload...]`，status 0 = 成功 RGBA。
 */
import type { BevyModule } from "./bevy-runtime.js";

/** 截图输出尺寸（与 Bevy `capture.rs` 一致）。 */
export const CAPTURE_WIDTH = 1280;
export const CAPTURE_HEIGHT = 720;
/** 截图轮询间隔与超时（毫秒）。超时留出慢机器与首次离屏回读的余量。 */
export const CAPTURE_POLL_INTERVAL_MS = 16;
export const CAPTURE_TIMEOUT_MS = 20000;

const CAPTURE_FAILURE_LABELS: Record<string, string> = {
  "capture-readiness-timeout": "捕捉视图等待渲染准备超时",
  "capture-readback-timeout": "捕捉画面回读超时",
  "capture-empty-image": "回读像素无效或画面全透明",
  "readback-failed": "画面回读失败",
  "camera-gone": "镜头相机已移除或尚未创建",
  "stale-generation": "镜头版本已变化",
  "cancelled": "捕捉已取消",
  "invalid-size": "捕捉尺寸无效",
  "busy": "捕捉队列已满",
  "capture-queue-timeout": "截图请求排队超时（未能路由到拍摄相机）"
};

export type ShotCaptureResult = { rgba: Uint8Array; width: number; height: number } | null;

export async function pollShotCapture(
  module: BevyModule,
  input: {
    requestId: number;
    nodeId: string;
    generation: number;
    width?: number;
    height?: number;
    /** 请求来源标签（诊断用，见 `requestCapture`）。 */
    source?: string;
  },
  current: () => boolean = () => true
): Promise<ShotCaptureResult> {
  if (!current() || !module.request_shot_capture || !module.poll_shot_capture) return null;
  module.request_shot_capture(
    JSON.stringify({
      requestId: input.requestId,
      nodeId: input.nodeId,
      generation: input.generation,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.source ? { source: input.source } : {})
    })
  );
  try {
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_INTERVAL_MS));
      if (!current()) return null;
      const frame = module.poll_shot_capture(input.requestId, input.generation);
      if (frame && frame.length >= 12) {
        const view = new DataView(frame.buffer, frame.byteOffset, 12);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        const status = view.getUint32(8, true);
        if (status !== 0) {
          const code = new TextDecoder().decode(frame.subarray(12)).trim() || "unknown";
          throw new Error(`${CAPTURE_FAILURE_LABELS[code] ?? "镜头捕捉失败"}（${code}）`);
        }
        const rgba = frame.subarray(12);
        if (width > 0 && height > 0 && rgba.length >= width * height * 4) {
          return { rgba: rgba.slice(0, width * height * 4), width, height };
        }
      }
    }
    throw new Error(`镜头捕捉等待结果超时（capture-poll-timeout，${CAPTURE_TIMEOUT_MS}ms）`);
  } finally {
    // 成功时请求已被路由（slot 为空），取消是 no-op；超时/中止时它可能还留在 slot 里，
    // 不摘掉就会持续 pin 归属片场为 High（渲染器侧另有 30 秒兜底）。
    try {
      module.cancel_shot_capture?.(input.requestId);
    } catch {
      // 取消失败不改变调用方结论：渲染器侧超时仍会释放 pin。
    }
  }
}
