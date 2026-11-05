import { createHash } from "node:crypto";
import { applyCanvasCommands, DEFAULT_MODEL_PLACEMENT, normalizeModelDefinition, planCanvasEdit, SHARED_WORLD_VERSION, stableStringify, type CanvasCommand, type CanvasNodeData, type FrozenImageDirectorSource, type GroundAabb, type GroundPoint, type ImageDirectorSceneCandidate, type ImageDirectorSceneReservation } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/room.js";
import { prepareImageDirectorCandidate } from "./image-director-candidate.js";
import { imageDirectorOccupancy } from "./image-director-placement.js";

type CommitInput = { canvasId: string; operationId: string; commandId: string; source: FrozenImageDirectorSource; candidate: ImageDirectorSceneCandidate; reservation?: ImageDirectorSceneReservation; delta: GroundPoint; bounds: GroundAabb };
const failure = (code: string, message: string) => ({ ok: false as const, code, message });
const intersects = (a: GroundAabb, b: GroundAabb) => a.min.u <= b.max.u && a.max.u >= b.min.u && a.min.v <= b.max.v && a.max.v >= b.min.v;
export const imageDirectorId = (operationId: string, key: string) => createHash("sha256").update(stableStringify([operationId, key])).digest("hex");
const id = imageDirectorId;

export async function lookupImageDirectorScene(room: CanvasRoom, commandId: string, authorize: () => Promise<boolean>) {
  if (!await authorize()) return failure("read-forbidden", "无权读取该画布");
  const record = await room.lookupCommand(commandId);
  return record?.modelBatch?.imageDirectorScene ? { ok: true as const, receipt: record.modelBatch.imageDirectorScene, revision: record.revision } : failure("receipt-not-found", "未找到提交回执");
}

/** Trusted host entry: caller supplies a frozen plan, never browser-supplied commands. */
export async function commitImageDirectorScene(room: CanvasRoom, input: CommitInput, options: { authorize: () => Promise<boolean>; signal?: AbortSignal }) {
  const hash = createHash("sha256").update(stableStringify(input)).digest("hex");
  const result = await room.submitDerived({ commandId: input.commandId, expectedModelBatchHash: hash, async derive(canvas) {
    if (options.signal?.aborted) return failure("cancelled", "提交已取消");
    if (!input.reservation && !canvas.document.nodes.some(node => node.id === input.source.sourceNodeId && node.type === "image")) return failure("source-missing", "来源图片已删除");
    const prepared = await prepareImageDirectorCandidate(input.candidate, { width: input.source.width, height: input.source.height }, options.signal);
    if (!prepared.ok) return failure("invalid-candidate", prepared.diagnostic);
    const bounds = input.bounds;
    if (![bounds.min.u, bounds.min.v, bounds.max.u, bounds.max.v, input.delta.u, input.delta.v].every(Number.isFinite) || bounds.min.u > bounds.max.u || bounds.min.v > bounds.max.v) return failure("invalid-placement", "放置范围无效");
    const points = [...prepared.value.footprints.map(box => ({ min: { u: box.min.u + input.delta.u, v: box.min.v + input.delta.v }, max: { u: box.max.u + input.delta.u, v: box.max.v + input.delta.v } })), { min: { u: input.candidate.camera.position.u + input.delta.u, v: input.candidate.camera.position.v + input.delta.v }, max: { u: input.candidate.camera.position.u + input.delta.u, v: input.candidate.camera.position.v + input.delta.v } }];
    if (points.some(box => box.min.u < bounds.min.u || box.min.v < bounds.min.v || box.max.u > bounds.max.u || box.max.v > bounds.max.v)) return failure("invalid-placement", "范围未覆盖模型和镜头");
    const occupied = await imageDirectorOccupancy(canvas, options.signal, input.reservation?.nodeId);
    if (occupied.some(box => !box || intersects(bounds, box))) return failure("placement-conflict", "放置范围被占用或占地未知");
    const modelNodeIds = input.candidate.models.map(model => id(input.operationId, `model:${model.key}`));
    const areaNodeId = id(input.operationId, "area"), cameraNodeId = id(input.operationId, "camera");
    const provenance = { operationId: input.operationId, sourceNodeId: input.source.sourceNodeId, assetId: input.source.assetId, contentVersion: input.source.contentVersion };
    if (input.reservation) {
      const current = canvas.nodeData[areaNodeId];
      const area = current?.sceneArea as Record<string, unknown> | undefined;
      const areaNode = canvas.document.nodes.find(node => node.id === areaNodeId);
      if (input.reservation.nodeId !== areaNodeId || !areaNode || areaNode.type !== "scene-area" || areaNode.parentId || (areaNode.position && (areaNode.position.x !== 0 || areaNode.position.y !== 0)) || !area || area.areaId !== input.reservation.areaId || area.scopeVersion !== input.reservation.scopeVersion || stableStringify(area.bounds) !== stableStringify(input.reservation.bounds) || stableStringify(current?.imageDirectorSource) !== stableStringify(provenance) || !["导演区 · 生成中", "导演区 · 生成失败"].includes(String(current?.title))) return failure("reservation-conflict", "生成中的导演区已被修改或删除");
    }
    const commands: CanvasCommand[] = [];
    for (const [index, model] of input.candidate.models.entries()) {
      const definition = normalizeModelDefinition({ modelScript: model.script, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", placement: DEFAULT_MODEL_PLACEMENT });
      if (!definition.ok) return failure("invalid-candidate", definition.reason);
      const transform = { ...model.transform, position: { ...model.transform.position, u: model.transform.position.u + input.delta.u, v: model.transform.position.v + input.delta.v } };
      commands.push({ type: "node.add", node: { id: modelNodeIds[index]!, type: "model3d", position: { x: 0, y: 0 } }, nodeData: { title: model.name, modelScript: definition.value.modelScript, modelScriptLanguage: definition.value.modelScriptLanguage, modelScriptVersion: definition.value.modelScriptVersion, modelContentVersion: definition.value.contentVersion, modelPlacement: definition.value.placement, sharedWorldInstance: { kind: "world-instance", version: SHARED_WORLD_VERSION, instanceId: id(input.operationId, `instance:${model.key}`), transform }, imageDirectorSource: provenance } as unknown as CanvasNodeData });
    }
    const areaData = { title: "导演区", ...(input.reservation && canvas.nodeData[areaNodeId]?.imageDirectorGeneration ? { imageDirectorGeneration: canvas.nodeData[areaNodeId]!.imageDirectorGeneration } : {}), sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: id(input.operationId, "area-id"), scopeVersion: id(input.operationId, "scope-version"), animationOrigin: { u: (bounds.min.u + bounds.max.u) / 2, v: (bounds.min.v + bounds.max.v) / 2 }, bounds }, imageDirectorSource: provenance } as unknown as CanvasNodeData;
    commands.push(input.reservation ? { type: "nodeData.patch", nodeId: areaNodeId, value: areaData } : { type: "node.add", node: { id: areaNodeId, type: "scene-area", position: { x: 0, y: 0 } }, nodeData: areaData });
    commands.push({ type: "node.add", node: { id: cameraNodeId, type: "world-camera", position: { x: 0, y: 0 } }, nodeData: { worldCamera: { kind: "world-camera", version: SHARED_WORLD_VERSION, cameraId: id(input.operationId, "camera-id"), settingsVersion: id(input.operationId, "camera-version"), ...input.candidate.camera, position: { ...input.candidate.camera.position, u: input.candidate.camera.position.u + input.delta.u, v: input.candidate.camera.position.v + input.delta.v }, captureMode: { kind: "static" }, aspect: { width: input.source.width, height: input.source.height }, boundInstanceId: null }, imageDirectorSource: provenance } as unknown as CanvasNodeData });
    const plan = planCanvasEdit(canvas, commands);
    if (!plan.ok) return failure("invalid-edit", plan.reason);
    let historyPlan = plan;
    let historyCommands = commands;
    if (input.reservation) {
      const withoutReservation = applyCanvasCommands(canvas, [{ type: "node.remove", nodeIds: [areaNodeId] }]);
      if (!withoutReservation.ok) return failure("reservation-conflict", withoutReservation.rejection.message);
      historyCommands = commands.map(command => command.type === "nodeData.patch" && command.nodeId === areaNodeId ? { type: "node.add" as const, node: { id: areaNodeId, type: "scene-area", position: { x: 0, y: 0 } }, nodeData: areaData } : command);
      const fullPlan = planCanvasEdit(withoutReservation.canvas, historyCommands);
      if (!fullPlan.ok) return failure("invalid-edit", fullPlan.reason);
      historyPlan = fullPlan;
    }
    const applied = applyCanvasCommands(canvas, commands);
    if (!applied.ok) return failure("invalid-edit", applied.rejection.message);
    for (const command of historyCommands) {
      if (command.type === "node.add" && applied.canvas.nodeData[command.node.id]) historyPlan.inverse.preconditions.push({ kind: "node-data-equals", nodeId: command.node.id, value: applied.canvas.nodeData[command.node.id]! });
    }
    const receipt = { operationId: input.operationId, source: input.source, modelNodeIds, areaNodeId, cameraNodeId, forward: historyPlan.forward, inverse: historyPlan.inverse };
    return { ok: true as const, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: input.canvasId, commandId: input.commandId, actorId: "image-director-scene", baseRevision: canvas.revision, commands }, modelBatch: { submissionHash: hash, nodes: [], imageDirectorScene: receipt } };
  } }, options);
  if (!result.ok) return result;
  const receipt = result.modelBatch?.imageDirectorScene;
  return receipt ? { ok: true as const, receipt, revision: result.revision, duplicate: result.status === "duplicate" } : failure("receipt-unavailable", "提交回执不可用");
}
