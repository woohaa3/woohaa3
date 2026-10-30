/**
 * 受保护的可撤销语义编辑命令 `edit.apply`（change:
 * 2026-10-09-improve-canvas-workflow，任务 1.1 / design D5.2）。
 *
 * 目的：让画布级撤销/重做在**服务端权威事务**内按原子前置条件安全执行，而不是提交整张
 * 画布旧快照（会覆盖任务与其它页面的修改）或依赖浏览器写所有权（Y.UndoManager 不可用）。
 *
 * 本模块只负责**形状解码**；类型与边界常量在 `edit-command-types.ts`，此处 re-export 以
 * 保持原公开路径不变。本模块是纯函数：不依赖 DOM / Node / Yjs，浏览器与服务端共用同一份
 * 解码与语义。
 */
import type { CanvasNodeData, Woohaa3CanvasJsonObject } from "./domain/index.js";
import {
  EDIT_APPLY_LIMITS,
  EDIT_NODE_FIELDS,
  type EditApplyCommand,
  type EditFieldSnapshot,
  type EditNodeDataField,
  type EditNodeDataFieldSnapshot,
  type EditNodeField,
  type EditNodeFieldSnapshot,
  type EditOperation,
  type EditPrecondition
} from "./edit-command-types.js";

export {
  EDIT_APPLY_LIMITS,
  EDIT_NODE_FIELDS,
  type EditNodeField,
  type EditNodeDataField,
  type EditFieldSnapshot,
  type EditNodeFieldSnapshot,
  type EditNodeDataFieldSnapshot,
  type EditPrecondition,
  type EditOperation,
  type EditApplyCommand
} from "./edit-command-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isEditNodeField(value: unknown): value is EditNodeField {
  return typeof value === "string" && (EDIT_NODE_FIELDS as readonly string[]).includes(value);
}

/** 由专门权威路径管理的结构字段；不能经 `edit.apply` 的字段快照回退。 */
const RESERVED_NODE_DATA_FIELDS = new Set([
  "prompt", "parameters", "references", "taskStatus", "taskKind", "outputAssetId", "posterAssetId",
  "activeRunId", "jobId", "mediaContent", "managedBy", "extensionId", "compositeAssetRole",
  // 连接映射由边/输入协调统一维护；它不是用户可独立撤销的字段。
  "inputMapping"
]);

/**
 * 是否允许作为通用 nodeData 历史字段。
 *
 * 任务、媒体与托管归属由专门权威路径管理，不能经字段历史回退；其余字段由净差异规划决定，
 * 内核不枚举具体业务字段名。
 */
export function isEditNodeDataField(value: unknown): value is EditNodeDataField {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !RESERVED_NODE_DATA_FIELDS.has(value) && !/[./[\]\\]/.test(value);
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function decodeFieldSnapshot(value: unknown): EditFieldSnapshot | null {
  if (!isRecord(value) || typeof value.present !== "boolean") return null;
  if (value.present === false) return { present: false };
  return { present: true, value: value.value };
}

function decodeNodeFieldSnapshot(value: unknown): EditNodeFieldSnapshot | null {
  if (!isRecord(value) || !isEditNodeField(value.field)) return null;
  const snapshot = decodeFieldSnapshot(value);
  return snapshot ? { field: value.field, ...snapshot } : null;
}

function decodeNodeDataFieldSnapshot(value: unknown): EditNodeDataFieldSnapshot | null {
  if (!isRecord(value) || !isEditNodeDataField(value.field)) return null;
  const snapshot = decodeFieldSnapshot(value);
  return snapshot ? { field: value.field, ...snapshot } : null;
}

function decodePrecondition(value: unknown): EditPrecondition | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "node-exists":
      return isNonEmptyString(value.nodeId) ? { kind: "node-exists", nodeId: value.nodeId } : null;
    case "node-missing":
      return isNonEmptyString(value.nodeId) ? { kind: "node-missing", nodeId: value.nodeId } : null;
    case "node-fields": {
      if (!isNonEmptyString(value.nodeId) || !Array.isArray(value.fields)) return null;
      const fields: EditNodeFieldSnapshot[] = [];
      for (const entry of value.fields) {
        const decoded = decodeNodeFieldSnapshot(entry);
        if (!decoded) return null;
        fields.push(decoded);
      }
      return { kind: "node-fields", nodeId: value.nodeId, fields };
    }
    case "node-data-equals": {
      if (!isNonEmptyString(value.nodeId) || typeof value.present !== "boolean") return null;
      return value.present
        ? { kind: "node-data-equals", nodeId: value.nodeId, present: true, value: value.value }
        : { kind: "node-data-equals", nodeId: value.nodeId, present: false };
    }
    case "node-data-fields": {
      if (!isNonEmptyString(value.nodeId) || !Array.isArray(value.fields)) return null;
      const fields: EditNodeDataFieldSnapshot[] = [];
      for (const entry of value.fields) {
        const decoded = decodeNodeDataFieldSnapshot(entry);
        if (!decoded) return null;
        fields.push(decoded);
      }
      return { kind: "node-data-fields", nodeId: value.nodeId, fields };
    }
    case "parent": {
      if (!isNonEmptyString(value.nodeId)) return null;
      if (value.parentId !== null && !isNonEmptyString(value.parentId)) return null;
      return { kind: "parent", nodeId: value.nodeId, parentId: value.parentId };
    }
    case "child-ids": {
      if (!isNonEmptyString(value.nodeId) || !Array.isArray(value.childIds)) return null;
      if (!value.childIds.every(isNonEmptyString)) return null;
      return { kind: "child-ids", nodeId: value.nodeId, childIds: [...value.childIds] };
    }
    case "incident-edge-ids": {
      if (!isNonEmptyString(value.nodeId) || !Array.isArray(value.edgeIds)) return null;
      if (!value.edgeIds.every(isNonEmptyString)) return null;
      return { kind: "incident-edge-ids", nodeId: value.nodeId, edgeIds: [...value.edgeIds] };
    }
    case "edge-missing":
      return isNonEmptyString(value.edgeId) ? { kind: "edge-missing", edgeId: value.edgeId } : null;
    case "edge-present":
      return isNonEmptyString(value.edgeId) ? { kind: "edge-present", edgeId: value.edgeId } : null;
    case "canvas-title-equals":
      return typeof value.title === "string" ? { kind: "canvas-title-equals", title: value.title } : null;
    case "no-active-run": {
      if (!Array.isArray(value.nodeIds) || !value.nodeIds.every(isNonEmptyString)) return null;
      return { kind: "no-active-run", nodeIds: [...value.nodeIds] };
    }
    case "asset-ready":
      return isNonEmptyString(value.assetId) ? { kind: "asset-ready", assetId: value.assetId } : null;
    case "assets-present": {
      if (!Array.isArray(value.assetIds) || !value.assetIds.every(isNonEmptyString)) return null;
      return { kind: "assets-present", assetIds: [...value.assetIds] };
    }
    default:
      return null;
  }
}

function decodeOperation(value: unknown): EditOperation | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "node-add": {
      const node = value.node;
      if (!isRecord(node)) return null;
      if (!isNonEmptyString(node.id) || !isNonEmptyString(node.type)) return null;
      if (!isPosition(node.position)) return null;
      if (node.width !== undefined && !isFiniteNumber(node.width)) return null;
      if (node.height !== undefined && !isFiniteNumber(node.height)) return null;
      if (node.parentId !== undefined && !isNonEmptyString(node.parentId)) return null;
      if (node.zIndex !== undefined && !isFiniteNumber(node.zIndex)) return null;
      if (value.nodeData !== undefined && !isRecord(value.nodeData)) return null;
      return {
        kind: "node-add",
        node: {
          id: node.id,
          type: node.type,
          position: { x: node.position.x, y: node.position.y },
          ...(node.width !== undefined ? { width: node.width as number } : {}),
          ...(node.height !== undefined ? { height: node.height as number } : {}),
          ...(node.parentId !== undefined ? { parentId: node.parentId as string } : {}),
          ...(node.zIndex !== undefined ? { zIndex: node.zIndex as number } : {})
        },
        ...(value.nodeData !== undefined ? { nodeData: value.nodeData as CanvasNodeData } : {})
      };
    }
    case "node-update": {
      if (!isNonEmptyString(value.nodeId)) return null;
      if (value.position !== undefined && !isPosition(value.position)) return null;
      if (value.width !== undefined && !isFiniteNumber(value.width)) return null;
      if (value.height !== undefined && !isFiniteNumber(value.height)) return null;
      if (value.zIndex !== undefined && !isFiniteNumber(value.zIndex)) return null;
      if (value.parentId !== undefined && value.parentId !== null && !isNonEmptyString(value.parentId)) return null;
      return {
        kind: "node-update",
        nodeId: value.nodeId,
        ...(value.position !== undefined ? { position: { x: value.position.x, y: value.position.y } } : {}),
        ...(value.width !== undefined ? { width: value.width as number } : {}),
        ...(value.height !== undefined ? { height: value.height as number } : {}),
        ...(value.parentId !== undefined ? { parentId: value.parentId as string | null } : {}),
        ...(value.zIndex !== undefined ? { zIndex: value.zIndex as number } : {})
      };
    }
    case "node-remove": {
      if (!Array.isArray(value.nodeIds) || !value.nodeIds.every(isNonEmptyString)) return null;
      return { kind: "node-remove", nodeIds: [...value.nodeIds] };
    }
    case "edge-add": {
      const edge = value.edge;
      if (!isRecord(edge)) return null;
      if (!isNonEmptyString(edge.id) || !isNonEmptyString(edge.source) || !isNonEmptyString(edge.target)) return null;
      if (edge.sourceHandle !== undefined && edge.sourceHandle !== null && !isNonEmptyString(edge.sourceHandle)) return null;
      if (edge.targetHandle !== undefined && edge.targetHandle !== null && !isNonEmptyString(edge.targetHandle)) return null;
      if (edge.data !== undefined && !isRecord(edge.data)) return null;
      return {
        kind: "edge-add",
        edge: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle as string | null } : {}),
          ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle as string | null } : {}),
          ...(edge.data !== undefined ? { data: edge.data as Woohaa3CanvasJsonObject } : {})
        }
      };
    }
    case "edge-remove":
      return isNonEmptyString(value.edgeId) ? { kind: "edge-remove", edgeId: value.edgeId } : null;
    case "node-data-set":
      return isNonEmptyString(value.nodeId) && isRecord(value.value)
        ? { kind: "node-data-set", nodeId: value.nodeId, value: value.value as CanvasNodeData }
        : null;
    case "node-data-unset": {
      if (!isNonEmptyString(value.nodeId) || !Array.isArray(value.fields)) return null;
      if (!value.fields.every(isEditNodeDataField)) return null;
      return { kind: "node-data-unset", nodeId: value.nodeId, fields: [...value.fields] as EditNodeDataField[] };
    }
    case "canvas-title-set":
      return typeof value.title === "string" ? { kind: "canvas-title-set", title: value.title } : null;
    default:
      return null;
  }
}

/**
 * 结构校验一个未受信任的 `edit.apply` 载荷。
 *
 * 只判定「形状是否合法且在有界范围内」；语义（条件是否成立、引用是否存在）由 reducer 在
 * 权威状态上判定。两端共用此函数，禁止任何一侧放宽。
 */
export function isEditApplyCommand(value: unknown): value is EditApplyCommand {
  if (!isRecord(value) || value.type !== "edit.apply") return false;
  const preconditions = value.preconditions;
  const operations = value.operations;
  if (!Array.isArray(preconditions) || !Array.isArray(operations)) return false;
  if (preconditions.length > EDIT_APPLY_LIMITS.maxPreconditions) return false;
  if (operations.length === 0 || operations.length > EDIT_APPLY_LIMITS.maxOperations) return false;

  let referencedNodes = 0;
  for (const raw of preconditions) {
    const decoded = decodePrecondition(raw);
    if (!decoded) return false;
    referencedNodes += countPreconditionNodes(decoded);
  }
  if (referencedNodes > EDIT_APPLY_LIMITS.maxReferencedNodes) return false;

  for (const raw of operations) {
    if (!decodeOperation(raw)) return false;
    // 禁止递归：operation 对象里不得出现 edit.apply。
    if (isRecord(raw) && raw.type === "edit.apply") return false;
  }

  // 有界载荷：序列化字节上限（与两端一致）。
  try {
    if (new TextEncoder().encode(JSON.stringify({ type: "edit.apply", preconditions, operations })).length > EDIT_APPLY_LIMITS.maxPayloadBytes) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** 解码为规范化副本（缺失字段补默认）；形状非法返回 null。 */
export function decodeEditApplyCommand(value: unknown): EditApplyCommand | null {
  if (!isEditApplyCommand(value)) return null;
  const record = value as Record<string, unknown>;
  const preconditions = (record.preconditions as unknown[]).map((raw) => decodePrecondition(raw)!);
  const operations = (record.operations as unknown[]).map((raw) => decodeOperation(raw)!);
  return { type: "edit.apply", preconditions, operations };
}

function countPreconditionNodes(precondition: EditPrecondition): number {
  switch (precondition.kind) {
    case "no-active-run": return precondition.nodeIds.length;
    default: return 1;
  }
}
