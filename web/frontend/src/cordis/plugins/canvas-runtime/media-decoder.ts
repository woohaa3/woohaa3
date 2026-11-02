import { acquireImageThumbnail } from "./image-worker/client.js";
/**
 * 有界媒体资源 store 的默认解码实现
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D9，任务 4.1）。
 *
 * 按来源 identity 的 key（受控同源 URL）经 Rust 派生为 CPU 位图，供共享 lease 复用。
 * 不持有 GPU 纹理；缩小结果通过 `tooLarge` 禁止原尺寸编辑。
 */
import { IMAGE_EDIT_LIMITS } from "@woohaa3/contracts";
import type { MediaDecodeResult, MediaSourceIdentity } from "./media-resource-store.js";

/** 解码实现可注入（测试用）；作为 store 的缺省。 */
export function createDefaultMediaDecoder(
  decodeImage?: (url: string) => Promise<{ bitmap: CanvasImageSource; width: number; height: number } | null>
): (source: MediaSourceIdentity) => Promise<MediaDecodeResult> {
  const decode = decodeImage ?? decodeViaRust;
  return async (source) => {
    if (!source.key) return { ok: false, code: "unresolvable", message: "来源没有稳定读取地址" };
    const decoded = await decode(source.key);
    if (!decoded) return { ok: false, code: "decode-failed", message: "媒体解码失败" };
    const tooLarge =
      ("scaled" in decoded && decoded.scaled === true) ||
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.width * decoded.height > IMAGE_EDIT_LIMITS.maxSourcePixels ||
      decoded.width > IMAGE_EDIT_LIMITS.maxSourceDimension ||
      decoded.height > IMAGE_EDIT_LIMITS.maxSourceDimension;
    return { ok: true, value: { bitmap: decoded.bitmap, width: decoded.width, height: decoded.height, tooLarge } };
  };
}

/** Host compatibility bitmap: pixels come from Rust; the img only displays derived PNG. */
async function decodeViaRust(url: string): Promise<{ bitmap: CanvasImageSource; width: number; height: number; scaled: boolean } | null> {
  const thumbnail = await acquireImageThumbnail(url,2048);
  try {
    const image = await new Promise<HTMLImageElement>((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('派生图片显示失败'));image.src=thumbnail.url;
    });
    // The store's existing close contract revokes this lease on eviction/disposal.
    (image as HTMLImageElement & {close:()=>void}).close=()=>{image.src='';thumbnail.release();};
    return {bitmap:image,width:thumbnail.width,height:thumbnail.height,scaled:thumbnail.width!==thumbnail.sourceWidth || thumbnail.height!==thumbnail.sourceHeight};
  } catch(error) {thumbnail.release();throw error;}
}
