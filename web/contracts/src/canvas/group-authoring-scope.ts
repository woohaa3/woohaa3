import type { ServerCanvas } from "./domain/index.js";
import { stableStringify } from "./canvas-script/planner/hash.js";

export type CanvasGroupScope = { canvasId: string; rootGroupId: string; scopeEpoch: number };

/** Membership is always resolved from the current parent graph, never a frozen list. */
export function canvasGroupMembers(canvas: ServerCanvas, rootGroupId: string): Set<string> {
  if (!canvas.document.nodes.some(n => n.id === rootGroupId && n.type === "group")) throw new Error("group-target-missing");
  const ids = new Set([rootGroupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of canvas.document.nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); changed = true; }
  }
  return ids;
}

/** A read projection contains neither cross-boundary edges nor global task/asset history. */
export function projectCanvasGroup(canvas: ServerCanvas, rootGroupId: string): ServerCanvas {
  const ids = canvasGroupMembers(canvas, rootGroupId);
  const nodes = canvas.document.nodes.filter(n => ids.has(n.id)).map(n => n.id === rootGroupId ? { ...n, parentId: undefined } : n);
  const nodeData = Object.fromEntries(Object.entries(canvas.nodeData).filter(([id]) => ids.has(id)));
  const assets = canvasGroupAssetIds(canvas, ids);
  return { ...canvas, title: String(nodeData[rootGroupId]?.title ?? "创作组"), document: { ...canvas.document, nodes, edges: canvas.document.edges.filter(e => ids.has(e.source) && ids.has(e.target)) }, nodeData, assets: canvas.assets.filter(a => assets.has(a.id)), jobs: canvas.jobs.filter(j => ids.has(j.nodeId)) };
}

/** Validate the reducer's full result, including implicit cascades and input reconciliation. */
export function validateCanvasGroupChange(before: ServerCanvas, after: ServerCanvas, rootGroupId: string): string | null {
  let ids: Set<string>, nextIds: Set<string>;
  try { ids = canvasGroupMembers(before, rootGroupId); nextIds = canvasGroupMembers(after, rootGroupId); } catch { return "不能删除或解散创作根组"; }
  const root = before.document.nodes.find(n => n.id === rootGroupId)!;
  const nextRoot = after.document.nodes.find(n => n.id === rootGroupId)!;
  const { width: _width, height: _height, ...rootIdentity } = root;
  const { width: _nextWidth, height: _nextHeight, ...nextIdentity } = nextRoot;
  if (!same(rootIdentity, nextIdentity)) return "不能移动、重挂或修改根组结构";
  if (root.parentId !== nextRoot.parentId || root.position.x !== nextRoot.position.x || root.position.y !== nextRoot.position.y || (nextRoot.width ?? 0) < (root.width ?? 0) || (nextRoot.height ?? 0) < (root.height ?? 0) || !same(before.nodeData[rootGroupId], after.nodeData[rootGroupId])) return "根组只允许随内容扩展边界";
  const nextNodes = new Map(after.document.nodes.map(n => [n.id, n]));
  const originalNodes = new Map(before.document.nodes.map(n => [n.id, n]));
  for (const n of after.document.nodes) if (nextIds.has(n.id) && n.id !== rootGroupId && !same(n, originalNodes.get(n.id))) {
    if (!Number.isFinite(n.position.x) || !Number.isFinite(n.position.y) || n.position.x < 0 || n.position.y < 0) return `节点 ${n.id} 必须使用组内有限局部坐标`;
  }
  for (const n of before.document.nodes) {
    if (!ids.has(n.id) && (!same(n, nextNodes.get(n.id)) || !same(before.nodeData[n.id], after.nodeData[n.id]))) return `组外节点 ${n.id} 受到影响`;
    if (ids.has(n.id) && nextNodes.has(n.id) && !nextIds.has(n.id)) return `不能将 ${n.id} 移出根组`;
  }
  const originalIds = new Set(before.document.nodes.map(n => n.id));
  for (const n of after.document.nodes) if (!originalIds.has(n.id) && !nextIds.has(n.id)) return `新节点 ${n.id} 必须归属根组`;
  const nextEdges = new Map(after.document.edges.map(e => [e.id, e]));
  for (const e of before.document.edges) if ((!ids.has(e.source) || !ids.has(e.target)) && !same(e, nextEdges.get(e.id))) return `跨组连接 ${e.id} 受到影响`;
  const originalEdges = new Set(before.document.edges.map(e => e.id));
  for (const e of after.document.edges) if (!originalEdges.has(e.id) && (!nextIds.has(e.source) || !nextIds.has(e.target))) return "连接端点必须均在组内";
  const assets = canvasGroupAssetIds(before, ids);
  const storageKeys = new Set(before.assets.filter(a => assets.has(a.id)).map(a => a.metadata?.storageKey).filter((v): v is string => typeof v === "string"));
  for (const [id, data] of Object.entries(after.nodeData)) if (nextIds.has(id) && !same(data, before.nodeData[id]) && hasExternalCanvasReference(data, nextIds, assets, storageKeys)) return `节点 ${id} 引用了组外输入`;
  if (before.title !== after.title || !same(before.assets, after.assets)) return "组工具不能修改画布标题或全局资产";
  const oldJobs = new Map(before.jobs.map(j => [j.id, j]));
  for (const j of after.jobs) if (!nextIds.has(j.nodeId) && !same(j, oldJobs.get(j.id))) return "组外任务受到影响";
  for (const j of before.jobs) if (!ids.has(j.nodeId) && !after.jobs.some(n => n.id === j.id)) return "组外任务受到影响";
  return null;
}
export function canvasGroupAssetIds(canvas: ServerCanvas, ids: Set<string>): Set<string> {
  const assets = new Set(canvas.assets.filter(a => a.nodeId && ids.has(a.nodeId)).map(a => a.id));
  for (const id of ids) for (const key of ["outputAssetId", "posterAssetId"] as const) {
    const assetId = canvas.nodeData[id]?.[key];
    if (typeof assetId === "string") assets.add(assetId);
  }
  return assets;
}
/** Used at write/run boundaries, including preexisting input mappings with no edge. */
export function hasExternalCanvasReference(value: unknown, ids: Set<string>, assets: Set<string>, storageKeys?: Set<string>): boolean {
  if (Array.isArray(value)) return value.some(v => hasExternalCanvasReference(v, ids, assets, storageKeys));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, v]) => {
    if ((key === "nodeId" || key.endsWith("NodeId")) && typeof v === "string" && !ids.has(v)) return true;
    if ((key === "nodeIds" || key.endsWith("NodeIds")) && Array.isArray(v) && v.some(id => typeof id === "string" && !ids.has(id))) return true;
    if ((key === "assetId" || key.endsWith("AssetId")) && typeof v === "string" && !assets.has(v)) return true;
    if ((key === "assetIds" || key.endsWith("AssetIds")) && Array.isArray(v) && v.some(id => typeof id === "string" && !assets.has(id))) return true;
    if (key === "storageKey" && storageKeys && typeof v === "string" && !storageKeys.has(v)) return true;
    return hasExternalCanvasReference(v, ids, assets, storageKeys);
  });
}
function same(a: unknown, b: unknown) { return stableStringify(a) === stableStringify(b); }
