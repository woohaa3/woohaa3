import type { CanvasNodePosition } from "@woohaa3/contracts";
import type { CanvasNodeIndex } from "./canvas-node-index.js";
import type { Map2D } from "./interaction-core.js";

/** Visit moved roots only; explicit previews are absolute. */
export function expandPositionPreviews(index: CanvasNodeIndex, previews: ReadonlyMap<string, {x:number;y:number}>): Map2D | null {
  const result: Map2D = new Map();
  const queue: Array<{id:string;dx:number;dy:number}> = [];
  for (const [id, next] of index.dragRoots(previews)) {
    const original = index.absolutePosition(id);
    if (!original) return null;
    queue.push({id,dx:next.x-original.x,dy:next.y-original.y});
  }
  // Unknown overridden IDs must not silently disappear through root filtering.
  for (const id of previews.keys()) if (!index.byId.has(id)) return null;
  for (let i=0;i<queue.length;i++) {
    const row = queue[i]!;
    if (result.has(row.id)) continue;
    const original = index.absolutePosition(row.id);
    if (!original) return null;
    const explicit = previews.get(row.id);
    const next = explicit ?? {x:original.x+row.dx,y:original.y+row.dy};
    if (![next.x,next.y].every(Number.isFinite)) return null;
    result.set(row.id,next);
    const dx=next.x-original.x,dy=next.y-original.y;
    for (const child of index.children.get(row.id) ?? []) queue.push({id:child,dx,dy});
  }
  return result;
}

/** Include previously previewed IDs so cancel/return removes every old offset. */
export function changedPreviewPositions(index: CanvasNodeIndex, before: ReadonlyMap<string,{x:number;y:number}>, after: ReadonlyMap<string,{x:number;y:number}>): CanvasNodePosition[] {
  const result: CanvasNodePosition[]=[];
  const ids=new Set([...before.keys(),...after.keys()]);
  for (const id of ids) {
    const original=index.absolutePosition(id);
    if (!original) throw new Error("Unknown position node");
    const previous=before.get(id) ?? original;
    const next=after.get(id) ?? original;
    if (next.x!==previous.x || next.y!==previous.y) result.push({id,...next});
  }
  return result;
}
