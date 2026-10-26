import type { VideoElementLike, PosterImage } from "./video-frame-session.js";
/** 只解析节点自身 ready 输出的同源媒体，不接受任意 URL。 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "../media-preview/media-preview.js";

/** 从 canonical 画布解析节点**自身** ready 视频输出（design D5）。 */
export function resolveNodeVideoSource(
  canvas: ServerCanvas | null,
  nodeId: string,
  runtimeAsset?: StoredAsset | null
): { url: string; posterUrl: string | null } | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.type !== "video") return null;
  const nodeData = canvas.nodeData as Record<string, { outputAssetId?: unknown } | undefined>;
  const outputId = nodeData[nodeId]?.outputAssetId;
  const asset = (typeof outputId === "string" && outputId !== "" ? canvas.assets.find((candidate) => candidate.id === outputId) : undefined) ?? runtimeAsset ?? undefined;
  if (!asset || asset.status !== "ready" || asset.mediaKind !== "video") return null;
  const storageKey = typeof asset.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
  if (!storageKey) return null;
  // 画布作用域读提示：视频与海报都属于这张画布的媒体。
  const url = resolveCanonicalMediaUrl(asset, canvas.id);
  if (!url) return null;
  const posterUrl = typeof asset.posterUrl === "string" ? resolveCanonicalMediaUrl({ url: asset.posterUrl }, canvas.id) : null;
  return { url, posterUrl };
}

/** 默认隐藏 video 元素工厂：不挂载 DOM，仅作为解码器。 */
export function defaultCreateVideo(): VideoElementLike {
  return document.createElement("video") as unknown as VideoElementLike;
}

/** 默认 poster 解码：DOM Image。 */
export function defaultLoadPosterImage(url: string): Promise<PosterImage> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("poster 加载失败"));
    image.src = url;
  });
}
