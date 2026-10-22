import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import {
  ADAPTIVE_PARAMETER_VALUE,
  IMAGE_ASPECT_RATIOS_STANDARD,
  aspectRatioField,
  imageModelPresetFor,
  resolutionField,
  seedreamSizePresetFor,
  seedreamSupportsAspectRatio,
  type SeedreamSizePreset
} from "@woohaa3/contracts";
import {
  createHttpProvider,
  jsonRequest,
  mergeHeaders,
  normalizeLanguagePrompt,
  normalizeProviderConfig,
  requestJson,
  type CommonProviderOptions,
  type HttpExecutionContext,
  type HttpProviderProtocol,
  type NormalizedProviderConfig
} from "@sdppp/pptask/providers/shared";
import { TOKENHUB_PROVIDER_ID, tokenHubOrigin } from "./shared.js";
import {
  assertRequestAccepted,
  buildSubmit,
  collectResultUrls,
  interpretStatus,
  readTaskId,
  routeModel,
  statusPath,
  type TokenHubKind
} from "./routes.js";

export type TokenHubProviderOptions = CommonProviderOptions & { apiKey: string };

const VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"] as const;

/**
 * TokenHub provider。文本同步返回；图片按系列同步或异步；视频全部异步。
 * 凭据在构造时传入。
 */
export function createTokenHubProvider(options: TokenHubProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(TOKENHUB_PROVIDER_ID, options, "");
  if (!config.baseURL) throw new Error("TokenHub 需要 baseURL");
  const origin = tokenHubOrigin(config.baseURL);

  const protocol: HttpProviderProtocol = {
    providerId: TOKENHUB_PROVIDER_ID,
    fetch: config.fetch,
    modelTypes: ["language", "image", "video"],
    mode(modelId, modelType) {
      const route = routeModel(modelId);
      if (!route || route.kind !== modelType) return modelType === "video" ? "async" : "sync";
      return route.mode;
    },
    validateModel(modelId, modelType) {
      const route = routeModel(modelId);
      if (modelType === "language") {
        if (route) throw new Error(`TokenHub 模型 ${modelId} 不是语言模型`);
        if (!modelId.trim()) throw new Error("TokenHub 模型 id 不能为空");
        return;
      }
      if (!route || route.kind !== modelType) throw new Error(`TokenHub 不支持 ${modelType} 模型：${modelId}`);
    },
    async execute(context) {
      if (context.modelType === "language") return executeText(context, config, origin);
      return executeImage(context, config, origin);
    },
    async start(context) {
      const { path, body } = buildSubmit(context.modelId, context.input);
      const payload = await postJson(config, origin, path, body, context);
      assertRequestAccepted(payload);
      const taskId = readTaskId(payload);
      if (!taskId) throw new Error("TokenHub 未返回任务 ID");
      const family = routeModel(context.modelId)?.family ?? "";
      return { operation: { taskId, family } };
    },
    async status(context) {
      const operation = operationOf(context.operation);
      if (!operation.taskId || !operation.family) return { state: "failed", error: "TokenHub 任务缺少 task id" };
      const payload = await getJson(config, origin, statusPath(operation.family, operation.taskId), context);
      const view = interpretStatus(payload);
      if (view.state === "pending") return { state: "pending", phase: view.phase };
      if (view.state === "failed") return { state: "failed", error: view.error };
      return { state: "completed", output: { data: view.urls.map((url) => ({ url })) } };
    },
    describe: async (modelId, modelType) => describeTokenHubModel(modelId, modelType)
  };

  return createHttpProvider(protocol, options);
}

export function describeTokenHubModel(modelId: string, modelType: PptaskModelType): PptaskDescription {
  if (modelType === "language") return describeText(modelId);
  if (modelType === "video") return describeVideo(modelId);
  return describeImage(modelId);
}

async function executeText(
  context: HttpExecutionContext,
  config: NormalizedProviderConfig,
  origin: string
): Promise<unknown> {
  const input = context.input;
  const body: Record<string, unknown> = {
    model: context.modelId,
    messages: chatMessages(input),
    max_tokens: positiveInt(input.max_tokens ?? input.maxTokens, 2048)
  };
  if (input.jsonMode === true) body.response_format = { type: "json_object" };
  return postJson(config, origin, "/v1/chat/completions", body, context);
}

async function executeImage(
  context: HttpExecutionContext,
  config: NormalizedProviderConfig,
  origin: string
): Promise<unknown> {
  const { path, body } = buildSubmit(context.modelId, context.input);
  const payload = await postJson(config, origin, path, body, context);
  assertRequestAccepted(payload);
  const urls = collectResultUrls(payload);
  const error = record(payload)?.error;
  if (!urls.length) {
    throw new Error(record(error)?.message && typeof record(error)?.message === "string"
      ? String(record(error)?.message)
      : "TokenHub 没有返回图片");
  }
  return { data: urls.map((url) => ({ url })) };
}

async function postJson(
  config: NormalizedProviderConfig,
  origin: string,
  path: string,
  body: unknown,
  context: HttpExecutionContext
): Promise<unknown> {
  return requestJson(
    config.fetch,
    TOKENHUB_PROVIDER_ID,
    jsonRequest(`${origin}${path}`, body, mergeHeaders(authHeaders(config.apiKey ?? ""), context.headers)),
    context.signal
  );
}

async function getJson(
  config: NormalizedProviderConfig,
  origin: string,
  path: string,
  context: HttpExecutionContext
): Promise<unknown> {
  return requestJson(
    config.fetch,
    TOKENHUB_PROVIDER_ID,
    {
      url: `${origin}${path}`,
      method: "GET",
      headers: mergeHeaders(authHeaders(config.apiKey ?? ""), context.headers)
    },
    context.signal
  );
}

function chatMessages(input: Record<string, unknown>): unknown[] {
  const normalized = normalizeLanguagePrompt(input).messages;
  const list = (Array.isArray(normalized) ? normalized : []).map(openAIMessage);
  const system = typeof input.system === "string" ? input.system.trim() : "";
  if (system && !list.some((message) => record(message)?.role === "system")) {
    list.unshift({ role: "system", content: system });
  }
  const refs = referenceUrls(input);
  if (refs.length) attachImages(list, refs);
  return list;
}

function openAIMessage(message: unknown): unknown {
  const row = record(message);
  if (!row || !Array.isArray(row.content)) return message;
  return {
    ...row,
    content: row.content.map((part) => {
      const item = record(part);
      if (item?.type === "image" && typeof item.url === "string") {
        return { type: "image_url", image_url: { url: item.url } };
      }
      return part;
    })
  };
}

function attachImages(messages: unknown[], urls: string[]): void {
  const target = [...messages].reverse().find((message) => record(message)?.role === "user");
  if (!target) {
    messages.push({ role: "user", content: urls.map(imagePart) });
    return;
  }
  const row = target as Record<string, unknown>;
  const content = Array.isArray(row.content)
    ? [...row.content]
    : typeof row.content === "string" ? [{ type: "text", text: row.content }] : [];
  const existing = new Set(content.flatMap((part) => {
    const item = record(part);
    const url = record(item?.image_url)?.url ?? item?.url;
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

function referenceUrls(input: Record<string, unknown>): string[] {
  const raw = input.urls ?? input.images;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 14);
}

function describeText(modelId: string): PptaskDescription {
  return {
    providerId: TOKENHUB_PROVIDER_ID,
    modelId,
    modelType: "language",
    title: modelId,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", title: "提示词", "x-component": "Input.TextArea" },
        system: { type: "string", title: "系统提示词", "x-component": "Input.TextArea" },
        urls: referenceImageSchema(14),
        maxTokens: { type: "number", title: "最大输出 Token", default: 2048, "x-component": "NumberPicker" },
        jsonMode: { type: "boolean", title: "JSON 输出", default: false, "x-component": "Switch" }
      }
    },
    defaultInput: { system: "", urls: [], maxTokens: 2048, jsonMode: false },
    capabilities: { mediaKind: "text", operations: ["text-generation"], cancel: false }
  };
}

function describeImage(modelId: string): PptaskDescription {
  // 同一模型跨 Provider 的参数预设来自 contracts；未命中时回退到 TokenHub 通用取值域。
  const seedream = seedreamSizePresetFor(modelId);
  if (seedream) return describeSeedreamImage(modelId, seedream);
  const preset = imageModelPresetFor(modelId);
  const ratios = preset?.aspectRatios ?? IMAGE_ASPECT_RATIOS_STANDARD;
  const adaptive = preset?.adaptiveAspectRatio === true;
  const resolutions = preset?.resolutions ?? ["1K", "2K", "4K"];
  const defaultResolution = preset?.defaultResolution ?? "1K";
  const defaultAspect = adaptive
    ? ADAPTIVE_PARAMETER_VALUE
    : ratios.includes("1:1") ? "1:1" : ratios[0] ?? "1:1";
  return {
    providerId: TOKENHUB_PROVIDER_ID,
    modelId,
    modelType: "image",
    title: modelId,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        urls: referenceImageSchema(10),
        aspectRatio: aspectRatioField({
          ratios,
          fallback: defaultAspect,
          adaptive,
          title: "比例"
        }),
        resolution: resolutionField({
          tiers: resolutions,
          fallback: defaultResolution,
          title: "图片分辨率"
        })
      }
    },
    defaultInput: { prompt: "", urls: [], aspectRatio: defaultAspect, resolution: defaultResolution },
    capabilities: { mediaKind: "image", operations: ["text-to-image", "image-to-image"], cancel: false }
  };
}

/**
 * 即梦（Seedream）的图片参数。
 *
 * 官方接口没有 `aspect_ratio` / `quality` / `n`：比例只能写进 `size` 像素值，分辨率只能选
 * 档位。所以这里只给「比例 + 分辨率」，且**只有该版本有官方比例表时才给比例**——
 * 4.0 的文档只列了一组像素值，比例交给 prompt，给了控件也兑现不了。
 */
function describeSeedreamImage(
  modelId: string,
  spec: SeedreamSizePreset
): PptaskDescription {
  const supportsRatio = seedreamSupportsAspectRatio(spec);
  // 即梦「方式 1」= 只给分辨率档位、宽高比交给模型，即面板上的自适应。
  const defaultAspect = ADAPTIVE_PARAMETER_VALUE;
  return {
    providerId: TOKENHUB_PROVIDER_ID,
    modelId,
    modelType: "image",
    title: modelId,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        urls: referenceImageSchema(spec.maxReferenceImages),
        ...(supportsRatio
          ? {
              aspectRatio: aspectRatioField({
                ratios: spec.aspectRatios,
                fallback: defaultAspect,
                adaptive: true,
                title: "比例"
              })
            }
          : {}),
        resolution: resolutionField({
          tiers: spec.resolutions,
          fallback: spec.defaultResolution,
          title: "图片分辨率"
        })
      }
    },
    defaultInput: {
      prompt: "",
      urls: [],
      ...(supportsRatio ? { aspectRatio: defaultAspect } : {}),
      resolution: spec.defaultResolution
    },
    capabilities: { mediaKind: "image", operations: ["text-to-image", "image-to-image"], cancel: false }
  };
}

function describeVideo(modelId: string): PptaskDescription {
  return {
    providerId: TOKENHUB_PROVIDER_ID,
    modelId,
    modelType: "video",
    title: modelId,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        urls: referenceImageSchema(3),
        aspectRatio: aspectRatioField({ ratios: VIDEO_ASPECTS, fallback: "16:9", adaptive: false, title: "比例" }),
        resolution: resolutionField({ tiers: ["720p", "1080p", "4K"], fallback: "720p", title: "分辨率" }),
        duration: {
          type: "number",
          title: "时长（秒）",
          default: 5,
          minimum: 1,
          maximum: 15,
          "x-component": "NumberPicker"
        }
      }
    },
    defaultInput: { prompt: "", urls: [], aspectRatio: "16:9", resolution: "720p", duration: 5 },
    capabilities: { mediaKind: "video", operations: ["text-to-video", "image-to-video"], cancel: false }
  };
}

function promptSchema(): Record<string, unknown> {
  return { type: "string", title: "提示词", required: true, "x-component": "Input.TextArea", "x-component-props": { rows: 4 } };
}

function referenceImageSchema(maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    title: "参考图",
    maxItems,
    "x-pptask-semantic": "reference-image",
    "x-component": "Upload",
    "x-component-props": { maxCount: maxItems }
  };
}

function operationOf(operation: unknown): { taskId: string; family: string } {
  const row = record(operation);
  return {
    taskId: typeof row?.taskId === "string" ? row.taskId : "",
    family: typeof row?.family === "string" ? row.family : ""
  };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? Math.min(8192, number) : fallback;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

export type { TokenHubKind };
