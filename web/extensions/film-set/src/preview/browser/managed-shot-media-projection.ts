import {
  decodeFilmSetNodeData, filmSetAnimationsOf, isFilmSetNode, managedNodeRelationOf, readFilmSetGroupMarker,
  shotPreviewNodeId, type CanvasNodeData, type ServerCanvas,
} from "@woohaa3/contracts";
import { FILM_SET_EXTENSION_ID } from "../../state/shared/identity.js";

/**
 * Bridge canonical managed media to the existing ShotCamera render input.
 * This is a transient adapter projection, never a command or persisted copy
 * of the source. A ready PNG/video is not a prerequisite for live view/capture.
 */
export function projectManagedShotMediaCanvas(canvas: ServerCanvas): ServerCanvas {
  let nodeData: ServerCanvas["nodeData"] | undefined;
  for (const node of canvas.document.nodes) {
    if (node.type !== "image" && node.type !== "video") continue;
    const data = canvas.nodeData[node.id];
    const relation = managedNodeRelationOf(data);
    if (relation?.extensionId !== FILM_SET_EXTENSION_ID
      || node.id !== shotPreviewNodeId(relation.ownerNodeId, relation.entityId)) continue;
    const owner = canvas.document.nodes.find(entry => entry.id === relation.ownerNodeId);
    if (!owner) continue;
    const group = owner.type === "group" ? readFilmSetGroupMarker(canvas.nodeData[owner.id]) : null;
    if (group?.clips) {
      const clip = group.clips.find(entry => entry.id === relation.entityId);
      if (!clip || node.type !== (clip.duration && clip.duration > 0 ? "video" : "image")) continue;
      nodeData ??= { ...canvas.nodeData };
      nodeData[node.id] = { ...data, shotPreview: { schemaVersion: 1, filmSetNodeId: owner.id, clipId: clip.id } } as CanvasNodeData;
      continue;
    }
    if (!isFilmSetNode(owner.type, canvas.nodeData[owner.id])) continue;
    const decoded = decodeFilmSetNodeData(canvas.nodeData[owner.id]);
    if (!decoded.ok) continue;
    const clip = filmSetAnimationsOf(decoded.value).clips.find(clip => clip.id === relation.entityId);
    if (!clip || node.type !== (clip.kind === "static" ? "image" : "video")) continue;
    nodeData ??= { ...canvas.nodeData };
    nodeData[node.id] = {
      ...data,
      shotPreview: { schemaVersion: 1, filmSetNodeId: owner.id, clipId: clip.id },
    } as CanvasNodeData;
  }
  return nodeData ? { ...canvas, nodeData } : canvas;
}
