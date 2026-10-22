/**
 * 命令 reducer 的片场对象命令（`filmSet.itemPatch`）。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。从**最新权威集合**读取对应 item 后按 `op` 原子更新；缺失对象、kind 不匹配、
 * precondition 不成立时整批拒绝，不按数组序号或客户端旧数组覆盖其他项。
 */
import type { CanvasCommand } from "../commands.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { readFilmSetContent } from "../film-set-content.js";
import { canonicalFilmSetFields, LEGACY_FILM_SET_ANIMATION_FIELDS, LEGACY_FILM_SET_TOP_MODEL_FIELDS } from "../film-set-clip-view.js";
import { animationSnapshotHash } from "../animation-snapshot.js";
import {
  applyFilmSetItemTransform,
  deleteFilmSetItem,
  type FilmSetItemOpCode,
  type FilmSetItemOpResult
} from "../film-set-item-ops.js";
import { OK, reject, type CanvasCommandRejectionCode, type CommandApplyResult, type WorkingState } from "./types.js";
import { validateFilmSetContentPatch } from "./node-data-validation.js";
import type { CanvasNodeData } from "../domain/index.js";

function applyFilmSetItemOp(
  content: ReturnType<typeof readFilmSetContent>,
  itemId: string,
  op: import("../commands.js").FilmSetItemPatchOp
): FilmSetItemOpResult {
  switch (op.kind) {
    case "transform":
      return applyFilmSetItemTransform({
        content,
        itemId,
        localTransform: op.localTransform,
        ...(op.expectedLocalTransform ? { expectedLocalTransform: op.expectedLocalTransform } : {})
      });
    case "delete":
      return deleteFilmSetItem({ content, itemId });
  }
}

function filmSetItemOpRejectionCode(code: FilmSetItemOpCode): CanvasCommandRejectionCode {
  switch (code) {
    case "unknown-item":
      return "unknown-node";
    case "kind-mismatch":
    case "invalid-payload":
    case "precondition":
    case "invalid-content":
      return "invalid-self-contained-node";
  }
}

/**
 * 片场对象级权威更新（change: 2026-10-09，任务 2.3；
 * change: 2026-10-11-extract-film-set-extension，D8/D10 —— items-only）。
 *
 * 从**最新权威集合**读取对应 item 后按 `op` 原子更新；缺失对象、kind 不匹配、precondition
 * 不成立时整批拒绝，不按数组序号或客户端旧数组覆盖其他项。对象动作/播放一律走 clip binding，
 * 因此这里只允许 transform / delete。更新后重新派生 `filmSetContent` 与 `animationSnapshotHash`，
 * 并复用媒体资产/来源 precondition 校验。
 */
export function patchFilmSetItem(
  work: WorkingState,
  command: Extract<CanvasCommand, { type: "filmSet.itemPatch" }>
): CommandApplyResult {
  const node = work.nodes.find((entry) => entry.id === command.nodeId);
  if (!node) {
    return reject("unknown-node", `节点 ${command.nodeId} 不存在`);
  }
  if (!isFilmSetNode(node.type, work.nodeData[command.nodeId])) {
    return reject("invalid-self-contained-node", "片场对象操作只支持片场复合资产节点（composite-asset + film-set）");
  }
  const previous = work.nodeData[command.nodeId] ?? {};
  const content = readFilmSetContent(previous);
  const result = applyFilmSetItemOp(content, command.itemId, command.op);
  if (!result.ok) return reject(filmSetItemOpRejectionCode(result.code), result.reason);
  if (!result.changed) return OK;
  const merged = { ...previous, filmSetContent: result.value } as CanvasNodeData;
  if (previous.filmSetAnimations !== undefined) {
    const current = decodeFilmSetNodeData(previous);
    if (!current.ok || !current.value.filmSetAnimations) return reject("invalid-self-contained-node", "片段集合非法");
    merged.filmSetContent = { ...result.value, schemaVersion: 3 };
    merged.filmSetAnimations = {
      ...current.value.filmSetAnimations,
      clips: current.value.filmSetAnimations.clips.map(clip => ({ ...clip, bindings: clip.bindings.filter(binding => result.value.items.some(item => item.id === binding.itemId)) }))
    };
  }
  const decoded = decodeFilmSetNodeData(merged);
  if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
  const importRejection = validateFilmSetContentPatch(work, command.nodeId, previous, decoded.value);
  if (importRejection) return importRejection;
  const next: CanvasNodeData = { ...(work.nodeData[command.nodeId] ?? {}) };
  Object.assign(next, canonicalFilmSetFields(decoded.value));
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete next[field];
  for (const field of LEGACY_FILM_SET_TOP_MODEL_FIELDS) delete next[field];

  const canonical = decodeFilmSetNodeData(next);
  if (!canonical.ok) return reject("invalid-self-contained-node", canonical.reason);
  next.animationSnapshotHash = animationSnapshotHash(canonical.value) as unknown as CanvasNodeData[string];
  work.nodeData[command.nodeId] = next;
  return OK;
}
