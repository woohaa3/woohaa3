/**
 * Task Service composition：provider 输入构造
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R10）。
 */
import { inferMediaKindFromType, type TaskSubmitRequest } from "@woohaa3/contracts";
import type { MediaClient } from "../clients/media-client.js";
import type { ArkVideoImageAsset, ArkVideoImageAssetInput, ArkVideoImageBinary } from "../providers/ark-types.js";

/**
 * 构造 provider 输入；参考输入由 Task 通过 Media sign 在调用前注入 URL。
 */
export function buildInput(request: TaskSubmitRequest, referenceUrls: readonly string[] = []): Record<string, unknown> {
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
      ...(referenceUrls.length > 0 ? { urls: [...referenceUrls] } : {})
    };
  }
  const groups: Record<string, Array<{ url: string; role: string }>> = {};
  request.inputs.forEach((input, index) => {
    const url = referenceUrls[index];
    if (!url) return;
    const field = inputFieldFor(input.mediaKind, input.role);
    (groups[field] ??= []).push({ url, role: input.role });
  });
  return {
    prompt: request.prompt,
    ...request.parameters,
    // 视频结果要写进任务所属画布作用域（本机 Provider 直接落稳定媒体），其它模型类型不需要。
    // 放在参数之后：请求里的画布身份是权威值，不能被面板参数覆盖。
    ...(request.modelType === "video" ? { canvasId: request.canvasId } : {}),
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
  if (providerId !== "ark" || request.modelType !== "video") {
    return buildInput(request, referenceUrls);
  }
  const imageInputs = request.inputs
    .map((input, index) => ({ input, url: referenceUrls[index] }))
    .filter((entry) => entry.url && isImageInput(entry.input.mediaKind, entry.input.role));
  if (imageInputs.length === 0) return buildInput(request, referenceUrls);
  if (!options.ensureVideoImageAsset) {
    options.logger?.({ event: "seedance-image-asset-unconfigured", count: imageInputs.length });
    return buildInput(request, referenceUrls);
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
  return buildInput(request, rewritten);
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
