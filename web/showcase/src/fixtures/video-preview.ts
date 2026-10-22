/**
 * Showcase 本地视频预览注册表。
 *
 * `URL.createObjectURL` 在 jsdom（component test）里不存在，浏览器里调用时对象 URL 的生命
 * 周期也要跟随组件卸载。所以把「生成 / 回收」集中到这一份插件级注册表：
 * - 组件只拿 `previewUrlForVideo(assetId)` 得到稳定同源/本地地址；
 * - 首次请求时惰性创建，卸载 story 时 `disposeVideoPreviews()` 统一回收。
 *
 * 这里只服务查看页展示，不参与任何权威媒体解析。
 */

const objectUrls = new Map<string, string>();

function createObjectUrl(): string {
  const factory = (
    globalThis as unknown as {
      URL?: { createObjectURL?: (blob: Blob) => string };
    }
  ).URL;
  if (typeof factory?.createObjectURL !== "function") return "";
  // 一个字节的黑帧：viewer 只需要可加载的视频源，不关心内容。
  const bytes = Uint8Array.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d
  ]);
  return factory.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
}

/** 某个 fixture 视频资产的本地可播放地址；环境不支持时返回空字符串。 */
export function previewUrlForVideo(assetId: string): string {
  const existing = objectUrls.get(assetId);
  if (existing !== undefined) return existing;
  const created = createObjectUrl();
  objectUrls.set(assetId, created);
  return created;
}

/** 回收全部本地对象 URL（story 卸载时调用）。 */
export function disposeVideoPreviews(): void {
  const factory = (
    globalThis as unknown as {
      URL?: { revokeObjectURL?: (url: string) => void };
    }
  ).URL;
  for (const url of objectUrls.values()) {
    if (url && typeof factory?.revokeObjectURL === "function") factory.revokeObjectURL(url);
  }
  objectUrls.clear();
}
