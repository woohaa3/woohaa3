import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFilmSetConversionInstruction, filmSetConversionCandidateSchema, normalizeFilmSetConversionOutput,
  readFilmSetConversionMediaInput, type AgentConversationAdapter, type AgentImageInput,
  type FilmSetConversionAdapterCapabilities, type FilmSetConversionProvider } from "@woohaa3/contracts";

/**
 * 候选生成与片场转换声明（change: 2026-10-22-remove-agent-execution-limits，任务 7.1）。
 *
 * `maxImages`/`maxFrames` 在这里表达助手引擎的**真实输入组织能力**（一次请求可承载的图/帧
 * 数量），不是应用可拒绝合法工作的执行额度；400 万像素的应用自造门禁已删除。
 */
export const ASSISTANT_CANDIDATE_CAPABILITIES = { imageInput: true, maxImages: 12 } as const;
export const ASSISTANT_CONVERSION_CAPABILITIES: FilmSetConversionAdapterCapabilities = {
  structuredCandidateOutput: true,
  input: { imageInput: true, maxImages: 12, videoInput: false, maxFrames: 12, maxDurationSeconds: 0 }
};

/** The owner-scoped directory supplies model ids; this provider never publishes other owners' models. */
export function createAssistantFilmSetConversionProvider(adapter: AgentConversationAdapter): FilmSetConversionProvider {
  return {
    providerId: adapter.id, assistantAdapterId: adapter.id, listModels: () => [],
    resolveCapabilities: ({ modelKey, sourceKind }) =>
      sourceKind !== "model3d" && modelKey?.startsWith(`${adapter.id}:`) && modelKey.length > adapter.id.length + 1
        ? { modelKey, capabilities: ASSISTANT_CONVERSION_CAPABILITIES } : null,
    createGenerator: ({ media }) => async input => {
      const owner = input.subject ?? input.ownerId;
      const connection = input.settings.connection;
      if (!owner || !connection || connection.adapterId !== adapter.id || !input.modelKey.startsWith(`${adapter.id}:`)) return { ok: false, code: "unauthorized", message: "请重新选择当前账户的助手连接" };
      if (!input.media) return { ok: false, code: "source-not-ready", message: "来源素材尚未就绪" };
      if (input.signal.aborted) return { ok: false, code: "cancelled", message: "创建已停止" };
      let mediaPrepared = false;
      try {
        input.onStep?.("prepare-source");
        const prepared = await readFilmSetConversionMediaInput({ media, sourceKind: input.frozenSource.kind,
          storageKey: input.media.storageKey, contentType: input.media.contentType, canvasId: input.canvasId,
          ...(input.frozenSource.range ? { range: input.frozenSource.range } : {}),
          ...(input.frozenSource.durationSeconds !== undefined ? { durationSeconds: input.frozenSource.durationSeconds } : {}),
          capabilities: ASSISTANT_CONVERSION_CAPABILITIES });
        if (prepared.attachments.some(image => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.contentType) || image.bytes.length === 0)) return { ok: false, code: "source-not-ready", message: "素材不是可用的图片或视频帧" };
        mediaPrepared = true;
        const prompt = buildFilmSetConversionInstruction({ sourceKind: input.frozenSource.kind, title: input.title,
          ...(input.settings.instruction ? { instruction: input.settings.instruction } : {}),
          ...(input.frozenSource.range ? { range: input.frozenSource.range } : {}),
          ...(input.frozenSource.durationSeconds !== undefined ? { durationSeconds: input.frozenSource.durationSeconds } : {}),
          ...(prepared.frameTimestamps ? { frameTimestamps: prepared.frameTimestamps } : {}), nativeVideo: false,
          ...(input.repair ? { repair: input.repair } : {}), ...(input.frozenSource.assetId ? { assetIds: [input.frozenSource.assetId] } : {}) });
        const outputSchema = filmSetConversionCandidateSchema();
        const identity = createHash("sha256").update(JSON.stringify([owner, connection, input.canvasId, input.requestId])).digest("hex");
        input.onStep?.("generate-film-set");
        const outcome = await adapter.run({ owner, connection, canvasId: input.canvasId,
          conversationId: `candidate-${identity}`, turnId: input.requestId, requestId: input.requestId,
          intent: { action: "discuss", canvasId: input.canvasId, model: input.modelKey.slice(adapter.id.length + 1),
            ...(input.settings.reasoningEffort ? { reasoningEffort: input.settings.reasoningEffort } : {}),
            prompt: `${prompt}\nRequired JSON schema:\n${JSON.stringify(outputSchema)}` },
          candidate: { images: prepared.attachments.map(image => ({ bytes: image.bytes, contentType: image.contentType })), outputSchema },
          history: [], signal: input.signal, emit: event => input.emit?.(event) });
        if (input.signal.aborted || outcome.status === "cancelled") return { ok: false, code: "cancelled", message: "创建已停止" };
        if (outcome.status !== "succeeded") return { ok: false, code: "generation-failed", message: outcome.error?.message ?? "助手生成失败", retryable: true };
        const text = (outcome.assistantText ?? "").trim();
        const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
        let parsed: unknown;
        try { parsed = JSON.parse(fenced ? fenced[1]! : text); }
        catch { return { ok: false, code: "candidate-invalid", message: "助手未返回合法的片场 JSON，请重试", retryable: true }; }
        return { ok: true, candidate: normalizeFilmSetConversionOutput(parsed), ...(prepared.note ? { note: prepared.note } : {}) };
      } catch (error) {
        return { ok: false, code: input.signal.aborted ? "cancelled" : mediaPrepared ? "generation-failed" : "budget-exceeded", message: error instanceof Error ? error.message : "助手生成失败", retryable: mediaPrepared && !input.signal.aborted };
      }
    }
  };
}

/** Only runtimes requiring local image paths materialize bytes; cleanup covers failure/cancellation. */
export async function withAgentImageFiles<T>(images: readonly AgentImageInput[], run: (files: string[]) => Promise<T>): Promise<T> {
  if (!images.length) return run([]);
  const root = await mkdtemp(path.join(tmpdir(), "woohaa-agent-images-"));
  try {
    const files = await Promise.all(images.map(async (image, index) => {
      const extension = image.contentType === "image/jpeg" ? "jpg" : image.contentType === "image/webp" ? "webp" : image.contentType === "image/gif" ? "gif" : "png";
      const file = path.join(root, `${index}.${extension}`);
      await writeFile(file, image.bytes, { mode: 0o600 });
      return file;
    }));
    return await run(files);
  } finally {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("woohaa-agent-images-")) throw new Error("Invalid temporary image directory");
    await rm(root, { recursive: true, force: true });
  }
}
