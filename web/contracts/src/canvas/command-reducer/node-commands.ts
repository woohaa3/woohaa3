import { applyContentNodeDataPatch, replaceContentNodeData } from "../content-node-data.js";
import { validateWorldIdentities, nodeHasCanvasCard } from "../domain/world-identities.js";
/**
 * 命令 reducer 的节点类命令（add/update/remove/nodeData.patch）。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。复用 domain 结构校验，语义与 edit.apply 的对应操作完全一致。
 */
import { minimumNodeSizeFor } from "../node-dimensions.js";
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
import { findActiveRunNode, isModelDefinitionNode } from "./working-state.js";
import { decodeManagedNodeRelation, managedNodeRelationOf } from "../managed-node.js";
import { decodeWorldInstanceData } from "../shared-world-codec.js";
import {
  normalizeSelfContained3D,
  validateMediaContentPatch,
  validateImageEditPatch,
  validateSelfContained3DNodePatch,
  validateVideoEditIntentsPatch
} from "./node-data-validation.js";

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
  command: Extract<CanvasCommand, { type: "node.add" }>,
  options: { restore?: boolean } = {}
): CommandApplyResult {
  const { node } = command;
  const worldRejection = validateWorldInstance(node.type, command.nodeData);
  if (worldRejection) return worldRejection;
  const legacyModelRejection = requireWorldInstanceForModel(node.type, command.nodeData as Record<string, unknown> | undefined, options.restore === true);
  if (legacyModelRejection) return legacyModelRejection;
  const managed = command.nodeData?.managedBy;
  if (managed !== undefined) {
    const decoded = decodeManagedNodeRelation(managed);
    if (!decoded.ok) return reject("invalid-command", decoded.reason);
    if (decoded.value.ownerNodeId === node.id) return reject("invalid-command", "托管节点不能把自身作为 owner");
    if (!work.nodes.some(entry => entry.id === decoded.value.ownerNodeId)) return reject("unknown-node", `托管 owner ${decoded.value.ownerNodeId} 不存在`);
    if (work.nodes.some(entry => managedNodeRelationOf(work.nodeData[entry.id])?.extensionId === decoded.value.extensionId && managedNodeRelationOf(work.nodeData[entry.id])?.ownerNodeId === decoded.value.ownerNodeId && managedNodeRelationOf(work.nodeData[entry.id])?.entityId === decoded.value.entityId)) return reject("duplicate-node", "同一托管实体已经存在节点");
  }
  if (work.nodes.some((entry) => entry.id === node.id)) {
    return reject("duplicate-node", `节点 ${node.id} 已存在`);
  }
  const hasCard = nodeHasCanvasCard(node, command.nodeData as Record<string, unknown> | undefined);
  if (node.position !== undefined
    && (!Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y))) {
    return reject("invalid-command", `节点 ${node.id} 的位置必须是有限数`);
  }
  if (hasCard && !node.position) return reject("invalid-command", `卡片节点 ${node.id} 缺少位置`);
  // 最小尺寸下限：挡住 model MCP 等写入方提交畸形尺寸（design D5）。
  const sizeRejection = hasCard ? validateNodeSize(node.width, node.height, node.type) : null;
  if (sizeRejection) return sizeRejection;
  const nextNode: Woohaa3CanvasNode = {
    id: node.id,
    type: node.type,
    ...(hasCard && node.position ? { position: { ...node.position } } : {}),
    ...(hasCard
      ? {
          width: node.width ?? DEFAULT_NODE_DIMS.width,
          height: node.height ?? DEFAULT_NODE_DIMS.height
        }
      : {}),
    ...(hasCard && typeof node.parentId === "string" && node.parentId.length > 0 ? { parentId: node.parentId } : {}),
    ...(hasCard
      ? {
          zIndex: typeof node.zIndex === "number" && Number.isFinite(node.zIndex)
            ? node.zIndex
            : nextWoohaa3CanvasNodeZIndex(work.nodes)
        }
      : {}),
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
    if (nextNode.type === "model3d" && value.sharedWorldInstance !== undefined) {
      const error = validateWorldIdentities([nextNode], { [nextNode.id]: value });
      if (error) return reject("invalid-command", error);
    }
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
  if (isLegacyModelCard(node, work.nodeData[node.id] as Record<string, unknown> | undefined)
    && (command.width !== undefined || command.height !== undefined)) {
    return reject("invalid-command", LEGACY_MODEL_CARD_REJECTION);
  }
  // 3D 节点没有卡片布局，但转换/撤销可能在同一批次里先恢复卡片字段再移除 3D 数据；
  // 最终由 normalizeCanvas 按节点最终形态剔除卡片布局，命令层不提前拒绝。
  if (command.position) node.position = { x: command.position.x, y: command.position.y };
  const sizeRejection = validateNodeSize(command.width, command.height, node.type);
  if (sizeRejection) return sizeRejection;
  if (command.width !== undefined) node.width = command.width;
  if (command.height !== undefined) node.height = command.height;
  if (command.zIndex !== undefined) node.zIndex = command.zIndex;
  return OK;
}

export function removeNodes(work: WorkingState, nodeIds: readonly string[]): CommandApplyResult {
  if (nodeIds.length === 0) return OK;
  const missing = nodeIds.find((id) => !work.nodes.some((node) => node.id === id));
  if (missing) return reject("unknown-node", `节点 ${missing} 不存在`);

  // 受保护预览不能独立删除（D2）：合法级联（源片场同批删除）由 reconciliation 在同一批次
  // 维护闭包，因此这里直接拒绝任何直接命中的预览；只删受保护预览的原始 node.remove 明确拒绝。
  const removed = collectWoohaa3CanvasRemovalIds(work.nodes, nodeIds, work.nodeData);
  const directManaged = nodeIds.find((id) => {
    const relation = managedNodeRelationOf(work.nodeData[id]);
    return relation && !removed.has(relation.ownerNodeId);
  });
  if (directManaged) return reject("invalid-command", `托管节点 ${directManaged} 需由 owner 生命周期管理`);

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
  const worldRejection = validateWorldInstance(node?.type, value);
  if (worldRejection) return worldRejection;
  if (node && isLegacyModelCard(node, work.nodeData[nodeId] as Record<string, unknown> | undefined)
    && (value !== null && Object.keys(value).some(key => key !== "title"))
    && !Object.prototype.hasOwnProperty.call(value, "sharedWorldInstance")) {
    return reject("invalid-command", LEGACY_MODEL_CARD_REJECTION);
  }
  const currentManaged = managedNodeRelationOf(work.nodeData[nodeId]);
  const hasManagedField = !!work.nodeData[nodeId] && Object.prototype.hasOwnProperty.call(work.nodeData[nodeId], "managedBy");
  if (value && Object.prototype.hasOwnProperty.call(value, "managedBy")) {
    const incoming = managedNodeRelationOf(value);
    if (!currentManaged || !incoming || JSON.stringify(currentManaged) !== JSON.stringify(incoming)) return reject("invalid-command", "托管归属只能由生命周期事务修改");
  }
  if (value === null && hasManagedField) return reject("invalid-command", "托管归属不能通过普通 patch 清除");
  // Legacy cards have no writable media cache. Canonical managed image/video
  // nodes do: managedBy is protected above, while outputAssetId/status must be
  // writable by the media host without changing ownership.
  if (value === null && node?.type === "composite-asset" && work.content) {
    return reject("content-owner-unavailable", "content-owner-unavailable");
  }
  if (value === null) {
    delete work.nodeData[nodeId];
    return OK;
  }
  if (!work.nodes.some((node) => node.id === nodeId)) {
    return reject("node-data-orphan", `节点业务数据指向不存在的节点 ${nodeId}`);
  }
  const candidate = { ...(work.nodeData[nodeId] ?? {}), ...value };
  if (node?.type === "model3d" && candidate.sharedWorldInstance !== undefined) {
    const error = validateWorldIdentities([node], { [nodeId]: candidate });
    if (error) return reject("invalid-command", error);
  }
  const intentRejection = validateVideoEditIntentsPatch(value);
  if (intentRejection) return intentRejection;
  const imageEditRejection = validateImageEditPatch(value);
  if (imageEditRejection) return imageEditRejection;
  const mediaRejection = validateMediaContentPatch(work, nodeId, value);
  if (mediaRejection) return mediaRejection;
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
  work.nodeData[nodeId] = { ...(work.nodeData[nodeId] ?? {}), ...value };
  return OK;
}

/** 旧卡片模型只保留原值：只允许重命名，其它写入一律拒绝。 */
export const LEGACY_MODEL_CARD_REJECTION = "旧版 3D 模型卡片已不再支持，请删除后重新创建模型";

function isLegacyModelCard(
  node: { type: string },
  data: Record<string, unknown> | undefined
): boolean {
  return node.type === "model3d" && (data?.sharedWorldInstance === undefined);
}

/**
 * 受支持的 `model3d` 必须携带 `sharedWorldInstance`；新建、复制、粘贴都不得再产生旧卡片节点
 * （change: 2026-11-10-remove-legacy-model-card-nodes）。`restore` 只用于撤销/重做恢复既有节点。
 */
function requireWorldInstanceForModel(
  type: string,
  data: Record<string, unknown> | undefined,
  restore: boolean
): CommandApplyResult | null {
  if (type !== "model3d" || restore) return null;
  if (data?.sharedWorldInstance !== undefined) return null;
  return reject("invalid-command", LEGACY_MODEL_CARD_REJECTION);
}

function validateWorldInstance(type: string | undefined, data: CanvasNodeData | null | undefined): CommandApplyResult | null {
  if (!data || !Object.prototype.hasOwnProperty.call(data, "sharedWorldInstance")) return null;
  if (type !== "model3d") return reject("invalid-command", "sharedWorldInstance 仅允许模型节点");
  const result = decodeWorldInstanceData(data.sharedWorldInstance);
  return result.ok ? null : reject("invalid-command", `sharedWorldInstance: ${result.code}`);
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
