/**
 * media-preview dialog 注册与 canonical 资产解析
 * （change: add-frontend-dialog-system，任务 4.1 / design D8）。
 *
 * payload 只携带 `{ assetId, nodeId, title }`；renderer 从**当前 canonical asset** 重新
 * 解析媒体 URL，不把调用方传入的 URL 当权威。仅接受 `status: ready`、`mediaKind: image`
 * 且稳定同源媒体引用（`/api/media/<storageKey>`）的资产，拒绝 blob/data/外部/签名 URL。
 */
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";
import { isAllowedMediaUrl, isAllowedNodeHistoryPreviewUrl, resolveCanonicalMediaUrl } from "../../services/media-remote.js";

export const MEDIA_PREVIEW_DIALOG_ID = "media-preview";

export type MediaPreviewPayload = {
  assetId: string;
  nodeId: string;
  title: string;
  canvasId?: string;
  kind?: "audio";
};

export { isAllowedMediaUrl, isAllowedNodeHistoryPreviewUrl, resolveCanonicalMediaUrl };

/** 解析给定 asset 是否可作为图片预览（canonical-only，仅 image，design D8）。 */
export function resolveImagePreview(
  canvas: { id?: string; assets?: ReadonlyArray<{ id: string; mediaKind?: string; status?: string; url?: string }> } | null | undefined,
  assetId: string
): { url: string; mediaKind: "image" } | null {
  const asset = canvas?.assets?.find((candidate) => candidate.id === assetId);
  if (!asset) return null;
  if (asset.status !== "ready") return null;
  if (asset.mediaKind !== "image") return null;
  // 预览发生在当前画布内：读请求带上画布提示，让宿主按画布路由到远端存储。
  const url = resolveCanonicalMediaUrl(asset, canvas?.id);
  if (!url) return null;
  return { url, mediaKind: "image" };
}

export const mediaPreviewDefinition: DialogDefinition = {
  dismissible: true,
  // 重复预览同一 dialog 时替换 payload，不堆叠第二个实例（design D2）。
  singleton: true,
  validatePayload: objectPayload<MediaPreviewPayload>("media-preview", (value) => {
    const assetId = value.assetId;
    const nodeId = value.nodeId;
    const title = value.title;
    if (typeof assetId !== "string" || assetId === "") return null;
    if (typeof nodeId !== "string" || nodeId === "") return null;
    if (value.kind !== undefined && value.kind !== "audio") return null;
    if (value.kind === "audio" && (typeof value.canvasId !== "string" || !value.canvasId)) return null;
    return {
      ...(value.kind === "audio" ? { kind: "audio" as const, canvasId: value.canvasId as string } : {}),
      assetId,
      nodeId,
      title: typeof title === "string" ? title : ""
    };
  })
};

/** Resolve only the current node's own canonical audio output. */
export function resolveAudioPreview(canvas: import("@woohaa3/contracts").ServerCanvas | null, nodeId: string, assetId?: string) {
  const node = canvas?.document.nodes.find(node => node.id === nodeId);
  if (!canvas || node?.type !== "audio") return null;
  const outputId = canvas.nodeData[nodeId]?.outputAssetId;
  if (!outputId || (assetId !== undefined && outputId !== assetId)) return null;
  const asset = canvas.assets.find(asset => asset.id === outputId);
  if (!asset || asset.status !== "ready" || asset.mediaKind !== "audio") return null;
  // 试听同样发生在当前画布内，读请求带画布提示。
  const url = resolveCanonicalMediaUrl(asset, canvas.id);
  return url ? { url, assetId: asset.id, title: asset.title || "音频试听", mediaKind: "audio" as const } : null;
}
