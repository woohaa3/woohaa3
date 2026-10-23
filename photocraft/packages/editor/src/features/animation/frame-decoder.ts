/**
 * 帧序列解码（U77）：浏览器把用户选择的图片/已解码字节转成内核需要的 RGBA8 帧。
 *
 * 只做**浏览器侧解码**，不接受路径、不写文件（design D2）。帧尺寸统一取当前画布尺寸：
 * 各帧按等比缩放居中绘制到画布，避免把不同尺寸的图直接塞进同一条帧栈（内核要求每帧字节
 * 长度等于画布尺寸）。
 *
 * 失败返回原因而不是抛异常：调用方（面板）直接显示并保留原文档。
 */

export type DecodedFrames =
  | { ok: true; width: number; height: number; frames: Uint8Array[] }
  | { ok: false; message: string };

/** 一次可解码的图片类型（视频帧由宿主 codec 端口负责，不在这里）。 */
export const FRAME_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/avif";

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext("2d", { colorSpace: "srgb", alpha: true, willReadFrequently: true });
}

/**
 * 把若干图片字节解码成同尺寸 RGBA8 帧。
 *
 * `files` 顺序即帧顺序；任一帧失败则整次导入失败（不返回半份序列）。
 */
export async function decodeFrameImages(files: readonly Blob[], width: number, height: number): Promise<DecodedFrames> {
  if (files.length === 0) return { ok: false, message: "没有选择任何图片帧" };
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, message: "画布尺寸无效，无法确定帧尺寸" };
  }
  if (typeof createImageBitmap !== "function") {
    return { ok: false, message: "当前浏览器不支持解码图片帧（缺少 createImageBitmap）" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvasContext(canvas);
  if (!context) return { ok: false, message: "无法创建帧解码画布，请重试" };
  const frames: Uint8Array[] = [];
  try {
    for (const [index, file] of files.entries()) {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image", colorSpaceConversion: "default", premultiplyAlpha: "none" });
      } catch {
        return { ok: false, message: `第 ${index + 1} 帧无法解码：文件可能不是受支持的图片` };
      }
      try {
        context.clearRect(0, 0, width, height);
        const scale = Math.min(width / bitmap.width, height / bitmap.height);
        const drawWidth = Math.max(1, Math.round(bitmap.width * scale));
        const drawHeight = Math.max(1, Math.round(bitmap.height * scale));
        context.drawImage(bitmap, Math.round((width - drawWidth) / 2), Math.round((height - drawHeight) / 2), drawWidth, drawHeight);
      } finally {
        bitmap.close();
      }
      const pixels = context.getImageData(0, 0, width, height).data;
      frames.push(new Uint8Array(pixels.buffer.slice(0)));
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  return { ok: true, width, height, frames };
}
