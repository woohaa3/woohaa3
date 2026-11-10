/**
 * ChatGPT 生成编排：结构化/工具两种模式的候选提交
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 *
 * 两模式共用同一 request lifecycle（受理/排队/取消/结算在 `generation.ts`），这里只做候选 →
 * 权威端口的提交与 receipt 归一。
 */
import type { ChatGptGenerationReceipt } from "@woohaa3/contracts";
import {
  PREFERRED_MODEL_SCRIPT_VERSION,
  validateSelfContainedModel
} from "@woohaa3/contracts";
import type { ChatGptCanvasPorts } from "../ports.js";
import { overwriteGuard } from "./candidate-codec.js";
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
  const raw = candidate as { modelScript?: unknown; modelScriptVersion?: unknown };
  const hasModel = typeof raw.modelScript === "string" && raw.modelScript.trim() !== "";
  if (!hasModel) return ctx.fail(record, onProgress, "invalid-candidate", "候选未包含模型。", 422);
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
  return ctx.succeed(record, onProgress, { status: "succeeded", requestId: input.requestId, mode: input.mode, canvasId: input.canvasId, nodeId: input.nodeId, commandId });
}
