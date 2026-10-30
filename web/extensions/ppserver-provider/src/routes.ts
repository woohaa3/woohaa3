/**
 * ppserver 的**同源转发**。
 *
 * 为什么要这一层：令牌是站点级 secret，只能待在宿主进程里；浏览器端（四喜前端）拿不到，
 * 也不该拿 —— 与 CLAUDE.md 里「密钥在服务端」一致。所以前端一律调同源
 * `/api/ppserver/tasks/*`，由这里补上 `Authorization` 再转给 ppserver。
 *
 * 信任边界（**这是 spike 级别，正式上线前必须收紧**）：
 * - 本机单实例宿主里没有用户会话，任何能访问本机端口的人都能借这条路由花钱；
 * - 有 `access.authenticator` 时强制要 principal，没有时放行 —— 与本地宿主其它
 *   「不需要站点管理员」的接口同一档。
 * - 前端**不能**借此发任意 URL：目标 origin 固定取配置里的 `baseUrl`，路径只认下面五条。
 *
 * 只转发这五条，不转发 `/tasks/create` —— 当前部署没有这个入口（线上 404）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostExtensionContext } from "@woohaa3/contracts";
import { ppserverOrigin } from "./shared.js";

const ROUTE_PREFIX = "/api/ppserver/tasks/";
const ALLOWED = new Set(["describe", "create_stream", "status", "result", "cancel"]);

type RouteRuntime = {
  gateway: {
    route(order: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>): () => void;
  };
  access: {
    authenticator?: (req: IncomingMessage, transport?: "http" | "ws" | "mcp") => Promise<unknown | null>;
  };
};

export type RegisterPpserverProxyOptions = {
  baseUrl: string;
  accessToken: () => string;
  tenantId?: () => string;
  order?: number;
  fetchImpl?: typeof globalThis.fetch;
};

/** 转发时保留的方法与查询串；body 原样透传（前端已经按 ppserver 的形状拼好）。 */
export async function proxyTaskRequest(input: {
  req: IncomingMessage;
  fetchImpl: typeof globalThis.fetch;
  origin: string;
  accessToken: string;
  tenantId?: string;
}): Promise<{ status: number; response: Response; contentType: string } | { status: number; message: string }> {
  const url = new URL(input.req.url ?? "/", "http://local");
  const name = url.pathname.slice(ROUTE_PREFIX.length);
  if (!ALLOWED.has(name)) return { status: 404, message: "未知的 ppserver 端点" };

  const target = new URL(`${input.origin}/tasks/${name}`);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const method = input.req.method ?? "GET";
  const headers: Record<string, string> = {
    accept: name === "create_stream" ? "text/event-stream" : "application/json"
  };
  if (input.accessToken) headers.authorization = `Bearer ${input.accessToken}`;

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(input.req);
    headers["content-type"] = "application/json";
    // 租户只有在配置里给了才补；前端没填时不覆盖它自己带的值。
    if (input.tenantId && !bodyHasTenant(body)) {
      body = withTenant(body, input.tenantId);
    }
  }

  const response = await input.fetchImpl(target, { method, headers, ...(body === undefined ? {} : { body }) });
  return {
    status: response.status,
    response,
    contentType: response.headers.get("content-type") ?? "application/json"
  };
}

export function registerPpserverProxy(ctx: HostExtensionContext, options: RegisterPpserverProxyOptions): void {
  const runtime = ctx as HostExtensionContext & RouteRuntime;
  const origin = ppserverOrigin(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  ctx.effect(() =>
    runtime.gateway.route(options.order ?? 24, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      if (!pathname.startsWith(ROUTE_PREFIX)) return false;

      // 有认证器就必须过认证；本机单实例没有认证器时按「本机可信」放行。
      if (runtime.access?.authenticator) {
        const principal = await runtime.access.authenticator(req, "http").catch(() => null);
        if (!principal) {
          writeJson(res, 401, { message: "需要登录" });
          return true;
        }
      }

      try {
        const result = await proxyTaskRequest({
          req,
          fetchImpl,
          origin,
          accessToken: options.accessToken(),
          ...(options.tenantId?.() ? { tenantId: options.tenantId() } : {})
        });
        if ("message" in result) {
          writeJson(res, result.status, { message: result.message });
          return true;
        }
        res.writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-cache, no-transform" });
        // 逐块转发：`create_stream` 是 SSE，攒成整包会让前端一直等到任务结束。
        if (!result.response.body) {
          res.end(await result.response.text());
          return true;
        }
        const reader = result.response.body.getReader();
        res.on("close", () => void reader.cancel().catch(() => undefined));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (error) {
        writeJson(res, 502, { message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    })
  );
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // 参考图不走这里（先由 Provider 上传换 URL），所以 4 MB 足够。
      if (size > 4 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bodyHasTenant(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return Boolean(parsed && typeof parsed === "object" && "tenantId" in parsed);
  } catch {
    return false;
  }
}

function withTenant(body: string, tenantId: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    return JSON.stringify({ ...parsed, tenantId });
  } catch {
    return body;
  }
}
