/** Fail-closed guards for pre-migration nodes; canonical lifecycle rules are injected by extensions. */
import { FILM_SET_SHOT_PREVIEW_NODE_TYPE } from "../film-set-shot-preview.js";
import { managedNodeRelationOf } from "../managed-node.js";
import type { WorkingState } from "./types.js";

export function hasShotPreviewOwnership(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as Record<string, unknown>).shotPreview !== undefined;
}
export function isProtectedShotPreview(work: WorkingState, nodeId: string): boolean {
  return !!managedNodeRelationOf(work.nodeData[nodeId])
    || work.nodes.find(n => n.id === nodeId)?.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE
    || hasShotPreviewOwnership(work.nodeData[nodeId]);
}
