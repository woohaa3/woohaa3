import type { CanvasCommand } from "../commands.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { canonicalFilmSetFields, LEGACY_FILM_SET_ANIMATION_FIELDS, LEGACY_FILM_SET_TOP_MODEL_FIELDS, resolveFilmSetClip } from "../film-set-clip-view.js";
import { applyFilmSetClipPatch } from "../film-set-clip-ops.js";
import { compileFilmSetClip, filmSetCompiledBudget } from "../film-set-clip-compilation.js";
import { animationSnapshotHash } from "../animation-snapshot.js";
import type { CanvasNodeData } from "../domain/index.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";

export function patchFilmSetClip(work: WorkingState, command: Extract<CanvasCommand, { type: "filmSet.clipPatch" }>): CommandApplyResult {
  const node = work.nodes.find(entry => entry.id === command.nodeId);
  if (!isFilmSetNode(node?.type, work.nodeData[command.nodeId])) return reject("unknown-node", "片场节点不存在");
  const previous = work.nodeData[command.nodeId] ?? {};
  const decoded = decodeFilmSetNodeData(previous);
  if (!decoded.ok) return reject("invalid-self-contained-node", decoded.reason);
  const result = applyFilmSetClipPatch({ animation: decoded.value, clipId: command.clipId, op: command.op, expectedHash: command.expectedHash });
  if (!result.ok) return reject("invalid-self-contained-node", `${result.code}: ${result.reason}`);
  if (!result.changed) return OK;
  const animation = { ...decoded.value, filmSetAnimations: result.value };
  const budget = filmSetCompiledBudget(animation);
  if (budget) return reject("invalid-self-contained-node", budget);
  const targetId = command.op.kind === "duplicate" ? command.op.newClipId : command.clipId;
  const target = resolveFilmSetClip(animation, targetId);
  // Metadata edits must still be possible when an old saved script is broken.
  if (target && ["create", "duplicate", "replace", "camera-motion", "binding", "timeline"].includes(command.op.kind)) {
    const compiled = compileFilmSetClip(command.nodeId, target);
    if (!compiled.ok || compiled.diagnostics.length) return reject("invalid-self-contained-node", !compiled.ok ? compiled.reason : compiled.diagnostics.join("；"));
  }
  const next = { ...previous, ...canonicalFilmSetFields(animation) } as CanvasNodeData;
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete next[field];
  for (const field of LEGACY_FILM_SET_TOP_MODEL_FIELDS) delete next[field];
  next.animationSnapshotHash = animationSnapshotHash(animation);
  work.nodeData[command.nodeId] = next;
  return OK;
}
