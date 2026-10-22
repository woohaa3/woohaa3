import { filmSetAnimationsOf, filmSetClipHash } from "@woohaa3/contracts";
/**
 * ChatGPT 生成编排：结构化/工具两种模式的候选提交
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 *
 * 两模式共用同一 request lifecycle（受理/排队/取消/结算在 `generation.ts`），这里只做候选 →
 * 权威端口的提交与 receipt 归一。
 */
import type { FilmSetNodeData, ChatGptGenerationReceipt, ModelCameraMutation } from "@woohaa3/contracts";
import {
  advanceModelRevision,
  applyModelCameraMutationBatch,
  createFilmSetItemMotion,
  createModelSnapshot,
  decodeFilmSetNodeData,
  decodeModelCameras,
  PREFERRED_MODEL_SCRIPT_VERSION,
  validateSelfContainedModel
} from "@woohaa3/contracts";
import type { ChatGptCanvasPorts } from "../ports.js";
import { normalizeCameraMutations, normalizeTimeline, overwriteGuard, toFlatAnimation } from "./candidate-codec.js";
import type { GenerateRequest, GenerationOutcome, GenerationProgress, RequestRecord } from "./types.js";

type ReadOk = Extract<Awaited<ReturnType<ChatGptCanvasPorts["readNode"]>>, { ok: true }>;

export type CommitContext = {
  ports: ChatGptCanvasPorts;
  fail: (record: RequestRecord, onProgress: GenerationProgress | undefined, code: string, message: string, status: number) => GenerationOutcome;
  succeed: (record: RequestRecord, onProgress: GenerationProgress | undefined, receipt: ChatGptGenerationReceipt) => GenerationOutcome;
  partial: (
    record: RequestRecord,
    onProgress: GenerationProgress | undefined,
    input: GenerateRequest,
    applied: string[],
    failed: Array<{ part: string; code: string; message: string }>
  ) => GenerationOutcome;
};

export async function commitModel(
  ctx: CommitContext,
  input: GenerateRequest,
  read: ReadOk,
  candidate: unknown,
  record: RequestRecord,
  onProgress?: GenerationProgress
): Promise<GenerationOutcome> {
  const raw = candidate as { modelScript?: unknown; modelScriptVersion?: unknown; cameraMutations?: unknown };
  const hasModel = typeof raw.modelScript === "string" && raw.modelScript.trim() !== "";
  const cameras = normalizeCameraMutations(raw.cameraMutations);
  if (!hasModel && cameras.length === 0) {
    return ctx.fail(record, onProgress, "invalid-candidate", "候选未包含模型或镜头改动。", 422);
  }
  const applied: string[] = [];
  let commandId = "";
  if (hasModel) {
    const modelScript = raw.modelScript as string;
    const version = typeof raw.modelScriptVersion === "string" ? raw.modelScriptVersion : undefined;
    const validity = validateSelfContainedModel(modelScript, version ?? PREFERRED_MODEL_SCRIPT_VERSION);
    if (!validity.ok) return ctx.fail(record, onProgress, "invalid-candidate", validity.message, 422);
    const shrink = overwriteGuard(input.prompt, read.source, modelScript);
    if (shrink) return ctx.fail(record, onProgress, "destructive-overwrite", shrink, 422);
    const outcome = await ctx.ports.submitModel({
      ownerId: input.ownerId,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      source: modelScript,
      ...(input.expectedContentHash ? { expectedModelContentHash: input.expectedContentHash } : read.modelContentVersion ? { expectedModelContentHash: read.modelContentVersion.contentHash } : {})
    });
    if (!outcome.ok) return ctx.fail(record, onProgress, outcome.code, outcome.message, outcome.code === "stale-source" ? 409 : 422);
    applied.push("模型");
    commandId = outcome.commandId;
  }
  if (cameras.length > 0) {
    const camera = await applyCameras(ctx, input, cameras, record, onProgress);
    if (!camera.ok) {
      if (applied.length === 0) return ctx.fail(record, onProgress, camera.code, camera.message, camera.code === "stale-source" ? 409 : 422);
      return ctx.partial(record, onProgress, input, applied, [{ part: "镜头", code: camera.code, message: camera.message }]);
    }
    applied.push("镜头");
    commandId = camera.commandId;
  }
  return ctx.succeed(record, onProgress, { status: "succeeded", requestId: input.requestId, mode: input.mode, canvasId: input.canvasId, nodeId: input.nodeId, commandId });
}

export async function commitAnimation(
  ctx: CommitContext,
  input: GenerateRequest,
  read: ReadOk,
  candidate: unknown,
  record: RequestRecord,
  onProgress?: GenerationProgress
): Promise<GenerationOutcome> {
  if (!read.animation) return ctx.fail(record, onProgress, "invalid-target", "目标不是可编辑的片场节点。", 409);
  const raw = candidate as { modelScript?: unknown; motionScript?: unknown; timeline?: unknown; cameraMutations?: unknown };
  const hasModel = typeof raw.modelScript === "string" && raw.modelScript.trim() !== "";
  const hasMotion = typeof raw.motionScript === "string" && raw.motionScript.trim() !== "";
  const cameras = normalizeCameraMutations(raw.cameraMutations);
  if (!hasModel && !hasMotion && cameras.length === 0) {
    return ctx.fail(record, onProgress, "invalid-candidate", "候选未包含模型或动作改动。", 422);
  }
  const applied: string[] = [];
  let commandId = "";
  if (hasModel || hasMotion) {
    // items-only（D8/D10）：候选写入目标 model item 的模型与目标 clip 的 binding，绝不写节点级顶层模型。
    const current = read.animation;
    const collection = filmSetAnimationsOf(current);
    const targetClipId = input.clipId ?? collection.defaultClipId;
    const targetClip = targetClipId ? collection.clips.find(clip => clip.id === targetClipId) : undefined;
    const captured = input.itemId ? current.filmSetContent.items.find(item => item.id === input.itemId) : undefined;
    if (input.itemId && !captured) return ctx.fail(record, onProgress, "unknown-item", "生成目标对象不存在", 409);
    const modelItem = captured ?? current.filmSetContent.items.find(item => item.kind === "model");
    let itemId = input.itemId ?? modelItem?.id;
    if (hasMotion && (!targetClip || !itemId)) {
      return ctx.fail(record, onProgress, "invalid-target", "动作生成需要已存在的目标片段与对象。", 409);
    }
    const items = current.filmSetContent.items.map(item => ({ ...item }));
    if (hasModel) {
      const version = modelItem && modelItem.kind === "model" ? modelItem.model.modelScriptVersion : PREFERRED_MODEL_SCRIPT_VERSION;
      const validity = validateSelfContainedModel(raw.modelScript as string, version);
      if (!validity.ok) return ctx.fail(record, onProgress, "invalid-candidate", validity.message, 422);
      const placement = modelItem && modelItem.kind === "model" ? modelItem.model.placement : { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
      const baseModel = createModelSnapshot({ modelScript: raw.modelScript as string, modelScriptVersion: version, placement, revision: 1 });
      const revision = modelItem && modelItem.kind === "model"
        ? advanceModelRevision(modelItem.model.contentVersion, baseModel.contentVersion.contentHash)
        : 1;
      const model = { ...baseModel, contentVersion: { ...baseModel.contentVersion, revision } };
      if (itemId) {
        const index = items.findIndex(item => item.id === itemId);
        if (index >= 0 && items[index]!.kind === "model") items[index] = { ...(items[index] as Extract<typeof items[number], { kind: "model" }>), model };
        else return ctx.fail(record, onProgress, "invalid-target", "目标对象不是可编辑模型。", 409);
      } else {
        itemId = uniqueModelItemId(current.filmSetContent.items.map(item => item.id));
        items.push({ id: itemId, kind: "model", name: "模型", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model });
      }
    }
    const nextClips = collection.clips.map(clip => ({ ...clip, bindings: clip.bindings.map(binding => ({ ...binding })) }));
    if (hasMotion && targetClip) {
      // 静态拍摄镜头不得被动作生成暗中延长/加动作：必须先显式转换类型（D1、spec「非法静态定义」）。
      if (targetClip.kind === "static") {
        return ctx.fail(record, onProgress, "static-shot-requires-conversion", "目标是静态拍摄镜头，不能直接写入对象动作或时长；请先显式把它转换为动态拍摄镜头。", 409);
      }
      const clip = nextClips.find(candidate => candidate.id === targetClip.id)!;
      const item = items.find(entry => entry.id === itemId);
      if (!item || item.kind !== "model") return ctx.fail(record, onProgress, "invalid-target", "动作目标不是模型对象。", 422);
      const motion = createFilmSetItemMotion({ item, motionScript: raw.motionScript as string });
      const existing = clip.bindings.find(binding => binding.itemId === itemId);
      const playback = existing?.playback ?? { startTime: 0, duration: clip.timeline.duration > 0 ? clip.timeline.duration : 4, timeScale: 1, loop: clip.timeline.loop };
      const targetItemId = item.id;
      clip.bindings = [...clip.bindings.filter(binding => binding.itemId !== targetItemId), { itemId: targetItemId, motion, playback }];
      clip.timeline = normalizeTimeline(raw.timeline, clip.timeline);
    }
    const next: FilmSetNodeData = {
      ...current,
      filmSetContent: { schemaVersion: 3, items },
      filmSetAnimations: { ...collection, clips: nextClips }
    };
    const decoded = decodeFilmSetNodeData(toFlatAnimation(next));
    if (!decoded.ok) return ctx.fail(record, onProgress, "invalid-candidate", decoded.reason, 422);
    // 只有真正改动片段的候选（对象动作）才走 clip precondition；纯模型编辑走完整 snapshot precondition。
    const editedClipId = input.clipId ?? (hasMotion ? targetClip?.id : undefined);
    const outcome = await ctx.ports.commitAnimation({
      ownerId: input.ownerId,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      animation: decoded.value,
      ...(editedClipId ? { clipId: editedClipId, expectedClipHash: input.expectedContentHash ?? filmSetClipHash(collection.clips.find(clip => clip.id === editedClipId)!) } : {}),
      ...(!editedClipId ? (input.expectedContentHash ? { expectedSnapshotHash: input.expectedContentHash } : read.snapshotHash ? { expectedSnapshotHash: read.snapshotHash } : {}) : {})
    });
    if (!outcome.ok) return ctx.fail(record, onProgress, outcome.code, outcome.message, outcome.code === "stale-snapshot" || outcome.code === "stale-clip" ? 409 : 422);
    applied.push(hasModel && hasMotion ? "模型与动作" : hasModel ? "模型" : "动作");
    commandId = outcome.commandId;
  }
  if (cameras.length > 0) {
    const camera = await applyCameras(ctx, input, cameras, record, onProgress);
    if (!camera.ok) {
      if (applied.length === 0) return ctx.fail(record, onProgress, camera.code, camera.message, camera.code === "stale-source" ? 409 : 422);
      return ctx.partial(record, onProgress, input, applied, [{ part: "镜头", code: camera.code, message: camera.message }]);
    }
    applied.push("镜头");
    commandId = camera.commandId;
  }
  return ctx.succeed(record, onProgress, { status: "succeeded", requestId: input.requestId, mode: input.mode, canvasId: input.canvasId, nodeId: input.nodeId, commandId });
}

/** 稳定且唯一的模型 itemId（不覆盖既有对象）。 */
function uniqueModelItemId(used: readonly string[]): string {
  const taken = new Set(used);
  if (!taken.has("model")) return "model";
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `model-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `model-${Date.now()}`;
}

export async function commitCameras(
  ctx: CommitContext,
  input: GenerateRequest,
  read: ReadOk,
  candidate: unknown,
  record: RequestRecord,
  onProgress?: GenerationProgress
): Promise<GenerationOutcome> {
  const mutations = normalizeCameraMutations((candidate as { mutations?: unknown })?.mutations);
  if (mutations.length === 0) {
    return ctx.fail(record, onProgress, "invalid-candidate", "候选缺少受限镜头变更列表。", 422);
  }
  if (input.selectedCameraId && mutations.some(m => m.kind === "create" || m.id !== input.selectedCameraId)) return ctx.fail(record, onProgress, "invalid-target", "Candidate exceeds the selected camera scope", 409);
  const current = decodeModelCameras(read.cameras);
  const pre = applyModelCameraMutationBatch(current.ok ? current.value : [], mutations, { nodeId: input.nodeId, seed: input.requestId });
  if (!pre.ok) return ctx.fail(record, onProgress, "invalid-candidate", pre.message, 422);
  const outcome = await ctx.ports.mutateCamerasBatch({
    ownerId: input.ownerId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    requestId: input.requestId,
    mutations
  });
  if (!outcome.ok) return ctx.fail(record, onProgress, outcome.code, outcome.message, outcome.code === "stale-source" ? 409 : 422);
  return ctx.succeed(record, onProgress, { status: "succeeded", requestId: input.requestId, mode: "camera", canvasId: input.canvasId, nodeId: input.nodeId, commandId: outcome.commandId });
}

/**
 * 应用同回合的镜头变更（非原子附加步骤）。
 */
async function applyCameras(
  ctx: CommitContext,
  input: GenerateRequest,
  mutations: ModelCameraMutation[],
  record: RequestRecord,
  onProgress?: GenerationProgress
): Promise<{ ok: true; commandId: string } | { ok: false; code: string; message: string }> {
  onProgress?.({ requestId: record.requestId, stage: "camera-applying" });
  const outcome = await ctx.ports.mutateCamerasBatch({
    ownerId: input.ownerId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    requestId: `${input.requestId}:camera`,
    mutations
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  return { ok: true, commandId: outcome.commandId };
}
