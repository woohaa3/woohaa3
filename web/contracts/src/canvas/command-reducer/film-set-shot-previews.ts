import { compositeChildMovementContext, followCompositeChildOwner, createCompositeChildNode, removeCompositeChildNodes } from "../composite-children.js";
/**
 * 共享 reducer 内的拍摄镜头预览 reconciliation 与最终不变式
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，D2/D3/D4）。
 *
 * 职责边界：
 * - 只根据**合法源生命周期的净差异**创建/清理预览节点（创建/复制镜头 → 新增预览；删除镜头/
 *   片场 → 级联移除）；源镜头未变化时保留节点 ID、位置、尺寸与 zIndex；
 * - 维护 D4 的 owner 移动闭包：片场绝对位置变化 `d` 时，未显式落位的预览同步加 `d`；
 *   预览与所属片场保持同一 group parent；
 * - 最终不变式：每个当前拍摄镜头恰有一个预览节点、节点身份等于派生 ID、归属在同画布且合法。
 *   违规说明存在绕过保护路径，整批拒绝，**不**把非法状态自动「修复」成合法状态。
 *
 * 纯函数式写回 `WorkingState`；不访问 DOM/Yjs/数据库。创建与源写入处于同一批次与同一提交。
 */
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  SHOT_PREVIEW_SCHEMA_VERSION,
  canonicalShotPreviewFields,
  decodeShotPreviewData,
  isShotPreviewNodeId,
  planShotPreviewLayout,
  shotPreviewCardSize,
  shotPreviewNodeId,
  shotPreviewTargetsOf,
  type ShotPreviewBounds,
  type ShotPreviewTarget
} from "../film-set-shot-preview.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import {
  getWoohaa3CanvasNodeAbsolutePosition,
  readNodeHeight,
  readNodeWidth
} from "../domain/index.js";
import type { CanvasNodeData, Woohaa3CanvasNode } from "../domain/index.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";

/** 批次上下文：批次前权威节点与显式落位的预览集合（供 owner 移动闭包与保护判定）。 */
export type ShotPreviewBatchContext = {
  /** 批次开始前的权威节点集合（用于区分「既有预览」与「本批新增」，以及位移基线）。 */
  beforeNodes: readonly Woohaa3CanvasNode[];
  /** 本批次中显式携带最终绝对落点的预览节点（显式落点优先，不再叠加片场位移）。 */
  explicitPreviewIds: ReadonlySet<string>;
};

/**
 * 源镜头集净差异 reconciliation：创建缺失预览、移除已消失预览，并维护 owner 移动闭包。
 *
 * 返回 `ok:false` 表示存在绕过保护的非法改动（伪造/改归属/独立删除/重复），整批原子拒绝。
 */
export function reconcileShotPreviews(
  work: WorkingState,
  context: ShotPreviewBatchContext
): CommandApplyResult {
  const desired = desiredShotPreviewTargets(work);
  const desiredByNodeId = new Map(desired.map((target) => [target.nodeId, target]));
  const beforePreviewIds = new Set(
    context.beforeNodes.filter((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE).map((node) => node.id)
  );
  const existing = collectExistingShotPreviews(work);

  // 既有预览的身份与归属必须仍然自洽；本批新增的预览必须恰好命中一个派生目标，
  // 否则就是伪造归属/独立创建的绕过路径。
  const seenTargets = new Set<string>();
  for (const entry of existing) {
    const decoded = decodeShotPreviewData(work.nodeData[entry.nodeId]);
    if (!decoded.ok) return reject("invalid-shot-preview", `预览节点 ${entry.nodeId} 的归属非法：${decoded.reason}`);
    const ownership = decoded.value.shotPreview;
    if (entry.nodeId !== shotPreviewNodeId(ownership.filmSetNodeId, ownership.clipId)) {
      return reject("invalid-shot-preview", `预览节点 ${entry.nodeId} 的 ID 与归属不一致`);
    }
    const key = `${ownership.filmSetNodeId}\u0000${ownership.clipId}`;
    if (seenTargets.has(key)) return reject("invalid-shot-preview", "同一拍摄镜头存在重复预览节点");
    seenTargets.add(key);
    if (desiredByNodeId.has(entry.nodeId) || beforePreviewIds.has(entry.nodeId)) continue;
    if (work.nodes.some((node) => node.id === ownership.filmSetNodeId)) {
      // 源片场仍在但已无法派生出该预览目标：不是合法源级联，拒绝而不是静默清理。
      return reject("invalid-shot-preview", `预览节点 ${entry.nodeId} 的源片场状态非法`);
    }
    if (!beforePreviewIds.has(entry.nodeId)) {
      return reject("invalid-shot-preview", `预览节点 ${entry.nodeId} 没有对应的拍摄镜头`);
    }
  }

  const moveRejection = applyShotPreviewMoveClosure(work, context);
  if (moveRejection) return moveRejection;

  // 清理：源镜头已消失或源片场已删除的预览连同 nodeData 一并移除；同时移除从这些预览拉出的
  // 镜头参考边（否则留下指向不存在来源的悬空边）。
  const removalIds = new Set(existing.filter((entry) => !desiredByNodeId.has(entry.nodeId)).map((entry) => entry.nodeId));
  removeCompositeChildNodes(work, removalIds);

  // 创建：按源镜头顺序补齐缺失预览（同一批次内原子创建，重试不增加副本）。
  const present = new Set(work.nodes.filter((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE).map((node) => node.id));
  const missing = desired.filter(target => !present.has(target.nodeId));
  const occupied: ShotPreviewBounds[] = missing.length ? work.nodes.map((node) => nodeBounds(work, node)) : [];
  for (const target of missing) {
    const source = work.nodes.find((node) => node.id === target.filmSetNodeId);
    if (!source) return reject("invalid-shot-preview", `拍摄镜头预览缺少源片场 ${target.filmSetNodeId}`);
    const placement = planShotPreviewLayout({
      filmSetBounds: nodeBounds(work, source),
      sizes: [shotPreviewCardSize(target.aspect)],
      occupied
    })[0]!;
    work.nodes.push(createCompositeChildNode({ nodes: work.nodes, owner: source, id: target.nodeId, type: FILM_SET_SHOT_PREVIEW_NODE_TYPE, bounds: placement }));
    work.nodeData[target.nodeId] = canonicalShotPreviewFields({
      shotPreview: {
        schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION,
        filmSetNodeId: target.filmSetNodeId,
        clipId: target.clipId
      }
    }) as CanvasNodeData;
    occupied.push({ x: placement.x, y: placement.y, width: placement.width, height: placement.height });
    present.add(target.nodeId);
  }

  return validateShotPreviewInvariants(work);
}

/**
 * 最终不变式：镜头 ↔ 预览一一对应、身份一致、源存在且同画布、parent 与源一致。
 *
 * 只判定，不修复；违规即说明存在绕过保护的路径，整批拒绝。
 */
export function validateShotPreviewInvariants(work: WorkingState): CommandApplyResult {
  const desired = desiredShotPreviewTargets(work);
  const desiredIds = new Set(desired.map((target) => target.nodeId));
  const previewNodes = work.nodes.filter((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE);
  const actualIds = new Set(previewNodes.map((node) => node.id));

  for (const target of desired) {
    if (!actualIds.has(target.nodeId)) {
      return reject("invalid-shot-preview", `拍摄镜头 ${target.clipId} 缺少预览节点`);
    }
  }
  for (const node of previewNodes) {
    if (!desiredIds.has(node.id)) {
      return reject("invalid-shot-preview", `预览节点 ${node.id} 没有对应的拍摄镜头`);
    }
    if (!isShotPreviewNodeId(node.id)) {
      return reject("invalid-shot-preview", `预览节点 ${node.id} 的身份形态非法`);
    }
    const decoded = decodeShotPreviewData(work.nodeData[node.id]);
    if (!decoded.ok) return reject("invalid-shot-preview", `预览节点 ${node.id} 的归属非法：${decoded.reason}`);
    const ownership = decoded.value.shotPreview;
    const source = work.nodes.find((entry) => entry.id === ownership.filmSetNodeId);
    if (!source || !isFilmSetNode(source.type, work.nodeData[source.id])) {
      return reject("invalid-shot-preview", `预览节点 ${node.id} 的源片场 ${ownership.filmSetNodeId} 不存在`);
    }
    if (node.id !== shotPreviewNodeId(source.id, ownership.clipId)) {
      return reject("invalid-shot-preview", `预览节点 ${node.id} 的 ID 与归属不一致`);
    }
    if ((node.parentId ?? null) !== (source.parentId ?? null)) {
      return reject("invalid-shot-preview", `预览节点 ${node.id} 必须与所属片场保持同一分组`);
    }
  }
  return OK;
}

/** 当前画布应存在的全部预览目标（按源片场与镜头顺序，纯派生）。 */
export function desiredShotPreviewTargets(work: WorkingState): ShotPreviewTarget[] {
  const targets: ShotPreviewTarget[] = [];
  for (const node of work.nodes) {
    if (!isFilmSetNode(node.type, work.nodeData[node.id])) continue;
    const decoded = decodeFilmSetNodeData(work.nodeData[node.id]);
    if (!decoded.ok) continue;
    targets.push(...shotPreviewTargetsOf(node.id, decoded.value));
  }
  return targets;
}

/** 当前画布中的既有预览节点（按 canonical type 或归属数据识别，用于差异与保护校验）。 */
export function collectExistingShotPreviews(work: WorkingState): { nodeId: string }[] {
  const ids = new Set<string>();
  for (const node of work.nodes) if (node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE) ids.add(node.id);
  for (const [nodeId, data] of Object.entries(work.nodeData)) {
    if (hasShotPreviewOwnership(data)) ids.add(nodeId);
  }
  return [...ids].map((nodeId) => ({ nodeId }));
}

/** 预览节点是否为受保护节点（canonical type 或归属数据任一命中）。 */
export function isProtectedShotPreview(work: WorkingState, nodeId: string): boolean {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  if (node?.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE) return true;
  return hasShotPreviewOwnership(work.nodeData[nodeId]);
}

/** 是否携带预览归属字段（受保护 nodeData）。 */
export function hasShotPreviewOwnership(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as Record<string, unknown>).shotPreview !== undefined;
}

// ---------------------------------------------------------------------------
// owner 移动闭包（D4）
// ---------------------------------------------------------------------------

/**
 * 片场位置变化 `d` 时，未显式落位的预览同步加 `d`；预览与来源保持同一 parent。
 *
 * 以**批次前的绝对坐标**为基线：移动、对齐、键盘移动、MCP node.update、粘贴与重父化共用同一
 * 规则。显式定位的预览以请求中的最终绝对落点为准，不再叠加 `d`。独立改变预览归属（parent）
 * 明确拒绝，不改写为「自动修复」。
 */
function applyShotPreviewMoveClosure(
  work: WorkingState,
  context: ShotPreviewBatchContext
): CommandApplyResult | null {
  const movement = compositeChildMovementContext(context.beforeNodes, work.nodes);
  for (const node of work.nodes) {
    if (!isFilmSetNode(node.type, work.nodeData[node.id])) continue;
    const decoded = decodeFilmSetNodeData(work.nodeData[node.id]);
    if (!decoded.ok) continue;
    const oldOwner = movement.before.get(node.id);
    for (const target of shotPreviewTargetsOf(node.id, decoded.value)) {
      const child = movement.current.get(target.nodeId);
      if (!child) continue;
      const oldChild = movement.before.get(child.id);
      if (oldChild && !context.explicitPreviewIds.has(child.id) && (oldChild.parentId ?? null) !== (oldOwner?.parentId ?? null)) return reject("invalid-shot-preview", `预览节点 ${child.id} 不能独立改变所属分组`);
      followCompositeChildOwner(child, node, context.beforeNodes, work.nodes, context.explicitPreviewIds.has(child.id), movement);
    }
  }
  return null;
}

function absolutePosition(work: WorkingState, nodeId: string): { x: number; y: number } {
  const byId = new Map(work.nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId);
  return node ? getWoohaa3CanvasNodeAbsolutePosition(node, byId) : { x: 0, y: 0 };
}

/** 节点绝对矩形（含缺省尺寸回退）。 */
function nodeBounds(work: WorkingState, node: Woohaa3CanvasNode): ShotPreviewBounds {
  const position = absolutePosition(work, node.id);
  return { x: position.x, y: position.y, width: readNodeWidth(node), height: readNodeHeight(node) };
}
