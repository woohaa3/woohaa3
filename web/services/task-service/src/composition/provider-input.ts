/**
 * Task Service composition：provider 输入构造
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R10）。
 */
import { inferMediaKindFromType, type TaskSubmitRequest } from "@woohaa3/contracts";
import type { MediaClient } from "../clients/media-client.js";
import type { ArkVideoImageAsset, ArkVideoImageAssetInput, ArkVideoImageBinary } from "../providers/ark-types.js";

/**
 * 图片模型的参考输入字段。
 *
 * 有 `field` 时按字段写：`{ "3_image": ["url"], "1x_image": ["url", "url"] }`。ppserver 这类
 * 多字段模型就是靠这个区分「主图」和「参考图」；只发一个 `urls`，服务端拿不到图。
 *
 * 没有 `field` 的输入按新旧分流：
 * - **全部**都没有（旧客户端 / ark、grsai 这种只有一个 `urls` 字段的模型）→ 仍是 `urls: [...]`，
 *   与改动前完全一致；
 * - **只有一部分**没有（两端版本不一致，或某条输入漏了分配）→ 这些 URL 丢弃并记一条告警。
 *   不能塞进 `urls`：多字段模型没有这个字段，多一个未知键会让整单被拒；
 *   也不能悄悄丢：调用方需要知道有几张图没送出去。
 */
function imageReferenceFields(
  inputs: TaskSubmitRequest["inputs"],
  referenceUrls: readonly string[],
  onDrop?: (dropped: number) => void
): Record<string, string[]> {
  const byField = new Map<string, string[]>();
  const fieldless: string[] = [];
  inputs.forEach((input, index) => {
    const url = referenceUrls[index];
    if (!url) return;
    const field = input.field;
    if (!field) {
      fieldless.push(url);
      return;
    }
    const bucket = byField.get(field);
    if (bucket) bucket.push(url);
    else byField.set(field, [url]);
  });
  if (byField.size === 0) {
    return fieldless.length > 0 ? { urls: fieldless } : {};
  }
  if (fieldless.length > 0) onDrop?.(fieldless.length);
  return Object.fromEntries(byField);
}

/**
 * 构造 provider 输入；参考输入由 Task 通过 Media sign 在调用前注入 URL。
 */
export function buildInput(
  request: TaskSubmitRequest,
  referenceUrls: readonly string[] = [],
  onDropFieldless?: (dropped: number) => void
): Record<string, unknown> {
  if (request.modelType === "language") {
    return {
      prompt: [{ role: "user", content: languageContentParts(request, referenceUrls) }],
      ...request.parameters
    };
  }
  if (request.modelType === "image") {
    return {
      prompt: request.prompt,
      ...request.parameters,
      ...imageReferenceFields(request.inputs, referenceUrls, onDropFieldless)
    };
  }
  const groups: Record<string, Array<{ url: string; role: string }>> = {};
  request.inputs.forEach((input, index) => {
    const url = referenceUrls[index];
    if (!url) return;
    // 有 `field` 就按字段写（ppserver 这类多字段模型，如视频的 `3_image` / `1x_image`）。
    // 没有才退回按角色猜字段（ark 的 videoUrls/audioUrls 等既有约定）。
    const field = input.field ?? inputFieldFor(input.mediaKind, input.role);
    (groups[field] ??= []).push({ url, role: input.role });
  });
  return {
    prompt: request.prompt,
    ...request.parameters,
    ...Object.fromEntries(Object.entries(groups).map(([field, refs]) => [field, refs]))
  };
}

/**
 * language 多模态 content parts（任务 6.1）：编译文本在前，媒体按**稳定输入顺序**追加。
 */
function languageContentParts(
  request: TaskSubmitRequest,
  referenceUrls: readonly string[]
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
  request.inputs.forEach((input, index) => {
    const url = referenceUrls[index];
    if (!url) return;
    const mediaKind = input.mediaKind ?? inferMediaKindFromType(input.mediaType);
    if (mediaKind === "image") {
      parts.push({ type: "image_url", image_url: { url } });
      return;
    }
    if (mediaKind === "video") {
      parts.push({ type: "video_url", video_url: { url } });
      return;
    }
    if (mediaKind === "audio") {
      parts.push({ type: "audio_url", audio_url: { url } });
    }
  });
  return parts;
}

/** role/mediaKind → Ark 参考字段名。 */
function inputFieldFor(mediaKind: string | undefined, role: string): "urls" | "videoUrls" | "audioUrls" {
  if (role === "edit_video" || role === "reference_video" || mediaKind === "video") return "videoUrls";
  if (role === "reference_audio" || role === "voice_sample" || mediaKind === "audio") return "audioUrls";
  return "urls";
}

/**
 * 构造交给 provider 的输入。
 */
export async function buildProviderInputForResource(options: {
  request: TaskSubmitRequest;
  referenceUrls: readonly string[];
  providerId: string;
  mediaClient: MediaClient | undefined;
  ensureVideoImageAsset?: (input: ArkVideoImageAssetInput) => Promise<ArkVideoImageAsset>;
  logger?: (event: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const { request, referenceUrls, providerId } = options;
  const onDropFieldless = (dropped: number) =>
    options.logger?.({ event: "reference-fields-dropped", count: dropped });
  if (providerId !== "ark" || request.modelType !== "video") {
    return buildInput(request, referenceUrls, onDropFieldless);
  }
  const imageInputs = request.inputs
    .map((input, index) => ({ input, url: referenceUrls[index] }))
    .filter((entry) => entry.url && isImageInput(entry.input.mediaKind, entry.input.role));
  if (imageInputs.length === 0) return buildInput(request, referenceUrls, onDropFieldless);
  if (!options.ensureVideoImageAsset) {
    options.logger?.({ event: "seedance-image-asset-unconfigured", count: imageInputs.length });
    return buildInput(request, referenceUrls, onDropFieldless);
  }
  const ensure = options.ensureVideoImageAsset;
  const materials = new Map<string, string>();
  for (const { input, url } of imageInputs) {
    const materialized = await ensure({
      reference: { url: url as string, role: input.role },
      binary: await readImageBinary(url as string)
    });
    if (!materialized.uri.startsWith("asset://")) {
      throw new Error("Seedance 图片素材 URI 无效");
    }
    materials.set(url as string, materialized.uri);
  }
  const rewritten = referenceUrls.map((url) => materials.get(url) ?? url);
  return buildInput(request, rewritten, onDropFieldless);
}

function isImageInput(mediaKind: string | undefined, role: string): boolean {
  if (mediaKind === "image") return true;
  if (mediaKind === "video" || mediaKind === "audio") return false;
  return role !== "edit_video" && role !== "reference_video" && role !== "reference_audio" && role !== "voice_sample";
}

async function readImageBinary(url: string): Promise<ArkVideoImageBinary> {
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`Seedance 参考图读取失败：HTTP ${response.status}`);
  const mimeType = (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()) || "image/png";
  if (!mimeType.startsWith("image/")) throw new Error("Seedance 参考素材不是图片");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/", 2)[1] || "png";
  return { bytes, mimeType, fileName: `reference.${extension}` };
}
