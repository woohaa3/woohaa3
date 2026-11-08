import type { VideoElementLike, PosterImage } from "./video-frame-session.js";
/** 只解析节点自身 ready 输出的同源媒体，不接受任意 URL。 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { decodeWorldCamera, hasReadyMediaAsset, worldCameraShotContext } from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "../media-preview/media-preview.js";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";

/** 动态镜头只播放与当前机位、动画匹配的已录制视频。 */
export function resolveWorldCameraVideoSource(canvas: ServerCanvas, nodeId: string): { url: string; posterUrl: string | null; contentKey: string } | null {
  const camera = decodeWorldCamera(canvas.nodeData[nodeId]?.worldCamera);
  if (!camera.ok) return null;
  const status = worldCameraShotStore.get(camera.value.cameraId);
  const shot = worldCameraShotContext(canvas, camera.value);
  if (!status || status.canvasId !== canvas.id || status.phase !== "ready" || status.stale
    || status.key?.cameraSettingsVersion !== camera.value.settingsVersion || !status.video || !status.dynamicKey
    || shot?.kind !== "dynamic" || !shot.animation || status.dynamicKey.animation.areaId !== shot.animation.areaId
    || status.dynamicKey.animation.scriptRevision !== shot.animation.scriptRevision
    || status.dynamicKey.animation.sourceHash !== shot.animation.sourceHash) return null;
  const url = resolveCanonicalMediaUrl({ metadata: { storageKey: status.video.storageKey } }, canvas.id);
  return url ? { url, posterUrl: null, contentKey: `asset:${status.video.storageKey}` } : null;
}

/** 从 canonical 画布解析节点**自身** ready 视频输出（design D5）。 */
export function resolveNodeVideoSource(
  canvas: ServerCanvas | null,
  nodeId: string,
  runtimeAsset?: StoredAsset | null
): { url: string; posterUrl: string | null } | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  if (node.type === "world-camera") return resolveWorldCameraVideoSource(canvas, nodeId);
  if (node.type !== "video") return null;
  const nodeData = canvas.nodeData as Record<string, { outputAssetId?: unknown } | undefined>;
  const outputId = nodeData[nodeId]?.outputAssetId;
  const asset = (typeof outputId === "string" && outputId !== "" ? canvas.assets.find((candidate) => candidate.id === outputId) : undefined) ?? runtimeAsset ?? undefined;
  if (!asset || !hasReadyMediaAsset(asset) || asset.mediaKind !== "video") return null;
  const storageKey = typeof asset.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
  if (!storageKey) return null;
  // 画布作用域读提示：视频与海报都属于这张画布的媒体。存量镜头参考资产只登记了
  // storageKey、没有 `url`（旧写入路径的缺陷），解析器会按存储身份派生读取地址。
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
