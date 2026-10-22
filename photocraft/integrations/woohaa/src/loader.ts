/**
 * 图片聚焦原图加载与资源生命周期
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.4 / design D2）。
 *
 * 按稳定 canonical asset 的 `storageKey` 从同源受控 URL 解码**原始素材**（非 1024 缩略图），
 * 供聚焦高清显示与编辑合成使用。late decode 由 request generation 丢弃；释放时关闭 bitmap。
 *
 * 资源上限：解码位图总像素超过声明上限时返回 `too-large`（允许查看缩略图、禁止编辑）。
 */
import { IMAGE_EDIT_LIMITS } from "@woohaa3/contracts";
import { isAllowedNodeHistoryPreviewUrl, resolveCanonicalMediaUrl } from "@woohaa3/frontend/plugin-api";

export type LoadedImage = {
  /** 解码位图（可传给 drawImage / createImageBitmap）。 */
  bitmap: CanvasImageSource;
  width: number;
  height: number;
  /** 原图是否超过编辑资源上限（允许查看、禁止编辑）。 */
  tooLarge: boolean;
};

export type ImageLoadResult =
  | { ok: true; value: LoadedImage }
  | { ok: false; code: "unresolvable" | "decode-failed" | "stale"; message: string };

/** 可注入的解码实现（测试用）；缺省 `createImageBitmap`，回退 `Image`。 */
export type ImageDecoder = (url: string) => Promise<{ bitmap: CanvasImageSource; width: number; height: number } | null>;

async function defaultDecode(url: string): Promise<{ bitmap: CanvasImageSource; width: number; height: number } | null> {
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

export type ImageFocusLoader = ReturnType<typeof createImageFocusLoader>;

/**
 * 原图加载器：每个会话拥有一个实例；`load` 带 request generation，丢弃迟到结果。
 */
export function createImageFocusLoader(options: { decode?: ImageDecoder; canvasId?: string } = {}) {
  const decode = options.decode ?? defaultDecode;
  // 画布内原图读取带画布提示；无画布身份（单测/独立页）保持原 URL。
  const canvasId = options.canvasId;
  let generation = 0;
  let current: LoadedImage | null = null;

  /** 解码一个已校验的受控 URL；generation 丢弃迟到结果。 */
  const decodeUrl = async (url: string, requestId: string): Promise<ImageLoadResult> => {
    generation += 1;
    const requestGeneration = generation;
    const decoded = await decode(url);
    if (requestGeneration !== generation) {
      if (decoded && typeof (decoded.bitmap as ImageBitmap).close === "function") (decoded.bitmap as ImageBitmap).close();
      return { ok: false, code: "stale", message: "解码结果已过期" };
    }
    if (!decoded) return { ok: false, code: "decode-failed", message: "原图解码失败" };
    const tooLarge =
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.width * decoded.height > IMAGE_EDIT_LIMITS.maxSourcePixels ||
      decoded.width > IMAGE_EDIT_LIMITS.maxSourceDimension ||
      decoded.height > IMAGE_EDIT_LIMITS.maxSourceDimension;
    closeCurrent();
    current = { bitmap: decoded.bitmap, width: decoded.width, height: decoded.height, tooLarge };
    void requestId;
    return { ok: true, value: current };
  };

  /** 加载某稳定资产的原图；返回是否仍是最新请求。 */
  const load = async (asset: unknown, requestId: string): Promise<ImageLoadResult> => {
    const url = resolveCanonicalMediaUrl(asset, canvasId);
    if (!url) return { ok: false, code: "unresolvable", message: "资产没有受控同源读取地址" };
    return decodeUrl(url, requestId);
  };

  /**
   * 加载节点历史受控预览。URL 由 `canvasRemote.nodeHistoryPreviewUrl` 构造，已经带挂载前缀，
   * 因此不再经 canonical 资产解析（那条路径只接受 `/api/media/...`）。
   */
  const loadHistoryPreview = async (url: string, requestId: string): Promise<ImageLoadResult> => {
    if (!isAllowedNodeHistoryPreviewUrl(url)) {
      return { ok: false, code: "unresolvable", message: "历史版本没有受控同源读取地址" };
    }
    return decodeUrl(url, requestId);
  };

  /** 释放当前位图（关闭 bitmap）。 */
  const closeCurrent = (): void => {
    if (current && typeof (current.bitmap as ImageBitmap).close === "function") {
      try {
        (current.bitmap as ImageBitmap).close();
      } catch {
        // ignore
      }
    }
    current = null;
  };

  const release = () => { generation += 1; closeCurrent(); };
  const loaded = (): LoadedImage | null => current;

  return { load, loadHistoryPreview, release, loaded };
}
