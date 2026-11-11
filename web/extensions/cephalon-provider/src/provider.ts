/**
 * 端脑云执行。
 *
 * 文本：`POST /user-center/v1/model/chat/completions`（同步）。
 * 图片：`POST /user-center/v1/model/images/generations`（同步，结果地址交给宿主下载入库）。
 * 视频：`POST /user-center/v1/model/video/tasks` 拿任务 ID，再 `GET .../video/tasks/{id}` 轮询。
 *
 * 平台地址不接受用户配置：构造时只认 `shared.ts` 里的固定 origin，凭据不会被改写到别的
 * 主机。视频的模型名必须放在 `Model-Name` 请求头（body 里的 `model` 无效），见 routes.ts 注释。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import {
  ADAPTIVE_PARAMETER_VALUE,
  aspectRatioField,
  resolutionField
} from "@woohaa3/contracts";
import {
  createHttpProvider,
  jsonRequest,
  mergeHeaders,
  normalizeProviderConfig,
  requestJson,
  type CommonProviderOptions,
  type HttpExecutionContext,
  type HttpProviderProtocol
} from "@sdppp/pptask/providers/shared";
import type { DiscoveredModel } from "./discovery.js";
import {
  buildChatBody,
  buildImageBody,
  buildVideoBody,
  imageResultBase64,
  imageResultUrls,
  interpretStatus,
  readTaskId,
  submitError,
  statusPath,
  videoSpecFor,
  CHAT_PATH,
  IMAGES_PATH,
  VIDEO_TASKS_PATH
} from "./routes.js";
import { CEPHALON_ORIGIN, CEPHALON_PROVIDER_ID } from "./shared.js";

export type CephalonProviderOptions = CommonProviderOptions & {
  apiKey: string;
  /**
   * 发现到的模型：模态校验、视觉能力与描述都从这里取事实，不按 id 猜。
   *
   * 传数组引用而不是快照：刷新后目录会原地替换，provider 必须看到新集合。
   */
  models?: readonly DiscoveredModel[];
  /**
   * 文本请求的完整地址（OpenAI 兼容 chat/completions）。
   *
   * 站点连接经 `serviceConnectionFactory` 传入时使用它；缺省走平台固定地址。
   * 只有这一个端点可被覆盖——图片与视频仍固定发往平台 origin，凭据不会被改写到别的主机。
   */
  chatEndpoint?: string;
};

const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

/** 未配置 Key 时的保守输出上限，避免面板给一个平台不接受的值。 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Cephalon provider。
 *
 * 文本与图片同步返回；视频全部异步（`start` + `status`）。凭据在构造时传入，地址固定。
 */
export function createCephalonProvider(options: CephalonProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(
    CEPHALON_PROVIDER_ID,
    { ...options, baseURL: CEPHALON_ORIGIN },
    CEPHALON_ORIGIN
  );
  // 站点连接会传入完整 chat 地址；未传时走平台固定路径。只影响文本，图片/视频仍固定 origin。
  const chatUrl = (options.chatEndpoint ?? "").trim() || `${CEPHALON_ORIGIN}${CHAT_PATH}`;
  const catalog = options.models ?? [];
  const findModel = (id: string): DiscoveredModel | undefined =>
    catalog.find((model) => model.id === id.trim());

  const protocol: HttpProviderProtocol = {
    providerId: CEPHALON_PROVIDER_ID,
    fetch: config.fetch,
    modelTypes: ["language", "image", "video"],
    mode(_modelId, modelType) {
      return modelType === "video" ? "async" : "sync";
    },
    validateModel(modelId, modelType) {
      const id = modelId.trim();
      if (!id) throw new Error("端脑云模型 id 不能为空");
      const model = findModel(id);
      // 目录里没有该模型时只校验模态可达性：目录可能在任务创建后被刷新下架，
      // 此时不应把已提交任务判成参数错误。
      if (model && model.modelType !== modelType) {
        throw new Error(`端脑云模型 ${id} 是${labelOf(model.modelType)}模型，不能按${labelOf(modelType)}执行`);
      }
      if (!isSupportedType(modelType)) throw new Error(`端脑云不支持 ${modelType} 模型`);
    },
    async execute(context) {
      if (context.modelType === "language") return executeText(context, config, findModel, chatUrl);
      if (context.modelType === "image") return executeImage(context, config);
      throw new Error(`端脑云不支持同步执行 ${context.modelType} 模型`);
    },
    async start(context) {
      const payload = await postJson(
        config,
        VIDEO_TASKS_PATH,
        buildVideoBody(context.modelId, context.input),
        context,
        // 平台按请求头定位模型与渠道；body 里的 model 会被忽略。
        { "model-name": context.modelId }
      );
      const rejected = submitError(payload);
      if (rejected) throw new Error(rejected);
      const taskId = readTaskId(payload);
      if (!taskId) throw new Error("端脑云未返回任务 ID");
      return { operation: { taskId } };
    },
    async status(context) {
      const taskId = operationTaskId(context.operation);
      if (!taskId) return { state: "failed", error: "端脑云任务缺少 task id" };
      const payload = await getJson(config, statusPath(taskId), context, { "model-name": context.modelId });
      const view = interpretStatus(payload);
      if (view.state === "pending") {
        return {
          state: "pending",
          phase: view.phase,
          ...(view.progress !== undefined ? { progress: view.progress } : {})
        };
      }
      if (view.state === "failed") return { state: "failed", error: view.error };
      return { state: "completed", output: { videos: view.urls.map((url) => ({ url })) } };
    },
    describe: async (modelId, modelType) => describeCephalonModel(modelId, modelType, findModel(modelId))
  };

  return createHttpProvider(protocol, options);
}

/** 三类模型的描述。参数只列平台文档确认可用的字段。 */
export function describeCephalonModel(
  modelId: string,
  modelType: PptaskModelType,
  model?: DiscoveredModel
): PptaskDescription {
  if (modelType === "language") return describeText(modelId, model);
  if (modelType === "video") return describeVideo(modelId);
  if (modelType === "image") return describeImage(modelId);
  throw new Error(`端脑云不支持描述 ${modelType} 模型：${modelId}`);
}

async function executeText(
  context: HttpExecutionContext,
  config: { apiKey?: string; fetch: typeof globalThis.fetch },
  findModel: (id: string) => DiscoveredModel | undefined,
  chatUrl: string
): Promise<unknown> {
  // 视觉能力取平台声明：未声明 `supports_vision` 的模型不带图片，避免上游 400。
  const supportsVision = findModel(context.modelId)?.supportsVision === true;
  const body = buildChatBody(context.modelId, context.input, { supportsVision });
  return postJsonAt(config, chatUrl, body, context);
}

async function executeImage(
  context: HttpExecutionContext,
  config: { apiKey?: string; fetch: typeof globalThis.fetch }
): Promise<unknown> {
  const payload = await postJson(config, IMAGES_PATH, buildImageBody(context.modelId, context.input), context);
  const rejected = submitError(payload);
  if (rejected) throw new Error(rejected);
  const urls = imageResultUrls(payload);
  if (urls.length === 0) {
    // `b64_json` 交给宿主既有入库路径（共享 output 解析认 base64/b64_json）。
    const inline = imageResultBase64(payload);
    if (inline.length === 0) throw new Error("端脑云没有返回图片");
    return { data: inline.map((value) => ({ b64_json: value })) };
  }
  return { data: urls.map((url) => ({ url })) };
}

async function postJson(
  config: { apiKey?: string; fetch: typeof globalThis.fetch },
  path: string,
  body: unknown,
  context: HttpExecutionContext,
  extra?: Record<string, string>
): Promise<unknown> {
  return postJsonAt(config, `${CEPHALON_ORIGIN}${path}`, body, context, extra);
}

/** 直接向已解析的完整地址 POST（文本连接可被来源 endpoint 覆盖时使用）。 */
async function postJsonAt(
  config: { apiKey?: string; fetch: typeof globalThis.fetch },
  url: string,
  body: unknown,
  context: HttpExecutionContext,
  extra?: Record<string, string>
): Promise<unknown> {
  return requestJson(
    config.fetch,
    CEPHALON_PROVIDER_ID,
    jsonRequest(url, body, mergeHeaders(authHeaders(config.apiKey ?? ""), extra, context.headers)),
    context.signal
  );
}

async function getJson(
  config: { apiKey?: string; fetch: typeof globalThis.fetch },
  path: string,
  context: HttpExecutionContext,
  extra?: Record<string, string>
): Promise<unknown> {
  return requestJson(
    config.fetch,
    CEPHALON_PROVIDER_ID,
    {
      url: `${CEPHALON_ORIGIN}${path}`,
      method: "GET",
      headers: mergeHeaders(authHeaders(config.apiKey ?? ""), extra, context.headers)
    },
    context.signal
  );
}

function describeText(modelId: string, model?: DiscoveredModel): PptaskDescription {
  const maxTokens = model?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const supportsVision = model?.supportsVision === true;
  return {
    providerId: CEPHALON_PROVIDER_ID,
    modelId,
    modelType: "language",
    title: modelId,
    inputSchema: {
      type: "object",
      properties: {
        prompt: promptSchema(),
        system: { type: "string", title: "系统提示词", "x-component": "Input.TextArea" },
        // 只有平台声明视觉能力的模型才给参考图控件：给不了就是在骗点击。
        ...(supportsVision ? { urls: referenceImageSchema(4) } : {}),
        maxTokens: {
          type: "number",
          title: "最大输出 Token",
          default: Math.min(2048, maxTokens),
          minimum: 1,
          maximum: maxTokens,
          "x-component": "NumberPicker"
        },
        jsonMode: { type: "boolean", title: "JSON 输出", default: false, "x-component": "Switch" }
      }
    },
    defaultInput: {
      prompt: "",
      system: "",
      ...(supportsVision ? { urls: [] } : {}),
      maxTokens: Math.min(2048, maxTokens),
      jsonMode: false
    },
    capabilities: { mediaKind: "text", operations: ["text-generation"], cancel: false }
  };
}

function describeImage(modelId: string): PptaskDescription {
  return {
    providerId: CEPHALON_PROVIDER_ID,
    modelId,
    modelType: "image",
    title: modelId,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        // 平台只校验 `size` 的这两个形态（档位或像素），没有可用性证据的比例字段不给。
        resolution: resolutionField({
          tiers: ["auto", "1K", "2K", "4K"],
          fallback: "1K",
          title: "图片分辨率"
        }),
        n: {
          type: "number",
          title: "数量",
          default: 1,
          minimum: 1,
          maximum: 10,
          "x-component": "NumberPicker"
        }
      }
    },
    defaultInput: { prompt: "", resolution: "1K", n: 1 },
    // 平台没有 `/images/edits`（404）：只声明文生图，不给图生图/编辑。
    capabilities: { mediaKind: "image", operations: ["text-to-image"], cancel: false }
  };
}

function describeVideo(modelId: string): PptaskDescription {
  const spec = videoSpecFor(modelId);
  // 平台只列出模型的模态，没有参数元数据；分辨率只在平台报错信息里确认过取值域时才给控件。
  const hasResolution = spec.resolutions.length > 0;
  return {
    providerId: CEPHALON_PROVIDER_ID,
    modelId,
    modelType: "video",
    title: modelId,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: promptSchema(),
        urls: referenceImageSchema(spec.maxImages),
        aspectRatio: aspectRatioField({
          ratios: VIDEO_ASPECT_RATIOS,
          fallback: ADAPTIVE_PARAMETER_VALUE,
          adaptive: true,
          title: "比例"
        }),
        ...(hasResolution
          ? {
              resolution: resolutionField({
                tiers: spec.resolutions,
                fallback: spec.defaultResolution,
                title: "分辨率"
              })
            }
          : {}),
        duration: {
          type: "number",
          title: "时长（秒）",
          default: 5,
          minimum: 4,
          maximum: spec.maxDuration,
          "x-component": "NumberPicker"
        }
      }
    },
    defaultInput: {
      prompt: "",
      urls: [],
      aspectRatio: ADAPTIVE_PARAMETER_VALUE,
      ...(hasResolution ? { resolution: spec.defaultResolution } : {}),
      duration: 5
    },
    capabilities: { mediaKind: "video", operations: ["text-to-video", "image-to-video"], cancel: false }
  };
}

function promptSchema(): Record<string, unknown> {
  return {
    type: "string",
    title: "提示词",
    required: true,
    "x-component": "Input.TextArea",
    "x-component-props": { rows: 4 }
  };
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

function operationTaskId(operation: unknown): string {
  const row = record(operation);
  const value = row?.taskId;
  return typeof value === "string" ? value.trim() : "";
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function labelOf(modelType: PptaskModelType): string {
  if (modelType === "language") return "文本";
  if (modelType === "image") return "图片";
  if (modelType === "video") return "视频";
  return String(modelType);
}

function isSupportedType(value: string): boolean {
  return value === "language" || value === "image" || value === "video";
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}
