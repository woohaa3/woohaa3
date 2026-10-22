import { setTimeout as delay } from "node:timers/promises";
import { createEndpointPolicy, guardedFetch } from "@woohaa3/agent-connections";
import { createSseParser } from "../protocol/sse.js";

const policy = createEndpointPolicy({ allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"], allowHttp: true });

/** Separate HTTP errors from network/policy results. Never expose credentials in errors. */
export function loopbackHttp(base: string, headers: Record<string, string>, signal: AbortSignal, fetchImpl: typeof fetch) {
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const result = await guardedFetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...Object.fromEntries(new Headers(init.headers).entries()) },
      signal: AbortSignal.any([signal, init.signal ?? AbortSignal.timeout(30_000)])
    }, policy, fetchImpl);
    if (!result.ok) throw new Error(result.message);
    if (!result.response.ok) {
      await result.response.body?.cancel();
      throw new Error(`本机 Agent ${path.split("?")[0]} 返回 HTTP ${result.response.status}`);
    }
    return result.response;
  };
  return {
    request,
    async json(path: string, method = "GET", body?: unknown): Promise<Record<string, any>> {
      const response = await request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      if (response.status === 204) return {};
      if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
        await response.body?.cancel();
        throw new Error(`本机 Agent ${path.split("?")[0]} 未返回 JSON（可能是协议版本不匹配）`);
      }
      return await response.json() as Record<string, any>;
    },
    async ready(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
      const started = Date.now();
      for (;;) {
        const attempt = new AbortController();
        const timer = setTimeout(() => attempt.abort(), 2000);
        try { return await request(path, { ...init, signal: AbortSignal.any([signal, attempt.signal]) }); }
        catch (error) {
          if (signal.aborted || Date.now() - started >= timeoutMs || /HTTP (?:4\d\d)/.test(String(error))) throw error;
          await delay(200, undefined, { signal });
        } finally { clearTimeout(timer); }
      }
    }
  };
}

export async function consumeSse(response: Response, onMessage: (message: Record<string, any>) => void): Promise<void> {
  if (!response.body) throw new Error("本机 Agent 未返回事件流");
  const reader = response.body.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const emit = (data: string) => {
    if (!data.trim() || data === "[DONE]") return;
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) onMessage(parsed as Record<string, unknown>);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) emit(event.data);
    }
    for (const event of parser.flush()) emit(event.data);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function canvasToolName(name: string, allowed: readonly string[]): string {
  return allowed.find(tool => name === tool || name.endsWith(`__${tool}`) || name.endsWith(`_${tool}`) || name.endsWith(`/${tool}`)) ?? name;
}

/** Some clients finish the RPC successfully even when the MCP tool rejects a write. */
export function toolResultFailed(value: unknown): boolean {
  if (typeof value === "string") {
    try { return toolResultFailed(JSON.parse(value)); } catch { return false; }
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(toolResultFailed);
  const result = value as Record<string, unknown>;
  return result.isError === true || result.ok === false || toolResultFailed(result.structuredContent) || toolResultFailed(result.content) || (result.type === "text" && toolResultFailed(result.text));
}
