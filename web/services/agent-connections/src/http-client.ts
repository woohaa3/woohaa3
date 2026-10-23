/**
 * 有界 HTTP 客户端与凭据注入
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 5.1/5.2 / design D4/D6）。
 *
 * 纯 HTTP SDK 适配器共用：每次请求经 `endpoint-policy` 校验 origin，凭据只附加在通过策略的
 * 目标上；支持 `AbortSignal` 取消、超时与 JSON 协议编解码。**不**修改全局 `process.env`，
 * 不使用隐式环境凭据：Key 由调用方按连接解析后传入。
 */
import { guardedFetch, type EndpointPolicy } from "./endpoint-policy.js";

export type BoundedHttpClientOptions = {
  policy: EndpointPolicy;
  fetchImpl?: typeof globalThis.fetch;
  /**
   * 单请求的**显式**期限（毫秒）。缺省不设置：在途工作不因固定时长中止
   * （change: 2026-10-22-remove-agent-execution-limits，任务 2.5）；停止仍由调用方 signal 表达。
   */
  timeoutMs?: number;
};

export type HttpJsonResult<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; code: "endpoint-not-allowed" | "transport-unavailable" | "protocol-mismatch" | "model-access-denied" | "capability-unsupported"; status?: number; message: string; body?: string };

export type HttpJsonRequest = {
  method?: "GET" | "POST" | "DELETE";
  url: string;
  /** 附加头（如 Authorization）；调用方负责不放 grant 到模型头。 */
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** 读取/解析非 2xx 响应正文时是否返回（默认 true，便于错误映射）。 */
  includeErrorBody?: boolean;
};

export function createBoundedHttpClient(options: BoundedHttpClientOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeout = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : undefined;

  /** 收集 `AbortSignal` 与（可选的）显式期限，返回可清理的组合信号。 */
  const composeSignal = (signal: AbortSignal | undefined, timeoutMs: number | undefined) => {
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else {
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", onAbort));
      }
    }
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    if (timer !== undefined) cleanups.push(() => clearTimeout(timer));
    return { signal: controller.signal, cleanup: () => { for (const fn of cleanups) fn(); } };
  };

  type HttpFailureCode = "endpoint-not-allowed" | "transport-unavailable" | "protocol-mismatch" | "model-access-denied" | "capability-unsupported";
  const mapFailure = (status: number): HttpFailureCode => {
    if (status === 401 || status === 403) return "model-access-denied";
    if (status === 404 || status === 400) return "capability-unsupported";
    return "protocol-mismatch";
  };

  const request = async <T>(input: HttpJsonRequest): Promise<HttpJsonResult<T>> => {
    const { signal, cleanup } = composeSignal(input.signal, defaultTimeout);
    try {
      const headers: Record<string, string> = { accept: "application/json", ...input.headers };
      let body: string | undefined;
      if (input.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(input.body);
      }
      const result = await guardedFetch(
        input.url,
        { method: input.method ?? "POST", headers, ...(body !== undefined ? { body } : {}), signal },
        options.policy,
        fetchImpl
      );
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      const response = result.response;
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) {
        const include = input.includeErrorBody ?? true;
        return {
          ok: false,
          code: mapFailure(response.status),
          status: response.status,
          message: `上游返回 ${response.status}`,
          ...(include ? { body: text.slice(0, 2000) } : {})
        };
      }
      if (text.trim() === "") return { ok: true, status: response.status, value: undefined as T };
      try {
        return { ok: true, status: response.status, value: JSON.parse(text) as T };
      } catch {
        return { ok: false, code: "protocol-mismatch", status: response.status, message: "响应不是 JSON", body: text.slice(0, 500) };
      }
    } finally {
      cleanup();
    }
  };

  /**
   * SSE/流式文本请求：逐块回调；返回是否正常结束。
   *
   * 只暴露公开过程（增量文本/原生工具调用），不解析隐藏推理。
   */
  const stream = async (
    input: HttpJsonRequest & { onChunk: (chunk: string) => void }
  ): Promise<HttpJsonResult<void>> => {
    const { signal, cleanup } = composeSignal(input.signal, defaultTimeout);
    try {
      const headers: Record<string, string> = { accept: "text/event-stream", ...input.headers };
      let body: string | undefined;
      if (input.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(input.body);
      }
      const result = await guardedFetch(
        input.url,
        { method: input.method ?? "POST", headers, ...(body !== undefined ? { body } : {}), signal },
        options.policy,
        fetchImpl
      );
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      const response = result.response;
      if (response.status < 200 || response.status >= 300) {
        const text = await response.text();
        return { ok: false, code: mapFailure(response.status), status: response.status, message: `上游返回 ${response.status}`, body: text.slice(0, 2000) };
      }
      if (!response.body) return { ok: true, status: response.status, value: undefined };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) input.onChunk(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock?.();
      }
      return { ok: true, status: response.status, value: undefined };
    } finally {
      cleanup();
    }
  };

  return { request, stream };
}

export type BoundedHttpClient = ReturnType<typeof createBoundedHttpClient>;
