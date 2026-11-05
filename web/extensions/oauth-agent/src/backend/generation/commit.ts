/**
 * ChatGPT 生成编排：结构化/工具两种模式的候选提交
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 *
 * 两模式共用同一 request lifecycle（受理/排队/取消/结算在 `generation.ts`），这里只做候选 →
 * 权威端口的提交与 receipt 归一。
 */
import type { ChatGptGenerationReceipt, ModelCameraMutation } from "@woohaa3/contracts";
import {
  applyModelCameraMutationBatch,
  decodeModelCameras,
  PREFERRED_MODEL_SCRIPT_VERSION,
  validateSelfContainedModel
} from "@woohaa3/contracts";
import type { ChatGptCanvasPorts } from "../ports.js";
import { normalizeCameraMutations, overwriteGuard } from "./candidate-codec.js";
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
