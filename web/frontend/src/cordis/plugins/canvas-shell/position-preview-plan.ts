import type { CanvasNodePosition } from "@woohaa3/contracts";
import type { CanvasNodeIndex } from "./canvas-node-index.js";
import type { Map2D } from "./interaction-core.js";

/**
 * Visit moved roots/descendants only; an explicit child preview is absolute.
 *
 * 拍摄镜头预览与所属片场保持同一 group parent，但不是片场的子节点（D4）：片场自身作为拖动根
 * 时，后代遍历不会命中预览，因此需要 owner→preview 闭包显式补位。闭包按键空间复用共享索引，
 * 只遍历本批真正移动的 owner，**不**扫描整画布；显式落点的预览以请求值优先，且同一 owner
 * 只位移一次。
 */
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
  // owner→preview 闭包：只对本批已移动的片场补位，避免 pointermove 全表扫描。
  for (const ownerId of [...result.keys()]) {
    const previewIds = index.shotPreviewsByOwner.get(ownerId);
    if (!previewIds) continue;
    const ownerOriginal = index.absolutePosition(ownerId);
    const ownerNext = result.get(ownerId);
    if (!ownerOriginal || !ownerNext) continue;
    const dx = ownerNext.x - ownerOriginal.x, dy = ownerNext.y - ownerOriginal.y;
    for (const previewId of previewIds) {
      if (result.has(previewId)) continue;
      const explicit = previews.get(previewId);
      if (explicit) {
        if (![explicit.x,explicit.y].every(Number.isFinite)) return null;
        result.set(previewId, explicit);
        continue;
      }
      const original = index.absolutePosition(previewId);
      if (!original) continue;
      const next = {x:original.x+dx,y:original.y+dy};
      if (![next.x,next.y].every(Number.isFinite)) return null;
      result.set(previewId,next);
    }
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
