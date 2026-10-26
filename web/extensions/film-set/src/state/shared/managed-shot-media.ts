import type { CanvasNodeData, FilmSetAnimationClip, ManagedNodeRelation, ServerCanvas, Woohaa3CanvasNode } from "@woohaa3/contracts";
import { decodeFilmSetNodeData, filmSetAnimationsOf, isFilmSetNode, managedNodeRelationOf, shotPreviewNodeId } from "@woohaa3/contracts";
import { FILM_SET_EXTENSION_ID } from "./identity.js";

/** Canonical media identity for a film-set clip. The host never decodes clip data. */
export function managedShotMediaNodeId(ownerNodeId: string, clipId: string): string {
  return shotPreviewNodeId(ownerNodeId, clipId);
}

export function managedShotMediaRelation(ownerNodeId: string, clipId: string): ManagedNodeRelation {
  return { schemaVersion: 1, extensionId: FILM_SET_EXTENSION_ID, ownerNodeId, entityId: clipId, lifecycle: "owner-managed" };
}

export function managedShotMediaType(clip: Pick<FilmSetAnimationClip, "kind">): "image" | "video" {
  return clip.kind === "static" ? "image" : "video";
}

export function managedShotMediaData(ownerNodeId: string, clip: Pick<FilmSetAnimationClip, "id" | "kind">): CanvasNodeData {
  return { managedBy: managedShotMediaRelation(ownerNodeId, clip.id), mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: ownerNodeId, clipId: clip.id } } };
}

export function isManagedShotMediaNode(node: Pick<Woohaa3CanvasNode, "type">, data: CanvasNodeData | undefined, ownerNodeId?: string): boolean {
  const relation = data?.managedBy;
  return (node.type === "image" || node.type === "video") && !!relation && relation.extensionId === FILM_SET_EXTENSION_ID && (!ownerNodeId || relation.ownerNodeId === ownerNodeId);
}

/** Shared frontend/backend admission rule; an unrelated provider or origin is not ownership. */
export function ownsShotMedia(canvas: ServerCanvas | null, nodeId: string): boolean {
  if (!canvas) return false;
  const node = canvas.document.nodes.find(node => node.id === nodeId);
  const relation = managedNodeRelationOf(canvas.nodeData[nodeId]);
  if (!node || (node.type !== "image" && node.type !== "video") || relation?.extensionId !== FILM_SET_EXTENSION_ID
    || node.id !== managedShotMediaNodeId(relation.ownerNodeId, relation.entityId)) return false;
  const owner = canvas.document.nodes.find(node => node.id === relation.ownerNodeId);
  if (!owner || !isFilmSetNode(owner.type, canvas.nodeData[owner.id])) return false;
  const data = decodeFilmSetNodeData(canvas.nodeData[owner.id]);
  return data.ok && filmSetAnimationsOf(data.value).clips.some(clip => clip.id === relation.entityId && node.type === managedShotMediaType(clip));
}

/** Explicit migration boundary: upgrade an old preview in place without changing layout/identity. */
export function migrateShotPreviewNode(input: {
  node: Woohaa3CanvasNode;
  ownerNodeId: string;
  clip: Pick<FilmSetAnimationClip, "id" | "kind">;
}): { node: Woohaa3CanvasNode; data: CanvasNodeData } {
  if (input.node.id !== managedShotMediaNodeId(input.ownerNodeId, input.clip.id)) throw new Error("镜头节点身份不匹配");
  return { node: { ...input.node, type: managedShotMediaType(input.clip) }, data: managedShotMediaData(input.ownerNodeId, input.clip) };
}

