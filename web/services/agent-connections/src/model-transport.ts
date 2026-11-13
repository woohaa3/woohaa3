/** Connection-bound model transport. No conversation memory or agent/tool loop. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import type { AgentApiType } from "@woohaa3/contracts";
import type { EndpointPolicy } from "./endpoint-policy.js";

export type ModelTransportOptions = {
  apiType: AgentApiType;
  upstream: string;
  apiKey: string;
  policy: EndpointPolicy;
  /** Rechecked before every upstream request, including SDK retries. */
  valid: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
  /** 测试接缝：覆盖上游 DNS 解析。 */
  lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  timeoutMs?: number;
};

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast IPv6; reject mapped IPv4 and private/link-local addresses.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
}

function routeAllowed(apiType: AgentApiType, method: string | undefined, path: string): boolean {
  if (apiType === "anthropic") {
    // `/v1` 前缀由 baseURL 决定；两种拼法都放行，避免把版本段差异当成非法路由。
    const bare = path.startsWith("/v1/") ? path.slice(3) : path;
    return (method === "POST" && (bare === "/messages" || bare === "/messages/count_tokens")) || (method === "GET" && bare === "/models");
  }
  if (apiType === "gemini") {
    return (method === "POST" && /^(?:\/v1beta)?\/models\/[a-zA-Z0-9._-]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path)) ||
      (method === "GET" && (path === "/models" || path === "/v1/models" || path === "/v1beta/models"));
  }
  // OpenAI 系协议只认自己的端点：`openai` 走 Responses，`chat-completions` 走 Chat Completions。
  // 两者互不兼收，避免把协议用错的请求悄悄打到上游。
  const bare = path.startsWith("/v1/") ? path.slice(3) : path;
  if (method === "GET") return bare === "/models";
  if (method !== "POST") return false;
  return apiType === "openai" ? bare === "/responses" : bare === "/chat/completions";
}

/**
 * 上游是否声明了 `/v1` 版本段由 baseURL 决定：`https://host/v1` 只接 `/v1/...`，
 * `https://host` 两种拼法都试一次。不再靠客户端猜前缀，也不再靠白名单硬编码。
 */
function upstreamCandidates(upstream: URL, protocolPath: string): URL[] {
  const base = upstream.pathname.replace(/\/+$/, "");
  const candidates = [new URL(upstream.toString())];
  candidates[0]!.pathname = base + protocolPath;
  if (base === "" || base === "/") {
    const versioned = new URL(upstream.toString());
    versioned.pathname = `/v1${protocolPath}`;
    if (versioned.pathname !== candidates[0]!.pathname) candidates.push(versioned);
  }
  return candidates;
}

/** 读取请求体（上限防止内存放大）；超过上限按空体处理，交给上游以自己的限制拒绝。 */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limit) return Buffer.alloc(0);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function createModelTransport(options: ModelTransportOptions) {
  if (options.signal?.aborted) throw new Error("Model transport cancelled");
  const checked = options.policy.check(options.upstream);
  if (!checked.ok) throw new Error(checked.message);
  const upstream = checked.url;
  if (upstream.search || upstream.hash) throw new Error("Model endpoint cannot contain query or fragment");
  const token = randomBytes(32).toString("base64url");
  const controllers = new Set<AbortController>();
  let closed = false;
  const fail = (response: ServerResponse, status: number, reason: string) => {
    if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
    // 原因随状态码一起返回：鉴权失败、路由不允许、上游拒绝必须一眼可辨，不一律伪装成 501。
    response.end(JSON.stringify({ error: { message: `Model transport request rejected: ${reason}`, type: "transport_error" } }));
  };
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    // 先读请求体：node 在 "close" 之后才开始发响应，若把 close 当成取消信号，响应永远发不出去。
    const body = await readBody(request, 32 * 1024 * 1024);
    request.once("aborted", () => controller.abort());
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      if (closed || controller.signal.aborted || !(await options.valid())) return fail(response, 410, "connection or turn is no longer valid");
      if (request.socket.remoteAddress !== "127.0.0.1") return fail(response, 403, "only loopback callers are served");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const supplied = request.headers.authorization?.replace(/^Bearer /i, "") ??
        request.headers["x-api-key"] ?? request.headers["x-goog-api-key"] ?? url.searchParams.get("key") ?? "";
      const actual = Buffer.from(typeof supplied === "string" ? supplied : "");
      const expected = Buffer.from(token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(response, 401, "relay token mismatch");
      if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("%") || request.url.includes("\\")) return fail(response, 400, "malformed request target");
      if (!routeAllowed(options.apiType, request.method, url.pathname)) return fail(response, 404, `route not supported: ${request.method ?? "?"} ${url.pathname}`);
      if ([...url.searchParams.keys()].some((key) => key !== "alt" && key !== "key" && !(options.apiType === "anthropic" && key === "beta" && url.searchParams.get("beta") === "true")) ||
          (url.searchParams.has("alt") && url.searchParams.get("alt") !== "sse")) return fail(response, 400, "unsupported query parameters");
      const protocolPath = options.apiType === "anthropic" && url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname;
      const candidates = upstreamCandidates(upstream, protocolPath)
        .filter((candidate) => {
          const allowed = options.policy.check(candidate.toString());
          return allowed.ok;
        });
      if (!candidates.length) return fail(response, 403, `upstream endpoint not allowed by policy: ${upstream.origin}`);
      // 目标主机必须是公网地址：白名单只说明"配置里允许"，这里挡住指向内网的地址。
      interface DialTarget { target: URL; address: string; family: number }
      const dialTargets: DialTarget[] = [];
      for (const candidate of candidates) {
        const hostname = candidate.hostname.replace(/^\[|\]$/g, "");
        const loopback = candidate.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
        let addresses: readonly { address: string; family: number }[];
        try {
          addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] :
            await (options.lookup ?? ((host) => dnsLookup(host, { all: true })))(hostname);
        } catch {
          continue;
        }
        const usable = addresses.filter(({ address }) => loopback ? address === "127.0.0.1" || address === "::1" : publicAddress(address));
        if (usable.length > 0) dialTargets.push({ target: candidate, ...usable[0]! });
      }
      if (!dialTargets.length) return fail(response, 403, `upstream address is not a public endpoint: ${upstream.host}`);
      if (closed || controller.signal.aborted || !(await options.valid())) return fail(response, 410, "connection or turn is no longer valid");
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (options.apiType === "anthropic") {
        headers["x-api-key"] = options.apiKey;
        headers["anthropic-version"] = typeof request.headers["anthropic-version"] === "string" ? request.headers["anthropic-version"] : "2023-06-01";
        if (typeof request.headers["anthropic-beta"] === "string") headers["anthropic-beta"] = request.headers["anthropic-beta"];
      } else if (options.apiType === "gemini") headers["x-goog-api-key"] = options.apiKey;
      else headers.authorization = `Bearer ${options.apiKey}`;
      const attempts = Math.max(1, Math.min(dialTargets.length, 2));
      let lastStatus = 0;
      for (let index = 0; index < attempts; index += 1) {
        const { target, address, family } = dialTargets[index]!;
        if (url.searchParams.get("alt") === "sse") target.searchParams.set("alt", "sse");
        if (options.apiType === "anthropic" && url.searchParams.get("beta") === "true") target.searchParams.set("beta", "true");
        const upstreamRequest = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
          method: request.method, headers, signal: controller.signal, family,
          // Pin the actual dial to the checked address; no second DNS lookup/rebinding.
          lookup: ((_host: string, _opts: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, address, family)) as never
        });
        // 推理可能长时间没有公开输出，默认不以网络静默时间中止；撤销／断连仍通过 signal 取消。
        if (options.timeoutMs && options.timeoutMs > 0) upstreamRequest.setTimeout(options.timeoutMs, () => upstreamRequest.destroy(new Error("timeout")));
        // 先挂事件再发请求体：on("response") 必须早于 end() 注册。
        const completed = new Promise<{ status: number; retry: boolean }>((resolve, reject) => {
          upstreamRequest.once("error", reject);
          upstreamRequest.once("response", (upstreamResponse) => {
            const status = upstreamResponse.statusCode ?? 502;
            if (status < 200 || status >= 300) {
              // Never relay redirects or upstream diagnostic bodies containing secrets.
              const relayed = status >= 300 && status < 400 ? 502 : status;
              // 404 可能是版本前缀猜错：读掉响应体后换另一种拼法再试一次。其余状态码不转发原响应体。
              resolve({ status: relayed, retry: relayed === 404 && index + 1 < attempts });
              upstreamResponse.resume();
              return;
            }
            response.writeHead(status, { "content-type": upstreamResponse.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
            void pipeline(upstreamResponse, response).then(() => resolve({ status, retry: false }), reject);
          });
          upstreamRequest.end(body);
        });
        const result = await completed;
        lastStatus = result.status;
        // 非 2xx 必须显式回写状态码：直接 return 会把响应悬挂到客户端超时。
        if (!result.retry) { fail(response, lastStatus || 502, `upstream answered ${lastStatus || 502}`); return; }
      }
      fail(response, lastStatus || 502, `upstream answered ${lastStatus || 502}`);
    } catch {
      if (!response.headersSent) fail(response, controller.signal.aborted ? 499 : 502, controller.signal.aborted ? "cancelled" : "upstream request failed");
      else response.destroy();
    } finally { controllers.delete(controller); }
  });
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const abort = () => { void close(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) await close();
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? 0}`, token, close };
}
