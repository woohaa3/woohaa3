/**
 * 共享编辑规划与效果捕获（change: 2026-10-09-improve-canvas-workflow，任务 1.4 / design D5.2）。
 *
 * 从「一次用户结构动作」（创建/粘贴插入、移动/缩放、删除、连线/mapping、重命名、成组/解组、
 * 对齐/分布）捕获：
 * - `forward`：带前置条件的受保护编辑（正确性可验证地复现该动作）；
 * - `inverse`：撤销该动作的受保护编辑（精确恢复到 before 状态，含缺失字段与级联闭包）。
 *
 * 采用**净差异（net diff）**规划而非逐命令拼接：先由共享 reducer 在 before 上模拟出 after，
 * 再比较 before/after 的节点、结构字段、边与 `nodeData.title`，据此得出正向与逆向操作。
 * 这样「规划效果」与「实际规范效果」严格一致，并且能正确排序（父先于子、节点先于边、
 * 先重挂子节点再删除容器）。
 *
 * 纯函数：只读取传入画布并用共享 reducer 模拟；不访问 DOM/网络/Yjs。
 */
import { type ContentContributionResolver } from "./content-contribution.js";
import { planPositionEdit } from "./edit-plan-position.js";
import type { CanvasCommand } from "./commands.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { managedNodeRelationOf } from "./managed-node.js";
import type { EditOperation, EditPrecondition, EditFieldSnapshot, EditNodeField, EditNodeFieldSnapshot } from "./edit-command.js";
import { decodeEditApplyCommand, EDIT_NODE_FIELDS, EDIT_NODE_DATA_FIELDS } from "./edit-command.js";
import { planNodeDataFieldDiffs } from "./edit-plan-node-data.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

export type EditPlan = {
  forward: { preconditions: EditPrecondition[]; operations: EditOperation[] };
  inverse: { preconditions: EditPrecondition[]; operations: EditOperation[] };
};

/** 规划失败的可读原因（不产生可撤销记录）。 */
export type EditPlanFailure = { ok: false; reason: string };

export type EditPlanResult = ({ ok: true } & EditPlan) | EditPlanFailure;

const TEXTUAL_FIELDS: readonly EditNodeField[] = ["position", "width", "height", "zIndex"];

function isPlannable(command: CanvasCommand): boolean {
  switch (command.type) {
    case "extension.command":
    case "node.add":
    case "node.update":
    case "node.remove":
    case "edge.add":
    case "edge.remove":
    case "nodeData.patch":
    case "canvas.setTitle":
      return true;
    default:
      return false;
  }
}

/**
 * 从规范画布与一批**结构写命令**派生 forward/inverse 受保护编辑。
 *
 * 返回 `ok:false` 时调用方 MUST NOT 宣称可撤销（例如动作无净变化、或包含不支持记录的字段）。
 */
export function planCanvasEdit(canvas: ServerCanvas, commands: readonly CanvasCommand[], options: { lifecycle?: import("./managed-node-lifecycle.js").ManagedNodeLifecycleResolver; content?: ContentContributionResolver } = {}): EditPlanResult {
  const relevant = commands.filter(isPlannable);
  if (relevant.length === 0) return { ok: false, reason: "没有可记录的结构动作" };

  const positionPlan = planPositionEdit(canvas, relevant);
  if (positionPlan) return positionPlan;

  const applied = applyCanvasCommands(canvas, relevant, options);
  if (!applied.ok) return { ok: false, reason: applied.rejection.message };
  if (!applied.changed) return { ok: false, reason: "操作没有产生净变化" };

  const generic = diffPlan(canvas, applied.canvas);
  const extensionIds = [...new Set(relevant.filter(command => command.type === "extension.command").map(command => command.extensionId))];
  if (!extensionIds.length) return generic;
  const extensionOnly = relevant.every(command => command.type === "extension.command");
  const result: EditPlan = !extensionOnly && generic.ok ? generic : { forward: { preconditions: [], operations: [] }, inverse: { preconditions: [], operations: [] } };
  for (const extensionId of extensionIds) {
    const planner = options.content?.resolve(extensionId)?.edit;
    if (!planner) return { ok: false, reason: "content-edit-unavailable" };
    try {
      const planned = planner.plan(structuredClone(canvas), structuredClone(applied.canvas));
      if (!planned.ok) return { ok: false, reason: planned.code };
      const fragment = (value: unknown) => decodeEditApplyCommand({ ...(value && typeof value === "object" ? value : {}), type: "edit.apply" });
      const forward = fragment(planned.forward), inverse = fragment(planned.inverse);
      if (!forward || !inverse) return { ok: false, reason: "content-edit-invalid" };
      const guarded = decodeEditApplyCommand({ ...forward, preconditions: [...forward.preconditions, ...planned.preconditions] });
      if (!guarded) return { ok: false, reason: "content-edit-invalid" };
      result.forward.operations.push(...guarded.operations);
      result.forward.preconditions.push(...guarded.preconditions);
      result.inverse.operations.push(...inverse.operations);
      result.inverse.preconditions.push(...inverse.preconditions);
    } catch { return { ok: false, reason: "content-codec-failed" }; }
  }
  for (const side of [result.forward, result.inverse]) {
    if (!decodeEditApplyCommand({ ...side, type: "edit.apply" })) return { ok: false, reason: "content-edit-limit-exceeded" };
  }
  // Owners must cover the complete effect without duplicating structural operations.
  const replay = applyCanvasCommands(canvas, [{ type: "edit.apply", ...result.forward }], options);
  if (!replay.ok || editStateKey(replay.canvas) !== editStateKey(applied.canvas)) return { ok: false, reason: "content-edit-forward-mismatch" };
  const undo = applyCanvasCommands(replay.canvas, [{ type: "edit.apply", ...result.inverse }], options);
  if (!undo.ok || editStateKey(undo.canvas) !== editStateKey(canvas)) return { ok: false, reason: "content-edit-inverse-mismatch" };
  return { ok: true, ...result };
}

function editStateKey(canvas: ServerCanvas): string {
  return JSON.stringify([canvas.title, canvas.document.nodes, canvas.document.edges, canvas.nodeData, canvas.assets, canvas.jobs], (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

export function diffPlan(before: ServerCanvas, after: ServerCanvas): EditPlanResult {
  const beforeNodes = new Map(before.document.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.document.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.document.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.document.edges.map((edge) => [edge.id, edge]));

  // 拍摄镜头预览是源镜头的**派生**节点（change: 2026-10-15 D3）：其创建/清理由 reconciliation
  // 在同一批次内维护，因此新增/删除不进入结构 diff（否则通用路径会把派生副作用记成独立增删，
  // 撤销时会尝试删除受保护预览并被正确拒绝）。但**既有**预览的布局变化（位置/尺寸/zIndex/父级）
  // 是用户显式动作，必须进入受保护编辑日志，故保留在 commonNodes 中参与字段差异规划。
  // Default object containers are also derived; recording their automatic creation would
  // make redo fail after reconciliation restores them during undo of a legacy scene edit.
  // Explicit removals remain in history so hide/delete undo restores the original layout.
  const addedNodes = [...afterNodes.values()].filter((node) => !beforeNodes.has(node.id) && !managedNodeRelationOf(after.nodeData[node.id]));
  const removedNodes = [...beforeNodes.values()].filter((node) => !afterNodes.has(node.id) && !managedNodeRelationOf(before.nodeData[node.id]));
  const commonNodes = [...afterNodes.values()].filter((node) => beforeNodes.has(node.id));
  const addedEdges = [...afterEdges.values()].filter((edge) => !beforeEdges.has(edge.id));
  const removedEdges = [...beforeEdges.values()].filter((edge) => !afterEdges.has(edge.id));

  const forwardOps: EditOperation[] = [];
  let inverseOps: EditOperation[] = [];
  const forwardPre: EditPrecondition[] = [];
  const inversePre: EditPrecondition[] = [];

  // ---- 结构字段变化（含 reparent）。正向必须先新增容器节点（见下）；逆向先重挂子节点。 ----
  const fieldForward: EditOperation[] = [];
  for (const node of commonNodes) {
    const prev = beforeNodes.get(node.id)!;
    const changed = TEXTUAL_FIELDS.filter((field) => nodeFieldChanged(prev, node, field));
    if (changed.length === 0) continue;
    fieldForward.push(updateOperationFor(node, changed, node));
    inverseOps.push(updateOperationFor(prev, changed, prev));
    forwardPre.push(fieldPrecondition(before, node.id, changed));
    inversePre.push(fieldPrecondition(after, node.id, changed));
  }

  // ---- 正向顺序：先新增节点（父先于子）→ 再字段/reparent → 再 nodeData.title → 边 → 删除。 ----
  const addedNodesOrdered = orderParentsFirst(addedNodes);
  for (const node of addedNodesOrdered) {
    forwardOps.push(nodeAddOperation(node, after));
    forwardPre.push({ kind: "node-missing", nodeId: node.id });
    forwardPre.push({ kind: "no-active-run", nodeIds: [node.id] });
  }
  forwardOps.push(...fieldForward);

  // Only explicitly owned fields enter history; unrelated node data survives replay.
  const dataPlan = planNodeDataFieldDiffs(before, after, commonNodes, EDIT_NODE_DATA_FIELDS);
  forwardOps.push(...dataPlan.forwardOps);
  inverseOps.push(...dataPlan.inverseOps);
  forwardPre.push(...dataPlan.forwardPre);
  inversePre.push(...dataPlan.inversePre);

  const removedNodesOrdered = orderChildrenFirst(removedNodes);
  for (const edge of addedEdges) {
    forwardOps.push(edgeAddOperation(edge));
    forwardPre.push({ kind: "edge-missing", edgeId: edge.id });
  }
  for (const edge of removedEdges) {
    forwardOps.push({ kind: "edge-remove", edgeId: edge.id });
    forwardPre.push({ kind: "edge-present", edgeId: edge.id });
  }
  for (const node of removedNodesOrdered) {
    forwardPre.push({ kind: "no-active-run", nodeIds: [node.id] });
  }
  if (removedNodes.length > 0) {
    forwardOps.push({ kind: "node-remove", nodeIds: removedNodes.map((node) => node.id) });
  }

  // ---- 逆向顺序：字段/reparent（已 push）→ 移除新增节点（子先于父，保护后来关联）
  //      → 恢复被删节点（父先于子）→ 恢复被删边 → 移除新增边。 ----
  const inverseRemoveAdded = orderChildrenFirst(addedNodes);
  for (const node of inverseRemoveAdded) {
    inverseOps.push({ kind: "node-remove", nodeIds: [node.id] });
    inversePre.push({ kind: "no-active-run", nodeIds: [node.id] });
    inversePre.push({
      kind: "incident-edge-ids",
      nodeId: node.id,
      edgeIds: incidentEdgeIds(after, node.id)
    });
  }
  const inverseRestoreRemoved = orderParentsFirst(removedNodes);
  for (const node of inverseRestoreRemoved) {
    inverseOps.push(nodeAddOperation(node, before));
    inversePre.push({ kind: "node-missing", nodeId: node.id });
  }
  const restoreAssetIds = collectRestoreAssetIds(before, removedNodes);
  if (restoreAssetIds.length > 0) inversePre.push({ kind: "assets-present", assetIds: restoreAssetIds });

  for (const edge of removedEdges) {
    inverseOps.push(edgeAddOperation(edge));
    inversePre.push({ kind: "edge-missing", edgeId: edge.id });
  }
  for (const edge of addedEdges) {
    inverseOps.push({ kind: "edge-remove", edgeId: edge.id });
  }

  // 画布标题（撤销画布重命名）。
  if ((before.title ?? "") !== (after.title ?? "")) {
    forwardOps.push({ kind: "canvas-title-set", title: after.title ?? "" });
    forwardPre.push({ kind: "canvas-title-equals", title: before.title ?? "" });
    inverseOps.push({ kind: "canvas-title-set", title: before.title ?? "" });
    inversePre.push({ kind: "canvas-title-equals", title: after.title ?? "" });
  }

  if (forwardOps.length === 0) return { ok: false, reason: "操作没有产生净变化" };
  return {
    ok: true,
    forward: { preconditions: forwardPre, operations: forwardOps },
    inverse: { preconditions: inversePre, operations: inverseOps }
  };
}

function nodeAddOperation(node: Woohaa3CanvasSerializedNode, source: ServerCanvas): Extract<EditOperation, { kind: "node-add" }> {
  const data = source.nodeData[node.id] as CanvasNodeData | undefined;
  return {
    kind: "node-add",
    node: {
      id: node.id,
      type: node.type,
      position: { ...node.position },
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
      ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
    },
    ...(data && Object.keys(data).length > 0 ? { nodeData: data } : {})
  };
}

function edgeAddOperation(edge: ServerCanvas["document"]["edges"][number]): Extract<EditOperation, { kind: "edge-add" }> {
  return {
    kind: "edge-add",
    edge: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      ...(edge.data && Object.keys(edge.data).length > 0 ? { data: edge.data } : {})
    }
  };
}

function updateOperationFor(
  node: Woohaa3CanvasSerializedNode,
  fields: readonly EditNodeField[],
  source: Woohaa3CanvasSerializedNode
): Extract<EditOperation, { kind: "node-update" }> {
  const operation: Extract<EditOperation, { kind: "node-update" }> = { kind: "node-update", nodeId: node.id };
  for (const field of fields) {
    switch (field) {
      case "position": operation.position = { ...source.position }; break;
      case "width": operation.width = source.width; break;
      case "height": operation.height = source.height; break;
      case "zIndex": operation.zIndex = source.zIndex; break;
    }
  }
  return operation;
}

function nodeFieldChanged(prev: Woohaa3CanvasSerializedNode, next: Woohaa3CanvasSerializedNode, field: EditNodeField): boolean {
  switch (field) {
    case "position": return prev.position.x !== next.position.x || prev.position.y !== next.position.y;
    default: return prev[field] !== next[field];
  }
}

function fieldPrecondition(canvas: ServerCanvas, nodeId: string, fields: readonly EditNodeField[]): EditPrecondition {
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  const snapshots: EditNodeFieldSnapshot[] = fields.map((field) => {
    if (!node) return { field, present: false };
    const raw: unknown = field === "position" ? node.position : node[field];
    return raw === undefined ? { field, present: false } : { field, present: true, value: raw };
  });
  return { kind: "node-fields", nodeId, fields: snapshots };
}

function incidentEdgeIds(canvas: ServerCanvas, nodeId: string): string[] {
  return canvas.document.edges
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .map((edge) => edge.id)
    .sort();
}

function collectRestoreAssetIds(canvas: ServerCanvas, nodes: readonly Woohaa3CanvasSerializedNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    const data = canvas.nodeData[node.id] as CanvasNodeData | undefined;
    if (typeof data?.outputAssetId === "string") ids.add(data.outputAssetId);
    if (typeof data?.posterAssetId === "string") ids.add(data.posterAssetId);
  }
  return [...ids];
}

/** 父节点先于子节点（用于恢复/创建）。 */
function orderParentsFirst(nodes: readonly Woohaa3CanvasSerializedNode[]): Woohaa3CanvasSerializedNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: Woohaa3CanvasSerializedNode[] = [];
  const added = new Set<string>();
  const visit = (node: Woohaa3CanvasSerializedNode) => {
    if (added.has(node.id)) return;
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent && !added.has(parent.id)) visit(parent);
    }
    added.add(node.id);
    ordered.push(node);
  };
  for (const node of nodes) visit(node);
  return ordered;
}

/** 子节点先于父节点（用于删除）。 */
function orderChildrenFirst(nodes: readonly Woohaa3CanvasSerializedNode[]): Woohaa3CanvasSerializedNode[] {
  return [...orderParentsFirst(nodes)].reverse();
}

/** 供调用方构造字段快照的辅助（测试/自定义 planner 使用）。 */
export function fieldSnapshot(value: unknown): EditFieldSnapshot {
  return value === undefined ? { present: false } : { present: true, value };
}

export { EDIT_NODE_FIELDS };
