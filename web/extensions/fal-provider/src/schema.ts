/**
 * 把 fal endpoint 的队列 OpenAPI 收成画布能用的描述，并在提交时映回该 endpoint 的输入。
 *
 * 定义来自 `GET /api/openapi/queue/openapi.json?endpoint_id=...`：`info.x-fal-metadata.category`
 * 决定模型类型，`components.schemas.<X>Input` 是字段定义。文件字段不直接暴露成字符串：
 * 画布参考图进 `urls`，视频进 `videoUrls`，音频进 `audioUrls`；每种媒体只绑定一个主字段。
 */
import {
  PPTASK_PARAMETER_ADAPTIVE,
  PPTASK_PARAMETER_CONTROL,
  inferParameterControl,
  isAdaptiveParameterValue,
  type GenerationModelDefinition,
  type PromptRequirement
} from "@woohaa3/contracts";
import { FAL_PROVIDER_ID } from "./shared.js";

export type FalModelType = "language" | "image" | "video" | "audio";

export type MediaBinding = { key: string; many: boolean };

export type FalModel = {
  id: string;
  modelType: FalModelType;
  title: string;
  category: string;
  promptRequirement: PromptRequirement;
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
  /** 允许写进 endpoint 输入的原始字段名。 */
  allowed: readonly string[];
  promptKey?: string;
  systemKey?: string;
  image?: MediaBinding;
  video?: MediaBinding;
  audio?: MediaBinding;
};

/** 参考图/视频/音频的主字段优先级。`mask`/末帧之类不作为主绑定，但仍按普通字段暴露。 */
const IMAGE_FIELDS = ["image_url", "image_urls", "image", "input_image", "input_images", "images", "start_image_url", "first_frame_url", "reference_image_urls"];
const VIDEO_FIELDS = ["video_url", "video_urls", "video", "input_video", "videos"];
const AUDIO_FIELDS = ["audio_url", "audio_urls", "audio", "input_audio"];

const IMAGE_NAME = /^(image|images|input_image|input_images|image_url|image_urls|start_image_url|first_frame_url|reference_image_urls|ref_image_urls)$/;
const VIDEO_NAME = /^(video|videos|input_video|video_url|video_urls)$/;
const AUDIO_NAME = /^(audio|audios|input_audio|audio_url|audio_urls)$/;
const URL_NAME = /_url(s)?$/;

/** 只支持 `input`/`output` 都是可执行生成的类别；语音转写、3D、训练不注册。 */
const UNSUPPORTED_CATEGORY = /(speech-to-text|audio-to-text|transcri|segmentation|3d|training|upscal)/i;

type Slot = { name: string; many: boolean; order: number };

export function classifyFalModel(id: string, payload: unknown): FalModel | undefined {
  if (!isRecord(payload)) return undefined;
  const schemas = isRecord(payload.components) && isRecord(payload.components.schemas) ? payload.components.schemas : undefined;
  const info = isRecord(payload.info) ? payload.info : undefined;
  const metadata = info && isRecord(info["x-fal-metadata"]) ? info["x-fal-metadata"] : undefined;
  const category = metadata && typeof metadata.category === "string" ? metadata.category.trim().toLowerCase() : "";
  const input = inputSchemaOf(payload, id, schemas);
  if (!input || !schemas) return undefined;
  const output = outputSchemaOf(payload, id, schemas);
  const modelType = classifyKind(category, output);
  if (!modelType || UNSUPPORTED_CATEGORY.test(category)) return undefined;

  const properties = isRecord(input.properties) ? input.properties : {};
  const required = Array.isArray(input.required) ? input.required.filter((item): item is string => typeof item === "string") : [];
  const order = orderOf(input);
  const imageSlots: Slot[] = [];
  const videoSlots: Slot[] = [];
  const audioSlots: Slot[] = [];
  const params: Array<{ name: string; schema: Record<string, unknown>; order: number }> = [];

  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    const position = order.get(name) ?? 1_000;
    const scalar = scalarSchema(raw, schemas);
    if (!scalar) continue;
    const slot = mediaSlot(name, scalar);
    if (slot?.kind === "image") imageSlots.push({ name, many: slot.many, order: position });
    else if (slot?.kind === "video") videoSlots.push({ name, many: slot.many, order: position });
    else if (slot?.kind === "audio") audioSlots.push({ name, many: slot.many, order: position });
    else params.push({ name, schema: scalar, order: position });
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
  if (promptKey) {
    const schema = params.find((item) => item.name === promptKey)?.schema;
    canvasProperties.prompt = {
      type: "string",
      title: titleOf(promptKey, schema),
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

  const defaultInput: Record<string, unknown> = {};
  if (promptKey) defaultInput.prompt = "";
  if (image) defaultInput.urls = [];
  if (video) defaultInput.videoUrls = [];
  if (audio) defaultInput.audioUrls = [];
  for (const [key, property] of Object.entries(canvasProperties)) {
    if (key === "prompt" || key === "urls" || key === "videoUrls" || key === "audioUrls") continue;
    if (isRecord(property) && property.default !== undefined) defaultInput[key] = property.default;
  }

  return {
    id,
    modelType,
    title: id,
    category,
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

export function falModelDefinitions(models: readonly FalModel[]): GenerationModelDefinition[] {
  return models.map((model) => ({
    providerId: FAL_PROVIDER_ID,
    providerModelId: model.id,
    modelType: model.modelType,
    title: model.title,
    inputSchema: model.inputSchema,
    defaultInput: model.defaultInput,
    promptRequirement: model.promptRequirement,
    cancel: "remote" as const
  }));
}

/** 把任务输入收成该 endpoint 定义里真正存在的字段。 */
export function buildFalInput(raw: Record<string, unknown>, model: FalModel): Record<string, unknown> {
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
  assignMedia(input, model.image, uniqueUrls(raw.urls, raw.images, raw.image, imageUrlsFromMessages(raw)));
  assignMedia(input, model.video, uniqueUrls(raw.videoUrls, raw.videos, raw.video));
  assignMedia(input, model.audio, uniqueUrls(raw.audioUrls, raw.audio));
  if (typeof raw.n === "number" && model.allowed.includes("num_images") && input.num_images === undefined) {
    input.num_images = raw.n;
  }
  return input;
}

export function promptText(raw: Record<string, unknown>): string {
  if (typeof raw.prompt === "string" && raw.prompt.trim()) return raw.prompt.trim();
  if (typeof raw.text === "string" && raw.text.trim()) return raw.text.trim();
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
  return key === "prompt" || key === "text" || key === "urls" || key === "images" || key === "videoUrls" || key === "audioUrls"
    || key === "messages" || key === "n" || key === "model" || key === "providerOptions"
    || key === "abortSignal" || key === "headers";
}

/** 类别 → 模型类型；类别缺失时按输出定义兜底。 */
export function classifyKind(category: string, output: Record<string, unknown> | undefined): FalModelType | undefined {
  if (/(speech-to-text|audio-to-text|transcri|segmentation|3d|training|upscal)/i.test(category)) return undefined;
  if (/video/.test(category)) return "video";
  if (/(speech|audio|music|voice|tts)/.test(category)) return "audio";
  if (/image/.test(category)) return "image";
  if (/(llm|language|chat|vision|text-to-text)/.test(category)) return "language";
  return kindFromOutput(output);
}

function kindFromOutput(output: Record<string, unknown> | undefined): FalModelType | undefined {
  const properties = output && isRecord(output.properties) ? Object.keys(output.properties) : [];
  if (properties.includes("video")) return "video";
  if (properties.includes("audio") || properties.includes("audio_url") || properties.includes("audio_urls")) return "audio";
  if (properties.includes("images") || properties.includes("image")) return "image";
  if (properties.includes("output") || properties.includes("text")) return "language";
  return undefined;
}

function inputSchemaOf(
  payload: Record<string, unknown>,
  id: string,
  schemas: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const referenced = operationSchema(payload, `/${id}`, "post", "requestBody");
  if (referenced) return referenced;
  return firstSchemaNamed(schemas, "Input");
}

function outputSchemaOf(
  payload: Record<string, unknown>,
  id: string,
  schemas: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const referenced = operationSchema(payload, `/${id}`, "get", "responses");
  if (referenced) return referenced;
  return firstSchemaNamed(schemas, "Output");
}

/** 从 OpenAPI 路径里取出被 `$ref` 指向的定义；路径缺失时返回 undefined。 */
function operationSchema(
  payload: Record<string, unknown>,
  path: string,
  method: "post" | "get",
  section: "requestBody" | "responses"
): Record<string, unknown> | undefined {
  const paths = isRecord(payload.paths) ? payload.paths : undefined;
  const operation = paths && isRecord(paths[path]) ? (paths[path] as Record<string, unknown>)[method] : undefined;
  if (!isRecord(operation)) return undefined;
  const node = section === "requestBody"
    ? contentSchema(operation.requestBody)
    : contentSchema(isRecord(operation.responses) ? operation.responses["200"] : undefined);
  const ref = isRecord(node) && typeof node.$ref === "string" ? node.$ref : "";
  const name = ref.split("/").pop() ?? "";
  const schemas = isRecord(payload.components) && isRecord(payload.components.schemas) ? payload.components.schemas : undefined;
  return name && schemas && isRecord(schemas[name]) ? (schemas[name] as Record<string, unknown>) : undefined;
}

function contentSchema(node: unknown): unknown {
  return isRecord(node) && isRecord(node.content) && isRecord(node.content["application/json"])
    ? node.content["application/json"].schema
    : undefined;
}

function firstSchemaNamed(schemas: Record<string, unknown> | undefined, suffix: string): Record<string, unknown> | undefined {
  if (!schemas) return undefined;
  for (const [name, schema] of Object.entries(schemas)) {
    if (name.endsWith(suffix) && isRecord(schema) && name !== "QueueStatus") return schema;
  }
  return undefined;
}

/** `x-fal-order-properties` 决定表单顺序。 */
function orderOf(input: Record<string, unknown>): Map<string, number> {
  const list = Array.isArray(input["x-fal-order-properties"]) ? input["x-fal-order-properties"] : [];
  const order = new Map<string, number>();
  list.forEach((name, index) => {
    if (typeof name === "string") order.set(name, index);
  });
  return order;
}

/**
 * 把 `anyOf`/`$ref` 收成能渲染的标量或字符串数组定义；对象、纯数组对象返回 undefined。
 * `anyOf` 里有 enum 的分支优先（`image_size` 就是「预设字符串 or 自定义宽高对象」）。
 */
function scalarSchema(schema: Record<string, unknown>, schemas: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = deref(schema, schemas);
  const branches = Array.isArray(direct.anyOf) ? direct.anyOf : Array.isArray(direct.oneOf) ? direct.oneOf : [];
  const candidates = branches.length > 0 ? branches.map((branch) => deref(branch, schemas)) : [direct];
  const usable = candidates.filter((item) => isScalar(item) || isStringArray(item) || Array.isArray(item.enum));
  if (usable.length === 0) return undefined;
  const preferred = usable.find((item) => Array.isArray(item.enum)) ?? usable[0]!;
  return { ...preferred, ...(typeof direct.title === "string" ? { title: direct.title } : {}), ...(direct.default !== undefined ? { default: direct.default } : {}) };
}

function isScalar(schema: Record<string, unknown>): boolean {
  return schema.type === "string" || schema.type === "integer" || schema.type === "number" || schema.type === "boolean" || Array.isArray(schema.enum);
}

function isStringArray(schema: Record<string, unknown>): boolean {
  if (schema.type !== "array") return false;
  const item = isRecord(schema.items) ? schema.items : undefined;
  return item?.type === "string";
}

function deref(schema: unknown, schemas: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (!isRecord(schema) || depth > 4) return isRecord(schema) ? schema : {};
  const ref = typeof schema.$ref === "string" ? schema.$ref : "";
  if (!ref) return schema;
  const name = ref.split("/").pop() ?? "";
  const target = schemas[name];
  return isRecord(target) ? deref(target, schemas, depth + 1) : schema;
}

function mediaSlot(name: string, schema: Record<string, unknown>): { kind: "image" | "video" | "audio"; many: boolean } | undefined {
  const many = schema.type === "array";
  if (!many && schema.type !== "string") return undefined;
  const known = IMAGE_NAME.test(name) || VIDEO_NAME.test(name) || AUDIO_NAME.test(name);
  if (!known && !URL_NAME.test(name)) return undefined;
  if (/mask/i.test(name)) return undefined;
  if (AUDIO_NAME.test(name)) return { kind: "audio", many };
  if (VIDEO_NAME.test(name) || /video/i.test(name)) return { kind: "video", many };
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
  const title = titleOf(name, schema);
  const values = Array.isArray(schema.enum) ? schema.enum.filter((item) => ["string", "number", "boolean"].includes(typeof item)) : [];
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
  if (schema.type === "string") {
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

function titleOf(name: string, schema: Record<string, unknown> | undefined): string {
  return schema && typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : name;
}

function byOrder(a: { order: number; name: string }, b: { order: number; name: string }): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
