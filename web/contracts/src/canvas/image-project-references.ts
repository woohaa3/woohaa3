import { decodeImageEditProjectObjectRef, type ImageEditProjectObjectRef } from "./image-edit.js";
import type { StoredAsset } from "./domain/types.js";

/** 目标画布可写、来源画布可读后，服务端核对实际引用并返回权威资产。 */
export type ImageProjectReferencesRequest = {
  canvasId: string;
  sourceCanvasId: string;
  nodeIds: string[];
  assetIds: string[];
  projects: ImageEditProjectObjectRef[];
};
export type ImageProjectReferencesResult = { assets: StoredAsset[] };

export function decodeImageProjectReferencesRequest(input: unknown): ImageProjectReferencesRequest | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const id = (item: unknown): item is string => typeof item === "string" && item.length > 0 && item.length <= 512;
  const ids = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 256 && items.every(id);
  if (!id(value.canvasId) || !id(value.sourceCanvasId) || !ids(value.nodeIds) || !ids(value.assetIds) || !Array.isArray(value.projects) || value.projects.length > 256) return null;
  const projects = value.projects.map(decodeImageEditProjectObjectRef);
  if (projects.some((ref) => !ref)) return null;
  return { canvasId: value.canvasId, sourceCanvasId: value.sourceCanvasId, nodeIds: value.nodeIds,
    assetIds: value.assetIds, projects: projects as ImageEditProjectObjectRef[] };
}
