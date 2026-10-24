/** Freeze one model snapshot and adapt only the target object's motion bindings. */
import { decodeModel3DNodeData, type FilmSetNodeData } from "./canvas-node-model.js";
import { cloneFilmSetItem, establishItemMotionAdapter, type FilmSetModelItem } from "./film-set-content.js";
import { filmSetItemEditHash } from "./film-set-item-edit.js";
import { filmSetAnimationsOf } from "./film-set-clip-view.js";
import { createModelSnapshot } from "./animation-snapshot.js";
import { modelSourceHash } from "./model-definition.js";
import { executeModelScriptVersioned } from "./model-executor-v2.js";
import { executeMotionScript } from "./motion-executor.js";
import type { CanvasNodeData } from "./domain/index.js";

export function replaceFilmSetObjectModel(input: {
  animation: FilmSetNodeData; itemId: string; sourceNodeId: string; sourceData: CanvasNodeData;
  expectedSourceHash: string; expectedModelHash: string; expectedItemHash: string; importedAt: string;
}): { ok: true; value: FilmSetNodeData; disabledClips: string[] } | { ok: false; reason: string } {
  if (typeof input.sourceNodeId !== "string" || !input.sourceNodeId.trim() ||
      typeof input.importedAt !== "string" || input.importedAt.length > 64 || !Number.isFinite(Date.parse(input.importedAt))) {
    return { ok: false, reason: "模型来源或快照时间无效" };
  }
  const old = input.animation.filmSetContent.items.find(item => item.id === input.itemId);
  if (!old || filmSetItemEditHash(old) !== input.expectedItemHash) return { ok: false, reason: "对象已变化，请重新拖入模型" };
  const source = decodeModel3DNodeData(input.sourceData);
  if (!source.ok || modelSourceHash(source.value.model.modelScript) !== input.expectedSourceHash) return { ok: false, reason: "来源模型已变化或不可用，请重新拖入" };
  const model = createModelSnapshot({ ...source.value.model, revision: source.value.model.contentVersion.revision });
  if (model.contentVersion.contentHash !== input.expectedModelHash) return { ok: false, reason: "来源模型版本已变化，请重新拖入" };
  const execution = executeModelScriptVersioned(source.value.model.modelScript, source.value.model.modelScriptVersion);
  if (!execution.ok) return { ok: false, reason: `来源模型编译失败：${execution.message}` };
  const next = cloneFilmSetItem({ id: old.id, name: old.name, kind: "model", localTransform: old.localTransform,
    model, origin: { sourceNodeId: input.sourceNodeId, importedAt: input.importedAt } }) as FilmSetModelItem;
  const partIds = new Set(["root", "", ...execution.scene.ops.filter(op => op.t !== "material").map(op => op.id)]);
  const disabledClips: string[] = [];
  const animations = filmSetAnimationsOf(input.animation);
  const clips = animations.clips.map(clip => ({ ...clip, bindings: clip.bindings.map(binding => {
    if (binding.itemId !== old.id || !binding.motion?.motionScript.trim()) return binding;
    const motion = executeMotionScript(binding.motion.motionScript, { duration: binding.playback.duration, partIds });
    if (!motion.ok || motion.ir.cameraMotion.length) {
      disabledClips.push(clip.name);
      // An incompatible script is restored by the same protected undo as the model snapshot.
      const { motion: _motion, ...rest } = binding;
      return rest;
    }
    return { ...binding, motion: { ...binding.motion, basedOnModelVersion: establishItemMotionAdapter(next) } };
  }) }));
  return { ok: true, disabledClips, value: { ...input.animation,
    filmSetContent: { ...input.animation.filmSetContent, items: input.animation.filmSetContent.items.map(item => item.id === old.id ? next : item) },
    ...(input.animation.filmSetAnimations ? { filmSetAnimations: { ...animations, clips } } : {}) } };
}
