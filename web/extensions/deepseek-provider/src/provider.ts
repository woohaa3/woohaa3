/**
 * DeepSeek 官方执行。
 *
 * 只有文本：`POST {origin}/v1/chat/completions`（OpenAI 兼容，同步返回）。图片理解、
 * 思考模式与 JSON 输出都走这同一个端点，差异只在请求字段：
 * - 参考图 → `content` 里的 `image_url` 块（只有目录声明 `image` 输入的模型才发）；
 * - 思考模式 → `thinking: { type: "enabled" | "disabled" }`，档位 → `reasoning_effort`；
 * - JSON 输出 → `response_format: { type: "json_object" }`。
 *
 * 官方地址固定（`shared.ts`），不接受用户配置：凭据只能发往 `api.deepseek.com`。
 * 思考模式下 `temperature` / `presence_penalty` / `frequency_penalty` 不生效，因此
 * 开启思考时**不发送**这三个字段，避免面板上的值与真实行为不一致。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import {
  createHttpProvider,
  jsonRequest,
  mergeHeaders,
  normalizeLanguagePrompt,
  normalizeProviderConfig,
  requestJson,
  type CommonProviderOptions,
  type HttpExecutionContext,
  type HttpProviderProtocol
} from "@sdppp/pptask/providers/shared";
import type { DeepSeekModel } from "./discovery.js";
import {
  DEEPSEEK_CHAT_PATH,
  DEEPSEEK_ORIGIN,
  DEEPSEEK_PROVIDER_ID
} from "./shared.js";

export type DeepSeekProviderOptions = CommonProviderOptions & {
  apiKey: string;
  /**
   * 发现到的模型：视觉能力、输出上限与思考档位都从这里取事实，不按 id 猜。
   * 传数组引用而不是快照：刷新后目录原地替换，provider 必须看到新集合。
   */
  models?: readonly DeepSeekModel[];
};

/** 未配置模型事实时的保守输出上限，避免面板给一个官方不接受的值。 */
const DEFAULT_MAX_TOKENS = 8192;

const THINKING_VALUES = ["enabled", "disabled"] as const;

export function createDeepSeekProvider(options: DeepSeekProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(DEEPSEEK_PROVIDER_ID, { ...options, baseURL: DEEPSEEK_ORIGIN }, DEEPSEEK_ORIGIN);
  const catalog = options.models ?? [];
  const findModel = (id: string): DeepSeekModel | undefined => catalog.find((model) => model.id === id.trim());

  const protocol: HttpProviderProtocol = {
    providerId: DEEPSEEK_PROVIDER_ID,
    fetch: config.fetch,
    // 只有文本。图片/视频/语音本期没有执行协议，注册进去只会得到一个点了就报错的面板。
    modelTypes: ["language"],
    mode: () => "sync",
    validateModel(modelId, modelType) {
      const id = modelId.trim();
      if (!id) throw new Error("DeepSeek 模型 id 不能为空");
      if (modelType !== "language") throw new Error(`DeepSeek 不支持 ${modelType} 模型：${id}`);
    },
    async execute(context) {
      if (context.modelType !== "language") {
        throw new Error(`DeepSeek 只实现文本模型，收到 ${context.modelType}`);
      }
      return executeText(context, config, findModel(context.modelId));
    },
    status: async () => {
      throw new Error("DeepSeek 文本模型同步返回，没有作业状态");
    },
    describe: async (modelId, modelType) => describeDeepSeekModel(modelId, modelType, findModel(modelId))
  };

  return createHttpProvider(protocol, options);
}

/** 模型描述：字段随目录事实变化（视觉参考图、输出上限、思考档位）。 */
export function describeDeepSeekModel(
  modelId: string,
  modelType: PptaskModelType,
  model?: DeepSeekModel
): PptaskDescription {
  if (modelType !== "language") throw new Error(`DeepSeek 不支持描述 ${modelType} 模型：${modelId}`);
  const maxTokens = model?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const supportsVision = model?.supportsVision === true;
  const efforts = model?.reasoningEfforts;
  const defaultEffort = model?.defaultReasoningEffort
    ?? (efforts && efforts.includes("high") ? "high" : efforts?.[0]);
  const defaultMaxTokens = Math.min(2048, maxTokens);
  return {
    providerId: DEEPSEEK_PROVIDER_ID,
    modelId,
    modelType: "language",
    title: model?.title ?? modelId,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", title: "提示词", required: true, "x-component": "Input.TextArea", "x-component-props": { rows: 4 } },
        system: { type: "string", title: "系统提示词", "x-component": "Input.TextArea" },
        // 只有目录声明图片输入的模型才给参考图控件：给不了就是在骗点击（上游会 400）。
        ...(supportsVision ? { urls: referenceImageSchema(8) } : {}),
        maxTokens: {
          type: "number",
          title: "最大输出 Token",
          default: defaultMaxTokens,
          minimum: 1,
          maximum: maxTokens,
          "x-component": "NumberPicker"
        },
        jsonMode: { type: "boolean", title: "JSON 输出", default: false, "x-component": "Switch" },
        // 思考模式默认开启（官方语义）；关闭时回到普通对话。
        thinking: selectSchema("思考模式", [
          { label: "开启", value: "enabled" },
          { label: "关闭", value: "disabled" }
        ], "enabled"),
        // 官方只有列出档位的模型才给这个控件；未声明的模型不猜。
        ...(efforts && efforts.length > 0
          ? { reasoningEffort: selectSchema("思考强度", efforts.map((effort) => ({ label: effort, value: effort })), defaultEffort ?? efforts[0]!) }
          : {})
      }
    },
    defaultInput: {
      prompt: "",
      system: "",
      ...(supportsVision ? { urls: [] } : {}),
      maxTokens: defaultMaxTokens,
      jsonMode: false,
      thinking: "enabled",
      ...(efforts && efforts.length > 0 ? { reasoningEffort: defaultEffort ?? efforts[0] } : {})
    },
    capabilities: { mediaKind: "text", operations: ["text-generation"], cancel: false },
    ...(efforts === undefined
      ? {}
      : { capabilityFacts: { reasoning: { supported: true, ...(efforts.length > 0 ? { efforts } : {}) } } })
  };
}

async function executeText(
  context: HttpExecutionContext,
  config: { apiKey?: string; fetch: typeof globalThis.fetch },
  model: DeepSeekModel | undefined
): Promise<unknown> {
  const input = context.input;
  const thinking = readThinking(input.thinking);
  const body: Record<string, unknown> = {
    model: context.modelId,
    messages: chatMessages(input, model?.supportsVision === true),
    max_tokens: capMaxTokens(input.max_tokens ?? input.maxTokens, model?.maxOutputTokens)
  };
  if (input.jsonMode === true) body.response_format = { type: "json_object" };
  if (thinking !== undefined) body.thinking = { type: thinking };
  // 档位只在模型声明了思考能力时下发：没声明的模型给这个字段只会得到一个静默忽略的值。
  const effort = readEffort(input.reasoningEffort ?? input.reasoning_effort ?? input.reasoning, model);
  if (effort !== undefined) body.reasoning_effort = effort;
  // 思考模式下这三个采样参数不生效，发了会让面板上的值与真实行为不一致。
  if (thinking !== "enabled") {
    assignIfPresent(body, "temperature", input.temperature);
    assignIfPresent(body, "top_p", input.top_p);
    assignIfPresent(body, "presence_penalty", input.presence_penalty);
    assignIfPresent(body, "frequency_penalty", input.frequency_penalty);
  }
  assignIfPresent(body, "stop", input.stop);
  return requestJson(
    config.fetch,
    DEEPSEEK_PROVIDER_ID,
    jsonRequest(
      `${DEEPSEEK_ORIGIN}/v1${DEEPSEEK_CHAT_PATH}`,
      body,
      mergeHeaders(authHeaders(config.apiKey ?? ""), context.headers)
    ),
    context.signal
  );
}

/** Chat Completions 消息；参考图按目录声明的视觉能力追加到最后一条 user 消息。 */
function chatMessages(input: Record<string, unknown>, supportsVision: boolean): unknown[] {
  const normalized = normalizeLanguagePrompt(input).messages;
  const list = Array.isArray(normalized) ? [...normalized] : [];
  const system = typeof input.system === "string" ? input.system.trim() : "";
  if (system && !list.some((message) => record(message)?.role === "system")) {
    list.unshift({ role: "system", content: system });
  }
  if (!supportsVision) return list;
  const refs = referenceUrls(input);
  if (refs.length > 0) attachImages(list, refs);
  return list;
}

function attachImages(messages: unknown[], urls: readonly string[]): void {
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
  for (const url of urls) if (!existing.has(url)) content.push(imagePart(url));
  row.content = content;
}

function imagePart(url: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url } };
}

function referenceUrls(input: Record<string, unknown>): string[] {
  const raw = input.urls ?? input.images ?? input.files;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      // AI SDK 的 file 形状（url 或 data URL）也要认。
      const row = record(item);
      const url = row?.url ?? row?.image_url;
      return typeof url === "string" ? [url] : [];
    })
    .filter((url) => url.length > 0)
    .slice(0, 8);
}

/** `enabled` / `disabled`；缺省 undefined 表示不下发（沿用官方默认：开启）。 */
function readThinking(value: unknown): "enabled" | "disabled" | undefined {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return typeof value === "string" && (THINKING_VALUES as readonly string[]).includes(value)
    ? value as "enabled" | "disabled"
    : undefined;
}

/**
 * 档位只取模型声明过的值；未声明思考能力的模型一律不转发。
 *
 * 官方对未知档位是映射到最近档位而不是报错，所以这里必须在本地拒绝越界值，
 * 否则面板写 `minimal` 也能「成功」，任务记录里留下的却是一个用户以为存在的档位。
 */
function readEffort(value: unknown, model: DeepSeekModel | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim();
  // `provider-default` 是 AI SDK 的「交给上游默认」，不是档位名。
  if (effort === "" || effort === "provider-default") return undefined;
  const declared = model?.reasoningEfforts;
  if (declared === undefined) return undefined;
  if (declared.length > 0 && !declared.includes(effort)) {
    throw new Error(`DeepSeek 模型 ${model?.id ?? ""} 不支持思考强度「${effort}」（支持：${declared.join(" / ")}）`);
  }
  return effort;
}

function capMaxTokens(value: unknown, ceiling: number | undefined): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  const fallback = Math.min(2048, ceiling ?? DEFAULT_MAX_TOKENS);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(number, ceiling ?? DEFAULT_MAX_TOKENS);
}

function selectSchema(
  title: string,
  values: readonly { label: string; value: string }[],
  fallback: string
): Record<string, unknown> {
  return { type: "string", title, default: fallback, enum: values, "x-component": "Select" };
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

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function assignIfPresent(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) body[key] = value;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
