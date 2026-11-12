/**
 * 远端 OpenAI 兼容面客户端（助手通路专用）。
 *
 * 为什么不复用 `sdk-agent` 的 `model-transport`：那个转发器只拨公网地址
 * （`publicAddress` 拒绝 10./172.16-31./192.168./127. 等），而远端服务端常态部署在内网。
 * 放宽它等于拆掉所有 Provider 的 SSRF 防线，所以这里自己发请求——会话令牌本来就在
 * 这个进程里，不需要 loopback 中转。
 *
 * 端点形状与 OpenAI 一致（`/v1/models`、`/v1/chat/completions`），因此
 * `deepseek` / `litellm` 那类"Provider 直接当助手"的语义在这里由扩展自己承担。
 */
import { resolveRemoteEndpoints } from "../../shared.js";
import type { RemoteSession } from "../session.js";

/** 单次非流式调用的上限。讨论回合可能很长，但挂住比失败更糟。 */
const REQUEST_TIMEOUT_MS = 120_000;

/** 一次会话式完成的结果。 */
export type RemoteChatResult =
  | {
      ok: true;
      text: string;
      /** 模型要求调用的工具；非空时 `text` 通常为空。 */
      toolCalls: RemoteToolCall[];
      /** 结束原因（stop / length / tool_calls …）。 */
      finishReason: string;
    }
  | { ok: false; code: string; message: string };

/** 目录里的一个文本模型。 */
export type RemoteChatModel = { id: string; label: string };

/** 兼容面调用的共同依赖。 */
export type RemoteChatTransportOptions = {
  fetchImpl: typeof globalThis.fetch;
  session: () => Promise<Pick<RemoteSession, "serverUrl" | "token"> | null>;
  /** 诊断出口（不含凭据）。 */
  log?: (event: Record<string, unknown>) => void;
};

/** 兼容面把失败折成稳定码，不把远端正文带出去。 */
function failure(status: number, code: string): RemoteChatResult {
  return { ok: false, code, message: chatErrorText(code, status) };
}

/**
 * 稳定短语。
 *
 * 远端正文里可能带模型名、上游请求 id 甚至部署信息，一律不转述：这里只按传输分类
 * 给一句可行动的话。
 */
export function chatErrorText(code: string, status = 0): string {
  switch (code) {
    case "unauthenticated":
      return "远端会话已失效，请重新登录";
    case "permission_denied":
      return "当前账号没有使用远端模型的权限";
    case "not_found":
      return "远端未开放该接口";
    case "unimplemented":
      return "这台服务端还没有开放助手接口";
    case "rate_limit":
      return "远端请求过于频繁或超出配额";
    case "unavailable":
      return "远端服务暂不可用";
    case "timeout":
      return "远端响应超时";
    case "unreachable":
      return "无法连接远端服务端";
    case "invalid":
      return "请求不被远端接受";
    default:
      return status >= 500 ? "远端服务暂不可用" : "远端调用失败";
  }
}

/** 把 HTTP 状态码折成稳定码。 */
function codeForStatus(status: number): string {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 404 || status === 501) return "unimplemented";
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid";
  return "unavailable";
}

/** 组装到兼容面的绝对地址。 */
function chatEndpoint(serverUrl: string, path: string): string {
  const { rpcBase } = resolveRemoteEndpoints(serverUrl);
  return `${rpcBase.replace(/\/+$/, "")}${path}`;
}

/**
 * 读取远端可用的文本模型。
 *
 * 失败时返回稳定原因而不是空数组：调用方需要区分「远端没有文本模型」与「这次没读到」，
 * 后者不该把已经可用的连接清空。
 */
export async function listRemoteChatModels(
  options: RemoteChatTransportOptions
): Promise<{ ok: true; models: RemoteChatModel[] } | { ok: false; code: string; message: string }> {
  const session = await options.session();
  if (!session) return { ok: false, code: "unauthenticated", message: chatErrorText("unauthenticated") };
  let response: Response;
  try {
    response = await options.fetchImpl(chatEndpoint(session.serverUrl, "/v1/models"), {
      method: "GET",
      headers: { Authorization: `Bearer ${session.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const code = timedOut ? "timeout" : "unreachable";
    return { ok: false, code, message: chatErrorText(code) };
  }
  if (!response.ok) {
    const code = codeForStatus(response.status);
    return { ok: false, code, message: chatErrorText(code, response.status) };
  }
  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models: RemoteChatModel[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    models.push({ id, label: id });
  }
  return { ok: true, models };
}

/** 一条对话消息。 */
export type RemoteChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  /** tool 消息可为空串以外必有值；assistant 带 tool_calls 时 content 允许为空串。 */
  content: string;
  /** assistant 要求调用的工具（OpenAI `tool_calls`）。 */
  toolCalls?: RemoteToolCall[];
  /** tool 消息对应的调用 id（OpenAI `tool_call_id`）。 */
  toolCallId?: string;
};

/** 一次工具调用（与 OpenAI 同形）。 */
export type RemoteToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** 给模型看的工具声明。 */
export type RemoteToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * 执行一次非流式会话式完成。
 *
 * `signal` 由助手的取消路径提供：远端请求必须能被真正中止，否则用户点了停止却还在
 * 消耗配额。
 *
 * `tools` 非空时带上工具声明，返回里可能出现 `toolCalls`（模型要求调工具，此时正文
 * 通常为空）。调用方据此进入工具执行回合。
 */
export async function chatRemote(
  options: RemoteChatTransportOptions,
  input: {
    model: string;
    messages: readonly RemoteChatMessage[];
    signal?: AbortSignal;
    tools?: readonly RemoteToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
  }
): Promise<RemoteChatResult> {
  const session = await options.session();
  if (!session) return { ok: false, code: "unauthenticated", message: chatErrorText("unauthenticated") };
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  // 一行最小诊断：模型收到几个工具声明。
  //
  // 只记数量、不记内容（prompt 与 schema 都是用户数据）。这一行值得留：模型收不到
  // `tools` 时会改用文本表达调用意图，症状是「助手返回了工具调用文本」，而根因在
  // 这一跳——没有这个计数就只能靠猜。
  if (input.tools !== undefined && input.tools.length > 0) {
    options.log?.({ event: "remote-assistant-chat-tools", count: input.tools.length });
  }
  let response: Response;
  try {
    response = await options.fetchImpl(chatEndpoint(session.serverUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map(serializeMessage),
        stream: false,
        ...(input.tools !== undefined && input.tools.length > 0
          ? {
              tools: input.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
            }
          : {}),
      }),
      signal,
    });
  } catch (error) {
    if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "已停止本次生成" };
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const code = timedOut ? "timeout" : "unreachable";
    return { ok: false, code, message: chatErrorText(code) };
  }
  if (!response.ok) {
    const code = codeForStatus(response.status);
    return failure(response.status, code);
  }
  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: { content?: unknown; tool_calls?: unknown };
    }>;
  } | null;
  const choice = payload?.choices?.[0];
  const toolCalls = parseToolCalls(choice?.message?.tool_calls);
  // 带 tool_calls 时正文通常是 null：这时不算错误，产出就是"要调哪些工具"。
  const rawContent = choice?.message?.content;
  const content = typeof rawContent === "string" ? rawContent : "";
  if (content === "" && toolCalls.length === 0) {
    return { ok: false, code: "invalid", message: chatErrorText("invalid") };
  }
  return {
    ok: true,
    text: content,
    toolCalls,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "",
  };
}

/** 把领域消息序列化成 OpenAI 形状（含 tool_calls / tool_call_id）。 */
function serializeMessage(message: RemoteChatMessage): Record<string, unknown> {
  const serialized: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    serialized.tool_calls = message.toolCalls;
    // 带工具调用时正文必须显式为 null：上游据此知道"这一条只含调用"。
    if (message.content === "") serialized.content = null;
  }
  if (message.toolCallId !== undefined) serialized.tool_call_id = message.toolCallId;
  return serialized;
}

/** 解析响应里的 tool_calls；形状不符的条目丢弃而不是让整次调用失败。 */
function parseToolCalls(raw: unknown): RemoteToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: RemoteToolCall[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const call = entry as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call.id !== "string" || typeof call.function?.name !== "string") continue;
    calls.push({
      id: call.id,
      type: "function",
      function: {
        name: call.function.name,
        // arguments 是 JSON 字符串；上游有时给对象，这里统一成字符串。
        arguments:
          typeof call.function.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? {}),
      },
    });
  }
  return calls;
}

/**
 * 执行一次流式会话式完成，逐段回调增量。
 *
 * `emit` 返回错误即中止（调用方断开连接时用它收尾）。返回前一定释放响应体：流式响应
 * 的连接不能被留在半开状态。
 */
export async function streamRemoteChat(
  options: RemoteChatTransportOptions,
  input: {
    model: string;
    messages: readonly RemoteChatMessage[];
    signal?: AbortSignal;
    emit: (delta: string) => Promise<void> | void;
  }
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const session = await options.session();
  if (!session) return { ok: false, code: "unauthenticated", message: chatErrorText("unauthenticated") };
  let response: Response;
  try {
    response = await options.fetchImpl(chatEndpoint(session.serverUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: true }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "已停止本次生成" };
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const code = timedOut ? "timeout" : "unreachable";
    return { ok: false, code, message: chatErrorText(code) };
  }
  if (!response.ok || !response.body) {
    const code = codeForStatus(response.status);
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, code, message: chatErrorText(code, response.status) };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 帧以空行分隔；保留最后一段未完整的缓冲等下一片。
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const delta = parseSseFrame(frame);
        if (delta === DONE) return { ok: true };
        if (delta !== "") {
          try {
            await input.emit(delta);
          } catch {
            // 调用方断开（浏览器关闭、回合取消）：主动停止读取上游。
            await reader.cancel().catch(() => undefined);
            return { ok: true };
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "已停止本次生成" };
    return { ok: false, code: "unreachable", message: chatErrorText("unreachable") };
  } finally {
    reader.releaseLock();
  }
  return { ok: true };
}

/** 流结束的哨兵值，与空增量区分开。 */
const DONE = Symbol("sse-done");

/**
 * 解析一帧 SSE。
 *
 * 返回 `DONE` 表示 `[DONE]` 终结帧；返回空串表示这一帧没有正文（心跳、角色帧、
 * 上游追加的未知字段）。**不因为解析失败而终止整条流**：上游可能追加本面不认识的
 * 字段，跳过比中断更接近用户预期。
 */
function parseSseFrame(frame: string): string | typeof DONE {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) continue;
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : "";
    if (payload === "") continue;
    if (payload === "[DONE]") return DONE;
    try {
      const chunk = JSON.parse(payload) as {
        model?: unknown;
        choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
        error?: { message?: unknown };
      };
      // 服务端在流中失败时发的 error 帧：正文已经不完整，交给调用方按失败收敛。
      if (chunk.error) return "";
      const choice = chunk.choices?.[0];
      for (const value of [choice?.delta?.content, choice?.message?.content]) {
        if (typeof value === "string" && value !== "") return value;
      }
    } catch {
      continue;
    }
  }
  return "";
}

/** 导出给测试用的帧解析（`model` 参数目前只用于诊断扩展）。 */
export const __test = { parseSseFrame, DONE };
