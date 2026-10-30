/**
 * 通用 nodeData 字段历史（change: 2026-10-28-generic-extension-content-ownership，任务 3.4）。
 *
 * 内核不再枚举业务字段白名单：对未被 owner `plan` 认领的节点，按 before/after 的净差异记录
 * 任意可序列化字段。任务、媒体与托管归属由专门权威路径管理，不进入字段历史；具体写入仍由
 * reducer/codec 校验。
 */
import { isEditNodeDataField, type EditNodeDataField, type EditNodeDataFieldSnapshot, type EditOperation, type EditPrecondition } from "./edit-command.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

function sameField(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(previous: CanvasNodeData, next: CanvasNodeData): EditNodeDataField[] {
  const fields = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...fields]
    .filter((field) => isEditNodeDataField(field))
    .filter((field) => !sameField(previous[field], next[field]))
    .sort();
}

export function planNodeDataFieldDiffs(before: ServerCanvas, after: ServerCanvas, nodes: readonly Woohaa3CanvasSerializedNode[]) {
  const forwardOps: EditOperation[] = [], inverseOps: EditOperation[] = [];
  const forwardPre: EditPrecondition[] = [], inversePre: EditPrecondition[] = [];
  for (const node of nodes) {
    const previous = before.nodeData[node.id] ?? {}, next = after.nodeData[node.id] ?? {};
    const changed = changedFields(previous, next);
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
