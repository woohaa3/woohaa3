/**
 * 命令后置条件判定（change: add-frontend-speculative-canvas-state，任务 1.3）。
 *
 * Pending batch 的 effect satisfaction 必须按**命令后置条件**判断，而不是仅比较 revision
 * （design D5）：新增实体按稳定 ID 与规范字段判断，删除按实体不存在，移动/patch 按目标
 * 字段，连接按稳定 edge ID。任一命令不满足即整批不满足（批次是原子的）。
 *
 * 纯函数：输入一次提交前后的规范画布与命令列表，输出是否全部满足。
 */
import type { CanvasCommand } from "./commands.js";
import { findContentCommandOwnerForLegacyType, type ContentContributionResolver } from "./content-contribution.js";
import type { EditOperation } from "./edit-command.js";
import { decodeEditApplyCommand } from "./edit-command.js";
import type { ServerCanvas } from "./domain/index.js";
import { snapGraphPosition } from "./domain/core/serialization.js";

/** 读取节点（缺失返回 undefined）。 */
function findNode(canvas: ServerCanvas, nodeId: string) {
  return canvas.document.nodes.find((node) => node.id === nodeId);
}

/**
 * 判定一批命令是否已「生效」于给定规范画布。
 *
 * 用于 update-first 场景：服务端 Yjs update 先于 command result 到达时，用稳定 ID 与
 * 命令后置条件识别效果已观察，避免重复应用或闪回。
 */
export function isCanvasCommandBatchSatisfied(
  canvas: ServerCanvas,
  commands: readonly CanvasCommand[],
  content?: ContentContributionResolver
): boolean {
  return commands.every((command) => isCanvasCommandSatisfied(canvas, command, content));
}

/** 单条命令的后置条件判定。 */
export function isCanvasCommandSatisfied(canvas: ServerCanvas, command: CanvasCommand, content?: ContentContributionResolver): boolean {
  // 过渡窗口：旧业务 type 由 owner `legacyTypes` 认领后按 owner `satisfied` 判定；
  // 未认领的类型不再进入内核业务分支。
  const legacyOwner = findContentCommandOwnerForLegacyType(content, command.type)?.commands;
  if (legacyOwner) {
    const target = "nodeId" in command && typeof command.nodeId === "string"
      ? command.nodeId
      : "groupId" in command && typeof command.groupId === "string" ? command.groupId : undefined;
    try {
      const decoded = legacyOwner.decode({ extensionId: "", ...(target ? { nodeId: target } : {}), kind: command.type, payload: command });
      return decoded.ok && legacyOwner.satisfied(decoded.value, canvas);
    } catch {
      return false;
    }
  }
  switch (command.type) {
    case "edit.apply": {
      const decoded = decodeEditApplyCommand(command);
      if (!decoded) return false;
      // 整批后置条件：所有内部操作的效果都必须可观察，才算这次受保护编辑已生效。
      return decoded.operations.every((operation) => isEditOperationSatisfied(canvas, operation));
    }
    case "canvas.setTitle":
      return (canvas.title ?? "") === command.title;
    case "node.add": {
      const node = findNode(canvas, command.node.id);
      if (!node) return false;
      // reducer 持久化时会把任意浮点坐标吸附到规范网格，后置条件必须比较规范值。
      if (!positionSatisfied(node.position, command.node.position)) {
        return false;
      }
      // 携带连接的创建批次：新边也必须出现（按稳定 edgeId）。
      if (command.connect?.edgeId) {
        return canvas.document.edges.some((edge) => edge.id === command.connect?.edgeId);
      }
      return true;
    }
    case "node.update": {
      const node = findNode(canvas, command.nodeId);
      if (!node) return false;
      if (command.position && !positionSatisfied(node.position, command.position)) {
        return false;
      }
      if (command.width !== undefined && node.width !== command.width) return false;
      if (command.height !== undefined && node.height !== command.height) return false;
      if (command.zIndex !== undefined && node.zIndex !== command.zIndex) return false;
      if (command.parentId !== undefined) {
        const expected = command.parentId === null ? undefined : command.parentId;
        if (node.parentId !== expected) return false;
      }
      return true;
    }
    case "node.remove":
      return command.nodeIds.every((nodeId) => !findNode(canvas, nodeId));
    case "nodeData.patch": {
      const data = canvas.nodeData[command.nodeId] as Record<string, unknown> | undefined;
      if (command.value === null) return data === undefined;
      if (!data) return false;
      return Object.entries(command.value).every(([key, value]) => shallowEqual(data[key], value));
    }
    case "extension.edit": {
      const owner = content?.resolve(command.extensionId)?.edit;
      if (!owner) return false;
      if (!owner.satisfied) return true;
      try {
        return owner.satisfied({
          direction: command.direction,
          edit: command.edit,
          preconditions: command.preconditions ?? [],
          canvas
        });
      } catch {
        return false;
      }
    }
    case "extension.command": {
      const owner = content?.resolve(command.extensionId)?.commands;
      if (!owner || (!owner.kinds.includes(command.kind) && !owner.legacyTypes?.includes(command.kind))) return false;
      try {
        const decoded = owner.decode({ extensionId: command.extensionId, nodeId: command.nodeId, kind: command.kind, payload: command.payload });
        return decoded.ok && owner.satisfied(decoded.value, canvas);
      } catch {
        return false;
      }
    }
    case "edge.add":
      return canvas.document.edges.some((edge) => {
        if (command.edge.id && edge.id !== command.edge.id) return false;
        return edge.source === command.edge.source && edge.target === command.edge.target;
      });
    case "edge.remove":
      return !canvas.document.edges.some((edge) => edge.id === command.edgeId);
    case "asset.upsert":
      return canvas.assets.some((asset) => asset.id === command.asset.id);
    case "asset.remove":
      return !canvas.assets.some((asset) => asset.id === command.assetId);
    case "job.upsert":
      return canvas.jobs.some((job) => job.id === command.job.id);
    case "job.remove":
      return !canvas.jobs.some((job) => job.id === command.jobId);
  }
}

function isEditOperationSatisfied(canvas: ServerCanvas, operation: EditOperation): boolean {
  switch (operation.kind) {
    case "node-add": {
      const node = findNode(canvas, operation.node.id);
      if (!node) return false;
      return positionSatisfied(node.position, operation.node.position);
    }
    case "node-update": {
      const node = findNode(canvas, operation.nodeId);
      if (!node) return false;
      if (operation.position && !positionSatisfied(node.position, operation.position)) return false;
      if (operation.width !== undefined && node.width !== operation.width) return false;
      if (operation.height !== undefined && node.height !== operation.height) return false;
      if (operation.zIndex !== undefined && node.zIndex !== operation.zIndex) return false;
      if (operation.parentId !== undefined) {
        const expected = operation.parentId === null ? undefined : operation.parentId;
        if (node.parentId !== expected) return false;
      }
      return true;
    }
    case "node-remove":
      return operation.nodeIds.every((nodeId) => !findNode(canvas, nodeId));
    case "edge-add":
      return canvas.document.edges.some((edge) => edge.id === operation.edge.id);
    case "edge-remove":
      return !canvas.document.edges.some((edge) => edge.id === operation.edgeId);
    case "node-data-set": {
      const data = canvas.nodeData[operation.nodeId] as Record<string, unknown> | undefined;
      if (!data) return false;
      return Object.entries(operation.value).every(([key, value]) => shallowEqual(data[key], value));
    }
    case "node-data-unset": {
      const data = canvas.nodeData[operation.nodeId] as Record<string, unknown> | undefined;
      if (!data) return true;
      return operation.fields.every((field) => !Object.prototype.hasOwnProperty.call(data, field));
    }
    case "canvas-title-set":
      return (canvas.title ?? "") === operation.title;
  }
}

function positionSatisfied(
  actual: { x: number; y: number },
  requested: { x: number; y: number }
): boolean {
  return actual.x === snapGraphPosition(requested.x)
    && actual.y === snapGraphPosition(requested.y);
}

function shallowEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
