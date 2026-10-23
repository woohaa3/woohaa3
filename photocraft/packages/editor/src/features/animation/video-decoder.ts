/**
 * 视频导入（U77，design D2）：把宿主 codec 端口解出的帧交给内核。
 *
 * 浏览器**不运行**上游 ffmpeg 子进程；视频容器（MP4/WebM）由宿主注册的
 * `AnimationCodecPort` 解码，内核只接收已解码的 RGBA8 字节。因此这里承担三件事：
 *
 * 1. 识别容器（只认端口约定的 `mp4`/`webm`），无法识别就拒绝，不猜；
 * 2. 先协商 `supports({direction:"decode"})`，不支持时把端口给的具体原因交回界面；
 * 3. 解码结果按内核预算**预检**（帧数、累计像素、逐帧字节长度）后再交给内核导入，
 *    避免把超预算或形状不符的帧栈塞进文档。
 *
 * 失败一律返回原因（不抛异常），调用方据此显示并保留原文档。取消由面板调用
 * `port.cancel(requestId)`；本模块不吞掉 `decode` 抛出的错误。
 */
import type { AnimationCodecPort, AnimationFrameBudget } from "@woohaa3/photocraft-protocol";

export type DecodedVideo =
  | { ok: true; width: number; height: number; fps: number; frames: Uint8Array[] }
  | { ok: false; message: string };

/** 端口约定的容器名（与 `AnimationCodecSupport.container` 同一套字符串）。 */
const CONTAINERS = ["mp4", "webm"] as const;

/**
 * 从文件名/MIME 判断容器。
 *
 * 只做**识别**，不据此宣称可解码：真正的可用性由 `port.supports` 决定。
 */
export function videoContainer(fileName: string, mimeType = ""): (typeof CONTAINERS)[number] | null {
  const mime = mimeType.toLowerCase();
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  if (extension === "mp4" || extension === "m4v" || extension === "mov") return "mp4";
  if (extension === "webm") return "webm";
  return null;
}

export type VideoDecodeInput = {
  fileName: string;
  mimeType?: string;
  bytes: Uint8Array;
  requestId: string;
};

export type VideoDecodeTarget = {
  /** 目标画布尺寸；端口按此上限缩放，不放大。 */
  width: number;
  height: number;
  fps: number;
  /** 内核报告的实际预算，用于解码后、导入前的预检。 */
  budget: Pick<AnimationFrameBudget, "maxFrames" | "maxCumulativeFramePixels">;
};

/** 解码一个视频文件为同尺寸 RGBA8 帧序列（尚未写入文档）。 */
export async function decodeVideoFrames(
  port: AnimationCodecPort | null,
  input: VideoDecodeInput,
  target: VideoDecodeTarget,
): Promise<DecodedVideo> {
  if (!port) {
    return { ok: false, message: "当前宿主未注册视频编解码端口，无法导入视频；可用图片帧序列或动画 GIF" };
  }
  const container = videoContainer(input.fileName, input.mimeType);
  if (!container) {
    return { ok: false, message: "无法识别视频容器：仅支持 MP4 与 WebM（其他容器没有已验证的解码端）" };
  }
  let resolved: Awaited<ReturnType<AnimationCodecPort["supports"]>>;
  try {
    resolved = await port.supports({ direction: "decode", container });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "宿主无法协商视频解码能力" };
  }
  if (!resolved.supported) return { ok: false, message: resolved.reason };

  let decoded: Awaited<ReturnType<AnimationCodecPort["decode"]>>;
  try {
    decoded = await port.decode({
      requestId: input.requestId,
      fileName: input.fileName,
      bytes: input.bytes,
      maxWidth: target.width,
      maxHeight: target.height,
      fps: target.fps,
      // 端口据此在解码时拒绝超长片段；内核的同名上限仍是最终裁判。
      maxFrames: target.budget.maxFrames
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "视频解码失败" };
  }
  if (!decoded.ok) return { ok: false, message: decoded.reason };
  return validateDecoded(decoded, target);
}

/** 解码结果预检：尺寸、帧数、累计像素与逐帧字节长度。 */
function validateDecoded(
  decoded: { ok: true; width: number; height: number; fps: number; frames: Uint8Array[] },
  target: VideoDecodeTarget,
): DecodedVideo {
  const { width, height, frames } = decoded;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, message: `解码端返回了无效的帧尺寸：${width}×${height}` };
  }
  if (width > target.width || height > target.height) {
    return { ok: false, message: `解码端放大了帧尺寸（${width}×${height} > 画布 ${target.width}×${target.height}），已拒绝` };
  }
  if (frames.length === 0) return { ok: false, message: "视频里没有可导入的帧" };
  if (frames.length > target.budget.maxFrames) {
    return { ok: false, message: `视频帧数超过上限：${frames.length} > ${target.budget.maxFrames}` };
  }
  const frameBytes = width * height * 4;
  const totalPixels = width * height * frames.length;
  if (totalPixels > target.budget.maxCumulativeFramePixels) {
    return { ok: false, message: `视频帧累计像素超过上限：${totalPixels} > ${target.budget.maxCumulativeFramePixels}` };
  }
  for (const [index, frame] of frames.entries()) {
    if (frame.length !== frameBytes) {
      return { ok: false, message: `第 ${index + 1} 帧字节长度与尺寸不符：${frame.length} != ${frameBytes}` };
    }
  }
  const fps = Number.isFinite(decoded.fps) && decoded.fps > 0 ? decoded.fps : target.fps;
  return { ok: true, width, height, fps, frames };
}
