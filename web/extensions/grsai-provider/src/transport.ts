/**
 * grsai 的 HTTP 传输：统一按 JSON 收发，失败时把上游的 `error`/`msg` 提成可读消息。
 *
 * 上游错误约定：统一接口用 HTTP 400 + `{id,status:"failed",error}`；查询过期任务用
 * HTTP 404 + `{error:"result not exist..."}`；旧绘图接口用 200 + `{code:-1,msg}`。
 */
export class GrsaiHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GrsaiHttpError";
    this.status = status;
  }
}

export async function requestGrsai(options: {
  fetchImpl: typeof globalThis.fetch;
  providerId: string;
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...definedHeaders(options.headers)
  };
  const response = await options.fetchImpl(options.url, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal
  });
  const text = await response.text().catch(() => "");
  const payload = parseJson(text);
  if (!response.ok) throw new GrsaiHttpError(errorMessage(payload, response.status, text), response.status);
  if (payload === undefined) throw new GrsaiHttpError(`${options.providerId} 返回了非 JSON 响应`, response.status);
  return payload;
}

function errorMessage(payload: unknown, status: number, text: string): string {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, any>) : {};
  const error = record.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 400);
  if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) return error.message.trim().slice(0, 400);
  if (typeof record.msg === "string" && record.msg.trim()) return record.msg.trim().slice(0, 400);
  const body = text.trim();
  return body ? `请求失败（HTTP ${status}）：${body.slice(0, 200)}` : `请求失败（HTTP ${status}）`;
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function definedHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
