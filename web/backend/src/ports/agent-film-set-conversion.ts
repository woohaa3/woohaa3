import {
  buildFilmSetConversionInstruction, filmSetConversionCandidateSchema, normalizeFilmSetConversionOutput,
  readFilmSetConversionAssistant, readFilmSetConversionMediaInput,
  type AccessRuntime, type FilmSetConversionProvider, type FilmSetConversionAdapterCapabilities
} from "@woohaa3/contracts";
import { createAgentAdapterRegistry, createAgentConnectionRegistry, type AgentAdapterRegistryHost } from "@woohaa3/application-service";

const capabilities: FilmSetConversionAdapterCapabilities = {
  structuredCandidateOutput: true,
  input: { imageInput: true, maxImages: 12, videoInput: false, maxFrames: 12, maxDurationSeconds: 60 }
};

/** Uses the same active adapters and owner-scoped connections as node authoring. */
export function createAgentFilmSetConversionProvider(options: { host: () => AgentAdapterRegistryHost | null; accessRuntime: AccessRuntime }): FilmSetConversionProvider {
  return {
    providerId: "assistant",
    // The frontend reads the shared owner-scoped assistant directory, not this legacy global list.
    listModels: () => [],
    resolveCapabilities: ({ modelKey }) => readFilmSetConversionAssistant(modelKey) ? { modelKey: modelKey!, capabilities } : null,
    createGenerator: ({ media }) => async input => {
      const fail = (message: string) => ({ ok: false as const, code: "generation-failed" as const, message, retryable: false });
      const selection = readFilmSetConversionAssistant(input.modelKey);
      const host = options.host();
      if (!selection || !host) return fail("所选助手已不可用，请重新选择");
      // subject is resolved by the HTTP authorization boundary; legacy provider owner cookies are irrelevant here.
      const owner = options.accessRuntime.enabled ? input.subject : options.accessRuntime.instance.ownerId;
      if (!owner) return fail("缺少可信用户身份");
      const connections = createAgentConnectionRegistry(host);
      const currentConnection = async () => {
        const c = await connections.getConnection({ owner, connectionId: selection.connection.connectionId });
        const frozen = selection.connection;
        return c && c.adapterId === frozen.adapterId && c.configRevision === frozen.configRevision && c.credentialEpoch === frozen.credentialEpoch ? c : null;
      };
      const connection = await currentConnection();
      if (!connection) return fail("助手连接已更新或无权访问，请重新选择");
      if (!connection.ready) return fail(connection.reason ?? "助手尚未就绪");
      const resolved = createAgentAdapterRegistry(host).resolve(selection.connection.adapterId);
      if (!resolved.ok) return fail(resolved.message);
      const adapter = resolved.handle.adapter;
      const catalog = connection.models.length ? connection.models : (await adapter.models({ owner })).models;
      const model = catalog.find(m => m.id === selection.model);
      if (selection.model && !model) return fail("所选助手模型已不可用，请重新选择");
      if (!selection.model && connection.authMode !== "local-login") return fail("请选择助手模型");
      if (selection.reasoningEffort && !model?.reasoningEfforts?.includes(selection.reasoningEffort)) return fail("所选 Variant 已不可用，请重新选择");
      if (!input.media) return fail("缺少稳定媒体引用");
      try {
        input.onStep?.("prepare-source");
        const source = input.frozenSource;
        const visual = await readFilmSetConversionMediaInput({ media, sourceKind: source.kind, ...input.media, canvasId: input.canvasId,
          ...(source.range ? { range: source.range } : {}), ...(source.durationSeconds !== undefined ? { durationSeconds: source.durationSeconds } : {}), capabilities });
        input.onStep?.("analyze-content");
        const prompt = buildFilmSetConversionInstruction({ sourceKind: source.kind, title: input.title,
          ...(input.settings.instruction ? { instruction: input.settings.instruction } : {}),
          ...(source.range ? { range: source.range } : {}), ...(source.durationSeconds !== undefined ? { durationSeconds: source.durationSeconds } : {}),
          ...(visual.frameTimestamps ? { frameTimestamps: visual.frameTimestamps } : {}), nativeVideo: visual.nativeVideo,
          ...(input.repair ? { repair: input.repair } : {}), ...(source.assetId ? { assetIds: [source.assetId] } : {}) }) +
          `\n只返回符合以下 JSON Schema 的候选 JSON，不执行工具、不写入画布：\n${JSON.stringify(filmSetConversionCandidateSchema())}`;
        if (input.signal.aborted) return { ok: false, code: "cancelled", message: "转换已取消" };
        if (!await currentConnection()) return fail("助手连接已更新，请重新选择");
        input.onStep?.("generate-film-set");
        const outcome = await adapter.run({ owner, canvasId: input.canvasId,
          // Each repair is a fresh, tool-free context; no old native grants or image history.
          conversationId: `film-set-conversion:${input.requestId}:${crypto.randomUUID()}`, turnId: crypto.randomUUID(), requestId: crypto.randomUUID(),
          connection: selection.connection, intent: { action: "discuss", canvasId: input.canvasId, prompt,
            ...(selection.model ? { model: selection.model } : {}), ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) },
          images: visual.attachments, history: [], signal: input.signal, emit: () => {} });
        if (input.signal.aborted) return { ok: false, code: "cancelled", message: "转换已取消" };
        if (!await currentConnection()) return fail("助手连接已更新，本次候选未采用");
        if (outcome.status !== "succeeded") return fail(outcome.error?.message ?? "助手未完成转换");
        const text = outcome.assistantText?.trim() ?? "";
        const payload = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text)?.[1] ?? text;
        try { return { ok: true, candidate: normalizeFilmSetConversionOutput(JSON.parse(payload)) }; }
        catch { return { ok: false, code: "candidate-invalid", message: "助手返回的片场候选不是合法 JSON" }; }
      } catch (error) {
        if (input.signal.aborted) return { ok: false, code: "cancelled", message: "转换已取消" };
        return fail(error instanceof Error ? error.message : "助手转换失败");
      }
    }
  };
}
