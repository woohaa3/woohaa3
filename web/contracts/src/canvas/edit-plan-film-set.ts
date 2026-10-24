/**
 * 片场对象净差异规划
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 3.3 / design D6）。
 *
 * 从 `edit-plan.ts` 拆出（业务源码 ≤500 行守卫）。比较 before/after 的每个 `animation3d`
 * 共同节点，捕获 transform / remove / restore 的净差异操作与前置条件；镜头定义/绑定变化由
 * `edit-plan-film-set-clip.ts` 的镜头净差异规划承担，本模块不越界处理。
 */
import type { EditOperation, EditPrecondition } from "./edit-command.js";
import {
  captureItemBindingClosure,
  captureItemOrderAnchor,
  filmSetItemBindingEditHash,
  filmSetItemEditHash
} from "./film-set-item-edit.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { isFilmSetNode } from "./domain/core/composite-asset-identity.js";
import { stableStringify } from "./yjs/commands.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";
import type { FilmSetItem } from "./film-set-content.js";

export type FilmSetItemPlanPiece = {
  ok: true;
  forwardOps: EditOperation[];
  inverseOps: EditOperation[];
  forwardPre: EditPrecondition[];
  inversePre: EditPrecondition[];
};

export type FilmSetItemPlanResult = FilmSetItemPlanPiece | { ok: false; reason: string };

/**
 * 片场对象净差异规划（change: 2026-10-10-improve-film-set-editing-and-inspector，
 * 任务 3.3 / design D6）。
 *
 * 比较 before/after 的每个 animation3d 共同节点：
 * - localTransform 变化 → 前向 transform + 对象内容条件，逆向恢复（仅本地变换字段）；
 * - item 新增 → 前向 restore（`filmSet-item-missing`、片段存在、绑定未占用），逆向 remove；
 * - item 删除 → 捕获完整 item 与全部片段 binding 闭包，前向 remove（含删除前条件），
 *   逆向原子 restore（含 item 缺失条件与 binding 未占用条件）。
 *
 * 只处理受支持的 item transform/delete/restore；镜头定义与绑定变化由镜头净差异规划承担。
 */
export function planFilmSetItemDiffs(
  before: ServerCanvas,
  after: ServerCanvas,
  commonNodes: readonly Woohaa3CanvasSerializedNode[]
): FilmSetItemPlanResult {
  const piece: FilmSetItemPlanPiece = { ok: true, forwardOps: [], inverseOps: [], forwardPre: [], inversePre: [] };
  for (const node of commonNodes) {
    if (!isFilmSetNode(node.type, after.nodeData[node.id] ?? before.nodeData[node.id])) continue;
    const beforeAnimation = animationForPlan(before, node.id);
    const afterAnimation = animationForPlan(after, node.id);
    if (!beforeAnimation || !afterAnimation) continue;
    const beforeItems = beforeAnimation.filmSetContent.items;
    const afterItems = afterAnimation.filmSetContent.items;
    const beforeIds = new Set(beforeItems.map((item) => item.id));
    const afterIds = new Set(afterItems.map((item) => item.id));

    // transform：仅 localTransform 变化的既有对象。
    for (const afterItem of afterItems) {
      if (!beforeIds.has(afterItem.id)) continue;
      const beforeItem = beforeItems.find((entry) => entry.id === afterItem.id)!;
      if (filmSetItemEditHash(beforeItem) === filmSetItemEditHash(afterItem)) continue;
      if (!sameItemExceptTransform(beforeItem, afterItem)) {
        piece.forwardPre.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(beforeItem) });
        piece.forwardPre.push({ kind: "film-set-item-binding-closure", nodeId: node.id, itemId: afterItem.id,
          bindings: captureItemBindingClosure(beforeAnimation, afterItem.id).map(entry => ({ clipId: entry.clipId, bindingHash: filmSetItemBindingEditHash(entry.binding) })) });
        piece.inversePre.push({ kind: "film-set-item-binding-closure", nodeId: node.id, itemId: afterItem.id,
          bindings: captureItemBindingClosure(afterAnimation, afterItem.id).map(entry => ({ clipId: entry.clipId, bindingHash: filmSetItemBindingEditHash(entry.binding) })) });
        piece.forwardOps.push({ kind: "film-set-item-set", nodeId: node.id, item: afterItem });
        piece.inversePre.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(afterItem) });
        piece.inverseOps.push({ kind: "film-set-item-set", nodeId: node.id, item: beforeItem });
        continue;
      }
      piece.forwardPre.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(beforeItem) });
      piece.forwardOps.push({ kind: "film-set-item-transform", nodeId: node.id, itemId: afterItem.id, localTransform: afterItem.localTransform, expectedLocalTransform: beforeItem.localTransform });
      piece.inversePre.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(afterItem) });
      piece.inverseOps.push({ kind: "film-set-item-transform", nodeId: node.id, itemId: afterItem.id, localTransform: beforeItem.localTransform, expectedLocalTransform: afterItem.localTransform });
    }

    // 新增对象（前向 restore / 逆向 remove）。
    for (const afterItem of afterItems) {
      if (beforeIds.has(afterItem.id)) continue;
      const anchor = captureItemOrderAnchor(afterItems, afterItem.id);
      piece.forwardPre.push({ kind: "film-set-item-missing", nodeId: node.id, itemId: afterItem.id });
      for (const restore of captureItemBindingClosure(afterAnimation, afterItem.id)) {
        piece.forwardPre.push({ kind: "film-set-clip-present", nodeId: node.id, clipId: restore.clipId });
        piece.forwardPre.push({
          kind: "film-set-item-binding",
          nodeId: node.id,
          clipId: restore.clipId,
          itemId: afterItem.id,
          bindingHash: filmSetItemBindingEditHash(undefined)
        });
      }
      piece.forwardOps.push({ kind: "film-set-item-restore", nodeId: node.id, item: afterItem, orderAnchor: anchor, bindings: captureItemBindingClosure(afterAnimation, afterItem.id) });
      piece.inversePre.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(afterItem) });
      piece.inverseOps.push({ kind: "film-set-item-remove", nodeId: node.id, itemId: afterItem.id });
    }

    // 删除对象（逆向原子 restore，捕获完整 item 与全部片段 binding 闭包）。
    for (const beforeItem of beforeItems) {
      if (afterIds.has(beforeItem.id)) continue;
      const closure = captureItemBindingClosure(beforeAnimation, beforeItem.id);
      piece.forwardPre.push({ kind: "film-set-item-state", nodeId: node.id, itemId: beforeItem.id, contentHash: filmSetItemEditHash(beforeItem) });
      // 保护删除前未被逆操作捕获的绑定闭包（任一其他片段新增/修改该对象绑定都拒绝）。
      piece.forwardPre.push({
        kind: "film-set-item-binding-closure",
        nodeId: node.id,
        itemId: beforeItem.id,
        bindings: closure.map((restore) => ({ clipId: restore.clipId, bindingHash: filmSetItemBindingEditHash(restore.binding) }))
      });
      piece.forwardOps.push({ kind: "film-set-item-remove", nodeId: node.id, itemId: beforeItem.id });

      piece.inverseOps.push({
        kind: "film-set-item-restore",
        nodeId: node.id,
        item: beforeItem,
        orderAnchor: captureItemOrderAnchor(beforeItems, beforeItem.id),
        bindings: closure
      });
      for (const restore of closure) {
        piece.inversePre.push({ kind: "film-set-clip-present", nodeId: node.id, clipId: restore.clipId });
        piece.inversePre.push({
          kind: "film-set-item-binding",
          nodeId: node.id,
          clipId: restore.clipId,
          itemId: beforeItem.id,
          bindingHash: filmSetItemBindingEditHash(undefined)
        });
      }
    }

    // 其余（默认镜头/镜头定义/绑定）变化由 `edit-plan-film-set-clip.ts` 的镜头净差异规划承担，
    // 这里不再判为「不支持」；本模块只负责对象级 transform/remove/restore。
  }
  return piece;
}

function animationForPlan(canvas: ServerCanvas, nodeId: string): FilmSetNodeData | null {
  const decoded = decodeFilmSetNodeData(canvas.nodeData[nodeId] as CanvasNodeData | undefined);
  return decoded.ok ? decoded.value : null;
}

/** 除 localTransform 外对象内容是否完全一致（含 motion/playback/name/来源）。 */
function sameItemExceptTransform(before: FilmSetItem, after: FilmSetItem): boolean {
  const strip = (item: FilmSetItem) => {
    const { localTransform: _localTransform, ...rest } = item;
    return stableStringify(rest);
  };
  return strip(before) === strip(after);
}
