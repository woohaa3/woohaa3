/** Stable failure classification and bounded retry policy shared by image adapters. */

/** 视为「暂时性」的 HTTP 状态：服务不可用、网关错误、限流与超时。 */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 图片解码/读取失败；`transient` 决定调用方是否可以自动重试。 */
export class ImageLoadError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = "ImageLoadError";
  }
}

/** 该失败是否值得自动重试（传输层抖动 vs 内容本身有问题）。 */
export function isTransientImageFailure(error: unknown): boolean {
  return error instanceof ImageLoadError && error.transient;
}

/**
 * 传输失败的有界自动重试节奏（第 n 次失败后的等待毫秒）。
 *
 * 只用于**传输失败**（媒体服务重启、网关 5xx、网络中断），不用于内容失败：一次几秒的重启
 * 不应把健康素材永久钉成错误。次数与总时长都有界，超过后同样转为显式重试
 * （design D2「静止帧不重试已失败身份」仍然成立：重试次数有限且只在退避到期时发生）。
 */
export const IMAGE_RETRY_DELAYS_MS = [800, 2000, 4000] as const;

/** 自动重试次数上限（= 退避表长度）。 */
export const IMAGE_RETRY_MAX_ATTEMPTS = IMAGE_RETRY_DELAYS_MS.length;

/**
 * 失败分类：`HEAD` 探测媒体是否仍可读。
 *
 * - 探测成功 → 字节在、解码失败 → 内容问题（不自动重试）；
 * - 探测 5xx/408/429 → 传输问题（自动重试）；
 * - 探测 4xx → 内容问题（删除、失权）；
 * - 探测本身抛错 → 传输问题（服务不可达）；
 * - 非 http(s) 来源（`blob:` 幽灵预览、`data:`）→ 不探测，按内容问题处理。
 */
export async function classifyImageFailure(url: string): Promise<ImageLoadError> {
  // 相对路径是同源地址（`appPublicUrl` 产物），同样可以探测；只跳过非 HTTP 协议。
  if (/^(blob|data|filesystem):/i.test(url)) return new ImageLoadError("图片加载失败。", false);
  try {
    const response = await globalThis.fetch(url, { method: "HEAD", credentials: "same-origin" });
    if (response.ok) return new ImageLoadError("图片加载失败。", false);
    return new ImageLoadError(
      `图片加载失败（HTTP ${response.status}）。`,
      TRANSIENT_STATUS.has(response.status)
    );
  } catch {
    return new ImageLoadError("图片加载失败（无法连接媒体服务）。", true);
  }
}
