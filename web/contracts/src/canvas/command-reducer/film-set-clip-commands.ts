import type { CanvasCommand } from "../commands.js";
import { decodeFilmSetNodeData } from "../canvas-node-model.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { canonicalFilmSetFields, LEGACY_FILM_SET_ANIMATION_FIELDS, LEGACY_FILM_SET_TOP_MODEL_FIELDS, resolveFilmSetClip } from "../film-set-clip-view.js";
import { applyFilmSetClipPatch } from "../film-set-clip-ops.js";
import { compileFilmSetClip, filmSetCompiledBudget } from "../film-set-clip-compilation.js";
import { animationSnapshotHash } from "../animation-snapshot.js";
import type { CanvasNodeData } from "../domain/index.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";
import { shotPreviewNodeId } from "../film-set-shot-preview.js";
import { isShotImageReferenceTargetNode, isShotReferenceTargetNode, shotReferenceRoleForKind } from "../domain/core/shot-reference.js";

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
  const previousKind = resolveFilmSetClip(decoded.value, targetId)?.clip.kind;
  if (target && previousKind && previousKind !== target.clip.kind) {
    const converted = convertShotReferenceConsumers(work, command.nodeId, targetId, target.clip.kind);
    if (!converted.ok) return converted;
  }
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete next[field];
  for (const field of LEGACY_FILM_SET_TOP_MODEL_FIELDS) delete next[field];
  next.animationSnapshotHash = animationSnapshotHash(animation);
  work.nodeData[command.nodeId] = next;
  return OK;
}

/** Shared by commands and protected undo/replay; reject all incompatible consumers before writes. */
export function convertShotReferenceConsumers(work: WorkingState, nodeId: string, clipId: string, kind: "static" | "dynamic"): CommandApplyResult {
  const previewId = shotPreviewNodeId(nodeId, clipId);
  const edges = work.edges.filter(edge => edge.source === previewId);
  const accepts = kind === "static" ? isShotImageReferenceTargetNode : isShotReferenceTargetNode;
  const blocked = edges.filter(edge => !accepts(work.nodes.find(node => node.id === edge.target)?.type, work.nodeData[edge.target]));
  if (blocked.length) return reject("invalid-connection", `镜头类型转换失败：下游 ${blocked.map(edge => edge.target).join("、")} 不支持${kind === "static" ? "图片" : "视频"}参考，请先断开连接`);
  for (const edge of edges) {
    edge.data = { ...edge.data, kind: kind === "static" ? "shot-image-reference" : "shot-reference", schemaVersion: 1 };
    const data = work.nodeData[edge.target];
    if (data?.inputMapping) work.nodeData[edge.target] = { ...data, inputMapping: data.inputMapping.map(mapping => {
      if (mapping.sourceNodeId !== previewId) return mapping;
      const { sourceAssetIds: _assets, ...rest } = mapping;
      return { ...rest, role: shotReferenceRoleForKind(kind) };
    }) } as CanvasNodeData;
  }
  return OK;
}
