/**
 * 账户服务的**同源转发**。
 *
 * 为什么要这一层：账户接口在 `api.sixiai.com.cn`，而它的 CORS 只回
 * `Access-Control-Allow-Origin: https://sixiai.com.cn`（固定值，不反射请求的 Origin）。
 * 宿主页面跑在 `localhost:5300`，浏览器直连必然被拦。
 *
 * 所以与 `routes.ts`（生图转发）同一套做法：前端调同源 `/api/ppserver/account/*`，
 * 这里补上 `Authorization` 与 `X-Tenant-ID` 再转给新服务。
 *
 * 与 `routes.ts` 的三处不同：
 * - **不同的 origin**：这个是 `api.sixiai.com.cn`，生图那个是 `sdpppx.zombee.tech`；
 * - **多带 `X-Tenant-ID`**：除认证路径外，账户接口都要它；
 * - **透传 `Idempotency-Key`**：下单/领券要它，缺了服务端会拒绝或重复建单。
 *
 * 信任边界与 `routes.ts` 一致（spike 级别）：有 `access.authenticator` 时要求 principal，
 * 本机单实例没有认证器时按「本机可信」放行。前端不能借此发任意 URL ——
 * origin 固定，路径只认白名单。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostExtensionContext } from "@woohaa3/contracts";

/** 同源前缀。前端拼这个，和后端白名单一一对应 */
export const ACCOUNT_ROUTE_PREFIX = "/api/ppserver/account/";

/**
 * 允许转发的路径（**去掉前缀之后**的部分）。
 *
 * 用前缀匹配而不是精确匹配，因为有几条带子路径：
 * `/sixi/v1/orders/{id}`、`/sixi/v1/orders/{id}/cancel`、
 * `/sixi/v1/coupon-offers/{key}`。
 *
 * **按「服务归属」列，不是按对接包是否收录**：`billing`、`recharge-tiers`、`orders`
 * 也在这台服务上，只是不在那 15 个操作里。前端那条前缀一旦放开而这里没放，
 * 请求会拿到「未知的账户接口」，表现为前端改了却不生效。
 *
 * 充值相关先不放：技术方建议加固完成前隐藏充值入口。
 */
const ALLOWED_PREFIXES = [
  // 认证：换业务会话与刷新。**这两条不带 X-Tenant-ID**（租户在 body 里）
  "auth/",
  // 读取与签到
  "client/v1/",
  "sixi/membership-levels",
  "sixi/check-in",
  "memberships/current",
  // 用量账单
  "billing",
  // 券与支付
  "sixi/v1/",
] as const;

/** 认证路径：租户放 body，**不能**带 X-Tenant-ID（否则预检失败） */
const AUTH_PREFIXES = ["auth/"] as const;

type RouteRuntime = {
  gateway: {
    route(
      order: number,
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
    ): () => void;
  };
  access: {
    authenticator?: (
      req: IncomingMessage,
      transport?: "http" | "ws" | "mcp",
    ) => Promise<unknown | null>;
  };
};

export type RegisterAccountProxyOptions = {
  /** 账户服务 origin，形如 `https://api.sixiai.com.cn` */
  baseUrl: string;
  /**
   * 取当前可用的令牌。**是函数不是字符串** —— 续期会换掉令牌，
   * 构造时取一份的话续期后仍在用旧值。
   */
  accessToken: () => string | Promise<string>;
  tenantId: () => string;
  order?: number;
  fetchImpl?: typeof globalThis.fetch;
};

function allowed(name: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isAuthPath(name: string): boolean {
  return AUTH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 转发一条账户请求。抽出来便于单测。 */
export async function proxyAccountRequest(input: {
  req: IncomingMessage;
  fetchImpl: typeof globalThis.fetch;
  origin: string;
  accessToken: string;
  tenantId: string;
}): Promise<{ status: number; response: Response; contentType: string } | { status: number; message: string }> {
  const url = new URL(input.req.url ?? "/", "http://local");
  const name = url.pathname.slice(ACCOUNT_ROUTE_PREFIX.length);

  if (!allowed(name)) return { status: 404, message: "未知的账户接口" };

  const target = new URL(`${input.origin}/${name}`);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  const method = input.req.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.accessToken) headers.authorization = `Bearer ${input.accessToken}`;
  /*
   * 认证路径**不能**带租户头：`/auth/*` 的 CORS 白名单只放行
   * Authorization / Content-Type，附加业务租户头会让预检失败。
   */
  if (!isAuthPath(name)) headers["x-tenant-id"] = input.tenantId;

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(input.req);
    headers["content-type"] = "application/json";
  }

  // 幂等键原样透传：下单/领券要它，由前端生成并持久化，宿主不替它决定
  const idempotencyKey = input.req.headers["idempotency-key"];
  if (typeof idempotencyKey === "string" && idempotencyKey.trim()) {
    headers["idempotency-key"] = idempotencyKey.trim();
  }

  const response = await input.fetchImpl(target, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: response.status,
    response,
    contentType: response.headers.get("content-type") ?? "application/json",
  };
}

export function registerAccountProxy(
  ctx: HostExtensionContext,
  options: RegisterAccountProxyOptions,
): void {
  const runtime = ctx as HostExtensionContext & RouteRuntime;
  const origin = options.baseUrl.trim().replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  ctx.effect(() =>
    runtime.gateway.route(options.order ?? 25, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      if (!pathname.startsWith(ACCOUNT_ROUTE_PREFIX)) return false;

      if (runtime.access?.authenticator) {
        const principal = await runtime.access.authenticator(req, "http").catch(() => null);
        if (!principal) {
          writeJson(res, 401, { message: "需要登录" });
          return true;
        }
      }

      try {
        const result = await proxyAccountRequest({
          req,
          fetchImpl,
          origin,
          accessToken: await options.accessToken(),
          tenantId: options.tenantId(),
        });
        if ("message" in result) {
          writeJson(res, result.status, { message: result.message });
          return true;
        }
        const text = await result.response.text();
        res.writeHead(result.status, {
          "content-type": result.contentType,
          // 账户数据与账号绑定，不允许中间层缓存
          "cache-control": "no-store",
        });
        res.end(text);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return true;
        }
        writeJson(res, 502, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }),
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
      // 账户请求都很小（报价、下单、签到），1 MB 已经非常宽裕
      if (size > 1024 * 1024) {
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
