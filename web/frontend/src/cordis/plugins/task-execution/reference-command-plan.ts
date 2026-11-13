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

/**
 * 往一个模型声明的空槽位填素材。
 *
 * 与普通「加参考」的差别只在 mapping 的 role：这里必须**显式写入槽位角色**。角色推断
 * 只会产出内置角色（`reference_image` 等），自定义槽位（`control_image`）根本推断不出来，
 * 靠推断会把控制图静默当成内容参考，最终走到"控制图没生效"这种看不出原因的结果。
 *
 * 边与 mapping 在同一批次提交：先加边后写 mapping 会留下一个短暂的"有连线没角色"状态，
 * 而角色决定落点，那个状态无法派发也无法校验。
 */
export function planFillSlot(
  canvas: ServerCanvas,
  target: string,
  slot: { role: string; sourceNodeId: string }
): CanvasCommand[] | null {
  if (slot.role === "" || slot.sourceNodeId === "") return null;
  const current = collectDirectMappings(canvas, target);
  // 同一个来源不能在同一节点上占两个槽位：那样会把同一张图提交两次。
  if (current.some((mapping) => mapping.sourceNodeId === slot.sourceNodeId)) return null;
  // 槽位已被别的来源占用时不允许覆盖：覆盖会让已存在的 mention 悄悄指向另一张素材。
  if (current.some((mapping) => mapping.role === slot.role)) return null;

  const original = canvas.nodeData[target]?.inputMapping ?? [];
  const mapping = ensureWoohaa3CanvasInputMappingSlotId({
    sourceNodeId: slot.sourceNodeId,
    role: slot.role,
    sortKey: String(current.length)
  });
  const commands: CanvasCommand[] = [{
    type: "nodeData.patch",
    nodeId: target,
    expectedInputMapping: structuredClone(original),
    value: { inputMapping: [...current, mapping] }
  }];
  if (!canvas.document.edges.some((edge) => edge.target === target && edge.source === slot.sourceNodeId)) {
    commands.push({
      type: "edge.add",
      edge: { id: createHighEntropyId("reference"), source: slot.sourceNodeId, target }
    });
  }
  return commands;
}
