import { establishItemMotionAdapter } from "./film-set-content.js";
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
import type { ContentContributionResolver } from "./content-contribution.js";
import type { EditOperation } from "./edit-command.js";
import { decodeEditApplyCommand } from "./edit-command.js";
import type { ServerCanvas } from "./domain/index.js";
import { snapGraphPosition } from "./domain/core/serialization.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import { readFilmSetContent } from "./film-set-content.js";
import { readFilmSetGroupMarker } from "./film-set-group.js";

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
  switch (command.type) {
    case "edit.apply": {
      const decoded = decodeEditApplyCommand(command);
      if (!decoded) return false;
      // 整批后置条件：所有内部操作的效果都必须可观察，才算这次受保护编辑已生效。
      return decoded.operations.every((operation) => isEditOperationSatisfied(canvas, operation, content));
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
    case "filmSet.clipPatch": {
      const decoded = decodeFilmSetNodeData(canvas.nodeData[command.nodeId]);
      if (!decoded.ok) return false;
      const collection = filmSetAnimationsOf(decoded.value);
      const clip = collection.clips.find(clip => clip.id === command.clipId);
      const op = command.op;
      if (op.kind === "delete") return !clip;
      if (op.kind === "set-default") return collection.defaultClipId === command.clipId;
      if (op.kind === "duplicate") return collection.clips.some(clip => clip.id === op.newClipId);
      if (!clip) return false;
      if (op.kind === "create" || op.kind === "replace") return shallowEqual(clip, op.clip);
      if (op.kind === "rename") return clip.name === op.name.trim();
      if (op.kind === "timeline") return shallowEqual(clip.timeline, op.timeline);
      if (op.kind === "camera") return shallowEqual(clip.initialCamera, op.initialCamera);
      if (op.kind === "camera-motion") return shallowEqual(clip.cameraMotion, op.cameraMotion);
      if (op.kind === "binding") return shallowEqual(clip.bindings.find(binding => binding.itemId === op.itemId) ?? null, op.binding);
      if (op.kind === "confirm-adaptation") {
        const item = decoded.value.filmSetContent.items.find(item => item.id === op.itemId);
        const motion = clip.bindings.find(binding => binding.itemId === op.itemId)?.motion;
        return !!item && !!motion && motion.basedOnModelVersion.contentHash === establishItemMotionAdapter(item).contentHash;
      }
      return false;
    }
    case "filmSet.itemPatch":
      // 对象级操作的后置条件：按稳定 itemId 观察结果，不做数组序号比较。
      // 具体内容由服务端 reducer 派生，这里只要求目标 item 的期望状态成立。
      return filmSetItemSatisfied(canvas, command);
    case "filmSetGroup.bindingPatch": {
      const marker = readFilmSetGroupMarker(canvas.nodeData[command.groupId]);
      const binding = marker?.sceneBindings.find(entry => entry.bindingId === command.bindingId);
      if (!binding) return false;
      if (command.patch.animation !== undefined && JSON.stringify(binding.animation) !== JSON.stringify(command.patch.animation)) return false;
      if (command.patch.contentKey !== undefined && binding.contentKey !== command.patch.contentKey) return false;
      if (command.patch.visibility !== undefined && binding.visibility !== command.patch.visibility) return false;
      if (command.patch.transform !== undefined && !shallowEqual(binding.transform, command.patch.transform)) return false;
      return true;
    }
    case "filmSetGroup.ungroup":
      return !findNode(canvas, command.groupId) && !readFilmSetGroupMarker(canvas.nodeData[command.groupId]);
    case "extension.command": {
      const owner = content?.resolve(command.extensionId)?.commands;
      if (!owner || !owner.kinds.includes(command.kind)) return false;
      try {
        const decoded = owner.decode(structuredClone({ extensionId: command.extensionId, nodeId: command.nodeId, kind: command.kind, payload: command.payload }));
        return decoded.ok && owner.satisfied(structuredClone(decoded.value), structuredClone(canvas));
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

function isEditOperationSatisfied(canvas: ServerCanvas, operation: EditOperation, content?: ContentContributionResolver): boolean {
  switch (operation.kind) {
    case "extension.edit": {
      const node = findNode(canvas, operation.nodeId);
      if (!node || (node.type === "composite-asset" && canvas.nodeData[operation.nodeId]?.extensionId !== operation.extensionId)) return false;
      const expand = content?.resolve(operation.extensionId)?.edit?.expand;
      if (!expand) return false;
      try {
        const result = expand({ nodeId: operation.nodeId, op: structuredClone(operation.op) });
        const fragment = decodeEditApplyCommand({ ...(result && typeof result === "object" ? result : {}), type: "edit.apply" });
        return !!fragment && fragment.operations.every(entry => entry.kind !== "extension.edit" && isEditOperationSatisfied(canvas, entry, content));
      } catch { return false; }
    }
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
    case "film-set-item-set": {
      const animation = decodeFilmSetNodeData(canvas.nodeData[operation.nodeId]);
      return animation.ok && shallowEqual(animation.value.filmSetContent.items.find(item => item.id === operation.item.id), operation.item);
    }
    case "film-set-item-transform": {
      const animation = decodeFilmSetNodeData(canvas.nodeData[operation.nodeId]);
      if (!animation.ok) return false;
      const item = animation.value.filmSetContent.items.find((entry) => entry.id === operation.itemId);
      return !!item && shallowEqual(item.localTransform, operation.localTransform);
    }
    case "film-set-item-remove": {
      const animation = decodeFilmSetNodeData(canvas.nodeData[operation.nodeId]);
      if (!animation.ok) return false;
      return !animation.value.filmSetContent.items.some((entry) => entry.id === operation.itemId);
    }
    case "film-set-item-restore": {
      const animation = decodeFilmSetNodeData(canvas.nodeData[operation.nodeId]);
      if (!animation.ok) return false;
      const item = animation.value.filmSetContent.items.find((entry) => entry.id === operation.item.id);
      if (!item) return false;
      const content = filmSetAnimationsOf(animation.value);
      return operation.bindings.every((restore) => {
        const binding = content.clips.find((clip) => clip.id === restore.clipId)?.bindings.find((entry) => entry.itemId === operation.item.id);
        return shallowEqual(binding ?? null, restore.binding);
      });
    }
    case "film-set-clip-set": {
      const animation = decodeFilmSetNodeData(canvas.nodeData[operation.nodeId]);
      if (!animation.ok) return false;
      const content = filmSetAnimationsOf(animation.value);
      const clip = content.clips.find((entry) => entry.id === operation.clipId);
      return !!clip && shallowEqual(clip, operation.clip) && content.defaultClipId === operation.defaultClipId;
    }
    case "film-set-clip-remove": {
      const animation = decodeFilmSetNodeData(canvas.nodeData[operation.nodeId]);
      if (!animation.ok) return false;
      const content = filmSetAnimationsOf(animation.value);
      return !content.clips.some((entry) => entry.id === operation.clipId)
        && content.defaultClipId === operation.defaultClipId;
    }
  }
}

function positionSatisfied(
  actual: { x: number; y: number },
  requested: { x: number; y: number }
): boolean {
  return actual.x === snapGraphPosition(requested.x)
    && actual.y === snapGraphPosition(requested.y);
}

/**
 * 片场对象级命令后置条件（change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.3）。
 *
 * 按稳定 itemId 观察：删除要求对象消失；transform/motion/playback 要求对象存在且新值成立。
 * 只读取命令声明的字段，不做数组序号比较。
 */
function filmSetItemSatisfied(
  canvas: ServerCanvas,
  command: Extract<CanvasCommand, { type: "filmSet.itemPatch" }>
): boolean {
  const content = readFilmSetContent(canvas.nodeData[command.nodeId]);
  const item = content.items.find((entry) => entry.id === command.itemId);
  if (command.op.kind === "delete") return item === undefined;
  if (!item) return false;
  switch (command.op.kind) {
    case "transform":
      return shallowEqual(item.localTransform, command.op.localTransform);
    case "replace-model":
      return item.kind === "model" && item.model.contentVersion.sourceHash === command.op.expectedSourceHash && item.model.contentVersion.contentHash === command.op.expectedModelHash
        && item.origin?.sourceNodeId === command.op.sourceNodeId && item.origin.importedAt === command.op.importedAt;
  }
}

function shallowEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
