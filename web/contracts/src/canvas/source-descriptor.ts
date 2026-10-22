import type { ServerCanvas, StoredAsset } from "./domain/types.js";
import { isFilmSetNode } from "./domain/core/composite-asset-identity.js";
import { readFilmSetContent } from "./film-set-content.js";
import { fnv1a64Hex } from "./content-hash.js";

/** 只描述规范来源及显式稳定引用，不抓取 URL、不推断未知插件内部格式。 */
export type CanvasSourceDescriptor = {
  nodeId: string;
  nodeType: string;
  snapshot: ServerCanvas["nodeData"][string];
  assets: StoredAsset[];
  mediaKeys: string[];
  contentHash: string;
};

export function describeCanvasSource(canvas: ServerCanvas, nodeId: string): CanvasSourceDescriptor | null {
  const node = canvas.document.nodes.find(node => node.id === nodeId);
  if (!node) return null;
  const snapshot = structuredClone(canvas.nodeData[nodeId] ?? {});
  const data = snapshot as Record<string, unknown>;
  const ids = new Set<string>();
  if (typeof data.outputAssetId === "string" && data.outputAssetId) ids.add(data.outputAssetId);
  for (const field of ["assetIds", "inputAssetIds"]) {
    if (data[field] !== undefined && (!Array.isArray(data[field]) || data[field].some(id => typeof id !== "string" || !id))) return null;
    if (Array.isArray(data[field])) for (const id of data[field]) ids.add(id as string);
  }
  if (isFilmSetNode(node.type, data)) {
    for (const item of readFilmSetContent(data).items) {
      if ((item.kind === "image" || item.kind === "video") && item.assetId) ids.add(item.assetId);
    }
  }
  const assets: StoredAsset[] = [];
  for (const id of ids) {
    const asset = canvas.assets.find(asset => asset.id === id && asset.status === "ready");
    if (!asset) return null;
    assets.push(structuredClone(asset));
  }
  if (data.mediaReferences !== undefined && (!Array.isArray(data.mediaReferences) || data.mediaReferences.some(key => typeof key !== "string" || !key))) return null;
  const mediaKeys = Array.isArray(data.mediaReferences)
    ? [...new Set(data.mediaReferences.filter((key): key is string => typeof key === "string" && !!key))] : [];
  const stable = { ...data };
  for (const field of ["progress", "hover", "selected", "taskStatus", "jobId"]) delete stable[field];
  const contentHash = fnv1a64Hex(JSON.stringify({ type: node.type, snapshot: stable,
    assets: assets.map(asset => ({ id: asset.id, text: asset.text, metadata: asset.metadata })), mediaKeys }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
  return { nodeId, nodeType: node.type, snapshot, assets, mediaKeys, contentHash };
}
