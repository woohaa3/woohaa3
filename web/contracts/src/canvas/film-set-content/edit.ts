/**
 * 片场受保护编辑的 owner 执行器（change: 2026-10-28-generic-extension-content-ownership，任务 3.4）。
 *
 * 原 `command-reducer/edit-command-film-set.ts` 的业务条件与操作迁到这里：canonical
 * `edit.apply` 不再分派 `film-set-*`，owner 通过 `extension.edit` 携带内部载荷。对象
 * transform/delete/restore 与镜头定义仍按稳定 itemId / clipId 定位，绝不整体回写客户端数组。
 *
 * owner 直接写回片场 canonical 字段（不经过普通 `nodeData.patch`）：旧 composite 片场已只读，
 * 受保护编辑仍需能撤销历史；写入复用与 `clipPatch` 相同的规范形态与内容身份。
 */
import type { CanvasNodeData, ServerCanvas } from "../domain/index.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../film-set-legacy-identity.js";
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
import { convertShotReferenceConsumers } from "../command-reducer/film-set-clip-commands.js";
import { canonicalFilmSetFields, filmSetAnimationsOf, LEGACY_FILM_SET_ANIMATION_FIELDS, LEGACY_FILM_SET_TOP_MODEL_FIELDS } from "../film-set-clip-view.js";
import { animationSnapshotHash } from "../animation-snapshot.js";
import { shotPreviewNodeId } from "../film-set-shot-preview.js";
import { shotReferenceOwnershipOf } from "../film-set-shot-reference.js";
import { isShotPreviewNode } from "../domain/core/shot-preview-node.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "../command-reducer/types.js";
import { toWorkingState } from "../command-reducer/working-state.js";
import type { FilmSetEditOperation, FilmSetEditPayload, FilmSetEditPrecondition } from "./edit-types.js";

/** 读取节点片场数据；非片场业务 / 非法返回 null（调用方给出稳定原因）。 */
function animationOf(work: WorkingState, nodeId: string): FilmSetNodeData | null {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  if (!isFilmSetNode(node?.type, work.nodeData[nodeId])) return null;
  const decoded = decodeFilmSetNodeData(work.nodeData[nodeId]);
  return decoded.ok ? decoded.value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 严格解码 owner 载荷；非法返回 null，内核据此稳定拒绝而不执行任何操作。 */
export function decodeFilmSetEditPayload(value: unknown): FilmSetEditPayload | null {
  if (!isRecord(value) || !Array.isArray(value.operations)) return null;
  if (value.operations.length === 0 || value.operations.length > 256) return null;
  const operations: FilmSetEditOperation[] = [];
  for (const raw of value.operations) {
    if (!isRecord(raw) || !isNonEmptyString(raw.nodeId)) return null;
    switch (raw.kind) {
      case "film-set-item-transform":
        if (!isNonEmptyString(raw.itemId) || !isRecord(raw.localTransform)) return null;
        break;
      case "film-set-item-set":
        if (!isRecord(raw.item) || !isNonEmptyString(raw.item.id)) return null;
        break;
      case "film-set-item-remove":
        if (!isNonEmptyString(raw.itemId)) return null;
        break;
      case "film-set-item-restore":
        if (!isRecord(raw.item) || !isNonEmptyString(raw.item.id) || !isRecord(raw.orderAnchor) || !Array.isArray(raw.bindings)) return null;
        break;
      case "film-set-clip-set":
        if (!isNonEmptyString(raw.clipId) || !isRecord(raw.clip) || raw.clip.id !== raw.clipId) return null;
        if (raw.defaultClipId !== null && !isNonEmptyString(raw.defaultClipId)) return null;
        break;
      case "film-set-clip-remove":
        if (!isNonEmptyString(raw.clipId)) return null;
        if (raw.defaultClipId !== null && !isNonEmptyString(raw.defaultClipId)) return null;
        break;
      default:
        return null;
    }
    operations.push(raw as FilmSetEditOperation);
  }
  return { operations };
}

/** 评估片场前置条件；返回非 null 表示整批拒绝。 */
export function evaluateFilmSetEditPrecondition(
  work: WorkingState,
  condition: FilmSetEditPrecondition
): CommandApplyResult | null {
  switch (condition.kind) {
    case "film-set-item-state": {
      const animation = animationOf(work, condition.nodeId);
      if (!animation) return reject("edit-precondition-failed", `片场 ${condition.nodeId} 不存在或内容非法`);
      const item = animation.filmSetContent.items.find((entry) => entry.id === condition.itemId);
      if (!item || filmSetItemEditHash(item) !== condition.contentHash) {
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

/** 应用片场对象/镜头操作；任一失败整次回滚（工作副本调用方丢弃）。 */
export function applyFilmSetEditOperation(work: WorkingState, operation: FilmSetEditOperation): CommandApplyResult {
  if (operation.kind === "film-set-item-set") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation || !animation.filmSetContent.items.some(item => item.id === operation.item.id)) return reject("edit-operation-invalid", "被替换的片场对象不存在");
    return writeFilmSetAnimation(work, operation.nodeId, { ...animation,
      filmSetContent: { ...animation.filmSetContent, items: animation.filmSetContent.items.map(item => item.id === operation.item.id ? operation.item : item) } });
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
    return writeFilmSetAnimation(work, operation.nodeId, result.value);
  }
  if (operation.kind === "film-set-item-remove") {
    const animation = animationOf(work, operation.nodeId);
    if (!animation) return reject("edit-operation-invalid", `片场 ${operation.nodeId} 不存在或内容非法`);
    const result = applyFilmSetItemEditRemove({ animation, itemId: operation.itemId });
    if (!result.ok) return reject("edit-operation-invalid", result.reason);
    return writeFilmSetAnimation(work, operation.nodeId, result.value);
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
    return writeFilmSetAnimation(work, operation.nodeId, result.value);
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
  return reject("edit-operation-invalid", "不支持的对象操作");
}

/** 预览节点是否存在、类型正确、归属与派生 ID 完全匹配。 */
function shotPreviewBelongsTo(work: WorkingState, previewNodeId: string, filmSetNodeId: string, clipId: string): boolean {
  const node = work.nodes.find((entry) => entry.id === previewNodeId);
  if (!node || !isShotPreviewNode(node.type, work.nodeData[previewNodeId])) return false;
  if (previewNodeId !== shotPreviewNodeId(filmSetNodeId, clipId)) return false;
  const ownership = shotReferenceOwnershipOf(work.nodeData[previewNodeId]);
  return ownership?.filmSetNodeId === filmSetNodeId && ownership.clipId === clipId;
}

/**
 * 受保护编辑写回片场 nodeData：复用 canonical flat 字段，清除旧顶层动作字段并重算内容身份，
 * 保证与 `clipPatch` 写入同一规范形态。
 */
function writeFilmSetAnimation(work: WorkingState, nodeId: string, animation: FilmSetNodeData): CommandApplyResult {
  const next = { ...(work.nodeData[nodeId] ?? {}), ...canonicalFilmSetFields(animation) } as CanvasNodeData;
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete next[field];
  for (const field of LEGACY_FILM_SET_TOP_MODEL_FIELDS) delete next[field];
  next.animationSnapshotHash = animationSnapshotHash(animation);
  work.nodeData[nodeId] = next;
  return OK;
}

/** 把 owner 应用结果写回不可变画布。 */
export function canvasFromWorkingState(canvas: ServerCanvas, work: WorkingState): ServerCanvas {
  return {
    ...canvas,
    title: work.title,
    document: {
      ...canvas.document,
      nodes: work.nodes.map((node) => ({ ...node, data: {} })),
      edges: work.edges
    },
    nodeData: work.nodeData as Record<string, CanvasNodeData>,
    assets: work.assets,
    jobs: work.jobs
  };
}

export function applyFilmSetEditPayload(
  canvas: ServerCanvas,
  payload: FilmSetEditPayload,
  preconditions: readonly unknown[]
): { ok: true; canvas: ServerCanvas } | { ok: false; code: string; reason: string } {
  const work = toWorkingState(canvas);
  for (const raw of preconditions) {
    if (!isRecord(raw) || typeof raw.kind !== "string") return { ok: false, code: "edit-precondition-invalid", reason: "edit-precondition-invalid" };
    const rejection = evaluateFilmSetEditPrecondition(work, raw as FilmSetEditPrecondition);
    if (rejection && !rejection.ok) return { ok: false, code: rejection.rejection.code, reason: rejection.rejection.message };
  }
  for (const operation of payload.operations) {
    const applied = applyFilmSetEditOperation(work, operation);
    if (!applied.ok) return { ok: false, code: applied.rejection.code, reason: applied.rejection.message };
  }
  return { ok: true, canvas: canvasFromWorkingState(canvas, work) };
}
