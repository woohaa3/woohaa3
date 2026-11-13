import {
  createHighEntropyId, normalizeModelDefinition, humanoidRigForAuthoredScript, decodeSceneAreaData, decodeWorldInstanceData, executeModelScriptVersioned,
  prepareModelResource, transformAabb, directorCharacterScript, somaBodyPresetName, type SomaBodyPresetId, type DirectorCapsulePreset, MODEL_SCRIPT_SCENE_IR_V2_VERSION, type Aabb, type GroundAabb, type ServerCanvas, type WorldTransform,
} from "@woohaa3/contracts";
import type { CanvasEditService } from "../../services/canvas-state/store/canvas-edit-service.js";
import type { CanvasRemoteService } from "../../contract/remote.js";

export { DIRECTOR_CHARACTER_SCRIPTS, type DirectorCharacterKind } from "@woohaa3/contracts";
import { type DirectorCharacterKind } from "@woohaa3/contracts";
const VERSION = "woohaa-model-js-v2";

function localBounds(script: string, version: unknown): Aabb {
  const result = executeModelScriptVersioned(script, version);
  if (!result.ok) throw new Error("角色模型尚未就绪");
  const bounds = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: result.scene.ops }).aabb;
  if (!bounds) throw new Error("无法确认模型范围");
  return bounds;
}
function footprint(aabb: Aabb, transform: WorldTransform): GroundAabb {
  const world = transformAabb({ translation: [transform.position.u, transform.position.v, transform.position.h],
    rotation: [...transform.rotation], scale: [transform.scale, transform.scale, transform.scale] },
  { min: [aabb.min[0], -aabb.max[2], aabb.min[1]], max: [aabb.max[0], -aabb.min[2], aabb.max[1]] });
  return { min: { u: world.min[0], v: world.min[1] }, max: { u: world.max[0], v: world.max[1] } };
}
const overlap = (a: GroundAabb, b: GroundAabb) => a.min.u < b.max.u + 0.08 && a.max.u > b.min.u - 0.08 && a.min.v < b.max.v + 0.08 && a.max.v > b.min.v - 0.08;

/** Center first; then nearest free placement wholly inside the director area. */
export function characterSpawn(bounds: GroundAabb, local: Aabb, occupied: readonly GroundAabb[]) {
  const offsets = { min: { u: local.min[0], v: -local.max[2] }, max: { u: local.max[0], v: -local.min[2] } };
  const minU = bounds.min.u - offsets.min.u, maxU = bounds.max.u - offsets.max.u;
  const minV = bounds.min.v - offsets.min.v, maxV = bounds.max.v - offsets.max.v;
  if (minU > maxU || minV > maxV) throw new Error("导演区内没有足够空间放置角色");
  const center = { u: (bounds.min.u + bounds.max.u) / 2, v: (bounds.min.v + bounds.max.v) / 2 };
  const us = [Math.max(minU, Math.min(maxU, center.u)), minU, maxU];
  const vs = [Math.max(minV, Math.min(maxV, center.v)), minV, maxV];
  for (const obstacle of occupied) {
    us.push(obstacle.min.u - offsets.max.u - 0.081, obstacle.max.u - offsets.min.u + 0.081);
    vs.push(obstacle.min.v - offsets.max.v - 0.081, obstacle.max.v - offsets.min.v + 0.081);
  }
  const candidates = us.flatMap(u => vs.map(v => ({ u, v })))
    .filter(p => p.u >= minU && p.u <= maxU && p.v >= minV && p.v <= maxV)
    .sort((a, b) => Math.hypot(a.u - center.u, a.v - center.v) - Math.hypot(b.u - center.u, b.v - center.v));
  for (const p of candidates) {
    const box = { min: { u: p.u + offsets.min.u, v: p.v + offsets.min.v }, max: { u: p.u + offsets.max.u, v: p.v + offsets.max.v } };
    if (!occupied.some(o => overlap(box, o))) return p;
  }
  throw new Error("导演区内没有空位，请先腾出空间");
}

/** Ordinary user edit: canonical write permission, spatial occupancy gate and shared undo history. */
export async function createDirectorCharacter(input: {
  canvasId: string; nodeId: string; areaId: string; kind: DirectorCharacterKind; bodyPreset?: SomaBodyPresetId; capsulePreset?: DirectorCapsulePreset;
  writable(): boolean; getCanvas(): ServerCanvas | null;
  resources?: ReadonlyMap<string, { aabb: Aabb | null }>;
  remote: Pick<CanvasRemoteService, "prepareSceneArea">; edit: Pick<CanvasEditService, "record">;
}) {
  if (!input.writable()) throw new Error("画布当前只读");
  const prepared = await input.remote.prepareSceneArea({ canvasId: input.canvasId, areaId: input.areaId });
  if (!prepared.ok) throw new Error(prepared.message);
  if (prepared.snapshot.occupancy.state !== "idle") throw new Error("导演区正在使用中，暂时无法创建角色");
  const canvas = input.getCanvas();
  if (!input.writable() || canvas?.id !== input.canvasId) throw new Error("画布当前不可写");
  const area = decodeSceneAreaData(canvas.nodeData[input.nodeId]?.sceneArea);
  if (!area.ok || area.value.areaId !== input.areaId || area.value.scopeVersion !== prepared.snapshot.scope.scopeVersion) throw new Error("导演区已改变，请重试");
  const script = directorCharacterScript(input.kind, input.bodyPreset, input.capsulePreset);
  const resolvedRig = humanoidRigForAuthoredScript(script, undefined, undefined);
  if (!resolvedRig.ok) throw new Error(resolvedRig.message);
  const definition = normalizeModelDefinition({ modelScript: script, modelScriptLanguage: "javascript", modelScriptVersion: VERSION, rig: resolvedRig.rig });
  if (!definition.ok) throw new Error(definition.reason);
  const local = localBounds(script, VERSION);
  const occupied: GroundAabb[] = [];
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id];
    const instance = decodeWorldInstanceData(data?.sharedWorldInstance);
    if (!instance.ok) continue;
    const entry = prepared.snapshot.objects.find(object => object.nodeId === node.id);
    if (entry?.containment === "outside") continue;
    // Unknown geometry cannot be treated as free space.
    const bounds = input.resources?.get(node.id)?.aabb ?? (typeof data?.modelScript === "string" ? localBounds(data.modelScript, data.modelScriptVersion) : null);
    if (!bounds) throw new Error("场景模型范围尚未就绪，请稍后重试");
    occupied.push(footprint(bounds, instance.value.transform));
  }
  const point = characterSpawn(area.value.bounds, local, occupied);
  const id = createHighEntropyId("character");
  const result = await input.edit.record([{ type: "node.add", node: { id, type: "model3d", position: { x: 0, y: 0 } }, nodeData: {
    directorCharacterCreation: { areaId: input.areaId, scopeVersion: area.value.scopeVersion, kind: input.kind, ...(input.bodyPreset ? { bodyPreset: input.bodyPreset } : {}), ...(input.capsulePreset ? { capsulePreset: input.capsulePreset } : {}) },
    title: input.bodyPreset ? somaBodyPresetName(input.bodyPreset) : input.kind === "capsule" ? input.capsulePreset ? "胶囊人 · 2头身" : "胶囊人" : "骨架人", modelScript: definition.value.modelScript, modelScriptLanguage: definition.value.modelScriptLanguage,
    modelScriptVersion: definition.value.modelScriptVersion, modelContentVersion: definition.value.contentVersion,
    modelPlacement: definition.value.placement, ...(definition.value.rig ? { modelRig: definition.value.rig } : {}),
    sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: id,
      transform: { version: "shared-world-v1", position: { ...point, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } },
  } }], input.kind === "capsule" ? "创建胶囊人" : "创建骨架人");
  if (!result.ok) throw new Error(result.reason);
}
