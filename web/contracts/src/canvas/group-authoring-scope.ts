/**
 * 2D 组创作作用域（group scope）纯规则。
 *
 * 旧的「普通组」容器用 `parentId` 树表达归属，随 `f510576d`（移除普通组与片场）一起删除。
 * 新画布的 2D 组是 `workflow-group-2d` 节点，成员存在 `nodeData.workflowGroup2d.memberNodeIds`，
 * 与卡片排布、世界变换、导演区权限完全独立。这里只做纯派生与校验，不写画布、不持有状态：
 *
 * - `canvasGroupMembers`：按当前文档解析根组与成员（成员表是权威，卡片矩形不参与）；
 * - `projectCanvasGroup`：把组投影成一张“看起来是整块画布”的只读视图，供 Agent 图查询与计划编译；
 * - `validateCanvasGroupChange`：命令提交后的整批校验，保证组外零影响；
 * - `hasExternalCanvasReference` / `canvasGroupAssetIds`：组外引用检测。
 */
import type { ServerCanvas } from "./domain/index.js";
import { decodeWorkflowGroupData } from "./creation-scope-codec.js";
import { stableStringify } from "./canvas-script/planner/hash.js";

export type CanvasGroupScope = { canvasId: string; rootGroupId: string; scopeEpoch: number };

/** 组内可被成员表收录的节点：2D 组不嵌套，导演区与共享世界实例没有画布卡片。 */
export function canvasGroupAcceptsMember(canvas: ServerCanvas, nodeId: string): boolean {
  const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
  if (!node) return false;
  if (node.type === "workflow-group-2d" || node.type === "scene-area") return false;
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  return data?.sharedWorldInstance === undefined;
}

/** 根组与其 `memberNodeIds`（未经存在性过滤；数据非法时为 null）。 */
function readGroupMembers(canvas: ServerCanvas, rootGroupId: string): { root: ServerCanvas["document"]["nodes"][number]; members: string[] } | null {
  const root = canvas.document.nodes.find((node) => node.id === rootGroupId && node.type === "workflow-group-2d");
  if (!root) return null;
  const decoded = decodeWorkflowGroupData((canvas.nodeData[rootGroupId] as Record<string, unknown> | undefined)?.workflowGroup2d);
  return decoded.ok ? { root, members: [...decoded.value.memberNodeIds] } : null;
}

/**
 * 组成员身份（含根组自身）。成员关系只来自当前文档的 `memberNodeIds`，绝不从矩形重叠推断。
 *
 * 根组不存在或数据非法时抛错，调用方据此判定授权失效，而不是退化成“整张画布可写”。
 */
export function canvasGroupMembers(canvas: ServerCanvas, rootGroupId: string): Set<string> {
  const read = readGroupMembers(canvas, rootGroupId);
  if (!read) throw new Error("group-target-missing");
  const ids = new Set<string>([rootGroupId]);
  for (const memberId of read.members) {
    // 悬空或已失效的成员引用不算成员；写入口另行拒绝整批计划，不在这里静默扩权。
    if (canvasGroupAcceptsMember(canvas, memberId)) ids.add(memberId);
  }
  return ids;
}

/** 成员表里已失效的引用（节点不存在或不可收录），供诊断与修复。 */
export function canvasGroupDanglingMembers(canvas: ServerCanvas, rootGroupId: string): string[] {
  const read = readGroupMembers(canvas, rootGroupId);
  if (!read) return [];
  return read.members.filter((memberId) => !canvasGroupAcceptsMember(canvas, memberId));
}

export const CANVAS_GROUP_DEFAULT_SIZE = { width: 260, height: 195 } as const;

/**
 * 只读组投影：图查询与计划编译看到的“画布”只包含根组与成员。
 *
 * 根组被投影成顶层节点（去掉 parentId），任务与资产也收敛到组内，Agent 因此无法读到组外的
 * 结构、运行或素材历史。成员位置保持绝对坐标，与界面一致。
 */
export function projectCanvasGroup(canvas: ServerCanvas, rootGroupId: string): ServerCanvas {
  const ids = canvasGroupMembers(canvas, rootGroupId);
  const nodes = canvas.document.nodes
    .filter((node) => ids.has(node.id))
    .map((node) => (node.id === rootGroupId ? { ...node, parentId: undefined } : node));
  const nodeData = Object.fromEntries(Object.entries(canvas.nodeData).filter(([id]) => ids.has(id)));
  const assets = canvasGroupAssetIds(canvas, ids);
  return {
    ...canvas,
    title: String((nodeData[rootGroupId] as { title?: unknown } | undefined)?.title ?? "2D 组"),
    document: {
      ...canvas.document,
      nodes,
      edges: canvas.document.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    },
    nodeData,
    assets: canvas.assets.filter((asset) => assets.has(asset.id)),
    jobs: canvas.jobs.filter((job) => ids.has(job.nodeId))
  };
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** 去掉可变字段后的节点身份（类型、层级等），用于“结构不能被改”的判定。 */
function structureOf(node: ServerCanvas["document"]["nodes"][number]) {
  const { position: _position, width: _width, height: _height, ...rest } = node;
  return rest;
}

/**
 * 校验 reducer 的完整结果（含隐式级联与输入收敛）：组外任何节点、边、任务、资产、标题都不得变化。
 *
 * 根组自身允许改标题、尺寸与成员表（助手需要放大缩小组、组织成员），但类型与身份必须保持。
 * 既有成员可以被整理/移动，也可以在显式改成员表时移出；新节点必须同时进入成员表。
 */
export function validateCanvasGroupChange(before: ServerCanvas, after: ServerCanvas, rootGroupId: string): string | null {
  let ids: Set<string>;
  let nextIds: Set<string>;
  try {
    ids = canvasGroupMembers(before, rootGroupId);
    nextIds = canvasGroupMembers(after, rootGroupId);
  } catch {
    return "不能删除或解散 2D 组";
  }
  const root = before.document.nodes.find((node) => node.id === rootGroupId);
  const nextRoot = after.document.nodes.find((node) => node.id === rootGroupId);
  if (!root || !nextRoot || nextRoot.type !== root.type) return "不能改变 2D 组的身份或类型";
  if (!same(structureOf(root), structureOf(nextRoot))) return "不能修改 2D 组的身份字段";
  const { workflowGroup2d: oldGroup, ...oldRest } = (before.nodeData[rootGroupId] ?? {}) as Record<string, unknown>;
  // 成员表允许变，但必须仍是合法的 2D 组数据（`canvasGroupMembers(after)` 已校验）；其余根组数据不可动。
  void oldGroup;
  const { workflowGroup2d: _nextGroup, title: nextTitle, ...nextRest } = (after.nodeData[rootGroupId] ?? {}) as Record<string, unknown>;
  const { title: _oldTitle, ...oldRestWithoutTitle } = oldRest;
  void nextTitle;
  if (!same(oldRestWithoutTitle, nextRest)) return "根组只允许修改标题与成员表";

  const afterNodes = new Map(after.document.nodes.map((node) => [node.id, node]));
  for (const node of before.document.nodes) {
    if (node.id === rootGroupId) continue;
    const next = afterNodes.get(node.id);
    const inBefore = ids.has(node.id);
    if (!next) {
      if (!inBefore) return `组外节点 ${node.id} 受到影响`;
      continue;
    }
    if (!inBefore) {
      // 组外既有节点：结构、位置、数据都不能被组工具改动。
      if (!same(node, next) || !same(before.nodeData[node.id], after.nodeData[node.id])) return `组外节点 ${node.id} 受到影响`;
      continue;
    }
    // 组内既有成员：允许被整理/移动，但不允许被改成别的结构（type/parentId）。
    if (!same(structureOf(node), structureOf(next))) return `组成员 ${node.id} 的结构不能被修改`;
  }
  const beforeIds = new Set(before.document.nodes.map((node) => node.id));
  for (const node of after.document.nodes) {
    if (beforeIds.has(node.id)) continue;
    if (!nextIds.has(node.id)) return `新节点 ${node.id} 必须在 2D 组内`;
    if (!canvasGroupAcceptsMember(after, node.id)) return `新节点 ${node.id} 不能是组、导演区或共享世界实例`;
  }

  const nextEdges = new Map(after.document.edges.map((edge) => [edge.id, edge]));
  for (const edge of before.document.edges) {
    const inside = ids.has(edge.source) && ids.has(edge.target);
    if (!inside && !same(edge, nextEdges.get(edge.id))) return `组外连接 ${edge.id} 受到影响`;
  }
  const beforeEdgeIds = new Set(before.document.edges.map((edge) => edge.id));
  for (const edge of after.document.edges) {
    if (beforeEdgeIds.has(edge.id)) continue;
    if (!nextIds.has(edge.source) || !nextIds.has(edge.target)) return "连接端点必须均在 2D 组内";
  }

  if (before.title !== after.title) return "组工具不能修改画布标题";
  const assets = canvasGroupAssetIds(before, ids);
  const nextAssets = canvasGroupAssetIds(after, nextIds);
  if (!same(before.assets.filter((asset) => assets.has(asset.id)), after.assets.filter((asset) => nextAssets.has(asset.id)))) {
    return "组工具不能修改组内资产";
  }
  if (!same(before.assets.filter((asset) => !assets.has(asset.id)), after.assets.filter((asset) => !nextAssets.has(asset.id)))) {
    return "组工具不能修改组外资产";
  }
  const oldJobs = new Map(before.jobs.map((job) => [job.id, job]));
  for (const job of after.jobs) {
    if (!nextIds.has(job.nodeId) && !same(job, oldJobs.get(job.id))) return "组外任务受到影响";
  }
  for (const job of before.jobs) {
    if (!ids.has(job.nodeId) && !after.jobs.some((next) => next.id === job.id)) return "组外任务受到影响";
  }
  return null;
}

/** 组内资产身份：成员产生的资产与成员数据里直接引用的资产。 */
export function canvasGroupAssetIds(canvas: ServerCanvas, ids: Set<string>): Set<string> {
  const assets = new Set(canvas.assets.filter((asset) => asset.nodeId && ids.has(asset.nodeId)).map((asset) => asset.id));
  for (const id of ids) {
    const data = canvas.nodeData[id] as Record<string, unknown> | undefined;
    for (const key of ["outputAssetId", "posterAssetId"] as const) {
      const assetId = data?.[key];
      if (typeof assetId === "string") assets.add(assetId);
    }
  }
  return assets;
}

/** 写/运行边界的组外引用检测（含没有连线但保留了上游映射的输入）。 */
export function hasExternalCanvasReference(
  value: unknown,
  ids: Set<string>,
  assets: Set<string>,
  storageKeys?: Set<string>
): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasExternalCanvasReference(entry, ids, assets, storageKeys));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => {
    if ((key === "nodeId" || key.endsWith("NodeId")) && typeof entry === "string" && !ids.has(entry)) return true;
    if ((key === "nodeIds" || key.endsWith("NodeIds")) && Array.isArray(entry) && entry.some((id) => typeof id === "string" && !ids.has(id))) return true;
    if ((key === "assetId" || key.endsWith("AssetId")) && typeof entry === "string" && !assets.has(entry)) return true;
    if ((key === "assetIds" || key.endsWith("AssetIds")) && Array.isArray(entry) && entry.some((id) => typeof id === "string" && !assets.has(id))) return true;
    if (key === "storageKey" && storageKeys && typeof entry === "string" && !storageKeys.has(entry)) return true;
    return hasExternalCanvasReference(entry, ids, assets, storageKeys);
  });
}

/**
 * 生成一次“把节点加入 2D 组”的 `nodeData.patch` 命令。
 *
 * 拖动释放时与位置命令放进同一批次，避免先改成员表再改位置造成两条命令互相抢 revision；
 * 返回 null 表示没有可加入的新成员（已存在、非法或组数据无效）。
 */
export function planGroupMembershipCommand(
  canvas: ServerCanvas,
  groupNodeId: string,
  memberNodeIds: readonly string[],
  scopeVersion: string,
): import("./commands.js").CanvasCommand | null {
  const read = readGroupMembers(canvas, groupNodeId);
  if (!read || !scopeVersion) return null;
  const next = [...read.members];
  for (const memberId of memberNodeIds) {
    if (!canvasGroupAcceptsMember(canvas, memberId)) continue;
    if (!next.includes(memberId)) next.push(memberId);
  }
  if (next.length === read.members.length) return null;
  const raw = (canvas.nodeData[groupNodeId] ?? {}) as Record<string, unknown>;
  return {
    type: "nodeData.patch",
    nodeId: groupNodeId,
    value: {
      ...raw,
      workflowGroup2d: {
        ...(raw.workflowGroup2d as Record<string, unknown>),
        scopeVersion,
        memberNodeIds: next,
      },
    } as import("./domain/index.js").CanvasNodeData,
  };
}
