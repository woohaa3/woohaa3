/** Connection-bound model transport. No conversation memory or agent/tool loop. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
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
  if (apiType === "openai") return (method === "POST" && path === "/responses") || (method === "GET" && path === "/models");
  if (apiType === "anthropic") return (method === "POST" && (path === "/messages" || path === "/messages/count_tokens")) || (method === "GET" && path === "/models");
  // OpenCode 的 OpenAI 兼容运行时按 `baseURL` 拼 `/v1/chat/completions`（不认裸 `/chat/completions`）。
  if (apiType === "chat-completions") return (method === "POST" && (path === "/chat/completions" || path === "/v1/chat/completions")) || (method === "GET" && (path === "/models" || path === "/v1/models"));
  // `baseURL` 自带版本段（`.../v1beta`）时客户端会再拼一次版本前缀：两种拼法都要放行。
  return (method === "POST" && /^(?:\/v1beta)?\/models\/[a-zA-Z0-9._-]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path)) ||
    (method === "GET" && (path === "/models" || path === "/v1beta/models"));
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
  const fail = (response: ServerResponse, status: number) => {
    if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Model transport request rejected", type: "transport_error" } }));
  };
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    request.once("aborted", () => controller.abort());
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      if (closed || controller.signal.aborted || !(await options.valid())) return fail(response, 410);
      if (request.socket.remoteAddress !== "127.0.0.1") return fail(response, 403);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const supplied = request.headers.authorization?.replace(/^Bearer /i, "") ??
        request.headers["x-api-key"] ?? request.headers["x-goog-api-key"] ?? url.searchParams.get("key") ?? "";
      const actual = Buffer.from(typeof supplied === "string" ? supplied : "");
      const expected = Buffer.from(token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(response, 401);
      if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("%") || request.url.includes("\\")) return fail(response, 400);
      const protocolPath = options.apiType === "anthropic" && url.pathname.startsWith("/v1/") ? url.pathname.slice(3) : url.pathname;
      if (!routeAllowed(options.apiType, request.method, protocolPath)) return fail(response, 404);
      if ([...url.searchParams.keys()].some((key) => key !== "alt" && key !== "key" && !(options.apiType === "anthropic" && key === "beta" && url.searchParams.get("beta") === "true")) ||
          (url.searchParams.has("alt") && url.searchParams.get("alt") !== "sse")) return fail(response, 400);
      const target = new URL(upstream.toString());
      target.pathname = upstream.pathname.replace(/\/$/, "") + protocolPath;
      if (url.searchParams.get("alt") === "sse") target.searchParams.set("alt", "sse");
      if (options.apiType === "anthropic" && url.searchParams.get("beta") === "true") target.searchParams.set("beta", "true");
      const allowed = options.policy.check(target.toString());
      if (!allowed.ok) return fail(response, 403);
      const hostname = target.hostname.replace(/^\[|\]$/g, "");
      const loopback = target.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] :
        await (options.lookup ?? ((host) => dnsLookup(host, { all: true })))(hostname);
      if (!addresses.length || addresses.some(({ address }) => loopback
        ? address !== "127.0.0.1" && address !== "::1"
        : !publicAddress(address))) return fail(response, 403);
      if (closed || controller.signal.aborted || !(await options.valid())) return fail(response, 410);
      const address = addresses[0]!;
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      if (options.apiType === "anthropic") {
        headers["x-api-key"] = options.apiKey;
        headers["anthropic-version"] = typeof request.headers["anthropic-version"] === "string" ? request.headers["anthropic-version"] : "2023-06-01";
        if (typeof request.headers["anthropic-beta"] === "string") headers["anthropic-beta"] = request.headers["anthropic-beta"];
      } else if (options.apiType === "gemini") headers["x-goog-api-key"] = options.apiKey;
      else headers.authorization = `Bearer ${options.apiKey}`;
      const upstreamRequest = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: request.method, headers, signal: controller.signal, family: address.family,
        // Pin the actual dial to the checked address; no second DNS lookup/rebinding.
        lookup: ((_host: string, _opts: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, address.address, address.family)) as never
      });
      // 推理可能长时间没有公开输出，默认不以网络静默时间中止；撤销／断连仍通过 signal 取消。
      if (options.timeoutMs && options.timeoutMs > 0) upstreamRequest.setTimeout(options.timeoutMs, () => upstreamRequest.destroy(new Error("timeout")));
      const completed = new Promise<void>((resolve, reject) => {
        upstreamRequest.once("error", reject);
        upstreamRequest.once("response", (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          // Never relay redirects or upstream diagnostic bodies containing secrets.
          if (status < 200 || status >= 300) {
            upstreamResponse.resume(); fail(response, status >= 300 && status < 400 ? 502 : status); resolve(); return;
          }
          response.writeHead(status, { "content-type": upstreamResponse.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
          void pipeline(upstreamResponse, response).then(resolve, reject);
        });
      });
      request.pipe(upstreamRequest);
      await completed;
    } catch {
      if (!response.headersSent) fail(response, controller.signal.aborted ? 499 : 502);
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
