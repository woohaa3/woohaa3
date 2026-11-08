/**
 * RunningHub 文字模型执行（OpenAI 兼容 Chat Completions）。
 *
 * 端点与媒体任务 API 分开：`https://llm.runninghub.ai/v1/chat/completions`，Bearer Key。
 * 只实现官方文档确认的同步与流式请求；工具调用按 OpenAI `tool_calls` 结构双向映射，
 * 流式解析标准 `data:` SSE。图片输入只有在模型目录声明 `vision` 时才会被 Agent 允许，
 * 这里仍按上游 Chat Completions 的 `image_url` 结构传递。
 */
import type {
  JSONValue,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolResultOutput
} from "@ai-sdk/provider";
import type { PptaskLanguageModelImplementation } from "@sdppp/pptask";

export type RunningHubLanguageConfig = {
  apiKey: string;
  baseURL: string;
  fetch: typeof globalThis.fetch;
};

type ChatResponse = {
  error?: { message?: unknown; type?: unknown; code?: unknown };
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: Record<string, unknown>;
};

export function createRunningHubLanguageModel(modelId: string, config: RunningHubLanguageConfig): PptaskLanguageModelImplementation {
  return {
    supportedUrls: {},
    async doGenerate(options) {
      const body = chatBody(modelId, options, false);
      const response = await send(config, body, options.abortSignal, options.headers);
      const choice = response.choices?.[0];
      const message = choice?.message ?? {};
      const content: LanguageModelV4Content[] = [];
      const reasoning = textOf(message.reasoning_content);
      if (reasoning) content.push({ type: "reasoning", text: reasoning });
      const text = textOf(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of toolCallsOf(message.tool_calls)) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.arguments ?? {}) });
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
      return {
        content,
        finishReason: finishReasonOf(choice?.finish_reason, content.some(part => part.type === "tool-call")),
        usage: usageOf(response.usage),
        warnings: [],
        providerMetadata: { runninghub: { modelId } },
        request: { body },
        response: { timestamp: new Date(), modelId, body: response as JSONValue }
      };
    },
    async doStream(options) {
      const body = chatBody(modelId, options, true);
      const response = await sendRaw(config, body, options.abortSignal, options.headers);
      return {
        stream: streamOf(response, modelId),
        request: { body },
        response: { headers: headersOf(response) }
      } satisfies LanguageModelV4StreamResult;
    }
  };
}

/** Chat Completions 请求体；只放官方示例确认的字段。 */
export function chatBody(modelId: string, options: LanguageModelV4CallOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: chatMessages(options.prompt),
    stream
  };
  if (stream) body.stream_options = { include_usage: true };
  const optional: Array<[string, unknown]> = [
    ["max_tokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["top_p", options.topP],
    ["stop", options.stopSequences],
    ["presence_penalty", options.presencePenalty],
    ["frequency_penalty", options.frequencyPenalty],
    ["seed", options.seed],
    ["reasoning_effort", options.reasoning === "provider-default" ? undefined : options.reasoning]
  ];
  for (const [key, value] of optional) if (value !== undefined) body[key] = value;
  const tools = (options.tools ?? []).flatMap(tool => tool.type === "function"
    ? [{ type: "function", function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.inputSchema } }]
    : []);
  if (tools.length > 0) body.tools = tools;
  if (options.toolChoice) {
    body.tool_choice = options.toolChoice.type === "tool"
      ? { type: "function", function: { name: options.toolChoice.toolName } }
      : options.toolChoice.type;
  }
  if (options.responseFormat?.type === "json") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

/**
 * AI SDK prompt → Chat Completions messages。
 *
 * 工具调用与工具结果必须保留在上下文里，否则多轮目标执行会被上游当成全新对话。
 */
export function chatMessages(prompt: LanguageModelV4CallOptions["prompt"]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          out.push({ role: "tool", tool_call_id: part.toolCallId, content: toolOutputText(part.output) });
        }
      }
      continue;
    }
    const parts = message.content as unknown as ReadonlyArray<Record<string, unknown>>;
    if (message.role === "assistant") {
      const text = parts.filter(part => part.type === "text").map(part => String(part.text ?? "")).join("");
      const calls = parts.filter(part => part.type === "tool-call").map(part => ({
        id: String(part.toolCallId ?? ""),
        type: "function" as const,
        function: { name: String(part.toolName ?? ""), arguments: JSON.stringify(part.input ?? {}) }
      }));
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {})
      });
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push({ type: "text", text: String(part.text ?? "") });
        continue;
      }
      const url = fileUrl(part);
      if (url) content.push({ type: "image_url", image_url: { url } });
    }
    out.push({
      role: "user",
      content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content
    });
  }
  return out;
}

function fileUrl(part: Record<string, unknown>): string | undefined {
  if (part.type !== "file") return undefined;
  const mediaType = typeof part.mediaType === "string" ? part.mediaType : "";
  if (!mediaType.startsWith("image/")) return undefined;
  const data = part.data;
  if (typeof data === "string") return data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
  if (data instanceof Uint8Array) return `data:${mediaType};base64,${bytesToBase64(data)}`;
  if (data && typeof data === "object") {
    const tagged = data as Record<string, unknown>;
    if (tagged.type === "url" && typeof tagged.url === "string") return tagged.url;
    if (tagged.type === "data" && typeof tagged.data === "string") return `data:${mediaType};base64,${tagged.data}`;
  }
  return undefined;
}

function toolOutputText(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === "text") return output.value;
  if (output.type === "json") return JSON.stringify(output.value);
  if (output.type === "content") {
    return output.value.map(part => part.type === "text" ? part.text : "[image]").join("");
  }
  return "";
}

async function send(
  config: RunningHubLanguageConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  headers?: Record<string, string | undefined>
): Promise<ChatResponse> {
  const response = await sendRaw(config, body, signal, headers);
  const text = await response.text();
  let parsed: ChatResponse;
  try {
    parsed = text ? JSON.parse(text) as ChatResponse : {};
  } catch {
    throw new Error(`RunningHub 文字模型返回了非 JSON 响应（HTTP ${response.status}）`);
  }
  if (parsed.error) throw new Error(`RunningHub 文字模型失败：${textOf(parsed.error.message) ?? "未知错误"}`);
  return parsed;
}

async function sendRaw(
  config: RunningHubLanguageConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  headers?: Record<string, string | undefined>
): Promise<Response> {
  const response = await config.fetch(`${config.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      ...definedHeaders(headers),
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: body.stream === true ? "text/event-stream" : "application/json"
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error("RunningHub 文字模型权限不足：需要 Enterprise-Shared API Key");
    }
    if (response.status === 429) throw new Error("RunningHub 文字模型触发限流，请稍后重试");
    throw new Error(`RunningHub 文字模型 HTTP ${response.status}：${text.slice(0, 500)}`);
  }
  return response;
}

function streamOf(response: Response, modelId: string): ReadableStream<LanguageModelV4StreamPart> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textStarted = false;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Record<string, unknown> | undefined;
  let finish: unknown;

  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
    },
    async pull(controller) {
      if (!reader) {
        controller.close();
        return;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          processBuffer(true);
          controller.enqueue({
            type: "finish",
            usage: usageOf(usage),
            finishReason: finishReasonOf(finish, toolCalls.size > 0),
            providerMetadata: { runninghub: { modelId } }
          });
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        if (processBuffer(false)) return;
      }

      function processBuffer(final: boolean): boolean {
        const lines = buffer.split(/\r?\n/);
        buffer = final ? "" : lines.pop() ?? "";
        for (const line of final ? lines : lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let chunk: ChatResponse;
          try {
            chunk = JSON.parse(payload) as ChatResponse;
          } catch {
            continue;
          }
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason !== undefined) finish = choice.finish_reason;
          const delta = choice.delta ?? {};
          const reasoning = textOf(delta.reasoning_content);
          if (reasoning) controller.enqueue({ type: "reasoning-delta", id: "reasoning", delta: reasoning });
          const text = textOf(delta.content);
          if (text) {
            if (!textStarted) {
              textStarted = true;
              controller.enqueue({ type: "text-start", id: "text" });
            }
            controller.enqueue({ type: "text-delta", id: "text", delta: text });
          }
          for (const call of rawToolCalls(delta.tool_calls)) {
            const current = toolCalls.get(call.index) ?? { id: call.id ?? `tool-${call.index}`, name: call.name ?? "", arguments: "" };
            if (call.id) current.id = call.id;
            if (call.name) current.name = call.name;
            if (call.arguments) current.arguments += call.arguments;
            toolCalls.set(call.index, current);
          }
        }
        return false;
      }
    },
    cancel() {
      void reader?.cancel();
    }
  }).pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
    transform(part, controller) {
      if (part.type === "finish") {
        if (textStarted) controller.enqueue({ type: "text-end", id: "text" });
        for (const [index, call] of toolCalls) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: call.id || `tool-${index}`,
            toolName: call.name,
            input: call.arguments === "" ? "{}" : call.arguments
          });
        }
      }
      controller.enqueue(part);
    }
  }));
}

type RawToolCall = { index: number; id?: string; name?: string; arguments?: string };

function rawToolCalls(value: unknown): RawToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, fallbackIndex) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
    return [{
      index: typeof record.index === "number" ? record.index : fallbackIndex,
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(typeof fn.name === "string" ? { name: fn.name } : {}),
      ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {})
    }];
  });
}

type ParsedToolCall = { id: string; name: string; arguments: unknown };

function toolCallsOf(value: unknown): ParsedToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
    return [{
      id: typeof record.id === "string" && record.id !== "" ? record.id : `tool-${index}`,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? safeJson(fn.arguments) : fn.arguments ?? {}
    }];
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function finishReasonOf(raw: unknown, hasToolCalls: boolean): LanguageModelV4FinishReason {
  const value = typeof raw === "string" ? raw : undefined;
  if (hasToolCalls || value === "tool_calls" || value === "tool-calls") return { unified: "tool-calls", raw: value };
  if (value === "length") return { unified: "length", raw: value };
  if (value === "content_filter") return { unified: "content-filter", raw: value };
  if (value === "error") return { unified: "error", raw: value };
  return { unified: "stop", raw: value };
}

function usageOf(raw: Record<string, unknown> | undefined): LanguageModelV4GenerateResult["usage"] {
  const input = numberValue(raw?.prompt_tokens ?? raw?.input_tokens);
  const output = numberValue(raw?.completion_tokens ?? raw?.output_tokens);
  const reasoning = numberValue((raw?.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning }
  };
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function definedHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
