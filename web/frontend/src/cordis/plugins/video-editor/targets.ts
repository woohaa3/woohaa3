/**
 * 视频聚焦目标解析
 * （change: 2026-10-10-add-video-node-focus-workspace，任务 1.4/2.1）。
 *
 * 双击聚焦与节点内播放一样，只解析该视频节点**自身**的 canonical ready 输出
 * （`outputAssetId`），要求 `status: ready`、`mediaKind: video`、稳定 storageKey 与受控同源
 * URL。**不**使用 `edit_video` input mapping；输入编辑（Seedance 截帧/标注）仍走各自映射优先
 * 解析（design D3）。
 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "../media-preview/media-preview.js";

export type VideoFocusTarget = {
  canvas: ServerCanvas;
  nodeId: string;
  asset: StoredAsset;
  /** 受控同源可播放 URL。 */
  url: string;
  /** 可选同源 poster。 */
  posterUrl: string | null;
};

/** 解析可聚焦的视频目标（canonical ready 视频自身输出）；不可用返回 null。 */
export function resolveVideoFocusTarget(canvas: ServerCanvas | null, nodeId: string): VideoFocusTarget | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== "video") return null;
  const data = canvas.nodeData[nodeId] as { outputAssetId?: unknown } | undefined;
  const outputId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  if (!asset || asset.status !== "ready" || asset.mediaKind !== "video") return null;
  const storageKey = typeof asset.metadata?.storageKey === "string" ? asset.metadata.storageKey : "";
  if (!storageKey) return null;
  // 画布内视频聚焦：播放地址与 poster 都带本画布读提示。
  const url = resolveCanonicalMediaUrl(asset, canvas.id);
  if (!url) return null;
  const posterUrl = typeof asset.posterUrl === "string" && asset.posterUrl !== "" ? resolveCanonicalMediaUrl({ url: asset.posterUrl }, canvas.id) : null;
  return { canvas, nodeId, asset, url, posterUrl };
}

/** 节点类型 → video focus kind（用于目标集合）；非视频返回 null。 */
export function videoFocusKindForNode(type: string): "video" | null {
  return type === "video" ? "video" : null;
}
