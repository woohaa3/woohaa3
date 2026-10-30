import { readFilmSetGroupMarker, createFilmSetGroupMarker, type FilmSetGroupClip } from "../film-set-group.js";
import { readFilmSetAnimationProjection } from "../film-set-animation-projection.js";
import type { FilmSetClipPatchCommand } from "../film-set-content/command-types.js";
import { resolveFilmSetClip } from "../film-set-clip-view.js";
import { applyFilmSetClipPatch } from "../film-set-clip-ops.js";
import { compileFilmSetClip, filmSetCompiledBudget } from "../film-set-clip-compilation.js";
import type { CanvasNodeData } from "../domain/index.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";
import { shotPreviewNodeId } from "../film-set-shot-preview.js";
import { isShotImageReferenceTargetNode, isShotReferenceTargetNode, shotReferenceRoleForKind } from "../domain/core/shot-reference.js";

export function patchFilmSetClip(work: WorkingState, command: FilmSetClipPatchCommand): CommandApplyResult {
  const node = work.nodes.find(entry => entry.id === command.nodeId);
  const group = node?.type === "group" ? readFilmSetGroupMarker(work.nodeData[command.nodeId]) : null;
  if (!group) return reject("invalid-self-contained-node", "旧片场只读，请先迁移为群组");
  const previous = work.nodeData[command.nodeId] ?? {};
  const projected = readFilmSetAnimationProjection({ document: { nodes: work.nodes }, nodeData: work.nodeData, assets: work.assets }, command.nodeId);
  if (!projected) return reject("invalid-self-contained-node", "片场群组资源无法解析");
  const decoded = { value: projected };
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
  const previousKind = resolveFilmSetClip(decoded.value, targetId)?.clip.kind;
  if (target && previousKind && previousKind !== target.clip.kind) {
    const converted = convertShotReferenceConsumers(work, command.nodeId, targetId, target.clip.kind);
    if (!converted.ok) return converted;
  }
  const marker = createFilmSetGroupMarker(group);
  marker.clips = result.value.clips.map(clip => {
    const cameraId = `camera:${clip.id}`;
    marker.cameras = (marker.cameras ?? []).filter(camera => camera.id !== cameraId);
    marker.cameras.push({ id: cameraId, name: clip.name, ...clip.initialCamera });
    return { id: clip.id, name: clip.name, cameraId, duration: clip.timeline.duration, loop: clip.timeline.loop, cameraMotion: clip.cameraMotion, bindings: clip.bindings, ...(clip.backdrop ? { backdrop: clip.backdrop } : {}) } satisfies FilmSetGroupClip;
  });
  marker.activeClip = result.value.defaultClipId;
  const usedCameras = new Set(marker.clips.map(clip => clip.cameraId));
  marker.cameras = marker.cameras?.filter(camera => usedCameras.has(camera.id));
  work.nodeData[command.nodeId] = { ...previous, filmSetGroup: marker } as CanvasNodeData;
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
