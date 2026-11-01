/** Protected history for names and stable project associations. */
import type { EditNodeDataField, EditNodeDataFieldSnapshot, EditOperation, EditPrecondition } from "./edit-command.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

export function planNodeDataFieldDiffs(before: ServerCanvas, after: ServerCanvas, nodes: readonly Woohaa3CanvasSerializedNode[], fields: readonly EditNodeDataField[]) {
  const forwardOps: EditOperation[] = [], inverseOps: EditOperation[] = [];
  const forwardPre: EditPrecondition[] = [], inversePre: EditPrecondition[] = [];
  for (const node of nodes) {
    const previous = before.nodeData[node.id] ?? {}, next = after.nodeData[node.id] ?? {};
    const changed = fields.filter(field => previous[field] !== next[field]);
    if (!changed.length) continue;
    const snapshots = (data: CanvasNodeData): EditNodeDataFieldSnapshot[] => changed.map(field =>
      data[field] === undefined ? { field, present: false } : { field, present: true, value: data[field] });
    const operations = (data: CanvasNodeData): EditOperation[] => {
      const present = changed.filter(field => data[field] !== undefined);
      const missing = changed.filter(field => data[field] === undefined);
      return [
        ...(present.length ? [{ kind: "node-data-set" as const, nodeId: node.id, value: Object.fromEntries(present.map(field => [field, data[field]])) as CanvasNodeData }] : []),
        ...(missing.length ? [{ kind: "node-data-unset" as const, nodeId: node.id, fields: missing }] : [])
      ];
    };
    forwardOps.push(...operations(next)); inverseOps.push(...operations(previous));
    forwardPre.push({ kind: "node-data-fields", nodeId: node.id, fields: snapshots(previous) });
    inversePre.push({ kind: "node-data-fields", nodeId: node.id, fields: snapshots(next) });
  }
  return { forwardOps, inverseOps, forwardPre, inversePre };
}
