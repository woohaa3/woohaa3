import { convertShotReferenceConsumers } from "./film-set-clip-commands.js";
import type { CanvasCommand } from "../commands.js";
import {
  decodeFilmSetGroupMarker,
  patchFilmSetGroupBinding as patchFilmSetGroupBindingMarker,
  validateFilmSetGroupBindings,
  FILM_SET_GROUP_FIELD,
} from "../film-set-group.js";
import type { CanvasNodeData } from "../domain/index.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";

function canvasFromWork(work: WorkingState) {
  return {
    id: "working",
    title: work.title,
    revision: 0,
    updatedAt: "",
    document: { schemaVersion: "asset-canvas-v1" as const, nodes: work.nodes, edges: work.edges, updatedAt: "" },
    nodeData: work.nodeData,
    assets: work.assets,
    jobs: work.jobs
  };
}

export function patchFilmSetGroupBinding(
  work: WorkingState,
  command: Extract<CanvasCommand, { type: "filmSetGroup.bindingPatch" }>
): CommandApplyResult {
  const node = work.nodes.find(entry => entry.id === command.groupId);
  if (!node) return reject("unknown-node", `片场 group ${command.groupId} 不存在`);
  if (node.type !== "group") return reject("invalid-film-set-group", "片场 owner 必须是 group");
  const current = work.nodeData[command.groupId]?.[FILM_SET_GROUP_FIELD] as unknown;
  const decoded = decodeFilmSetGroupMarker(current);
  if (!decoded.ok) return reject("invalid-film-set-group", decoded.reason);
  const binding = decoded.value.sceneBindings.find(entry => entry.bindingId === command.bindingId);
  if (!binding) return reject("invalid-film-set-group", `binding ${command.bindingId} 不存在`);
  if (command.expectedContentKey !== undefined && binding.contentKey !== command.expectedContentKey) return reject("edit-precondition-failed", "片场资源版本已变化，请重新解析");
  const patched = patchFilmSetGroupBindingMarker(decoded.value, command.bindingId, command.patch);
  if (!patched.ok) return reject("invalid-film-set-group", patched.reason);
  const validation = validateFilmSetGroupBindings(canvasFromWork(work), command.groupId, patched.value, new Set(decoded.value.sceneBindings.map(entry => entry.sourceNodeId)), decoded.value.sceneBindings);
  if (validation) return reject("invalid-film-set-group", validation);
  work.nodeData[command.groupId] = { ...(work.nodeData[command.groupId] ?? {}), [FILM_SET_GROUP_FIELD]: patched.value } as CanvasNodeData;
  return OK;
}

export function ungroupFilmSetGroup(
  work: WorkingState,
  command: Extract<CanvasCommand, { type: "filmSetGroup.ungroup" }>
): CommandApplyResult {
  const group = work.nodes.find(node => node.id === command.groupId);
  if (!group || group.type !== "group") return reject("invalid-film-set-group", "片场 group 不存在");
  const decoded = decodeFilmSetGroupMarker(work.nodeData[command.groupId]?.[FILM_SET_GROUP_FIELD]);
  if (!decoded.ok) return reject("invalid-film-set-group", "片场 group marker 非法");
  const marker = decoded.value;
  if (command.expectedSchemaVersion !== undefined && command.expectedSchemaVersion !== marker.schemaVersion) return reject("edit-precondition-failed", "片场 schema 已变化，请重新解析");
  const byId = new Map(work.nodes.map(node => [node.id, node]));
  const descendants = work.nodes.filter(node => {
    let parent = node.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === group.id) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return false;
  });
  const absolute = (node: typeof group): { x: number; y: number } => {
    let x = node.position.x, y = node.position.y, parent = node.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const value = byId.get(parent);
      if (!value) break;
      x += value.position.x; y += value.position.y; parent = value.parentId;
    }
    return { x, y };
  };
  const parent = group.parentId ? byId.get(group.parentId) : undefined;
  const parentAbs = parent ? absolute(parent) : { x: 0, y: 0 };
  for (const node of descendants) {
    const world = absolute(node);
    node.parentId = group.parentId;
    node.position = { x: world.x - parentAbs.x, y: world.y - parentAbs.y };
  }
  work.nodes = work.nodes.filter(node => node.id !== group.id && !managedOwnerIs(node.id, command.groupId, work));
  delete work.nodeData[command.groupId];
  return OK;
}

function managedOwnerIs(nodeId: string, ownerId: string, work: WorkingState): boolean {
  const relation = work.nodeData[nodeId]?.managedBy;
  return typeof relation === "object" && relation !== null && (relation as { ownerNodeId?: unknown }).ownerNodeId === ownerId;
}

export function validateFilmSetGroupDataPatch(
  work: WorkingState,
  nodeId: string,
  value: CanvasNodeData,
  nodeType?: string
): CommandApplyResult | null {
  if (value[FILM_SET_GROUP_FIELD] === undefined) return null;
  const node = work.nodes.find(entry => entry.id === nodeId) ?? (nodeType ? { id: nodeId, type: nodeType } : undefined);
  if (!node || node.type !== "group") return reject("invalid-film-set-group", "filmSetGroup 只允许 group 节点");
  const ownerRejection = rejectFilmSetGroupByOwner(work, nodeId, value);
  if (ownerRejection) return ownerRejection;
  const decoded = decodeFilmSetGroupMarker(value[FILM_SET_GROUP_FIELD]);
  if (!decoded.ok) return reject("invalid-film-set-group", decoded.reason);
  // A node.add may be followed by node.update commands that attach source cards in
  // the same atomic batch. Defer membership validation until the batch final pass;
  // existing nodes still get an immediate check when possible.
  if (!work.nodes.some(entry => entry.id === nodeId)) return null;
  const previous = decodeFilmSetGroupMarker(work.nodeData[nodeId]?.filmSetGroup);
  const knownSources = new Set(previous.ok ? previous.value.sceneBindings.map(binding => binding.sourceNodeId) : []);
  const validation = validateFilmSetGroupBindings(canvasFromWork(work), nodeId, decoded.value, knownSources, previous.ok ? previous.value.sceneBindings : []);
  if (validation) return reject("invalid-film-set-group", validation);
  return null;
}

/** 已注册的 owner 先判定 marker 形状。没有 resolver 时仍走下面的内核解码。 */
function rejectFilmSetGroupByOwner(work: WorkingState, nodeId: string, value: CanvasNodeData): CommandApplyResult | null {
  if (!work.content) return null;
  const previous = work.nodeData[nodeId] ?? {};
  for (const contribution of work.content.implementations()) {
    const codec = contribution.nodeData;
    if (!codec) continue;
    try {
      const diagnostic = codec.validatePatch(structuredClone(previous), structuredClone(value));
      if (diagnostic) return reject("content-command-rejected", diagnostic.code);
    } catch {
      return reject("content-codec-failed", "content-codec-failed");
    }
  }
  return null;
}

/** Marker restoration and protected undo must update connected reference roles atomically. */
export function convertFilmSetGroupConsumers(work: WorkingState, nodeId: string, value: CanvasNodeData): CommandApplyResult | null {
  if (value.filmSetGroup === undefined) return null;
  const before = decodeFilmSetGroupMarker(work.nodeData[nodeId]?.filmSetGroup);
  const after = decodeFilmSetGroupMarker(value.filmSetGroup);
  if (!before.ok || !after.ok) return null;
  for (const clip of after.value.clips ?? []) {
    const previous = before.value.clips?.find(entry => entry.id === clip.id);
    if (!previous || ((previous.duration ?? 0) > 0) === ((clip.duration ?? 0) > 0)) continue;
    const result = convertShotReferenceConsumers(work, nodeId, clip.id, (clip.duration ?? 0) > 0 ? "dynamic" : "static");
    if (!result.ok) return result;
  }
  return null;
}
