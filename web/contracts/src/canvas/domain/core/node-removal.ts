import { readFilmSetGroupMarker } from "../../film-set-group.js";
import type { Woohaa3CanvasNode } from "./canvas-runtime";

/**
 * Returns every selected node plus all nested descendants. Empty ancestors
 * are removed as well, so deleting the last member of a group cannot leave a
 * dangling container in the graph.
 */
export function collectWoohaa3CanvasRemovalIds(
  nodes: Array<Pick<Woohaa3CanvasNode, "id" | "parentId">>,
  nodeIds: readonly string[],
  nodeData: Record<string, { retainWhenEmpty?: unknown; filmSetGroup?: unknown }> = {}
): Set<string> {
  const removed = new Set(nodeIds);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) {
        removed.add(node.id);
        changed = true;
      }
    }
    for (const node of nodes) {
      const children = nodes.filter((candidate) => candidate.parentId === node.id);
      if (children.length > 0 && children.every((child) => removed.has(child.id)) && !removed.has(node.id) && nodeData[node.id]?.retainWhenEmpty !== true && !readFilmSetGroupMarker(nodeData[node.id])) {
        removed.add(node.id);
        changed = true;
      }
    }
  }

  return removed;
}
