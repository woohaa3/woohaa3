/**
 * 命令 reducer 的受保护编辑命令（`edit.apply`）。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。保留 design D5.2 语义：
 * 1. 先解码形状（含白名单/有界/非递归），非法直接拒绝；
 * 2. 在**当前工作副本**（即权威状态）上评估全部前置条件，任一不成立整批拒绝；
 * 3. 顺序应用白名单操作，复用既有 node/edge 结构校验；任一失败整批拒绝；
 * 4. 删除（含级联）额外保护 active run：涉及 queued/pending/running 任务的目标拒绝，
 *    不隐式取消任务（与 run-service / task-projector 的 latest-run-wins 一致）。
 */
import type { EditApplyCommand, EditOperation, EditPrecondition, EditNodeDataField } from "../edit-command.js";
import { decodeEditApplyCommand } from "../edit-command.js";
import { collectWoohaa3CanvasRemovalIds, type CanvasNodeData, type Woohaa3CanvasNode } from "../domain/index.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";
import { findActiveRunNode } from "./working-state.js";
import {
  addNode,
  patchNodeData,
  removeNodes,
  unsetNodeDataFields,
  updateNode
} from "./node-commands.js";
import { addEdge, removeEdge } from "./edge-resource-commands.js";
import {
  applyFilmSetOperation,
  evaluateFilmSetPrecondition,
  isFilmSetOperation,
  isFilmSetPrecondition
} from "./edit-command-film-set.js";

export function applyEditCommand(work: WorkingState, command: EditApplyCommand): CommandApplyResult {
  const decoded = decodeEditApplyCommand(command);
  if (!decoded) return reject("invalid-command", "edit.apply 结构非法或超出上限");

  const failed = evaluateEditPreconditions(work, decoded.preconditions);
  if (failed) return failed;

  // 单次删除保护：扩展为完整级联闭包后校验 active run。
  for (const operation of decoded.operations) {
    const activeRunRejection = validateEditOperationActiveRun(work, operation);
    if (activeRunRejection) return activeRunRejection;
  }

  for (const operation of decoded.operations) {
    const result = applyEditOperation(work, operation);
    if (!result.ok) return result;
  }
  return OK;
}

/**
 * 评估结构化前置条件；返回非 null 表示整批拒绝（无部分写入）。
 *
 * 所有比较都基于 `work` 的**编辑前**状态。字段比较明确区分「不存在」与「null」：
 * 快照 `present:false` 要求字段确实缺失，`present:true,value:null` 要求字段显式为 null。
 */
export function evaluateEditPreconditions(
  work: WorkingState,
  preconditions: readonly EditPrecondition[]
): CommandApplyResult | null {
  for (const condition of preconditions) {
    if (isFilmSetPrecondition(condition.kind)) {
      const result = evaluateFilmSetPrecondition(work, condition);
      if (result) return result;
      continue;
    }
    switch (condition.kind) {
      case "node-exists":
        if (!work.nodes.some((node) => node.id === condition.nodeId)) {
          return reject("edit-precondition-failed", `作品 ${condition.nodeId} 不存在，无法执行`);
        }
        break;
      case "node-missing":
        if (work.nodes.some((node) => node.id === condition.nodeId)) {
          return reject("edit-precondition-failed", `作品 ${condition.nodeId} 已存在，无法执行`);
        }
        break;
      case "node-fields": {
        const node = work.nodes.find((entry) => entry.id === condition.nodeId);
        if (!node) return reject("edit-precondition-failed", `作品 ${condition.nodeId} 不存在，无法执行`);
        for (const snapshot of condition.fields) {
          if (!matchNodeField(node, snapshot.field, snapshot)) {
            return reject("edit-precondition-failed", `作品 ${condition.nodeId} 的${snapshot.field}已被其他操作修改，无法执行`);
          }
        }
        break;
      }
      case "node-data-fields": {
        const data = work.nodeData[condition.nodeId];
        for (const snapshot of condition.fields) {
          if (!matchNodeDataField(data, snapshot.field, snapshot)) {
            return reject("edit-precondition-failed", `作品 ${condition.nodeId} 的字段 ${snapshot.field} 已被其他操作修改，无法执行`);
          }
        }
        break;
      }
      case "parent": {
        const node = work.nodes.find((entry) => entry.id === condition.nodeId);
        if (!node) return reject("edit-precondition-failed", `作品 ${condition.nodeId} 不存在，无法执行`);
        const actual = node.parentId ?? null;
        if (actual !== condition.parentId) {
          return reject("edit-precondition-failed", `作品 ${condition.nodeId} 的分组关系已变化，无法执行`);
        }
        break;
      }
      case "child-ids": {
        const actual = work.nodes
          .filter((node) => node.parentId === condition.nodeId)
          .map((node) => node.id)
          .sort();
        const expected = [...condition.childIds].sort();
        if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
          return reject("edit-precondition-failed", `作品 ${condition.nodeId} 的子作品已变化，无法执行`);
        }
        break;
      }
      case "incident-edge-ids": {
        const actual = work.edges
          .filter((edge) => edge.source === condition.nodeId || edge.target === condition.nodeId)
          .map((edge) => edge.id)
          .sort();
        const expected = [...condition.edgeIds].sort();
        if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
          return reject("edit-precondition-failed", `作品 ${condition.nodeId} 的连线已变化，无法执行`);
        }
        break;
      }
      case "edge-missing":
        if (work.edges.some((edge) => edge.id === condition.edgeId)) {
          return reject("edit-precondition-failed", `连线 ${condition.edgeId} 已存在，无法恢复`);
        }
        break;
      case "edge-present":
        if (!work.edges.some((edge) => edge.id === condition.edgeId)) {
          return reject("edit-precondition-failed", `连线 ${condition.edgeId} 已不存在，无法执行`);
        }
        break;
      case "canvas-title-equals":
        if ((work.title ?? "") !== condition.title) {
          return reject("edit-precondition-failed", "画布名称已被其他操作修改，无法执行");
        }
        break;
      case "no-active-run": {
        const active = findActiveRunNode(work, condition.nodeIds);
        if (active) {
          return reject("edit-active-run", `作品 ${active} 正在生成，请先取消任务或等待结束`);
        }
        break;
      }
      case "asset-ready": {
        const asset = work.assets.find((entry) => entry.id === condition.assetId);
        if (!asset || asset.status !== "ready") {
          return reject("edit-asset-missing", `素材 ${condition.assetId} 当前不可用，无法恢复`);
        }
        break;
      }
      case "assets-present": {
        const missing = condition.assetIds.find((id) => !work.assets.some((asset) => asset.id === id));
        if (missing) return reject("edit-asset-missing", `恢复所需素材 ${missing} 已不可用`);
        break;
      }
    }
  }
  return null;
}

export function matchNodeField(
  node: Woohaa3CanvasNode,
  field: "position" | "width" | "height" | "parentId" | "zIndex",
  snapshot: { present: boolean; value?: unknown }
): boolean {
  const raw: unknown = field === "position" ? node.position : node[field];
  const present = raw !== undefined;
  if (!snapshot.present) return !present;
  if (!present) return false;
  if (field === "position") {
    const expected = snapshot.value as { x?: unknown; y?: unknown } | undefined;
    const actual = raw as { x: number; y: number };
    return !!expected
      && actual.x === expected.x
      && actual.y === expected.y;
  }
  return raw === snapshot.value;
}

export function matchNodeDataField(
  data: CanvasNodeData | undefined,
  field: EditNodeDataField,
  snapshot: { present: boolean; value?: unknown }
): boolean {
  const raw: unknown = data?.[field];
  const present = raw !== undefined;
  if (!snapshot.present) return !present;
  return present && raw === snapshot.value;
}

/**
 * 删除操作（含级联）的 active run 保护。
 *
 * 与 reducer 的实际删除闭包一致：先算 `collectWoohaa3CanvasRemovalIds` 的实际删除集合，
 * 再检查其中任何节点是否有进行中任务，避免「检查目标通过但后代仍在生成」的竞态。
 */
export function validateEditOperationActiveRun(
  work: WorkingState,
  operation: EditOperation
): CommandApplyResult | null {
  if (operation.kind !== "node-remove") return null;
  if (operation.nodeIds.length === 0) return null;
  const removed = collectWoohaa3CanvasRemovalIds(work.nodes, operation.nodeIds, work.nodeData);
  const active = findActiveRunNode(work, [...removed]);
  if (active) {
    return reject("edit-active-run", `作品 ${active} 正在生成，请先取消任务或等待结束`);
  }
  return null;
}

/** 应用单条白名单操行；复用既有结构校验，语义与对应原生命令一致。 */
export function applyEditOperation(work: WorkingState, operation: EditOperation): CommandApplyResult {
  if (isFilmSetOperation(operation)) return applyFilmSetOperation(work, operation);
  switch (operation.kind) {
    case "node-add":
      return addNode(work, { type: "node.add", node: operation.node, nodeData: operation.nodeData });
    case "node-update":
      return updateNode(work, {
        type: "node.update",
        nodeId: operation.nodeId,
        ...(operation.position !== undefined ? { position: operation.position } : {}),
        ...(operation.width !== undefined ? { width: operation.width } : {}),
        ...(operation.height !== undefined ? { height: operation.height } : {}),
        ...(operation.parentId !== undefined ? { parentId: operation.parentId } : {}),
        ...(operation.zIndex !== undefined ? { zIndex: operation.zIndex } : {})
      });
    case "node-remove":
      return removeNodes(work, operation.nodeIds);
    case "edge-add":
      return addEdge(work, {
        id: operation.edge.id,
        source: operation.edge.source,
        target: operation.edge.target,
        sourceHandle: operation.edge.sourceHandle ?? null,
        targetHandle: operation.edge.targetHandle ?? null,
        ...(operation.edge.data !== undefined ? { data: operation.edge.data } : {})
      });
    case "edge-remove":
      return removeEdge(work, operation.edgeId);
    case "node-data-set":
      return patchNodeData(work, operation.nodeId, operation.value);
    case "node-data-unset":
      return unsetNodeDataFields(work, operation.nodeId, operation.fields);
    case "canvas-title-set":
      work.title = operation.title;
      return OK;
  }
}
