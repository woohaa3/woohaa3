import type { Woohaa3CanvasNode } from "./canvas-runtime";

export function nextWoohaa3CanvasNodeZIndex(nodes: readonly Woohaa3CanvasNode[]): number {
  let max = 0;
  nodes.forEach((node, index) => {
    const value = typeof node.zIndex === "number" && Number.isFinite(node.zIndex)
      ? node.zIndex
      : index;
    if (value > max) max = value;
  });
  return max + 1;
}

export function assignTopWoohaa3CanvasZIndexes<T extends Woohaa3CanvasNode>(
  existing: readonly Woohaa3CanvasNode[],
  created: readonly T[]
): T[] {
  let next = nextWoohaa3CanvasNodeZIndex(existing);
  return created.map((node) => {
    if (typeof node.zIndex === "number" && Number.isFinite(node.zIndex) && node.zIndex >= next) {
      next = node.zIndex + 1;
      return node;
    }
    const assigned = { ...node, zIndex: next };
    next += 1;
    return assigned;
  });
}
