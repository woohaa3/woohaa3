/** Object replacement entrances. Geometry remains owned by the film set. */
import { isBoundedId, isJsonObject } from "../validation.js";
import { base64UrlEncodeBytes, sha256Bytes, utf8Encode } from "./film-set-shot-preview.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import { isFilmSetNode } from "./domain/core/composite-asset-identity.js";
import type { CanvasNodeData, ServerCanvas } from "./domain/index.js";

export const FILM_SET_OBJECT_CONTAINER_ROLE = "object-container" as const;
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
export function filmSetObjectContainerData(filmSetNodeId: string, itemId: string): CanvasNodeData {
  return { extensionId: "film-set", compositeAssetRole: FILM_SET_OBJECT_CONTAINER_ROLE,
    filmSetObject: { schemaVersion: 1, filmSetNodeId, itemId } };
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
    if (node?.type !== "composite-asset" || !owner || containerId !== filmSetObjectContainerId(owner.filmSetNodeId, owner.itemId)) return null;
    const parent = nodes.get(owner.filmSetNodeId);
    if (!isFilmSetNode(parent?.type, canvas.nodeData[owner.filmSetNodeId])) return null;
    let decoded = scenes.get(owner.filmSetNodeId);
    if (!decoded) { decoded = decodeFilmSetNodeData(canvas.nodeData[owner.filmSetNodeId]); scenes.set(owner.filmSetNodeId, decoded); }
    if (!decoded.ok) return null;
    const item = decoded.value.filmSetContent.items.find(item => item.id === owner.itemId);
    return item ? { owner, item, animation: decoded.value } : null;
  };
}
