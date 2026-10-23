/**
 * ChatGPT 图片/视频 → 片场转换 adapter
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1–2.3 / design D2/D5/D6）。
 *
 * 把**真实媒体内容**（图片原文件；视频原生或服务端抽取的有时间戳帧组）与内置转换指令送入
 * 已授权的 Codex 执行器，产出结构化片场候选。不 import film-set 的私有 service：
 * 能力判定、指令与候选 schema、媒体读取/抽帧都由 `@woohaa3/contracts` 的公共契约表达，
 * 媒体字节由注入的 `FilmSetConversionMediaReader` 提供。
 */
import type {
  FilmSetConversionAdapterCapabilities,
  FilmSetConversionGenerationInput,
  FilmSetConversionGenerationResult,
  FilmSetConversionGenerator,
  FilmSetConversionMediaReader
} from "@woohaa3/contracts";
import {
  isChatGptReasoningEffort,
  buildFilmSetConversionInstruction,
  filmSetConversionCandidateSchema,
  normalizeFilmSetConversionOutput,
  readFilmSetConversionMediaInput
} from "@woohaa3/contracts";
import type { CodexAdapter, CodexImageAttachment } from "./codex-adapter.js";

/** ChatGPT 视觉转换能力声明（gpt-6.* 视觉模型：真实图片、多图抽帧，非原生视频）。 */
export const CHATGPT_CONVERSION_CAPABILITIES: FilmSetConversionAdapterCapabilities = {
  structuredCandidateOutput: true,
  input: {
    imageInput: true,
    maxImages: 12,
    videoInput: false,
    maxFrames: 12,
    maxDurationSeconds: 0
  }
};

export type ChatGptConversionGeneratorOptions = {
  codex: CodexAdapter;
  /**
   * 执行 owner 解析：
   * - 传字符串：固定 owner（不随请求变化；不静默换账户）；
   * - 传函数：由请求**已解析的 owner**（`input.ownerId`，宿主在 HTTP 边界经提供方 `resolveOwner`
   *   产出）或可信主体 (`input.subject`) 解析 owner；解析失败（返回 null）时明确拒绝，
   *   不静默回退到其它账户。
   */
  ownerId: string | ((input: { subject?: string; ownerId?: string }) => string | null);
  /**
   * 实际模型身份（ChatGPT allowlist 的 slug）解析：
   * - 传字符串：固定模型；
   * - 传函数：按请求已解析的 `input.modelKey` 解析为 slug；返回 null 时明确拒绝（不静默换模型）。
   */
  model: string | ((input: { modelKey?: string }) => string | null);
  reasoningEffort?: import("@woohaa3/contracts").ChatGptReasoningEffort;
  capabilities?: FilmSetConversionAdapterCapabilities;
  /** 稳定媒体读取/抽帧；由宿主注入（Media 能力）。 */
  media: FilmSetConversionMediaReader;
  logger?: (event: Record<string, unknown>) => void;
};

/**
 * 构造 ChatGPT 转换生成器。
 *
 * 图片：读取真实原文件作为单个 `local_image` 附件。
 * 视频：支持原生视频的模型直接传原件；否则按所选范围在服务端抽取有时间戳的帧组（覆盖首尾与
 * 主要变化），作为一组 `local_image` 附件，并把时间戳写入指令。超出模型帧预算时**拒绝**
 * （要求用户重选范围），绝不静默只处理前几秒。
 */
export function createChatGptFilmSetConversionGenerator(
  options: ChatGptConversionGeneratorOptions
): FilmSetConversionGenerator {
  const log = options.logger ?? (() => undefined);
  const capabilities = options.capabilities ?? CHATGPT_CONVERSION_CAPABILITIES;

  return async (input: FilmSetConversionGenerationInput): Promise<FilmSetConversionGenerationResult> => {
    const { frozenSource, media } = input;
    if (!media) return { ok: false, code: "source-not-ready", message: "缺少稳定媒体引用" };
    const ownerId = typeof options.ownerId === "string"
      ? options.ownerId
      : options.ownerId({ ...(input.subject ? { subject: input.subject } : {}), ...(input.ownerId ? { ownerId: input.ownerId } : {}) });
    if (!ownerId) {
      return { ok: false, code: "model-not-configured", message: "缺少可信账户授权，无法调用 ChatGPT 转换", retryable: false };
    }
    const model = typeof options.model === "string"
      ? options.model
      : options.model({ ...(input.modelKey ? { modelKey: input.modelKey } : {}) });
    if (!model) {
      return { ok: false, code: "model-not-configured", message: "所选转换模型不可用，请重新选择", retryable: false };
    }
    input.onStep?.("prepare-source");

    let attachments: CodexImageAttachment[];
    let nativeVideo = false;
    let frameTimestamps: number[] | undefined;
    try {
      const mediaInput = await readFilmSetConversionMediaInput({
        media: options.media,
        sourceKind: frozenSource.kind,
        storageKey: media.storageKey,
        contentType: media.contentType,
        // 转片场记录冻结了 canvasId：源素材属于该画布，远端画布的字节只在托管存储里，
        // 不带作用域就会去主存储找而失败。读的是同一张画布，不是伪造的 id。
        canvasId: input.canvasId,
        ...(frozenSource.range ? { range: frozenSource.range } : {}),
        ...(frozenSource.durationSeconds !== undefined ? { durationSeconds: frozenSource.durationSeconds } : {}),
        capabilities
      });
      attachments = mediaInput.attachments.map((attachment) => ({
        fileName: attachment.fileName,
        bytes: attachment.bytes,
        mimeType: attachment.contentType
      }));
      nativeVideo = mediaInput.nativeVideo;
      frameTimestamps = mediaInput.frameTimestamps;
      if (mediaInput.note) log({ event: "chatgpt-conversion-media", note: mediaInput.note });
    } catch (error) {
      return {
        ok: false,
        code: "budget-exceeded",
        message: error instanceof Error ? error.message : "媒体读取失败",
        retryable: false
      };
    }

    input.onStep?.("analyze-content");
    const instruction = buildFilmSetConversionInstruction({
      sourceKind: frozenSource.kind,
      title: input.title,
      ...(input.settings.instruction ? { instruction: input.settings.instruction } : {}),
      ...(frozenSource.range ? { range: frozenSource.range } : {}),
      ...(frozenSource.durationSeconds !== undefined ? { durationSeconds: frozenSource.durationSeconds } : {}),
      ...(frameTimestamps ? { frameTimestamps } : {}),
      nativeVideo,
      ...(input.repair ? { repair: input.repair } : {}),
      ...(input.frozenSource.assetId ? { assetIds: [input.frozenSource.assetId] } : {})
    });

    input.onStep?.("generate-film-set");
    const reasoningEffort = input.settings.reasoningEffort ?? options.reasoningEffort;
    if (reasoningEffort && !isChatGptReasoningEffort(reasoningEffort)) return {
      ok: false, code: "malformed-request", message: "当前授权模型不支持此思考强度"
    };
    let finalResponse: string;
    try {
      const result = await options.codex.run({
        ownerId,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        prompt: instruction,
        images: attachments,
        outputSchema: filmSetConversionCandidateSchema(),
        signal: input.signal
      });
      finalResponse = result.finalResponse;
      input.emit?.({ type: "message", role: "assistant", content: finalResponse, delivery: "replace", streamId: input.requestId });
    } catch (error) {
      if (input.signal.aborted) return { ok: false, code: "cancelled", message: "转换已取消" };
      return {
        ok: false,
        code: "generation-failed",
        message: error instanceof Error ? error.message : "上游转换失败",
        retryable: true
      };
    }
    if (input.signal.aborted) return { ok: false, code: "cancelled", message: "转换已取消" };

    const parsed = parseJsonCandidate(finalResponse);
    if (!parsed.ok) return { ok: false, code: "candidate-invalid", message: parsed.message };
    const candidate = normalizeFilmSetConversionOutput(parsed.value);
    return { ok: true, candidate };
  };
}

/** 解析结构化候选 JSON（允许 ```json 围栏）。 */
function parseJsonCandidate(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "推理未返回候选内容" };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  const payload = fenced ? fenced[1]! : trimmed;
  try {
    return { ok: true, value: JSON.parse(payload) as unknown };
  } catch {
    return { ok: false, message: "推理返回不是合法 JSON，无法作为片场候选" };
  }
}
