/**
 * 命令 reducer 的片场对象命令（`filmSet.itemPatch`）。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。从**最新权威集合**读取对应 item 后按 `op` 原子更新；缺失对象、kind 不匹配、
 * precondition 不成立时整批拒绝，不按数组序号或客户端旧数组覆盖其他项。
 */
import { replaceFilmSetObjectModel } from "../film-set-object-replacement.js";
import { patchNodeData } from "./node-commands.js";
import type { CanvasCommand } from "../commands.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { FILM_SET_CONTENT_VERSION, readFilmSetContent } from "../film-set-content.js";
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
    case "replace-model":
      return { ok: false, code: "invalid-payload", reason: "模型替换必须从权威来源解析" };
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
 * 因此动作仍由片段维护；这里允许 transform / delete / replace-model。更新后重新派生 `filmSetContent` 与 `animationSnapshotHash`，
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
  if (command.op.kind === "replace-model") {
    const op = command.op;
    const source = work.nodes.find(node => node.id === op.sourceNodeId);
    if (source?.type !== "model3d") return reject("invalid-self-contained-node", "仅普通 3D 模型可以替换对象");
    const animation = decodeFilmSetNodeData(previous);
    if (!animation.ok) return reject("invalid-self-contained-node", animation.reason);
    const result = replaceFilmSetObjectModel({ animation: animation.value, itemId: command.itemId,
      sourceNodeId: op.sourceNodeId, sourceData: work.nodeData[op.sourceNodeId],
      expectedSourceHash: op.expectedSourceHash, expectedModelHash: op.expectedModelHash, expectedItemHash: op.expectedItemHash, importedAt: op.importedAt });
    if (!result.ok) return reject("invalid-self-contained-node", result.reason);
    return patchNodeData(work, command.nodeId, canonicalFilmSetFields(result.value) as CanvasNodeData);
  }
  const content = readFilmSetContent(previous);
  const result = applyFilmSetItemOp(content, command.itemId, command.op);
  if (!result.ok) return reject(filmSetItemOpRejectionCode(result.code), result.reason);
  if (!result.changed) return OK;
  const merged = { ...previous, filmSetContent: result.value } as CanvasNodeData;
  if (previous.filmSetAnimations !== undefined) {
    const current = decodeFilmSetNodeData(previous);
    if (!current.ok || !current.value.filmSetAnimations) return reject("invalid-self-contained-node", "片段集合非法");
    merged.filmSetContent = { ...result.value, schemaVersion: FILM_SET_CONTENT_VERSION };
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
