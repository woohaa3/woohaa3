import { projectFilmSetCapture } from "../../state/browser/capture-snapshot.js";
import { filmSetMediaSources } from "./media-sources.js";
import { shotPreviewNodeId,  isFilmSetGroupNode, readFilmSetGroupMarker,  type ServerCanvas, type CanvasNodeData } from "@woohaa3/contracts";
import type { CompositeAssetAdapter, CompositeChildPresentation } from "@woohaa3/frontend/extension-api";
import { HistoryFilmSetSnapshots } from "./history-preview.js";
import { FILM_SET_EXTENSION_ID } from "../../state/shared/identity.js";
import { projectManagedShotMediaCanvas } from "./managed-shot-media-projection.js";
import { filmSetManagedLifecycle } from "../../state/shared/managed-shot-media-lifecycle.js";

/** Adapter identity contains orchestration only; geometry preparation reads the resource cards. */
export function filmSetExecutionKey(data: CanvasNodeData): string { return JSON.stringify(readFilmSetGroupMarker(data)); }
export function createFilmSetModelAdapter(history = new HistoryFilmSetSnapshots(), canvas: () => ServerCanvas | null = () => null, _feedback: (nodeId: string) => string | undefined = () => undefined, captureOwner?: object): CompositeAssetAdapter {
  const project = (current: ServerCanvas) => projectManagedShotMediaCanvas(captureOwner ? projectFilmSetCapture(captureOwner, history.project(current)!) : history.project(current)!);
  return {
    extensionId: FILM_SET_EXTENSION_ID, owner: FILM_SET_EXTENSION_ID,
    managedLifecycle: filmSetManagedLifecycle,
    /** Group-owned badges use the same trusted overview primitive LOD declaration as the old composite node. */
    geometryQuality: "overview-primitives-v1",
    matchesNode: (node, data) => isFilmSetGroupNode(node, data),
    children(current, ownerNodeId) {
      const owner = current.document.nodes.find(node => node.id === ownerNodeId);
      if (owner?.type === "group" && isFilmSetGroupNode(owner, current.nodeData[ownerNodeId])) {
        const marker = readFilmSetGroupMarker(current.nodeData[ownerNodeId]);
        return (marker?.clips ?? []).flatMap(clip => {
          const previewId = shotPreviewNodeId(ownerNodeId, clip.id);
          return current.document.nodes.some(node => node.id === previewId)
            ? [{ nodeId: previewId, ownerNodeId, kind: "entity", role: "preview" } satisfies CompositeChildPresentation]
            : [];
        });
      }
      return [];
    },
    executionKey: filmSetExecutionKey,
    mediaSources: (id, data, playback) => readFilmSetGroupMarker(data) ? filmSetMediaSources(id, data, playback, canvas() ? project(canvas()!) : null) : [],
    projectCanvas: project,
    history: (nodeId, detail) => { if (!detail) { history.clear(nodeId); return true; } return history.set(nodeId, detail); },
    historyProjection: () => null,
    // Canonical group geometry belongs to the node preparation capability.
    prepare() { return null; }
  };
}
