import type { Woohaa3CanvasEdge } from "./canvas-runtime";

/** Clones each edge entering a duplicated node while retaining its source. */
export function duplicateWoohaa3CanvasIncomingEdges(
  edges: readonly Woohaa3CanvasEdge[],
  duplicatedNodeIds: ReadonlyMap<string, string>
): Woohaa3CanvasEdge[] {
  const existingIds = new Set(edges.map((edge) => edge.id));
  const suffix = Date.now().toString(36);
  return edges.flatMap((edge) => {
    const target = duplicatedNodeIds.get(edge.target);
    if (!target) return [];
    const source = duplicatedNodeIds.get(edge.source) ?? edge.source;
    const id = createUniqueEdgeId(`asset-edge-${source}-${target}-copy-${suffix}`, existingIds);
    existingIds.add(id);
    return [{ ...edge, id, source, target, data: { ...edge.data } }];
  });
}

function createUniqueEdgeId(prefix: string, existingIds: ReadonlySet<string>): string {
  let id = prefix;
  let index = 1;
  while (existingIds.has(id)) id = `${prefix}-${++index}`;
  return id;
}
