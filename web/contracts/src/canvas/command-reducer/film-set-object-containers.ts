import { compositeChildMovementContext, followCompositeChildOwner, createCompositeChildNode, removeCompositeChildNodes, planCompositeChildLayout } from "../composite-children.js";
/** Maintain a default-visible container for every scene object and explicit hide choices. */
import { filmSetObjectOwnershipOf, filmSetObjectContainerId, filmSetObjectContainerData, createFilmSetObjectResolver } from "../film-set-object-container.js";
import { getWoohaa3CanvasNodeAbsolutePosition, type ServerCanvas } from "../domain/index.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { OK, reject, type WorkingState, type CommandApplyResult } from "./types.js";

export function reconcileFilmSetObjectContainers(work: WorkingState, before: ServerCanvas, positioned: ReadonlySet<string>): CommandApplyResult {
  const canvas = { document: { ...before.document, nodes: work.nodes }, nodeData: work.nodeData };
  const removed = new Set<string>();
  const beforeNodes = before.document.nodes.map(node => ({ ...node, data: {} }));
  const movement = compositeChildMovementContext(beforeNodes, work.nodes);
  const resolve = createFilmSetObjectResolver(canvas), resolveBefore = createFilmSetObjectResolver(before);
  for (const node of work.nodes) {
    const data = work.nodeData[node.id];
    const previousOwner = filmSetObjectOwnershipOf(before.nodeData[node.id]);
    const isContainer = data?.extensionId === "film-set" && data.compositeAssetRole !== undefined;
    if (!isContainer && !previousOwner) continue;
    const owner = filmSetObjectOwnershipOf(data);
    if (node.type !== "composite-asset" || !owner || node.id !== filmSetObjectContainerId(owner.filmSetNodeId, owner.itemId)) return reject("invalid-self-contained-node", "对象容器归属非法或已被修改");
    if (Object.keys(data).some(key => !["extensionId", "compositeAssetRole", "filmSetObject"].includes(key))) return reject("invalid-self-contained-node", "对象容器只保存归属，不能保存独立模型或场景内容");
    const target = resolve(node.id);
    if (!target) {
      if (previousOwner && resolveBefore(node.id)) { removed.add(node.id); continue; }
      return reject("invalid-self-contained-node", "对象容器对应的片场对象不存在");
    }
    if (Array.isArray(work.nodeData[owner.filmSetNodeId]?.filmSetObjectContainersHidden) && (work.nodeData[owner.filmSetNodeId].filmSetObjectContainersHidden as string[]).includes(owner.itemId)) { removed.add(node.id); continue; }
    const parent = movement.current.get(owner.filmSetNodeId)!;
    followCompositeChildOwner(node, parent, beforeNodes, work.nodes, positioned.has(node.id), movement);
  }
  removeCompositeChildNodes(work, removed);
  // Missing visibility settings mean every object is visible, including legacy scenes.
  for (const parent of [...work.nodes]) {
    const data = work.nodeData[parent.id];
    if (!isFilmSetNode(parent.type, data)) continue;
    const decoded = decodeFilmSetNodeData(data);
    if (!decoded.ok) continue;
    const hidden = data.filmSetObjectContainersHidden;
    if (hidden !== undefined && (!Array.isArray(hidden) || hidden.some(id => typeof id !== "string") || new Set(hidden).size !== hidden.length)) return reject("invalid-self-contained-node", "对象容器显示设置非法");
    const hiddenIds = new Set((hidden ?? []) as string[]);
    for (const item of decoded.value.filmSetContent.items) {
      const id = filmSetObjectContainerId(parent.id, item.id);
      if (hiddenIds.has(item.id) || work.nodes.some(node => node.id === id)) continue;
      const map = new Map(work.nodes.map(node => [node.id, node]));
      const absolute = getWoohaa3CanvasNodeAbsolutePosition(parent, map);
      const width = 248, height = 232;
      const position = planCompositeChildLayout({ ownerBounds: { ...absolute, width: parent.width ?? 320, height: parent.height ?? 240 }, sizes: [{ width, height }], occupied: work.nodes.map(node => ({ ...getWoohaa3CanvasNodeAbsolutePosition(node, map), width: node.width ?? 248, height: node.height ?? 232 })) })[0]!;
      work.nodes.push(createCompositeChildNode({ nodes: work.nodes, owner: parent, id, type: "composite-asset", bounds: position }));
      work.nodeData[id] = filmSetObjectContainerData(parent.id, item.id);
    }
  }
  return OK;
}
