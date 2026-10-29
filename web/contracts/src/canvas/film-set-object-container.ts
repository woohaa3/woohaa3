/** Object replacement entrances. Geometry remains owned by the film set. */
import { isBoundedId, isJsonObject } from "../validation.js";
import { base64UrlEncodeBytes, sha256Bytes, utf8Encode } from "./film-set-shot-preview.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import { isFilmSetNode } from "./domain/core/composite-asset-identity.js";
import { model3DNodeDataFields } from "./animation-snapshot.js";
import type { FilmSetModelItem } from "./film-set-content.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasNode } from "./domain/index.js";

export const FILM_SET_OBJECT_CONTAINER_ROLE = "object-container" as const;
/** Keep the outer container's dashed outline visible around the model card. */
export const FILM_SET_OBJECT_MODEL_PADDING = 12;
export const FILM_SET_MAX_VISIBLE_OBJECTS = 6;
/** Stable object order supplies defaults; hidden objects remain in the scene. */
export function filmSetVisibleObjectIds(itemIds: readonly string[], hiddenIds: readonly string[] = []): string[] {
  const hidden = new Set(hiddenIds);
  return itemIds.filter(id => !hidden.has(id)).slice(0, FILM_SET_MAX_VISIBLE_OBJECTS);
}
export type FilmSetObjectOwnership = { schemaVersion: 1; filmSetNodeId: string; itemId: string };
export function filmSetObjectOwnershipOf(data: unknown): FilmSetObjectOwnership | null {
  if (!isJsonObject(data) || data.extensionId !== "film-set" || data.compositeAssetRole !== FILM_SET_OBJECT_CONTAINER_ROLE) return null;
  const owner = data.filmSetObject;
  return isJsonObject(owner) && Object.keys(owner).every(key => ["schemaVersion", "filmSetNodeId", "itemId"].includes(key)) && owner.schemaVersion === 1 && isBoundedId(owner.filmSetNodeId) && isBoundedId(owner.itemId)
    ? { schemaVersion: 1, filmSetNodeId: owner.filmSetNodeId, itemId: owner.itemId } : null;
}
export function filmSetObjectContainerId(filmSetNodeId: string, itemId: string): string {
  return `film-object:${base64UrlEncodeBytes(sha256Bytes(utf8Encode(JSON.stringify(["film-set-object-v1", filmSetNodeId, itemId]))))}`;
}
/** Stable child node that exposes a model item as a real model3d card. */
export function filmSetObjectModelNodeId(filmSetNodeId: string, itemId: string): string {
  return `film-object-model:${base64UrlEncodeBytes(sha256Bytes(utf8Encode(JSON.stringify(["film-set-object-model-v1", filmSetNodeId, itemId]))))}`;
}
/** True only for the canonical model3d child derived from a film-set object container. */
export function isFilmSetObjectModelNode(
  node: Pick<Woohaa3CanvasNode, "id" | "type"> | null | undefined,
  data: unknown
): boolean {
  const owner = filmSetObjectOwnershipOf(data);
  return !!node && node.type === "model3d" && !!owner
    && node.id === filmSetObjectModelNodeId(owner.filmSetNodeId, owner.itemId);
}
/** True only for the canonical outer composite container derived from a film-set object. */
export function isFilmSetObjectContainerNode(
  node: Pick<Woohaa3CanvasNode, "id" | "type"> | null | undefined,
  data: unknown
): boolean {
  const owner = filmSetObjectOwnershipOf(data);
  return !!node && node.type === "composite-asset" && !!owner
    && node.id === filmSetObjectContainerId(owner.filmSetNodeId, owner.itemId);
}
export function filmSetObjectContainerData(filmSetNodeId: string, itemId: string): CanvasNodeData {
  return { extensionId: "film-set", compositeAssetRole: FILM_SET_OBJECT_CONTAINER_ROLE,
    filmSetObject: { schemaVersion: 1, filmSetNodeId, itemId } };
}
export function filmSetObjectModelNodeData(filmSetNodeId: string, item: FilmSetModelItem): CanvasNodeData {
  return {
    ...filmSetObjectContainerData(filmSetNodeId, item.id),
    ...model3DNodeDataFields({ kind: "model3d", title: item.name, source: "script", model: item.model })
  } as CanvasNodeData;
}
export function resolveFilmSetObject(canvas: Pick<ServerCanvas, "document" | "nodeData">, containerId: string) {
  return createFilmSetObjectResolver(canvas)(containerId);
}

/** One immutable projection/reconciliation pass decodes each source scene at most once. */
export function createFilmSetObjectResolver(canvas: Pick<ServerCanvas, "document" | "nodeData">) {
  const nodes = new Map(canvas.document.nodes.map(node => [node.id, node]));
  const scenes = new Map<string, ReturnType<typeof decodeFilmSetNodeData>>();
  return (containerId: string) => {
    const node = nodes.get(containerId);
    const owner = filmSetObjectOwnershipOf(canvas.nodeData[containerId]);
    if (!node || !owner ||
      (node.type !== "composite-asset" && node.type !== "model3d") ||
      (node.type === "composite-asset"
        ? containerId !== filmSetObjectContainerId(owner.filmSetNodeId, owner.itemId)
        : containerId !== filmSetObjectModelNodeId(owner.filmSetNodeId, owner.itemId))) return null;
    const parent = nodes.get(owner.filmSetNodeId);
    if (!isFilmSetNode(parent?.type, canvas.nodeData[owner.filmSetNodeId])) return null;
    let decoded = scenes.get(owner.filmSetNodeId);
    if (!decoded) { decoded = decodeFilmSetNodeData(canvas.nodeData[owner.filmSetNodeId]); scenes.set(owner.filmSetNodeId, decoded); }
    if (!decoded.ok) return null;
    const item = decoded.value.filmSetContent.items.find(item => item.id === owner.itemId);
    return item ? { owner, item, animation: decoded.value } : null;
  };
}
