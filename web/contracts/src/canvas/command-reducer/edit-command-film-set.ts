import { convertShotReferenceConsumers } from "./film-set-clip-commands.js";
/**
 * 命令 reducer 的**片场对象类型化受保护编辑**（`edit.apply` 扩展）
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 3.1–3.2 / design D6）。
 *
 * 自 `command-reducer/edit-command.ts` 拆出以保持文件体积守卫。对象 transform/delete/restore
 * 用稳定 itemId / clipId 定位，复用共享 item/binding 解码与内容校验，绝不整体回写客户端数组。
 * 条件匹配与操作应用均为纯函数；写入仍经 `patchNodeData` 走 canonical 归一化与资产校验。
 */
import type { EditOperation, EditPrecondition } from "../edit-command.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import type { CanvasNodeData } from "../domain/index.js";
import {
  applyFilmSetItemEditRemove,
  applyFilmSetItemEditRestore,
  applyFilmSetItemEditTransform,
  captureItemBindingClosure,
  filmSetClipExists,
  filmSetItemBindingEditHash,
  filmSetItemBindingHashOf,
  filmSetItemEditHash
} from "../film-set-item-edit.js";
import { applyFilmSetClipEditRemove, applyFilmSetClipEditSet, filmSetClipStateHash } from "../film-set-clip-edit.js";
import { patchNodeData } from "./node-commands.js";
import { canonicalFilmSetFields, filmSetAnimationsOf, LEGACY_FILM_SET_ANIMATION_FIELDS, LEGACY_FILM_SET_TOP_MODEL_FIELDS } from "../film-set-clip-view.js";
import { animationSnapshotHash } from "../animation-snapshot.js";
import { shotPreviewNodeId } from "../film-set-shot-preview.js";
import { shotReferenceOwnershipOf } from "../film-set-shot-reference.js";
import { isShotPreviewNode } from "../domain/core/shot-preview-node.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";

/** 片场对象相关条件种类（用于 edit-command 主分发）。 */
const FILM_SET_PRECONDITION_KINDS: readonly EditPrecondition["kind"][] = [
  "film-set-item-state",
  "film-set-item-missing",
  "film-set-clip-present",
  "film-set-item-binding",
  "film-set-item-binding-closure",
  "film-set-clip-state",
  "film-set-shot-preview-state"
];

export function isFilmSetPrecondition(kind: EditPrecondition["kind"]): boolean {
  return FILM_SET_PRECONDITION_KINDS.includes(kind);
}

/** 片场对象/镜头操作子集（供主分发做类型收窄）。 */
export type FilmSetEditOperation = Extract<EditOperation, { kind: `film-set-item-${string}` | `film-set-clip-${string}` }>;

export function isFilmSetOperation(operation: EditOperation): operation is FilmSetEditOperation {
  return operation.kind.startsWith("film-set-item-") || operation.kind.startsWith("film-set-clip-");
}

/** 读取节点片场数据；非片场业务 / 非法返回 null（调用方给出稳定原因）。 */
function animationOf(work: WorkingState, nodeId: string): FilmSetNodeData | null {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  if (!isFilmSetNode(node?.type, work.nodeData[nodeId])) return null;
  const decoded = decodeFilmSetNodeData(work.nodeData[nodeId]);
  return decoded.ok ? decoded.value : null;
}

/** 评估片场对象前置条件；返回非 null 表示整批拒绝。 */
export function evaluateFilmSetPrecondition(
  work: WorkingState,
  condition: EditPrecondition
): CommandApplyResult | null {
  switch (condition.kind) {
    case "film-set-item-state": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      const expected = condition.contentHash;
      const item = animation.filmSetContent.items.find((entry) => entry.id === condition.itemId);
      if (!item || filmSetItemEditHash(item) !== expected) {
        return reject("edit-precondition-failed", `片场对象 ${condition.itemId} 已被并发修改，无法执行`);
      }
      return null;
    }
    case "film-set-item-missing": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      if (animation.filmSetContent.items.some((entry) => entry.id === condition.itemId)) {
        return reject("edit-precondition-failed", `片场对象 ${condition.itemId} 已存在，无法恢复`);
      }
      return null;
    }
    case "film-set-clip-present": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      if (!filmSetClipExists(animation, condition.clipId)) {
        return reject("edit-precondition-failed", `片段 ${condition.clipId} 已不存在，无法恢复对象绑定`);
      }
      return null;
    }
    case "film-set-item-binding": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      if (filmSetItemBindingHashOf(animation, condition.clipId, condition.itemId) !== condition.bindingHash) {
        return reject("edit-precondition-failed", `对象 ${condition.itemId} 在片段 ${condition.clipId} 的绑定已变化，无法执行`);
      }
      return null;
    }
    case "film-set-item-binding-closure": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      const actual = captureItemBindingClosure(animation, condition.itemId)
        .map((entry) => ({ clipId: entry.clipId, bindingHash: filmSetItemBindingEditHash(entry.binding) }))
        .sort((left, right) => left.clipId.localeCompare(right.clipId));
      const expected = [...condition.bindings].sort((left, right) => left.clipId.localeCompare(right.clipId));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        return reject("edit-precondition-failed", `对象 ${condition.itemId} 的动作绑定集合已变化，无法安全删除`);
      }
      return null;
    }
    case "film-set-clip-state": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      if (filmSetClipStateHash(animation, condition.clipId) !== condition.clipHash) {
        return reject("edit-precondition-failed", `拍摄镜头 ${condition.clipId} 的定义已被并发修改，无法执行`);
      }
      return null;
    }
    case "film-set-shot-preview-state": {
      if (!shotPreviewBelongsTo(work, condition.previewNodeId, condition.filmSetNodeId, condition.clipId)) {
        return reject("edit-precondition-failed", `拍摄镜头预览 ${condition.previewNodeId} 已变化或归属不符`);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * 应用片场对象操作（transform / remove / restore），经 `patchNodeData` 走 canonical
 * 归一化与资产/来源校验，保持整批原子。
 */
export function applyFilmSetOperation(work: WorkingState, operation: EditOperation): CommandApplyResult {
  if (operation.kind === "film-set-item-set") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation || !animation.filmSetContent.items.some(item => item.id === operation.item.id)) return reject("edit-operation-invalid", "被替换的片场对象不存在");
    return patchNodeData(work, operation.nodeId, fromAnimation({ ...animation,
      filmSetContent: { ...animation.filmSetContent, items: animation.filmSetContent.items.map(item => item.id === operation.item.id ? operation.item : item) } }));
  }
  if (operation.kind === "film-set-item-transform") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation) return reject("edit-operation-invalid", `片场 ${operation.nodeId} 不存在或内容非法`);
    const result = applyFilmSetItemEditTransform({
      animation,
      itemId: operation.itemId,
      localTransform: operation.localTransform,
      ...(operation.expectedLocalTransform ? { expectedLocalTransform: operation.expectedLocalTransform } : {})
    });
    if (!result.ok) return reject("edit-operation-invalid", result.reason);
    if (!result.changed) return OK;
    return patchNodeData(work, operation.nodeId, fromAnimation(result.value));
  }
  if (operation.kind === "film-set-item-remove") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation) return reject("edit-operation-invalid", `片场 ${operation.nodeId} 不存在或内容非法`);
    const result = applyFilmSetItemEditRemove({ animation, itemId: operation.itemId });
    if (!result.ok) return reject("edit-operation-invalid", result.reason);
    return patchNodeData(work, operation.nodeId, fromAnimation(result.value));
  }
  if (operation.kind === "film-set-item-restore") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation) return reject("edit-operation-invalid", `片场 ${operation.nodeId} 不存在或内容非法`);
    const result = applyFilmSetItemEditRestore({
      animation,
      item: operation.item,
      orderAnchor: operation.orderAnchor,
      bindings: operation.bindings
    });
    if (!result.ok) return reject("edit-operation-invalid", result.reason);
    return patchNodeData(work, operation.nodeId, fromAnimation(result.value));
  }
  if (operation.kind === "film-set-clip-set") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation) return reject("edit-operation-invalid", `片场 ${operation.nodeId} 不存在或内容非法`);
    const result = applyFilmSetClipEditSet({ animation, clip: operation.clip, defaultClipId: operation.defaultClipId });
    if (!result.ok) return reject("edit-operation-invalid", result.reason);
    if (!result.changed) return OK;
    const previous = filmSetAnimationsOf(animation).clips.find(clip => clip.id === operation.clip.id);
    if (previous && previous.kind !== operation.clip.kind) {
      const converted = convertShotReferenceConsumers(work, operation.nodeId, operation.clip.id, operation.clip.kind);
      if (!converted.ok) return converted;
    }
    return writeFilmSetAnimation(work, operation.nodeId, result.value);
  }
  if (operation.kind === "film-set-clip-remove") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation) return reject("edit-operation-invalid", `片场 ${operation.nodeId} 不存在或内容非法`);
    const result = applyFilmSetClipEditRemove({ animation, clipId: operation.clipId, defaultClipId: operation.defaultClipId });
    if (!result.ok) return reject("edit-operation-invalid", result.reason);
    if (!result.changed) return OK;
    return writeFilmSetAnimation(work, operation.nodeId, result.value);
  }
  return reject("edit-operation-invalid", `不支持的对象操作`);
}

/** 预览节点是否存在、类型正确、归属与派生 ID 完全匹配（并发布局/归属前置条件）。 */
function shotPreviewBelongsTo(work: WorkingState, previewNodeId: string, filmSetNodeId: string, clipId: string): boolean {
  const node = work.nodes.find((entry) => entry.id === previewNodeId);
  if (!node || !isShotPreviewNode(node.type, work.nodeData[previewNodeId])) return false;
  if (previewNodeId !== shotPreviewNodeId(filmSetNodeId, clipId)) return false;
  const ownership = shotReferenceOwnershipOf(work.nodeData[previewNodeId]);
  return ownership?.filmSetNodeId === filmSetNodeId && ownership.clipId === clipId;
}

/**
 * 受保护编辑写回片场 nodeData：复用 canonical flat 字段（items-only + 片段集合），
 * 清除旧顶层动作字段并重算内容身份，保证与 `clipPatch` 写入同一规范形态。
 *
 * 刻意**不**走 `patchNodeData` 的通用合并：`patchNodeData` 会拒绝预览归属，而片场自身
 * 写入必须整份 canonical，避免残留旧字段被严格解码拒绝。
 */
function writeFilmSetAnimation(work: WorkingState, nodeId: string, animation: FilmSetNodeData): CommandApplyResult {
  const next = { ...(work.nodeData[nodeId] ?? {}), ...canonicalFilmSetFields(animation) } as CanvasNodeData;
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete next[field];
  for (const field of LEGACY_FILM_SET_TOP_MODEL_FIELDS) delete next[field];
  next.animationSnapshotHash = animationSnapshotHash(animation);
  work.nodeData[nodeId] = next;
  return OK;
}

/**
 * 把编辑后的动画视图转成 nodeData patch。`patchNodeData` 复用动画 canonical 归一化
 * （重算 identity / 预算 / 媒体资产），因此这里只声明受影响字段。
 *
 * 通过 `canonicalFilmSetFields` 同时升级/保留影片片段集合，避免 schema 1/2 与 3 混写。
 */
function fromAnimation(next: FilmSetNodeData): CanvasNodeData {
  return canonicalFilmSetFields(next) as CanvasNodeData;
}
