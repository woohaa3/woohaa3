import { compositeChildMovementContext, followCompositeChildOwner, createCompositeChildNode, removeCompositeChildNodes, planCompositeChildLayout } from "../composite-children.js";
/** Maintain at most six external object containers and preserve explicit hide choices. */
import { FILM_SET_MAX_VISIBLE_OBJECTS, filmSetVisibleObjectIds, FILM_SET_OBJECT_MODEL_PADDING, filmSetObjectOwnershipOf, filmSetObjectContainerId, filmSetObjectContainerData, filmSetObjectModelNodeId, filmSetObjectModelNodeData, createFilmSetObjectResolver } from "../film-set-object-container.js";
import { getWoohaa3CanvasNodeAbsolutePosition, refitWoohaa3CanvasGroups, MIN_NODE_WIDTH, type CanvasNodeData, type ServerCanvas } from "../domain/index.js";
import { effectiveCanvasNodeSize, MODEL_PREVIEW_MIN_HEIGHT } from "../node-dimensions.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { OK, reject, type WorkingState, type CommandApplyResult } from "./types.js";

/** 容器只拥有归属；其余字段分别归片场节点或真实 `model3d` 子节点所有。 */
const CONTAINER_OWNERSHIP_KEYS = ["extensionId", "compositeAssetRole", "filmSetObject"] as const;

/**
 * 把容器上残留的内容字段收敛掉，返回收敛后的数据（无残留时原样返回）。
 *
 * 旧版本一度把片场/模型内容写到容器上；严格拒绝会让**整张画布的所有**命令永久失败
 * （症状：新建节点、连线、从端口拉线全部无效，且没有任何可执行的修复入口），所以历史残留
 * 在这里就地收敛。新的写入仍由 `patchNodeData` 的归属校验拒绝，不变式不放宽。
 */
function dropContainerResidue(work: WorkingState, nodeId: string, data: CanvasNodeData): CanvasNodeData {
  const residue = Object.keys(data).filter(key => !(CONTAINER_OWNERSHIP_KEYS as readonly string[]).includes(key));
  if (residue.length === 0) return data;
  const cleaned = { ...data };
  for (const key of residue) delete (cleaned as Record<string, unknown>)[key];
  work.nodeData[nodeId] = cleaned;
  return cleaned;
}

export function reconcileFilmSetObjectContainers(work: WorkingState, before: ServerCanvas, positioned: ReadonlySet<string>): CommandApplyResult {
  const canvas = { document: { ...before.document, nodes: work.nodes }, nodeData: work.nodeData };
  // Normalize legacy/default visibility before reconciling existing children, so overflow is removed too.
  for (const parent of work.nodes) {
    const data = work.nodeData[parent.id];
    if (!isFilmSetNode(parent.type, data)) continue;
    const decoded = decodeFilmSetNodeData(data);
    if (!decoded.ok) continue;
    const hidden = data.filmSetObjectContainersHidden;
    if (hidden !== undefined && (!Array.isArray(hidden) || hidden.some(id => typeof id !== "string") || new Set(hidden).size !== hidden.length)) return reject("invalid-self-contained-node", "对象容器显示设置非法");
    const hiddenIds = new Set((hidden ?? []) as string[]);
    const ids = decoded.value.filmSetContent.items.map(item => item.id);
    const requested = ids.filter(id => !hiddenIds.has(id));
    if (requested.length <= FILM_SET_MAX_VISIBLE_OBJECTS) continue;
    if (hidden !== undefined && JSON.stringify(hidden) !== JSON.stringify(before.nodeData[parent.id]?.filmSetObjectContainersHidden)) {
      return reject("invalid-self-contained-node", `每个片场最多外显 ${FILM_SET_MAX_VISIBLE_OBJECTS} 个对象，请先关闭一个容器`);
    }
    for (const id of requested.slice(FILM_SET_MAX_VISIBLE_OBJECTS)) hiddenIds.add(id);
    work.nodeData[parent.id] = { ...data, filmSetObjectContainersHidden: [...hiddenIds].sort() } as CanvasNodeData;
  }
  const removed = new Set<string>();
  const beforeNodes = before.document.nodes.map(node => ({ ...node, data: {} }));
  const movement = compositeChildMovementContext(beforeNodes, work.nodes);
  const resolve = createFilmSetObjectResolver(canvas), resolveBefore = createFilmSetObjectResolver(before);
  for (const node of work.nodes) {
    let data = work.nodeData[node.id];
    const previousOwner = filmSetObjectOwnershipOf(before.nodeData[node.id]);
    const isContainer = data?.extensionId === "film-set" && data.compositeAssetRole !== undefined;
    const isModelChild = node.type === "model3d" && !!filmSetObjectOwnershipOf(data) && node.id === filmSetObjectModelNodeId(filmSetObjectOwnershipOf(data)!.filmSetNodeId, filmSetObjectOwnershipOf(data)!.itemId);
    if (!isContainer && !previousOwner) continue;
    const owner = filmSetObjectOwnershipOf(data);
    const expectedContainerId = owner ? filmSetObjectContainerId(owner.filmSetNodeId, owner.itemId) : null;
    if ((!isModelChild && (node.type !== "composite-asset" || expectedContainerId === null || node.id !== expectedContainerId)) || (isModelChild && !owner)) return reject("invalid-self-contained-node", "对象容器归属非法或已被修改");
    if (!isModelChild && isContainer && data) data = dropContainerResidue(work, node.id, data);
    if (!owner) return reject("invalid-self-contained-node", "对象容器归属缺失");
    const target = resolve(node.id);
    if (!target) {
      if (previousOwner && resolveBefore(node.id)) { removed.add(node.id); continue; }
      return reject("invalid-self-contained-node", "对象容器对应的片场对象不存在");
    }
    if (Array.isArray(work.nodeData[owner.filmSetNodeId]?.filmSetObjectContainersHidden) && (work.nodeData[owner.filmSetNodeId].filmSetObjectContainersHidden as string[]).includes(owner.itemId)) { removed.add(node.id); continue; }
    if (isModelChild) {
      if (target.item.kind !== "model") { removed.add(node.id); continue; }
      work.nodeData[node.id] = filmSetObjectModelNodeData(owner.filmSetNodeId, target.item);
      continue;
    }
    const parent = movement.current.get(owner.filmSetNodeId)!;
    followCompositeChildOwner(node, parent, beforeNodes, work.nodes, positioned.has(node.id), movement);
  }
  removeCompositeChildNodes(work, removed);
  // Default to the first six objects; explicit hidden choices remain stable.
  for (const parent of [...work.nodes]) {
    const data = work.nodeData[parent.id];
    if (!isFilmSetNode(parent.type, data)) continue;
    const decoded = decodeFilmSetNodeData(data);
    if (!decoded.ok) continue;
    const hidden = data.filmSetObjectContainersHidden;
    if (hidden !== undefined && (!Array.isArray(hidden) || hidden.some(id => typeof id !== "string") || new Set(hidden).size !== hidden.length)) return reject("invalid-self-contained-node", "对象容器显示设置非法");
    const hiddenIds = new Set((hidden ?? []) as string[]);
    const visibleIds = new Set(filmSetVisibleObjectIds(decoded.value.filmSetContent.items.map(item => item.id), [...hiddenIds]));
    for (const item of decoded.value.filmSetContent.items) {
      const id = filmSetObjectContainerId(parent.id, item.id);
      if (!visibleIds.has(item.id) || work.nodes.some(node => node.id === id)) continue;
      const map = new Map(work.nodes.map(node => [node.id, node]));
      const absolute = getWoohaa3CanvasNodeAbsolutePosition(parent, map);
      const width = 248, height = 232;
      const position = planCompositeChildLayout({ layout: "row", ownerBounds: { ...absolute, width: parent.width ?? 320, height: parent.height ?? 240 }, sizes: [{ width, height }], occupied: work.nodes.map(node => ({ ...getWoohaa3CanvasNodeAbsolutePosition(node, map), width: node.width ?? 248, height: node.height ?? 232 })) })[0]!;
      work.nodes.push(createCompositeChildNode({ nodes: work.nodes, owner: parent, id, type: "composite-asset", bounds: position }));
      work.nodeData[id] = filmSetObjectContainerData(parent.id, item.id);
    }
    for (const item of decoded.value.filmSetContent.items) {
      if (item.kind !== "model" || !visibleIds.has(item.id)) continue;
      const containerId = filmSetObjectContainerId(parent.id, item.id);
      const modelId = filmSetObjectModelNodeId(parent.id, item.id);
      const container = work.nodes.find(node => node.id === containerId);
      if (!container) continue;
      const padding = FILM_SET_OBJECT_MODEL_PADDING;
      const size = effectiveCanvasNodeSize(container);
      // A model preview has its own minimum size; keep padding even for small containers.
      container.width = Math.max(size.width, MIN_NODE_WIDTH + padding * 2);
      container.height = Math.max(size.height, MODEL_PREVIEW_MIN_HEIGHT + padding * 2);
      let model = work.nodes.find(node => node.id === modelId);
      if (!model) {
        model = { id: modelId, type: "model3d", position: { x: padding, y: padding }, parentId: containerId, zIndex: (work.nodes.at(-1)?.zIndex ?? 0) + 1, data: {} };
        work.nodes.push(model);
      }
      // Reconcile existing cards too, including scenes saved before padded cards existed.
      model.parentId = containerId;
      model.position = { x: padding, y: padding };
      model.width = container.width - padding * 2;
      model.height = container.height - padding * 2;
      work.nodeData[modelId] = filmSetObjectModelNodeData(parent.id, item);
    }
  }
  refitFilmSetAncestors(work);
  return OK;
}

/** Grow every group around a film set to include the reducer-derived object cards. */
function refitFilmSetAncestors(work: WorkingState): void {
  const groups = new Set<string>();
  const byId = new Map(work.nodes.map(node => [node.id, node]));
  for (const node of work.nodes) {
    if (!isFilmSetNode(node.type, work.nodeData[node.id])) continue;
    const decoded = decodeFilmSetNodeData(work.nodeData[node.id]);
    if (!decoded.ok || decoded.value.filmSetContent.items.length === 0) continue;
    let parentId = node.parentId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (parent?.type !== "group") break;
      groups.add(parent.id);
      parentId = parent.parentId;
    }
  }
  if (groups.size === 0) return;
  const depth = (id: string) => {
    let current = work.nodes.find(node => node.id === id), value = 0;
    while (current?.parentId) {
      value++;
      current = work.nodes.find(node => node.id === current!.parentId);
    }
    return value;
  };
  for (const groupId of [...groups].sort((a, b) => depth(a) - depth(b))) {
    work.nodes = refitWoohaa3CanvasGroups(work.nodes, [groupId]).nodes;
  }
}
