/**
 * grsai 的输入表单与请求体映射。
 *
 * 统一生成接口 `/v1/api/generate` 的字段按模型而不按类别给出（例如未定档的比例如
 * `minimax-h3` 用 portrait/landscape，nano-banana 用 16:9）。画布只有「模型类型」这一层，
 * 所以可选参数一律**不带默认值**：面板不填就不进请求体，避免把 A 模型支持的取值发给 B 模型；
 * 具体取值以 grsai 官方模型页为准。
 */
import { aspectRatioField, qualityField, resolutionField, type GenerationModelDescription } from "@woohaa3/contracts";
import { normalizeLanguagePrompt } from "@sdppp/pptask/providers/shared";
import type { GrsaiKind, GrsaiModel } from "./discovery.js";

const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"] as const;
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "portrait", "landscape"] as const;

export function describeGrsaiModel(model: GrsaiModel): GenerationModelDescription {
  return {
    title: model.title,
    inputSchema: grsaiInputSchema(model.kind, model.id),
    defaultInput: grsaiDefaultInput(model.kind),
    promptRequirement: "required"
    // 没有远端取消接口：保持缺省的 local（宿主只停本地轮询）。
  };
}

/**
 * grsai 的视频分辨率是模型级契约。公开模型表目前声明：minimax-h3 使用
 * `480p/768p/1080p`，agnes-video-2.5 使用 `720p/1080p/2k`。未知模型保留
 * 通用集合，且不猜默认值，避免把某个模型的值发给另一个模型。
 */
export function grsaiVideoResolutions(modelId?: string): readonly string[] {
  const id = modelId?.trim().toLowerCase();
  if (id === "agnes-video-2.5") return ["720p", "1080p", "2k"];
  return ["480p", "768p", "1080p"];
}

export function grsaiInputSchema(kind: GrsaiKind, modelId?: string): Record<string, unknown> {
  if (kind === "language") {
    return {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        system: { type: "string", title: "系统提示词", "x-component": "Input.TextArea" },
        urls: referenceSchema(8),
        maxTokens: { type: "number", title: "最大输出 Token", default: 2048, "x-component": "NumberPicker" },
        jsonMode: { type: "boolean", title: "JSON 输出", default: false, "x-component": "Switch" }
      }
    };
  }
  if (kind === "video") {
    return {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        urls: referenceSchema(9),
        aspectRatio: aspectRatioField({ ratios: VIDEO_ASPECTS, adaptive: false, title: "比例" }),
        resolution: resolutionField({ tiers: grsaiVideoResolutions(modelId), title: "分辨率" }),
        duration: { type: "number", title: "时长（秒）", minimum: 1, maximum: 15, "x-component": "NumberPicker" }
      }
    };
  }
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: promptSchema(),
      urls: referenceSchema(8),
      aspectRatio: aspectRatioField({ ratios: IMAGE_ASPECTS, adaptive: { value: "auto" }, title: "比例" }),
      imageSize: resolutionField({ tiers: ["1K", "2K", "4K"], title: "图片分辨率" }),
      quality: qualityField({ levels: ["auto", "low", "medium", "high", "xhigh", "max"], title: "质量" }),
      background: selectSchema("背景", ["auto", "transparent"])
    }
  };
}

export function grsaiDefaultInput(kind: GrsaiKind): Record<string, unknown> {
  if (kind === "language") return { prompt: "", system: "", urls: [], maxTokens: 2048, jsonMode: false };
  return { prompt: "", urls: [] };
}

/** 图片/视频：统一生成接口，`replyType: async` 先拿任务 id 再轮询。 */
export function buildGenerateBody(model: GrsaiModel, raw: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.id, prompt: promptText(raw), replyType: "async" };
  const images = uniqueUrls(raw.urls, raw.images);
  if (images.length > 0) body.images = images;
  assignText(body, "aspectRatio", raw.aspectRatio ?? raw.aspect_ratio);
  if (model.kind === "image") {
    assignText(body, "imageSize", raw.imageSize);
    assignText(body, "quality", raw.quality);
    assignText(body, "background", raw.background);
  } else {
    assignText(body, "resolution", raw.resolution);
    if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) body.duration = raw.duration;
  }
  return body;
}

/** 文本：OpenAI 兼容的 Chat Completions。 */
export function buildChatBody(model: GrsaiModel, raw: Record<string, unknown>): Record<string, unknown> {
  return {
    model: model.id,
    messages: chatMessages(raw),
    max_tokens: positiveInt(raw.maxTokens ?? raw.max_tokens, 2048),
    ...(raw.jsonMode === true ? { response_format: { type: "json_object" } } : {})
  };
}

export function promptText(raw: Record<string, unknown>): string {
  if (typeof raw.prompt === "string" && raw.prompt.trim()) return raw.prompt.trim();
  if (typeof raw.text === "string" && raw.text.trim()) return raw.text.trim();
  return "";
}

function chatMessages(raw: Record<string, unknown>): unknown[] {
  const normalized = normalizeLanguagePrompt(raw).messages;
  const list: unknown[] = (Array.isArray(normalized) ? normalized : []).map(openAIMessage);
  const system = typeof raw.system === "string" ? raw.system.trim() : "";
  if (system && !list.some((message) => isRecord(message) && message.role === "system")) {
    list.unshift({ role: "system", content: system });
  }
  const refs = uniqueUrls(raw.urls, raw.images);
  if (refs.length > 0) attachImages(list, refs);
  return list;
}

/** AI SDK 的 image 部件换成 Chat Completions 的 `image_url`。 */
function openAIMessage(message: unknown): unknown {
  const row = isRecord(message) ? message : undefined;
  if (!row || !Array.isArray(row.content)) return message;
  return {
    ...row,
    content: row.content.map((part) => {
      const item = isRecord(part) ? part : undefined;
      if (item?.type === "image" && typeof item.url === "string") return { type: "image_url", image_url: { url: item.url } };
      return part;
    })
  };
}

function attachImages(messages: unknown[], urls: string[]): void {
  const target = [...messages].reverse().find((message) => isRecord(message) && message.role === "user");
  if (!target) {
    messages.push({ role: "user", content: urls.map(imagePart) });
    return;
  }
  const row = target as Record<string, unknown>;
  const content = Array.isArray(row.content)
    ? [...row.content]
    : typeof row.content === "string" ? [{ type: "text", text: row.content }] : [];
  const existing = new Set(content.flatMap((part) => {
    const item = isRecord(part) ? part : undefined;
    const url = isRecord(item?.image_url) ? item.image_url.url : item?.url;
    return typeof url === "string" ? [url] : [];
  }));
  for (const url of urls) {
    if (!existing.has(url)) content.push(imagePart(url));
  }
  row.content = content;
}

function imagePart(url: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url } };
}

function uniqueUrls(...sources: unknown[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      // 参考图既可以是公网地址，也可以是 grsai 明确支持的 data URI。
      if ((/^https?:\/\//i.test(value) || /^data:/i.test(value)) && !seen.has(value)) {
        seen.add(value);
        urls.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value) && typeof value.url === "string") visit(value.url);
  };
  for (const source of sources) visit(source);
  return urls;
}

function assignText(body: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) body[key] = value.trim();
}

function promptSchema(): Record<string, unknown> {
  return { type: "string", title: "提示词", "x-component": "Input.TextArea", "x-component-props": { rows: 4 } };
}

function referenceSchema(maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    title: "参考图",
    maxItems,
    "x-pptask-semantic": "reference-image",
    "x-component": "Upload",
    "x-component-props": { maxCount: maxItems }
  };
}

/** 不给默认值：面板不填就不进请求体。 */
function selectSchema(title: string, values: readonly string[]): Record<string, unknown> {
  return {
    type: "string",
    title,
    "x-component": "Select",
    enum: values.map((value) => ({ label: value, value }))
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? Math.min(8192, number) : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
