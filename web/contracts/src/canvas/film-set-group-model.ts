/** Disposable geometry projection: sources own their scripts, bindings own placement. */
import { contentKeyForFilmSetGroupSource, prepareFilmSetGroup, readFilmSetGroupMarker } from "./film-set-group.js";
import { composeFilmSetScene, type FilmSetCompositionModel } from "./film-set-composition.js";
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import { decodeModelDefinition } from "./model-definition.js";
import { prepareModelResource } from "./prepared-model.js";
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "./model-script.js";
import type { NodeModelPreparation } from "./node-capabilities.js";

// Geometry execution is cached per source content, independently of group membership.
const sourceExecutions = new Map<string, ReturnType<typeof executeModelScriptVersioned>>();
function executeSource(script: string, version: Parameters<typeof executeModelScriptVersioned>[1]) {
  const key = JSON.stringify([version, script]);
  const cached = sourceExecutions.get(key);
  if (cached) return cached;
  const result = executeModelScriptVersioned(script, version);
  if (sourceExecutions.size >= 128) sourceExecutions.delete(sourceExecutions.keys().next().value!);
  sourceExecutions.set(key, result);
  return result;
}

export const filmSetGroupModelPreparation: NodeModelPreparation = {
  reportsStatus: false,
  executionKey: ({ canvas, data }) => {
    const marker = readFilmSetGroupMarker(data);
    if (!marker) return undefined;
    return JSON.stringify([marker.ground, marker.sceneBindings.map(binding => {
      const source = canvas.nodeData[binding.sourceNodeId];
      return [binding.bindingId, binding.sourceNodeId, binding.kind, binding.contentKey, contentKeyForFilmSetGroupSource(canvas, binding.sourceNodeId), source?.modelScript, source?.modelScriptVersion, source?.modelContentVersion, source?.modelPlacement];
    })]);
  },
  prepare: ({ canvas, node }) => {
    const prepared = prepareFilmSetGroup(canvas, node.id);
    if (!prepared) return { status: "fail:compile:invalid-film-set-group" };
    const models: FilmSetCompositionModel[] = [];
    const failures = prepared.diagnostics.map(diagnostic => `${diagnostic.bindingId}:${diagnostic.code}`);
    for (const binding of prepared.bindings) {
      if (binding.kind !== "model3d") continue;
      const model = decodeModelDefinition(canvas.nodeData[binding.sourceNodeId]);
      if (!model.ok) { failures.push(`${binding.bindingId}:${model.reason}`); continue; }
      const execution = executeSource(model.value.modelScript, model.value.modelScriptVersion);
      if (!execution.ok) { failures.push(`${binding.bindingId}:${execution.code}`); continue; }
      models.push({ itemId: binding.bindingId, ops: execution.scene.ops, placement: model.value.placement, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    }
    const ready = new Set(models.map(model => model.itemId));
    for (const binding of prepared.marker.sceneBindings) {
      const failed = prepared.diagnostics.some(diagnostic => diagnostic.bindingId === binding.bindingId)
        || (binding.kind === "model3d" && !ready.has(binding.bindingId));
      if (!failed) continue;
      models.push({ itemId: binding.bindingId, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
        ops: [{ t: "box", id: "resource-unavailable", parent: null, position: [0, .4, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#c67d42", size: [.8, .8, .8] }] });
    }
    const ground = prepared.marker.ground;
    const composition = composeFilmSetScene({ models, grounds: ground ? [{ itemId: "film-set-ground", localTransform: ground.transform ? { offset: { x: ground.transform.x, y: ground.transform.y, z: ground.transform.z }, scale: ground.transform.scale, yaw: ground.transform.yaw } : { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: ground.width, depth: ground.depth }, ...(ground.color ? { color: ground.color } : {}) }] : [] });
    return { ...(failures.length ? { diagnostic: failures.join("；") } : {}), status: failures.length ? `ok:partial:${failures.join(";")}` : "ok", resource: prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: composition.ops }) };
  }
};
