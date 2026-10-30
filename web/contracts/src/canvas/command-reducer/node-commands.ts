import { applyContentNodeDataPatch, replaceContentNodeData } from "../content-node-data.js";
/**
 * 命令 reducer 的节点类命令（add/update/remove/nodeData.patch）与 group parent 校验。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。复用 domain 结构校验，语义与 edit.apply 的对应操作完全一致。
 */
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { minimumNodeSizeFor } from "../node-dimensions.js";
import {
  filmSetObjectContainerId,
  filmSetObjectOwnershipOf,
  isFilmSetObjectModelNode
} from "../film-set-object-container.js";
import type { CanvasCommand } from "../commands.js";
import {
  DEFAULT_NODE_DIMS,
  collectWoohaa3CanvasRemovalIds,
  createWoohaa3CanvasEdge,
  isValidWoohaa3CanvasConnection,
  nextWoohaa3CanvasNodeZIndex,
  type CanvasNodeData,
  type Woohaa3CanvasNode
} from "../domain/index.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";
import {
  hasShotPreviewOwnership,
  isProtectedShotPreview
} from "./film-set-shot-previews.js";
import { FILM_SET_SHOT_PREVIEW_NODE_TYPE } from "../film-set-shot-preview.js";
import { findActiveRunNode, isModelDefinitionNode } from "./working-state.js";
import { decodeManagedNodeRelation, managedNodeRelationOf } from "../managed-node.js";
import { shotReferenceOwnershipOf } from "../film-set-shot-reference.js";
import {
  normalizeSelfContained3D,
  validateGroupAppearancePatch,
  validateMediaContentPatch,
  validateImageEditPatch,
  validateModelCamerasPatch,
  validateSelfContained3DNodePatch,
  validateVideoEditIntentsPatch
} from "./node-data-validation.js";
import { validateFilmSetGroupDataPatch, convertFilmSetGroupConsumers } from "./film-set-group-commands.js";
import { isFilmSetGroupNode } from "../film-set-group.js";

/**
 * 校验本次提交的 width/height 是否满足节点类别最小下限（change: add-node-resize, design D5）。
 * 未提供的字段视为「本次不修改」，不参与校验；只有显式提供的过小值才拒绝。
 */
export function validateNodeSize(width: number | undefined, height: number | undefined, type: string): CommandApplyResult | null {
  const minimum = minimumNodeSizeFor(type);
  if (width !== undefined && (!Number.isFinite(width) || width < minimum.width)) {
    return reject("invalid-node-size", `节点宽度 ${width} 小于下限 ${minimum.width}`);
  }
  if (height !== undefined && (!Number.isFinite(height) || height < minimum.height)) {
    return reject("invalid-node-size", `节点高度 ${height} 小于下限 ${minimum.height}`);
  }
  return null;
}

/**
 * 校验 `node.update` / `node.add` 的 group parent 不变式
 * （change: add-canvas-node-grouping，design D1；
 *  change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D7）。
 *
 * - parent 必须存在；
 * - parent 必须是 `group` 类型；唯一例外是片场对象容器下与归属匹配的真实 `model3d` 子节点；
 * - 不能自指；
 * - 不能形成 parent 环；
 * - `group` 不能成为另一个 group 的成员（不支持嵌套组，整批拒绝）。
 *
 * 只校验显式提供的 `parentId`；`undefined`（不修改）与 `null`（解除）直接通过。
 */
export function validateGroupParent(
  work: WorkingState,
  nodeId: string,
  parentId: string | null | undefined,
  nodeData?: CanvasNodeData,
  nodeType?: string
): CommandApplyResult | null {
  if (parentId === undefined || parentId === null) return null;
  const parent = work.nodes.find((entry) => entry.id === parentId);
  if (!parent) {
    return reject("invalid-parent", `父节点 ${parentId} 不存在`);
  }
  const child = work.nodes.find((entry) => entry.id === nodeId);
  const childData = nodeData ?? (child ? work.nodeData[nodeId] : undefined);
  const ownership = filmSetObjectOwnershipOf(childData);
  const childIdentity = child ?? (nodeData && nodeType ? { id: nodeId, type: nodeType } : undefined);
  const parentOwnership = filmSetObjectOwnershipOf(work.nodeData[parent.id]);
  const isFilmSetModelChild = isFilmSetObjectModelNode(childIdentity, childData)
    && parent.type === "composite-asset"
    && parentOwnership?.filmSetNodeId === ownership?.filmSetNodeId
    && parentOwnership?.itemId === ownership?.itemId
    && parent.id === filmSetObjectContainerId(ownership!.filmSetNodeId, ownership!.itemId);
  // 嵌套组不支持：group 一旦获得 group parent 就整批拒绝，不写部分 parent/position
  // （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D7）。
  if (childIdentity?.type === "group") {
    return reject("invalid-parent", `group ${nodeId} 不能成为父节点 ${parentId} 的成员`);
  }
  if (parent.type !== "group" && !isFilmSetModelChild) {
    return reject("invalid-parent", `父节点 ${parentId} 不是 group`);
  }
  if (parentId === nodeId) {
    return reject("invalid-parent", "节点不能作为自身父节点");
  }
  // 沿候选 parent 的祖先链上溯：若回到本节点则成环。
  const seen = new Set<string>();
  let cursor: string | undefined = parentId;
  while (cursor) {
    if (cursor === nodeId) {
      return reject("invalid-parent", `parent 关系成环：${nodeId} -> ${parentId}`);
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = work.nodes.find((entry) => entry.id === cursor)?.parentId;
  }
  return null;
}

/**
 * 拒绝以 `group` 作为端点的持久化边（change: add-canvas-node-grouping，design D5）。
 *
 * group 的输出端点是 UI 聚合入口：客户端必须在同一批次里把它展开为成员的真实边。
 * 持久化 `group -> target` 会让输入解析与任务执行误把结构容器当成数据来源。
 *
 * `extra` 用于 `node.add.connect`：目标节点尚未进入 `work.nodes`。
 */
export function validateNoGroupEndpoint(
  work: WorkingState,
  source: string,
  target: string,
  extra?: Woohaa3CanvasNode
): CommandApplyResult | null {
  for (const endpoint of [source, target]) {
    const node = work.nodes.find((entry) => entry.id === endpoint) ?? (extra?.id === endpoint ? extra : undefined);
    if (node?.type === "group") {
      return reject("invalid-edge-endpoint", `group ${endpoint} 不能作为边端点`);
    }
  }
  return null;
}

/**
 * `node.add.connect` 的 nodeData 读取器：目标节点尚未进入工作副本，需合并命令携带的 nodeData
 * （供镜头参考判定读取目标 taskKind 等）。工作副本中的其它节点照常读取。
 */
function connectDataReader(
  work: WorkingState,
  newNodeId: string,
  newNodeData: CanvasNodeData | undefined
) {
  return {
    get: (nodeId: string) => {
      if (nodeId === newNodeId) {
        return (newNodeData ?? undefined) as Record<string, unknown> | undefined;
      }
      return work.nodeData[nodeId] as Record<string, unknown> | undefined;
    }
  };
}

export function addNode(
  work: WorkingState,
  command: Extract<CanvasCommand, { type: "node.add" }>
): CommandApplyResult {
  const { node } = command;
  if (isFilmSetNode(node.type, command.nodeData) || filmSetObjectOwnershipOf(command.nodeData)) {
    return reject("invalid-self-contained-node", "旧 composite 片场与对象容器只允许迁移读取，请创建 film-set group");
  }
  const managed = command.nodeData?.managedBy;
  if (managed !== undefined) {
    const decoded = decodeManagedNodeRelation(managed);
    if (!decoded.ok) return reject("invalid-command", decoded.reason);
    if (decoded.value.ownerNodeId === node.id) return reject("invalid-command", "托管节点不能把自身作为 owner");
    if (!work.nodes.some(entry => entry.id === decoded.value.ownerNodeId)) return reject("unknown-node", `托管 owner ${decoded.value.ownerNodeId} 不存在`);
    if (work.nodes.some(entry => managedNodeRelationOf(work.nodeData[entry.id])?.extensionId === decoded.value.extensionId && managedNodeRelationOf(work.nodeData[entry.id])?.ownerNodeId === decoded.value.ownerNodeId && managedNodeRelationOf(work.nodeData[entry.id])?.entityId === decoded.value.entityId)) return reject("duplicate-node", "同一托管实体已经存在节点");
  }
  if (command.nodeData?.retainWhenEmpty !== undefined && (node.type !== "group" || typeof command.nodeData.retainWhenEmpty !== "boolean")) return reject("invalid-group-config", "retainWhenEmpty 只允许 group 的布尔配置");
  if (command.nodeData?.groupCollapsed !== undefined && (node.type !== "group" || typeof command.nodeData.groupCollapsed !== "boolean")) return reject("invalid-group-config", "groupCollapsed 只允许 group 的布尔配置");
  if (command.nodeData?.groupBadgeScale !== undefined) return reject("invalid-group-config", "groupBadgeScale 已移除：组徽标按画布共享模型单位呈现，不再接受展示倍率");
  if (command.nodeData?.groupAppearance !== undefined && node.type !== "group") return reject("invalid-group-appearance", "groupAppearance 只属于普通组节点");
  if (command.nodeData?.filmSetGroup !== undefined) {
    const markerRejection = validateFilmSetGroupDataPatch(work, node.id, command.nodeData, node.type);
    if (markerRejection) return markerRejection;
  }
  // 预览节点只能由源镜头生命周期派生（D3）：普通新建路径禁止预览类型；恢复路径（撤销删除
  // 镜头）允许重建，但必须携带合法归属、派生 ID 与存在的源片场，最终不变式仍会复核。
  if (node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE || hasShotPreviewOwnership(command.nodeData)) {
    return reject("invalid-shot-preview", "普通节点不能写入拍摄镜头预览归属");
  }
  // 容器只保存归属：内容必须落在真实 `model3d` 子节点。旧版本曾把片场/模型内容直接写在容器上，
  // 之后每个命令的 reconciliation 都会因此整批失败（整张画布不可写），所以在写入入口就拒绝。
  if (command.nodeData && filmSetObjectOwnershipOf(command.nodeData)
    && node.type !== "model3d"
    && Object.keys(command.nodeData).some((key) => !["extensionId", "compositeAssetRole", "filmSetObject"].includes(key))) {
    return reject("invalid-self-contained-node", "对象容器只保存归属，模型内容必须位于 model3d 子节点");
  }
  if (work.nodes.some((entry) => entry.id === node.id)) {
    return reject("duplicate-node", `节点 ${node.id} 已存在`);
  }
  // 最小尺寸下限：挡住 model MCP 等写入方提交畸形尺寸（design D5）。
  const sizeRejection = validateNodeSize(node.width, node.height, node.type);
  if (sizeRejection) return sizeRejection;
  // group parent 不变式（change: add-canvas-node-grouping）：新节点必须挂在已有 group 下。
  const parentRejection = validateGroupParent(work, node.id, node.parentId, command.nodeData, node.type);
  if (parentRejection) return parentRejection;
  const nextNode: Woohaa3CanvasNode = {
    id: node.id,
    type: node.type,
    position: { ...node.position },
    width: node.width ?? DEFAULT_NODE_DIMS.width,
    height: node.height ?? DEFAULT_NODE_DIMS.height,
    parentId: node.parentId,
    zIndex: typeof node.zIndex === "number" && Number.isFinite(node.zIndex)
      ? node.zIndex
      : nextWoohaa3CanvasNodeZIndex(work.nodes),
    data: {}
  };

  if (command.connect) {
    const source = work.nodes.find((entry) => entry.id === command.connect?.fromNodeId);
    if (!source) {
      return reject("unknown-node", `连线起点 ${command.connect.fromNodeId} 不存在`);
    }
    // 稳定 edgeId 必须由客户端提供（design D7 / spec「创建命令缺少稳定实体 ID」）。
    if (!command.connect.edgeId) {
      return reject("missing-edge-id", "node.add.connect 缺少必需的稳定 edgeId");
    }
    const candidate = {
      source: source.id,
      target: nextNode.id,
      sourceHandle: null,
      targetHandle: null
    };
    // group 不得作为持久化边端点（change: add-canvas-node-grouping，design D5）。
    const groupEndpoint = validateNoGroupEndpoint(work, candidate.source, candidate.target, nextNode);
    if (groupEndpoint) return groupEndpoint;
    if (!isValidWoohaa3CanvasConnection(candidate, [...work.nodes, nextNode], work.edges, connectDataReader(work, nextNode.id, command.nodeData))) {
      return reject(
        "invalid-connection",
        `${source.type} -> ${nextNode.type} 不是合法连线（端点相同、重复连线或不满足 handle 规则）`
      );
    }
    const generated = createWoohaa3CanvasEdge(candidate, [...work.nodes, nextNode], connectDataReader(work, nextNode.id, command.nodeData));
    if (!generated) return reject("invalid-connection", `无法为 ${source.id} -> ${nextNode.id} 创建边`);
    // 稳定 edgeId（change: add-frontend-speculative-canvas-state，design D7）：
    // 客户端必须预分配边 ID，服务端保留请求 ID，避免前后端生成不同实体。
    const edgeId = command.connect.edgeId ?? generated.id;
    if (work.edges.some((entry) => entry.id === edgeId)) {
      return reject("duplicate-edge", `边 ${edgeId} 已存在`);
    }
    work.edges.push({
      ...generated,
      id: edgeId,
      data: command.connect.label
        ? { ...generated.data, label: command.connect.label }
        : generated.data
    });
  }

  work.nodes.push(nextNode);
  if (command.nodeData) {
    const intentRejection = validateVideoEditIntentsPatch(command.nodeData);
    if (intentRejection) return intentRejection;
  }
  if (nextNode.type === "composite-asset" && work.content) {
    const owned = applyContentNodeDataPatch({}, command.nodeData ?? {}, work.content);
    if (!owned.ok) return reject(owned.code, owned.message);
    work.nodeData[nextNode.id] = owned.value;
    return OK;
  }
  if (command.nodeData) {
    const value = { ...command.nodeData };
    work.nodeData[nextNode.id] = value;
    // 文件模型（GLB）在创建时就要走与 patch 相同的权威校验与内容身份归一化：导入/粘贴/恢复
    // 都不能依赖客户端声明的 hash，也不能绕过来源互斥与资产存在性校验。脚本模型的创建语义
    // 保持原样（历史内容允许带未知/旧版本，由执行侧稳定失败），只有出现来源标记时收口
    // （change: 2026-10-28-support-glb-model-nodes）。
    if (value.modelSourceKind !== undefined && isModelDefinitionNode(work, nextNode.id)) {
      const nodeRejection = validateSelfContained3DNodePatch(work, nextNode.id, value);
      if (nodeRejection) return nodeRejection;
      const normalized = normalizeSelfContained3D(work, nextNode.id, value, value);
      if (normalized) return normalized;
    }
  }
  return OK;
}

export function updateNode(
  work: WorkingState,
  command: Extract<CanvasCommand, { type: "node.update" }>
): CommandApplyResult {
  const node = work.nodes.find((entry) => entry.id === command.nodeId);
  if (!node) return reject("unknown-node", `节点 ${command.nodeId} 不存在`);
  if (isFilmSetObjectModelNode(node, work.nodeData[node.id])) {
    if (command.position || command.parentId !== undefined || command.zIndex !== undefined) {
      return reject("invalid-self-contained-node", "片场对象内的 model3d 节点不能移动或改父级");
    }
  }
  // 预览节点不得独立改归属（D4）：重父化只随所属片场移动由 reconciliation 补齐。
  if (command.parentId !== undefined && isProtectedShotPreview(work, command.nodeId)) {
    const owner = shotReferenceOwnershipOf(work.nodeData[command.nodeId]);
    const parent = owner ? work.nodes.find(entry => entry.id === owner.filmSetNodeId) : null;
    // 受保护编辑重放会显式携带由 owner 派生的 parent 更新，允许与当前 owner 一致的值。
    if (!parent || (command.parentId ?? null) !== (parent.parentId ?? null)) {
      return reject("invalid-shot-preview", "拍摄镜头预览不能独立改变所属分组");
    }
  }

  const parentRejection = validateGroupParent(work, command.nodeId, command.parentId);
  if (parentRejection) return parentRejection;

  if (command.position) node.position = { x: command.position.x, y: command.position.y };  // 最小尺寸下限：只校验本次提交的字段，既不改写既有记录也不受其影响（design D5）。
  const sizeRejection = validateNodeSize(command.width, command.height, node.type);
  if (sizeRejection) return sizeRejection;
  if (command.width !== undefined) node.width = command.width;
  if (command.height !== undefined) node.height = command.height;
  if (command.zIndex !== undefined) node.zIndex = command.zIndex;
  if (command.parentId !== undefined) {
    node.parentId = command.parentId === null ? undefined : command.parentId;
  }
  return OK;
}

export function removeNodes(work: WorkingState, nodeIds: readonly string[]): CommandApplyResult {
  if (nodeIds.length === 0) return OK;
  const missing = nodeIds.find((id) => !work.nodes.some((node) => node.id === id));
  if (missing) return reject("unknown-node", `节点 ${missing} 不存在`);

  const directModelChild = nodeIds.find((id) => {
    const node = work.nodes.find((entry) => entry.id === id);
    return isFilmSetObjectModelNode(node, work.nodeData[id])
      && !nodeIds.includes(node?.parentId ?? "");
  });
  if (directModelChild) {
    return reject("invalid-self-contained-node", `片场对象内的 model3d 节点 ${directModelChild} 需随片场对象生命周期管理`);
  }

  // 受保护预览不能独立删除（D2）：合法级联（源片场同批删除）由 reconciliation 在同一批次
  // 维护闭包，因此这里直接拒绝任何直接命中的预览；只删受保护预览的原始 node.remove 明确拒绝。
  const removed = collectWoohaa3CanvasRemovalIds(work.nodes, nodeIds, work.nodeData);
  // Deleting a film-set group only removes orchestration and managed previews.
  // Its source cards remain usable on the canvas; move them to the former
  // parent while preserving their world position in this same transaction.
  for (const groupId of nodeIds) {
    const group = work.nodes.find(node => node.id === groupId);
    if (!group || !isFilmSetGroupNode(group, work.nodeData[groupId])) continue;
    const byId = new Map(work.nodes.map(node => [node.id, node]));
    const parent = group.parentId ? byId.get(group.parentId) : undefined;
    const world = (node: typeof group) => {
      let x = node.position.x, y = node.position.y, parentId = node.parentId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const ancestor = byId.get(parentId);
        if (!ancestor) break;
        x += ancestor.position.x; y += ancestor.position.y; parentId = ancestor.parentId;
      }
      return { x, y };
    };
    const parentWorld = parent ? world(parent) : { x: 0, y: 0 };
    for (const candidate of work.nodes) {
      if (!removed.has(candidate.id) || candidate.id === groupId) continue;
      if (!['model3d', 'image', 'video'].includes(candidate.type)) continue;
      const position = world(candidate);
      candidate.parentId = group.parentId;
      candidate.position = { x: position.x - parentWorld.x, y: position.y - parentWorld.y };
      removed.delete(candidate.id);
    }
  }
  const directManaged = nodeIds.find((id) => {
    const relation = managedNodeRelationOf(work.nodeData[id]);
    return relation && !removed.has(relation.ownerNodeId);
  });
  if (directManaged) return reject("invalid-command", `托管节点 ${directManaged} 需由 owner 生命周期管理`);
  const directPreview = nodeIds.find((id) => isProtectedShotPreview(work, id) && !managedNodeRelationOf(work.nodeData[id]));
  if (directPreview) {
    return reject("invalid-shot-preview", `拍摄镜头预览 ${directPreview} 需在拍摄镜头管理中删除`);
  }

  // 递归删除后代 + 空父容器，再清理关联边与 nodeData。
  // 刻意**不**级联删除 assets / jobs：资产是内容寻址且可能被历史或其它节点引用。
  // Owner deletion is a generic lifecycle operation. It remains valid while the
  // extension is unavailable because the persisted relation is authoritative.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [id, data] of Object.entries(work.nodeData)) {
      const relation = managedNodeRelationOf(data);
      if (relation && removed.has(relation.ownerNodeId) && !removed.has(id)) { removed.add(id); expanded = true; }
    }
  }
  // 删除闭包若因级联携带了受保护预览（例如与源片场同批删除），保留由 reconciliation 处理；
  // 但若预览的来源仍存在，则该删除不是合法源级联，拒绝。
  const invalidManagedRemoval = [...removed].find(id => {
    const relation = managedNodeRelationOf(work.nodeData[id]);
    return relation && !removed.has(relation.ownerNodeId);
  });
  if (invalidManagedRemoval) return reject("invalid-command", `托管节点 ${invalidManagedRemoval} 的 owner 仍存在，不能随分组删除`);
  // 任务边界保护（change: 2026-10-09-improve-canvas-workflow，任务 1.2 / design D5.2）：
  // 涉及 queued/pending/running 任务的目标或级联节点一律原子拒绝，不隐式取消任务。
  // 所有删除写入口（原生 node.remove、撤销/恢复 edit.apply、容器移入）复用同一门禁。
  const activeNode = findActiveRunNode(work, [...removed]);
  if (activeNode) {
    return reject("edit-active-run", `作品 ${activeNode} 正在生成，请先取消任务或等待结束`);
  }
  work.nodes = work.nodes.filter((node) => !removed.has(node.id));
  work.edges = work.edges.filter(
    (edge) => !removed.has(edge.source) && !removed.has(edge.target)
  );
  for (const id of removed) delete work.nodeData[id];
  return OK;
}

export function patchNodeData(
  work: WorkingState,
  nodeId: string,
  value: CanvasNodeData | null
): CommandApplyResult {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  if (isFilmSetNode(node?.type, work.nodeData[nodeId]) || isFilmSetNode(node?.type, value)) {
    return reject("invalid-self-contained-node", "旧 composite 片场只允许迁移读取，请编辑 film-set group");
  }
  const currentManaged = managedNodeRelationOf(work.nodeData[nodeId]);
  const hasManagedField = !!work.nodeData[nodeId] && Object.prototype.hasOwnProperty.call(work.nodeData[nodeId], "managedBy");
  if (value && Object.prototype.hasOwnProperty.call(value, "managedBy")) {
    const incoming = managedNodeRelationOf(value);
    if (!currentManaged || !incoming || JSON.stringify(currentManaged) !== JSON.stringify(incoming)) return reject("invalid-command", "托管归属只能由生命周期事务修改");
  }
  if (value === null && hasManagedField) return reject("invalid-command", "托管归属不能通过普通 patch 清除");
  if (isFilmSetObjectModelNode(node, work.nodeData[nodeId])) {
    return reject("invalid-self-contained-node", "片场对象内的 model3d 节点模型由片场自动同步，不能直接修改");
  }
  if (filmSetObjectOwnershipOf(work.nodeData[nodeId])) return reject("invalid-self-contained-node", "对象容器只保存归属；请拖入模型替换对象，或移除容器");
  // Legacy cards have no writable media cache. Canonical managed image/video
  // nodes do: managedBy is protected above, while outputAssetId/status must be
  // writable by the media host without changing ownership.
  if (hasShotPreviewOwnership(value)
    || node?.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE
    || hasShotPreviewOwnership(work.nodeData[nodeId])) {
    return reject("invalid-shot-preview", "拍摄镜头预览归属不能通过普通数据写入修改");
  }
  if (value === null && node?.type === "composite-asset" && work.content) {
    return reject("content-owner-unavailable", "content-owner-unavailable");
  }
  if (value === null) {
    delete work.nodeData[nodeId];
    return OK;
  }
  if (value.retainWhenEmpty !== undefined && (work.nodes.find(node => node.id === nodeId)?.type !== "group" || typeof value.retainWhenEmpty !== "boolean")) return reject("invalid-group-config", "retainWhenEmpty 只允许 group 的布尔配置");
  if (value.groupCollapsed !== undefined && (node?.type !== "group" || typeof value.groupCollapsed !== "boolean")) return reject("invalid-group-config", "groupCollapsed 只允许 group 的布尔配置");
  if (value.groupBadgeScale !== undefined) return reject("invalid-group-config", "groupBadgeScale 已移除：组徽标按画布共享模型单位呈现，不再接受展示倍率");
  if (!work.nodes.some((node) => node.id === nodeId)) {
    return reject("node-data-orphan", `节点业务数据指向不存在的节点 ${nodeId}`);
  }
  // 片场 canonical 写入不做任何实时旧字段清理：正常混合/残留旧结构由严格解码拒绝，
  // 旧磁盘格式仅在隔离离线迁移中转换（D8；不得靠 patch 删字段将旧磁盘升版）。
  const intentRejection = validateVideoEditIntentsPatch(value);
  if (intentRejection) return intentRejection;
  const cameraRejection = validateModelCamerasPatch(value);
  if (cameraRejection) return cameraRejection;
  const imageEditRejection = validateImageEditPatch(value);
  if (imageEditRejection) return imageEditRejection;
  const mediaRejection = validateMediaContentPatch(work, nodeId, value);
  if (mediaRejection) return mediaRejection;
  const appearanceRejection = validateGroupAppearancePatch(work, nodeId, value);
  if (appearanceRejection) return appearanceRejection;
  const filmSetGroupRejection = validateFilmSetGroupDataPatch(work, nodeId, value);
  if (filmSetGroupRejection) return filmSetGroupRejection;
  if (node?.type === "composite-asset" && work.content) {
    const owned = applyContentNodeDataPatch(work.nodeData[nodeId] ?? {}, value, work.content);
    if (!owned.ok) return reject(owned.code, owned.message);
    work.nodeData[nodeId] = owned.value;
    return OK;
  }
  const nodeRejection = validateSelfContained3DNodePatch(work, nodeId, value);
  if (nodeRejection) return nodeRejection;
  const merged = { ...(work.nodeData[nodeId] ?? {}), ...value };
  if (merged.managedBy !== undefined && !managedNodeRelationOf(merged)) return reject("invalid-command", "托管归属非法");
  // 内容身份归一化（change: 2026-10-06-fix-animation3d-runtime-and-authoring，任务 1.2/1.4）：
  // 任何来源的 patch（通用命令、MCP、导入、粘贴、恢复）都不能依赖客户端声明的 hash；模型源码/
  // 语言/API 版本/摆放的实际内容决定 contentHash 与 revision，只改源码的 patch 不会保留旧身份。
  if (isModelDefinitionNode(work, nodeId)) {
    const normalized = normalizeSelfContained3D(work, nodeId, value, merged);
    if (normalized) return normalized;
  }
  const conversion = convertFilmSetGroupConsumers(work, nodeId, value);
  if (conversion) return conversion;
  work.nodeData[nodeId] = { ...(work.nodeData[nodeId] ?? {}), ...value };
  return OK;
}

/**
 * 精确移除业务字段，恢复「原本不存在」的状态。
 *
 * 与 `nodeData.patch`（合并语义）不同：撤销新增标题时必须能移除键本身，而不是写入 null。
 * 字段缺失时幂等通过（无净变化）。
 */
export function unsetNodeDataFields(
  work: WorkingState,
  nodeId: string,
  fields: readonly import("../edit-command.js").EditNodeDataField[]
): CommandApplyResult {
  if (!work.nodes.some((node) => node.id === nodeId)) {
    return reject("node-data-orphan", `节点业务数据指向不存在的节点 ${nodeId}`);
  }
  const data = work.nodeData[nodeId];
  if (!data) return OK;
  if (fields.includes("managedBy" as never) && managedNodeRelationOf(data)) return reject("invalid-command", "托管归属不能通过 unset 清除");
  const next = { ...data };
  let changed = false;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      delete next[field];
      changed = true;
    }
  }
  if (changed && work.content && work.nodes.find(node => node.id === nodeId)?.type === "composite-asset") {
    const owned = replaceContentNodeData(data, next, work.content);
    if (!owned.ok) return reject(owned.code, owned.message);
    work.nodeData[nodeId] = owned.value;
  } else if (changed) work.nodeData[nodeId] = next;
  return OK;
}
