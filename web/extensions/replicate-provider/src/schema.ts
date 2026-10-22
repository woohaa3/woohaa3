/**
 * 把 Replicate 模型的 OpenAPI Input/Output 收成画布能用的描述，并在提交时映回预测 input。
 *
 * 文件字段不直接暴露成字符串：画布参考图进 `urls`，视频进 `videoUrls`，音频进 `audioUrls`。
 * 每种媒体只绑定一个主字段（优先 image / video / audio），其余文件字段不进表单。
 */
import {
  PPTASK_PARAMETER_ADAPTIVE,
  PPTASK_PARAMETER_CONTROL,
  inferParameterControl,
  isAdaptiveParameterValue,
  type GenerationModelDefinition,
  type PromptRequirement
} from "@woohaa3/contracts";
import { REPLICATE_PROVIDER_ID } from "./shared.js";

export type ReplicateModelType = "language" | "image" | "video" | "audio";

export type MediaBinding = { key: string; many: boolean };

export type ReplicateModel = {
  id: string;
  version: string;
  modelType: ReplicateModelType;
  title: string;
  promptRequirement: PromptRequirement;
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
  /** 允许写进预测 input 的原始字段名。 */
  allowed: readonly string[];
  promptKey?: string;
  systemKey?: string;
  image?: MediaBinding;
  video?: MediaBinding;
  audio?: MediaBinding;
};

const IMAGE_FIELDS = ["image", "input_image", "image_input", "init_image", "start_image", "first_frame", "images", "input_images"];
const VIDEO_FIELDS = ["video", "input_video", "video_input", "videos"];
const AUDIO_FIELDS = ["audio", "input_audio", "audio_input"];

type Slot = { name: string; many: boolean; order: number };

export function classifyReplicateModel(id: string, payload: unknown): ReplicateModel | undefined {
  if (!isRecord(payload)) return undefined;
  const version = isRecord(payload.latest_version) && typeof payload.latest_version.id === "string"
    ? payload.latest_version.id.trim()
    : "";
  if (!version) return undefined;
  const openapi = isRecord(payload.latest_version) && isRecord(payload.latest_version.openapi_schema)
    ? payload.latest_version.openapi_schema
    : undefined;
  const schemas = isRecord(openapi?.components) && isRecord(openapi.components.schemas)
    ? openapi.components.schemas
    : undefined;
  const input = isRecord(schemas?.Input) ? schemas.Input : undefined;
  const output = schemas?.Output;
  const description = typeof payload.description === "string" ? payload.description : "";
  const modelType = classifyKind(id, description, output);
  if (!modelType || !input) return undefined;

  const properties = isRecord(input.properties) ? input.properties : {};
  const required = Array.isArray(input.required)
    ? input.required.filter((item): item is string => typeof item === "string")
    : [];
  const imageSlots: Slot[] = [];
  const videoSlots: Slot[] = [];
  const audioSlots: Slot[] = [];
  const params: Array<{ name: string; order: number; schema: Record<string, unknown> }> = [];

  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    const order = typeof raw["x-order"] === "number" ? raw["x-order"] : 1_000;
    const slot = mediaSlot(name, raw);
    if (slot?.kind === "image") imageSlots.push({ name, many: slot.many, order });
    else if (slot?.kind === "video") videoSlots.push({ name, many: slot.many, order });
    else if (slot?.kind === "audio") audioSlots.push({ name, many: slot.many, order });
    else params.push({ name, order, schema: raw });
  }

  const promptKey = pickPromptKey(params, required);
  const systemKey = params.some((item) => item.name === "system_prompt")
    ? "system_prompt"
    : params.some((item) => item.name === "system") ? "system" : undefined;
  const image = pickSlot(imageSlots, IMAGE_FIELDS);
  const video = pickSlot(videoSlots, VIDEO_FIELDS);
  const audio = pickSlot(audioSlots, AUDIO_FIELDS);
  const promptRequirement: PromptRequirement = promptKey
    ? (required.includes(promptKey) ? "required" : "optional")
    : "none";

  const canvasProperties: Record<string, unknown> = {};
  const promptSchema = promptKey ? params.find((item) => item.name === promptKey)?.schema : undefined;
  if (promptKey && promptSchema) {
    canvasProperties.prompt = {
      ...canvasProperty("prompt", { ...promptSchema, title: labelOf(promptKey, promptSchema) }),
      "x-component": "Input.TextArea",
      "x-component-props": { rows: 4 }
    };
  }
  if (image) canvasProperties.urls = referenceSchema("参考图", "reference-image", image.many ? 8 : 1);
  if (video) canvasProperties.videoUrls = referenceSchema("参考视频", "reference-video", video.many ? 4 : 1);
  if (audio) canvasProperties.audioUrls = referenceSchema("参考音频", "reference-audio", audio.many ? 4 : 1);
  for (const item of params.filter((entry) => entry.name !== promptKey && entry.name !== systemKey).sort(byOrder)) {
    const property = canvasProperty(item.name, item.schema);
    if (property) canvasProperties[item.name] = property;
  }
  if (systemKey) {
    const system = params.find((item) => item.name === systemKey);
    if (system) {
      const property = canvasProperty(system.name, system.schema);
      if (property) canvasProperties[system.name] = property;
    }
  }

  const example = isRecord(payload.default_example) && isRecord(payload.default_example.input)
    ? payload.default_example.input
    : {};
  const defaultInput: Record<string, unknown> = {};
  if (promptKey && typeof example[promptKey] === "string") defaultInput.prompt = example[promptKey];
  if (image) defaultInput.urls = [];
  if (video) defaultInput.videoUrls = [];
  if (audio) defaultInput.audioUrls = [];
  for (const key of Object.keys(canvasProperties)) {
    if (key === "prompt" || key === "urls" || key === "videoUrls" || key === "audioUrls") continue;
    const value = example[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") defaultInput[key] = value;
  }

  return {
    id,
    version,
    modelType,
    title: id,
    promptRequirement,
    inputSchema: { type: "object", properties: canvasProperties },
    defaultInput,
    allowed: Object.keys(properties),
    ...(promptKey ? { promptKey } : {}),
    ...(systemKey ? { systemKey } : {}),
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {})
  };
}

export function replicateModelDefinitions(models: readonly ReplicateModel[]): GenerationModelDefinition[] {
  return models.map((model) => ({
    providerId: REPLICATE_PROVIDER_ID,
    providerModelId: model.id,
    modelType: model.modelType,
    title: model.title,
    inputSchema: model.inputSchema,
    defaultInput: model.defaultInput,
    promptRequirement: model.promptRequirement,
    cancel: "remote"
  }));
}

/** 把任务输入收成该模型 OpenAPI Input 里真正存在的字段。 */
export function buildPredictionInput(raw: Record<string, unknown>, model: ReplicateModel): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!model.allowed.includes(key) || isControlKey(key)) continue;
    if (value === undefined || value === "") continue;
    input[key] = value;
  }
  const prompt = promptText(raw);
  if (model.promptKey && prompt) input[model.promptKey] = prompt;
  const system = systemText(raw);
  if (model.systemKey && system) input[model.systemKey] = system;
  assignMedia(input, model.image, uniqueUrls(raw.urls, raw.images, imageUrlsFromMessages(raw)));
  assignMedia(input, model.video, uniqueUrls(raw.videoUrls));
  assignMedia(input, model.audio, uniqueUrls(raw.audioUrls));
  if (typeof raw.n === "number" && model.allowed.includes("num_outputs") && input.num_outputs === undefined) {
    input.num_outputs = raw.n;
  }
  return input;
}

export function promptText(raw: Record<string, unknown>): string {
  if (typeof raw.prompt === "string" && raw.prompt.trim()) return raw.prompt.trim();
  if (typeof raw.messages === "string" && raw.messages.trim()) return raw.messages.trim();
  const messages = Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.prompt) ? raw.prompt : [];
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role === "system") continue;
    collectText(message.content, parts);
  }
  return parts.join("\n").trim();
}

function systemText(raw: Record<string, unknown>): string {
  if (typeof raw.system === "string" && raw.system.trim()) return raw.system.trim();
  if (typeof raw.system_prompt === "string" && raw.system_prompt.trim()) return raw.system_prompt.trim();
  const messages = Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.prompt) ? raw.prompt : [];
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "system") continue;
    collectText(message.content, parts);
  }
  return parts.join("\n").trim();
}

function collectText(content: unknown, parts: string[]): void {
  if (typeof content === "string" && content.trim()) {
    parts.push(content.trim());
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (typeof part === "string" && part.trim()) parts.push(part.trim());
    else if (isRecord(part) && typeof part.text === "string" && part.text.trim()) parts.push(part.text.trim());
  }
}

function imageUrlsFromMessages(raw: Record<string, unknown>): string[] {
  const messages = Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.prompt) ? raw.prompt : [];
  const urls: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      const nested = isRecord(part.image_url) ? part.image_url.url : undefined;
      if (typeof nested === "string") urls.push(nested);
      if (part.type === "image" && typeof part.url === "string") urls.push(part.url);
    }
  }
  return urls;
}

function uniqueUrls(...sources: unknown[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if ((/^https:\/\//i.test(value) || /^data:/i.test(value)) && !seen.has(value)) {
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

function assignMedia(input: Record<string, unknown>, slot: MediaBinding | undefined, urls: string[]): void {
  if (!slot || urls.length === 0) return;
  input[slot.key] = slot.many ? urls : urls[0];
}

function isControlKey(key: string): boolean {
  return key === "prompt" || key === "urls" || key === "images" || key === "videoUrls" || key === "audioUrls"
    || key === "messages" || key === "n" || key === "model" || key === "providerOptions"
    || key === "abortSignal" || key === "headers";
}

function classifyKind(id: string, description: string, output: unknown): ReplicateModelType | undefined {
  const haystack = `${id} ${description}`.toLowerCase();
  if (/\b(3d|mesh|nerf|gaussian|point-cloud|tripo)\b/.test(haystack)) return undefined;
  const media = outputMedia(output);
  if (media.includes("video/")) return "video";
  if (media.includes("audio/")) return "audio";
  if (media.includes("image/")) return "image";
  const video = /\b(video|animate|i2v|t2v|text-to-video|image-to-video)\b/.test(haystack);
  const audio = /\b(audio|music|speech|tts|voice)\b/.test(haystack);
  const image = /\b(image|flux|sdxl|stable-diffusion|upscale|img2img|inpaint)\b/.test(haystack);
  if (video && !audio) return "video";
  if (audio && !video && !image) return "audio";
  if (isTextOutput(output) && !image && !video) return "language";
  if (isUriOutput(output) || image) return "image";
  if (isTextOutput(output)) return "language";
  return undefined;
}

function outputMedia(schema: unknown): string {
  if (!isRecord(schema)) return "";
  const direct = typeof schema.contentMediaType === "string" ? schema.contentMediaType : "";
  const item = isRecord(schema.items) && typeof schema.items.contentMediaType === "string" ? schema.items.contentMediaType : "";
  return `${direct} ${item}`.toLowerCase();
}

function isTextOutput(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "string" && schema.format !== "uri") return true;
  return schema.type === "array" && isRecord(schema.items) && schema.items.type === "string" && schema.items.format !== "uri";
}

function isUriOutput(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.format === "uri") return true;
  return schema.type === "array" && isRecord(schema.items) && schema.items.format === "uri";
}

function mediaSlot(name: string, schema: Record<string, unknown>): { kind: "image" | "video" | "audio"; many: boolean } | undefined {
  const many = schema.type === "array";
  const item = many && isRecord(schema.items) ? schema.items : schema;
  const format = typeof item.format === "string" ? item.format : "";
  const media = `${typeof item.contentMediaType === "string" ? item.contentMediaType : ""} ${typeof schema.contentMediaType === "string" ? schema.contentMediaType : ""}`.toLowerCase();
  const uri = format === "uri" || format === "uri-reference" || media.startsWith("image/") || media.startsWith("video/") || media.startsWith("audio/");
  if (!uri) return undefined;
  const blob = `${name} ${typeof schema.description === "string" ? schema.description : ""} ${typeof schema.title === "string" ? schema.title : ""} ${media}`.toLowerCase();
  if (/\b(audio|voice|speech|wav|mp3)\b/.test(blob) && !/image/.test(name)) return { kind: "audio", many };
  if (/\b(video|mp4|webm)\b/.test(blob) && !/image/.test(name)) return { kind: "video", many };
  return { kind: "image", many };
}

function pickPromptKey(params: Array<{ name: string }>, required: readonly string[]): string | undefined {
  const names = new Set(params.map((item) => item.name));
  if (names.has("prompt")) return "prompt";
  if (names.has("text")) return "text";
  return required.find((name) => names.has(name));
}

function pickSlot(slots: Slot[], preferred: readonly string[]): MediaBinding | undefined {
  if (slots.length === 0) return undefined;
  const ranked = [...slots].sort((a, b) => rank(a.name, preferred) - rank(b.name, preferred) || a.order - b.order);
  const best = ranked[0];
  return best ? { key: best.name, many: best.many } : undefined;
}

function rank(name: string, preferred: readonly string[]): number {
  const index = preferred.indexOf(name);
  if (index >= 0) return index;
  if (/mask|end|last/.test(name)) return 1_000;
  return 100;
}

function canvasProperty(name: string, schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const title = labelOf(name, schema);
  const values = Array.isArray(schema.enum)
    ? schema.enum.filter((item) => ["string", "number", "boolean"].includes(typeof item))
    : [];
  if (values.length > 0) {
    // 动态上游没有模型家族信息；按参数名 + 取值推断比例/分辨率语义（只认明确的形态）。
    const semantic = inferParameterControl(name, values.map((value) => String(value)));
    return {
      type: "string",
      title,
      "x-component": "Select",
      enum: values.map((value) => {
        const option = { label: String(value), value: String(value) };
        return semantic === "aspect-ratio" && isAdaptiveParameterValue(String(value))
          ? { ...option, [PPTASK_PARAMETER_ADAPTIVE]: true }
          : option;
      }),
      ...(semantic ? { [PPTASK_PARAMETER_CONTROL]: semantic } : {}),
      ...(schema.default !== undefined ? { default: String(schema.default) } : {})
    };
  }
  if (schema.type === "boolean") {
    return { type: "boolean", title, "x-component": "Switch", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
  }
  if (schema.type === "integer" || schema.type === "number") {
    return {
      type: "number",
      title,
      "x-component": "NumberPicker",
      ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
      ...(typeof schema.default === "number" ? { default: schema.default } : {})
    };
  }
  if (schema.type === "string" && schema.format !== "uri") {
    return { type: "string", title, "x-component": "Input", ...(typeof schema.default === "string" ? { default: schema.default } : {}) };
  }
  return undefined;
}

function referenceSchema(title: string, semantic: string, maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    title,
    maxItems,
    "x-pptask-semantic": semantic,
    "x-component": "Upload",
    "x-component-props": { maxCount: maxItems }
  };
}

function labelOf(name: string, schema: Record<string, unknown>): string {
  if (typeof schema.title === "string" && schema.title.trim()) return schema.title.trim();
  return name;
}

function byOrder(a: { order: number; name: string }, b: { order: number; name: string }): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
