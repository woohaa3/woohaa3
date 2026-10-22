/** 图片聚焦目标解析与工程会话初始化。 */
import { decodeImageEditDocument, isImageProjectDocument, type ImageEditDocument, type ImageProjectDocument, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "@woohaa3/frontend/plugin-api";
import { ProjectSession } from "./project-session.js";

export type ImageFocusTarget = {
  canvas: ServerCanvas;
  nodeId: string;
  asset: StoredAsset;
  /**
   * 旧标注编辑定义（v1）。旧编辑器已删除，这里只作为**转换来源**：进入图片编辑时按每
   * shape 一层转成工程图层（design D7）。工程定义存在时由 `project` 承载、`edit` 为 null。
   */
  edit: ImageEditDocument | null;
  /** 工程编辑定义（无则 null）。 */
  project: ImageProjectDocument | null;
};

/** 解析可聚焦的图片目标（canonical ready 图片 + 受控同源 URL）；不可用返回 null。 */
export function resolveImageFocusTarget(canvas: ServerCanvas | null, nodeId: string): ImageFocusTarget | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== "image") return null;
  const data = canvas.nodeData[nodeId] as { outputAssetId?: unknown } | undefined;
  const outputId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  if (!asset || asset.status !== "ready" || asset.mediaKind !== "image") return null;
  if (!resolveCanonicalMediaUrl(asset)) return null;
  const rawEdit = (data as { imageEdit?: unknown }).imageEdit;
  const decoded = rawEdit !== undefined && rawEdit !== null ? decodeImageEditDocument(rawEdit) : null;
  // 工程定义：单独承载，旧标注会话对它保持只读（不提供旧标注保存分支）。
  if (decoded && decoded.ok && isImageProjectDocument(decoded.value)) {
    const doc = decoded.value;
    const baseAsset = canvas.assets.find((candidate) => candidate.id === doc.baseAssetId);
    const baseStorageKey = readStorageKey(baseAsset);
    if (baseAsset && baseStorageKey && resolveCanonicalMediaUrl(baseAsset)) {
      return { canvas, nodeId, asset: baseAsset, edit: null, project: doc };
    }
    // 原图不可解析：明确不可编辑（允许查看当前输出）。
    return { canvas, nodeId, asset, edit: null, project: doc };
  }
  // 已保存编辑图：以稳定原图 + shapes 重建；无编辑定义或原图缺失时以当前输出为原图。
  if (decoded && decoded.ok) {
    const baseAsset = canvas.assets.find((candidate) => candidate.id === decoded.value.baseAssetId);
    const baseStorageKey = readStorageKey(baseAsset);
    if (baseAsset && baseStorageKey && resolveCanonicalMediaUrl(baseAsset)) {
      return { canvas, nodeId, asset: baseAsset, edit: decoded.value, project: null };
    }
    // 原图不可解析：明确不可编辑（允许查看当前输出）。
    return { canvas, nodeId, asset, edit: decoded.value, project: null };
  }
  return { canvas, nodeId, asset, edit: null, project: null };
}

function readStorageKey(asset: StoredAsset | undefined): string | null {
  const key = asset?.metadata && (asset.metadata as { storageKey?: unknown }).storageKey;
  return typeof key === "string" && key !== "" ? key : null;
}

export function workspaceDisplayAsset(target: ImageFocusTarget): StoredAsset {
  const outputId = (target.canvas.nodeData[target.nodeId] as { outputAssetId?: unknown } | undefined)?.outputAssetId;
  return target.canvas.assets.find(asset => asset.id === outputId && asset.status === "ready" && resolveCanonicalMediaUrl(asset)) ?? target.asset;
}

export function workspaceProject(target: ImageFocusTarget): ProjectSession {
  return new ProjectSession({
    nodeId: target.nodeId, baseAssetId: target.project?.baseAssetId ?? target.asset.id,
    baseStorageKey: readStorageKey(target.asset) ?? "",
    sourceWidth: target.project?.sourceWidth ?? target.edit?.sourceWidth ?? readAssetDimension(target.asset, "width") ?? 0,
    sourceHeight: target.project?.sourceHeight ?? target.edit?.sourceHeight ?? readAssetDimension(target.asset, "height") ?? 0,
    edit: target.project ?? target.edit,
    ...(target.project ? { projectObjectAvailable: true } : {})
  });
}

export function readAssetDimension(asset: StoredAsset, key: "width" | "height"): number | null {
  const metadata = asset.metadata as { [k: string]: unknown } | undefined;
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
