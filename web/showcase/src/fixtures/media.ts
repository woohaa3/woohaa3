/**
 * Showcase 媒体 fixtures：稳定的视频/音频资产与本地 poster。
 *
 * 生产 `resolveReferenceItems` 只认「canonical asset + 稳定 storageKey + 同源 URL」，
 * 所以这里构造的资产形状与真实 Canvas Service 投影完全一致；不同之处只有 URL 指向查看页
 * 本地的对象地址（`video-preview.ts`），从而不需要任何后端。
 */
import type { StoredAsset } from "@woohaa3/contracts";
import { previewUrlForVideo } from "./video-preview.js";

const NOW = "2026-09-27T00:00:00.000Z";

type MediaKind = "image" | "video" | "audio" | "text";

/** 展示用媒体资产（默认 ready）。 */
export function mediaAsset(options: {
  id: string;
  mediaKind: MediaKind;
  title?: string;
  status?: StoredAsset["status"];
  storageKey?: string;
  contentType?: string;
  url?: string;
  text?: string;
  /** 缺失 metadata.storageKey（上游未产出稳定引用的真实形态）。 */
  withoutStorageKey?: boolean;
}): StoredAsset {
  const storageKey = options.storageKey ?? `${options.id}.${extensionFor(options.mediaKind)}`;
  return {
    id: options.id,
    title: options.title ?? options.id,
    mediaKind: options.mediaKind,
    source: "generated",
    status: options.status ?? "ready",
    createdAt: NOW,
    ...(options.url ? { url: options.url } : {}),
    ...(options.text !== undefined ? { text: options.text } : {}),
    ...(options.withoutStorageKey
      ? {}
      : { metadata: { storageKey, contentType: options.contentType ?? contentTypeFor(options.mediaKind) } })
  };
}

function extensionFor(kind: MediaKind): string {
  return kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png";
}

function contentTypeFor(kind: MediaKind): string {
  return kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png";
}

/** ready 视频资产：`edit_video` 模式下的可编辑输入。 */
export function readyVideoAsset(id = "asset-video-ready"): StoredAsset {
  return mediaAsset({
    id,
    mediaKind: "video",
    title: "待编辑视频",
    // 本地对象地址：查看页无后端，但形状仍是「稳定同源可播放地址」。
    url: previewUrlForVideo(id)
  });
}

/** pending 视频资产：上游还没有可用输出（缺稳定 storageKey ⇒ chips waiting）。 */
export function pendingVideoAsset(id = "asset-video-pending"): StoredAsset {
  return mediaAsset({
    id,
    mediaKind: "video",
    title: "待生成视频",
    status: "generating",
    withoutStorageKey: true
  });
}

/** 音频资产（音频 story 的参考展示用）。 */
export function audioAsset(id = "asset-audio"): StoredAsset {
  return mediaAsset({ id, mediaKind: "audio", title: "参考音频" });
}

export const SHOWCASE_MEDIA_NOW = NOW;
