import { toWoohaa3CanvasDocument, type Woohaa3CanvasSnapshot } from "./core";
import type { ServerCanvas } from "./types";

export function alignCanvasDocumentWithGraph(
  canvas: ServerCanvas,
  graph: Pick<Woohaa3CanvasSnapshot, "nodes" | "edges">
): ServerCanvas {
  if (graph.nodes.length === 0 && canvas.document.nodes.length > 0) return canvas;
  const aligned = toWoohaa3CanvasDocument({
    nodes: [...graph.nodes],
    edges: [...graph.edges]
  });
  if (sameDocumentGraph(canvas.document, aligned)) return canvas;
  return {
    ...canvas,
    document: {
      ...canvas.document,
      nodes: aligned.nodes,
      edges: aligned.edges
    }
  };
}

function sameDocumentGraph(
  left: ServerCanvas["document"],
  right: ServerCanvas["document"]
): boolean {
  return JSON.stringify({ nodes: left.nodes, edges: left.edges })
    === JSON.stringify({ nodes: right.nodes, edges: right.edges });
}
