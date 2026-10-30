/**
 * 片场编辑规划（change: 2026-10-28-generic-extension-content-ownership，任务 3.4）。
 *
 * 原 `edit-plan-film-set.ts` / `edit-plan-film-set-clip.ts` 的业务差异规划迁到 owner：
 * - 普通 group 的 `filmSetGroup` 字段与其它可序列化字段按通用净差异记录；
 * - 新增/删除镜头时补齐确定落点的派生预览节点（通用 node-add / 条件）；
 * - 旧 composite 片场的对象与镜头定义变化走 owner 专属载荷，经 `extension.edit` 原子应用。
 *
 * 内核只看到通用结构操作与不透明 owner 段，不再识别 `film-set-*` 条件或操作。
 */
import type { ContentEditPlan, ContentEditPlanner } from "../content-contribution.js";
import type { EditOperation, EditPrecondition } from "../edit-command.js";
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "../domain/index.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "../domain/core/composite-asset-identity.js";
import { isShotPreviewNode } from "../domain/core/shot-preview-node.js";
import { decodeFilmSetNodeData, type FilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../film-set-legacy-identity.js";
import { readFilmSetGroupMarker } from "../film-set-group.js";
import { shotPreviewNodeId } from "../film-set-shot-preview.js";
import { filmSetAnimationsOf } from "../film-set-clip-view.js";
import { absentFilmSetClipHash, filmSetClipStateHash } from "../film-set-clip-edit.js";
import {
  captureItemBindingClosure,
  captureItemOrderAnchor,
  filmSetItemBindingEditHash,
  filmSetItemEditHash
} from "../film-set-item-edit.js";
import { stableStringify } from "../yjs/commands.js";
import { planNodeDataFieldDiffs } from "../edit-plan-node-data.js";
import type { FilmSetAnimationClip } from "../film-set-animations.js";
import type { FilmSetItem } from "./types.js";
import type { FilmSetEditOperation, FilmSetEditPrecondition } from "./edit-types.js";
import { applyFilmSetEditPayload, decodeFilmSetEditPayload } from "./edit.js";

type StepParts = {
  operations: EditOperation[];
  preconditions: EditPrecondition[];
  ownerOperations: FilmSetEditOperation[];
  ownerPreconditions: FilmSetEditPrecondition[];
};

function emptyParts(): StepParts {
  return { operations: [], preconditions: [], ownerOperations: [], ownerPreconditions: [] };
}

function matchesFilmSetNode(type: string, data: unknown): boolean {
  if (type === "group") return readFilmSetGroupMarker(data) !== null;
  if (type === COMPOSITE_ASSET_NODE_TYPE) return isFilmSetNode(type, data);
  return false;
}

function nodeDataBefore(before: ServerCanvas, node: Woohaa3CanvasSerializedNode): CanvasNodeData | undefined {
  return before.nodeData[node.id];
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

/** 旧 composite 对象净差异（transform/remove/restore）：进入 owner 载荷。 */
function planLegacyItemDiffs(
  before: ServerCanvas,
  after: ServerCanvas,
  commonNodes: readonly Woohaa3CanvasSerializedNode[],
  forward: StepParts,
  inverse: StepParts
): void {
  for (const node of commonNodes) {
    if (!isFilmSetNode(node.type, after.nodeData[node.id] ?? nodeDataBefore(before, node))) continue;
    const beforeAnimation = animationForPlan(before, node.id);
    const afterAnimation = animationForPlan(after, node.id);
    if (!beforeAnimation || !afterAnimation) continue;
    const beforeItems = beforeAnimation.filmSetContent.items;
    const afterItems = afterAnimation.filmSetContent.items;
    const beforeIds = new Set(beforeItems.map((item) => item.id));
    const afterIds = new Set(afterItems.map((item) => item.id));

    for (const afterItem of afterItems) {
      if (!beforeIds.has(afterItem.id)) continue;
      const beforeItem = beforeItems.find((entry) => entry.id === afterItem.id)!;
      if (filmSetItemEditHash(beforeItem) === filmSetItemEditHash(afterItem)) continue;
      if (!sameItemExceptTransform(beforeItem, afterItem)) {
        forward.ownerPreconditions.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(beforeItem) });
        forward.ownerPreconditions.push({ kind: "film-set-item-binding-closure", nodeId: node.id, itemId: afterItem.id,
          bindings: captureItemBindingClosure(beforeAnimation, afterItem.id).map(entry => ({ clipId: entry.clipId, bindingHash: filmSetItemBindingEditHash(entry.binding) })) });
        inverse.ownerPreconditions.push({ kind: "film-set-item-binding-closure", nodeId: node.id, itemId: afterItem.id,
          bindings: captureItemBindingClosure(afterAnimation, afterItem.id).map(entry => ({ clipId: entry.clipId, bindingHash: filmSetItemBindingEditHash(entry.binding) })) });
        forward.ownerOperations.push({ kind: "film-set-item-set", nodeId: node.id, item: afterItem });
        inverse.ownerPreconditions.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(afterItem) });
        inverse.ownerOperations.push({ kind: "film-set-item-set", nodeId: node.id, item: beforeItem });
        continue;
      }
      forward.ownerPreconditions.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(beforeItem) });
      forward.ownerOperations.push({ kind: "film-set-item-transform", nodeId: node.id, itemId: afterItem.id, localTransform: afterItem.localTransform, expectedLocalTransform: beforeItem.localTransform });
      inverse.ownerPreconditions.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(afterItem) });
      inverse.ownerOperations.push({ kind: "film-set-item-transform", nodeId: node.id, itemId: afterItem.id, localTransform: beforeItem.localTransform, expectedLocalTransform: afterItem.localTransform });
    }

    for (const afterItem of afterItems) {
      if (beforeIds.has(afterItem.id)) continue;
      const anchor = captureItemOrderAnchor(afterItems, afterItem.id);
      forward.ownerPreconditions.push({ kind: "film-set-item-missing", nodeId: node.id, itemId: afterItem.id });
      for (const restore of captureItemBindingClosure(afterAnimation, afterItem.id)) {
        forward.ownerPreconditions.push({ kind: "film-set-clip-present", nodeId: node.id, clipId: restore.clipId });
        forward.ownerPreconditions.push({
          kind: "film-set-item-binding",
          nodeId: node.id,
          clipId: restore.clipId,
          itemId: afterItem.id,
          bindingHash: filmSetItemBindingEditHash(undefined)
        });
      }
      forward.ownerOperations.push({ kind: "film-set-item-restore", nodeId: node.id, item: afterItem, orderAnchor: anchor, bindings: captureItemBindingClosure(afterAnimation, afterItem.id) });
      inverse.ownerPreconditions.push({ kind: "film-set-item-state", nodeId: node.id, itemId: afterItem.id, contentHash: filmSetItemEditHash(afterItem) });
      inverse.ownerOperations.push({ kind: "film-set-item-remove", nodeId: node.id, itemId: afterItem.id });
    }

    for (const beforeItem of beforeItems) {
      if (afterIds.has(beforeItem.id)) continue;
      const closure = captureItemBindingClosure(beforeAnimation, beforeItem.id);
      forward.ownerPreconditions.push({ kind: "film-set-item-state", nodeId: node.id, itemId: beforeItem.id, contentHash: filmSetItemEditHash(beforeItem) });
      forward.ownerPreconditions.push({
        kind: "film-set-item-binding-closure",
        nodeId: node.id,
        itemId: beforeItem.id,
        bindings: closure.map((restore) => ({ clipId: restore.clipId, bindingHash: filmSetItemBindingEditHash(restore.binding) }))
      });
      forward.ownerOperations.push({ kind: "film-set-item-remove", nodeId: node.id, itemId: beforeItem.id });

      inverse.ownerOperations.push({
        kind: "film-set-item-restore",
        nodeId: node.id,
        item: beforeItem,
        orderAnchor: captureItemOrderAnchor(beforeItems, beforeItem.id),
        bindings: closure
      });
      for (const restore of closure) {
        inverse.ownerPreconditions.push({ kind: "film-set-clip-present", nodeId: node.id, clipId: restore.clipId });
        inverse.ownerPreconditions.push({
          kind: "film-set-item-binding",
          nodeId: node.id,
          clipId: restore.clipId,
          itemId: beforeItem.id,
          bindingHash: filmSetItemBindingEditHash(undefined)
        });
      }
    }
  }
}

/** 旧 composite 镜头定义净差异（定义替换/删除/恢复）：进入 owner 载荷。 */
function planLegacyClipDiffs(
  before: ServerCanvas,
  after: ServerCanvas,
  commonNodes: readonly Woohaa3CanvasSerializedNode[],
  forward: StepParts,
  inverse: StepParts
): void {
  for (const node of commonNodes) {
    if (!isFilmSetNode(node.type, after.nodeData[node.id] ?? nodeDataBefore(before, node))) continue;
    const beforeAnimation = animationForPlan(before, node.id);
    const afterAnimation = animationForPlan(after, node.id);
    if (!beforeAnimation || !afterAnimation) continue;
    const beforeClips = filmSetAnimationsOf(beforeAnimation).clips;
    const afterClips = filmSetAnimationsOf(afterAnimation).clips;
    const beforeById = new Map(beforeClips.map((clip) => [clip.id, clip]));
    const afterById = new Map(afterClips.map((clip) => [clip.id, clip]));
    const sharedItems = new Set(
      beforeAnimation.filmSetContent.items.map((item) => item.id).filter((id) => afterAnimation.filmSetContent.items.some((item) => item.id === id))
    );
    const beforeDefault = filmSetAnimationsOf(beforeAnimation).defaultClipId;
    const afterDefault = filmSetAnimationsOf(afterAnimation).defaultClipId;
    let wroteDefaultForward = false;
    let wroteDefaultInverse = false;

    for (const clip of afterClips) {
      if (beforeById.has(clip.id)) continue;
      forward.ownerOperations.push(clipSetOperation(node.id, clip, afterDefault));
      forward.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: absentFilmSetClipHash() });
      wroteDefaultForward = true;
      inverse.ownerOperations.push({ kind: "film-set-clip-remove", nodeId: node.id, clipId: clip.id, defaultClipId: beforeDefault });
      inverse.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(afterAnimation, clip.id) });
      wroteDefaultInverse = true;
    }

    for (const clip of afterClips) {
      const previous = beforeById.get(clip.id);
      if (!previous) continue;
      if (!clipDefinitionChanged(previous, clip, sharedItems)) continue;
      forward.ownerOperations.push(clipSetOperation(node.id, clip, afterDefault));
      forward.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(beforeAnimation, clip.id) });
      inverse.ownerOperations.push(clipSetOperation(node.id, previous, beforeDefault));
      inverse.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(afterAnimation, clip.id) });
      wroteDefaultForward = true;
      wroteDefaultInverse = true;
    }

    for (const clip of beforeClips) {
      if (afterById.has(clip.id)) continue;
      forward.ownerOperations.push({ kind: "film-set-clip-remove", nodeId: node.id, clipId: clip.id, defaultClipId: afterDefault });
      forward.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(beforeAnimation, clip.id) });
      inverse.ownerOperations.push(clipSetOperation(node.id, clip, beforeDefault));
      inverse.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: absentFilmSetClipHash() });
      wroteDefaultForward = true;
      wroteDefaultInverse = true;
    }

    if (beforeDefault !== afterDefault) {
      if (!wroteDefaultForward && afterDefault) {
        const clip = afterById.get(afterDefault);
        if (clip) {
          forward.ownerOperations.push(clipSetOperation(node.id, clip, afterDefault));
          forward.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(beforeAnimation, clip.id) });
        }
      }
      if (!wroteDefaultInverse && beforeDefault) {
        const clip = beforeById.get(beforeDefault);
        if (clip) {
          inverse.ownerOperations.push(clipSetOperation(node.id, clip, beforeDefault));
          inverse.ownerPreconditions.push({ kind: "film-set-clip-state", nodeId: node.id, clipId: clip.id, clipHash: filmSetClipStateHash(afterAnimation, clip.id) });
        }
      }
    }
  }
}

/** group marker 的派生预览布局：新增/删除镜头时补齐或保护确定落点。 */
function planGroupPreviewDiffs(
  before: ServerCanvas,
  after: ServerCanvas,
  commonNodes: readonly Woohaa3CanvasSerializedNode[],
  forward: StepParts,
  inverse: StepParts
): void {
  for (const node of commonNodes) {
    if (node.type !== "group") continue;
    const beforeGroup = readFilmSetGroupMarker(before.nodeData[node.id]);
    const afterGroup = readFilmSetGroupMarker(after.nodeData[node.id]);
    if (!beforeGroup || !afterGroup) continue;
    const beforeIds = new Set((beforeGroup.clips ?? []).map(clip => clip.id));
    const afterIds = new Set((afterGroup.clips ?? []).map(clip => clip.id));
    for (const id of afterIds) if (!beforeIds.has(id)) pushPreviewAdd(forward.operations, forward.preconditions, after, node.id, id);
    for (const id of beforeIds) if (!afterIds.has(id)) {
      pushPreviewAdd(inverse.operations, inverse.preconditions, before, node.id, id);
      pushPreviewProtection(forward.preconditions, before, node.id, id);
    }
  }
}

/** 捕获某个镜头预览在给定画布中的确定落点并追加 node-add（含前置条件）。 */
function pushPreviewAdd(
  operations: EditOperation[],
  preconditions: EditPrecondition[],
  layoutSource: ServerCanvas,
  filmSetNodeId: string,
  clipId: string
): void {
  const previewId = shotPreviewNodeId(filmSetNodeId, clipId);
  const node = layoutSource.document.nodes.find((entry) => entry.id === previewId && isShotPreviewNode(entry.type, layoutSource.nodeData[entry.id]));
  if (!node) return;
  const nodeData = layoutSource.nodeData[previewId] as CanvasNodeData | undefined;
  operations.push({
    kind: "node-add",
    node: {
      id: node.id,
      type: node.type,
      position: { ...node.position },
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
    },
    ...(nodeData && Object.keys(nodeData).length > 0 ? { nodeData } : {})
  });
  preconditions.push({ kind: "node-missing", nodeId: previewId });
  preconditions.push({ kind: "no-active-run", nodeIds: [previewId] });
}

/** 删除镜头前保护既有预览的布局与归属（通用 nodeData 快照，不进入业务字段名）。 */
function pushPreviewProtection(
  preconditions: EditPrecondition[],
  canvas: ServerCanvas,
  filmSetNodeId: string,
  clipId: string
): void {
  const previewId = shotPreviewNodeId(filmSetNodeId, clipId);
  if (!canvas.document.nodes.some((entry) => entry.id === previewId && isShotPreviewNode(entry.type, canvas.nodeData[entry.id]))) return;
  const data = canvas.nodeData[previewId];
  preconditions.push(data === undefined
    ? { kind: "node-data-equals", nodeId: previewId, present: false }
    : { kind: "node-data-equals", nodeId: previewId, present: true, value: data });
}

function clipSetOperation(nodeId: string, clip: FilmSetAnimationClip, defaultClipId: string | null): FilmSetEditOperation {
  return { kind: "film-set-clip-set", nodeId, clipId: clip.id, clip: cloneClip(clip), defaultClipId };
}

function clipDefinitionChanged(previous: FilmSetAnimationClip, next: FilmSetAnimationClip, sharedItems: ReadonlySet<string>): boolean {
  const view = (clip: FilmSetAnimationClip) =>
    JSON.stringify({ ...stripBindings(clip), bindings: clip.bindings.filter((binding) => sharedItems.has(binding.itemId)) });
  return view(previous) !== view(next);
}

function stripBindings(clip: FilmSetAnimationClip): Omit<FilmSetAnimationClip, "bindings"> {
  const { bindings: _bindings, ...rest } = clip;
  return rest;
}

function cloneClip(clip: FilmSetAnimationClip): FilmSetAnimationClip {
  return JSON.parse(JSON.stringify(clip)) as FilmSetAnimationClip;
}

function toStep(parts: StepParts, extensionId: string, direction: "forward" | "inverse"): ContentEditPlan["forward"] {
  const extensions = parts.ownerOperations.length > 0
    ? [{ extensionId, direction, edit: { operations: parts.ownerOperations }, preconditions: parts.ownerPreconditions }]
    : undefined;
  return {
    preconditions: parts.preconditions,
    operations: parts.operations,
    ...(extensions ? { extensions } : {})
  };
}

function planFilmSetEdit(before: ServerCanvas, after: ServerCanvas): { ok: true; plan: ContentEditPlan } | { ok: false; code: string; reason: string } {
  const forward = emptyParts();
  const inverse = emptyParts();
  const commonNodes = after.document.nodes.filter((node) =>
    before.document.nodes.some((entry) => entry.id === node.id)
    && matchesFilmSetNode(node.type, after.nodeData[node.id] ?? before.nodeData[node.id]));

  // 普通 group：owner 认领的 nodeData 字段净差异仍用 canonical 通用操作表达。
  const groupNodes = commonNodes.filter((node) => node.type === "group");
  const dataPlan = planNodeDataFieldDiffs(before, after, groupNodes);
  forward.operations.push(...dataPlan.forwardOps);
  inverse.operations.push(...dataPlan.inverseOps);
  forward.preconditions.push(...dataPlan.forwardPre);
  inverse.preconditions.push(...dataPlan.inversePre);

  planGroupPreviewDiffs(before, after, commonNodes, forward, inverse);
  planLegacyItemDiffs(before, after, commonNodes, forward, inverse);
  planLegacyClipDiffs(before, after, commonNodes, forward, inverse);

  return {
    ok: true,
    plan: {
      forward: toStep(forward, "film-set", "forward"),
      inverse: toStep(inverse, "film-set", "inverse")
    }
  };
}

export const filmSetEditPlanner: ContentEditPlanner = {
  matchesNode: matchesFilmSetNode,
  plan: planFilmSetEdit,
  apply({ edit, preconditions, canvas }) {
    const payload = decodeFilmSetEditPayload(edit);
    if (!payload) return { ok: false, code: "invalid-film-set-edit", reason: "invalid-film-set-edit" };
    return applyFilmSetEditPayload(canvas, payload, preconditions);
  }
};
