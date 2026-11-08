import {
  createHighEntropyId,
  ensureWoohaa3CanvasInputMappingSlotId,
  type CanvasCommand,
  type ServerCanvas
} from "@woohaa3/contracts";
import { collectDirectMappings, type ReferenceItem } from "./reference-items.js";

/** One guarded batch changes both topology and mappings; untouched mention slots retain their IDs. */
export function planReferenceChange(
  canvas: ServerCanvas,
  target: string,
  change: { remove: readonly Pick<ReferenceItem, "slotId" | "sourceNodeId">[]; replacement?: string }
): CanvasCommand[] | null {
  const original = canvas.nodeData[target]?.inputMapping ?? [];
  const current = collectDirectMappings(canvas, target);
  const removed = current.filter(mapping => change.remove.some(item =>
    mapping.sourceNodeId === item.sourceNodeId && (!item.slotId || mapping.slotId === item.slotId)));
  if (change.remove.some(item => !removed.some(mapping => mapping.sourceNodeId === item.sourceNodeId
    && (!item.slotId || mapping.slotId === item.slotId)))) return null;
  if (change.replacement && removed.length !== 1) return null;
  const remaining = current.filter(mapping => !removed.includes(mapping));
  const replacement = change.replacement;
  if (replacement && removed.length === 1) {
    const { slotId: _oldSlot, sourceAssetIds: _oldAssets, ...fields } = removed[0]!;
    // A replaced source gets its own identity: old @ tokens must never silently refer to new media.
    remaining.push(ensureWoohaa3CanvasInputMappingSlotId({ ...fields, sourceNodeId: replacement }));
  }
  const sources = new Set(remaining.map(mapping => mapping.sourceNodeId));
  const edges = canvas.document.edges.filter(edge => edge.target === target && !sources.has(edge.source));
  const commands: CanvasCommand[] = [{
    type: "nodeData.patch", nodeId: target,
    expectedInputMapping: structuredClone(original),
    value: { inputMapping: remaining }
  }, ...edges.map(edge => ({ type: "edge.remove" as const, edgeId: edge.id }))];
  if (replacement && !canvas.document.edges.some(edge => edge.target === target && edge.source === replacement)) {
    commands.push({ type: "edge.add", edge: { id: createHighEntropyId("reference"), source: replacement, target } });
  }
  return commands;
}
