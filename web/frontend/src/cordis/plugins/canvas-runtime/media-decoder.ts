/**
 * 有界媒体资源 store 的默认解码实现
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D9，任务 4.1）。
 *
 * 按来源 identity 的 key（受控同源 URL）解码**原始素材**为 CPU 位图，供共享 lease 复用。
 * 只做解码，不持有 GPU 纹理；编辑资源上限判定由 consumer 读取 `tooLarge` 决定。
 */
import { IMAGE_EDIT_LIMITS } from "@woohaa3/contracts";
import type { MediaDecodeResult, MediaSourceIdentity } from "./media-resource-store.js";

/** 解码实现可注入（测试用）；作为 store 的缺省。 */
export function createDefaultMediaDecoder(
  decodeImage?: (url: string) => Promise<{ bitmap: CanvasImageSource; width: number; height: number } | null>
): (source: MediaSourceIdentity) => Promise<MediaDecodeResult> {
  const decode = decodeImage ?? decodeViaDom;
  return async (source) => {
    if (!source.key) return { ok: false, code: "unresolvable", message: "来源没有稳定读取地址" };
    const decoded = await decode(source.key);
    if (!decoded) return { ok: false, code: "decode-failed", message: "媒体解码失败" };
    const tooLarge =
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.width * decoded.height > IMAGE_EDIT_LIMITS.maxSourcePixels ||
      decoded.width > IMAGE_EDIT_LIMITS.maxSourceDimension ||
      decoded.height > IMAGE_EDIT_LIMITS.maxSourceDimension;
    return { ok: true, value: { bitmap: decoded.bitmap, width: decoded.width, height: decoded.height, tooLarge } };
  };
}

async function decodeViaDom(url: string): Promise<{ bitmap: CanvasImageSource; width: number; height: number } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) return null;
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      return null;
    }
  }
  if (typeof Image === "undefined") return null;
  return await new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve({ bitmap: image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
