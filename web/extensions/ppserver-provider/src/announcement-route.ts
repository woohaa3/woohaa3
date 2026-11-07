/**
 * 平台公告的**同源转发**。
 *
 * 公告是官网上的一个静态文本文件：`https://sixiai.com.cn/gonggao/gonggao.txt`。
 * 它在官网主域，不在账户服务的 `api.sixiai.com.cn` 上（那边同路径是 404），
 * 也没有 CORS 头，所以宿主页面（`localhost:5300`）直接取会被浏览器拦下 ——
 * 与账户、生图是同一个问题，同一个解法：前端调同源地址，由这里代取。
 *
 * 与 `account-routes.ts` 的区别：
 * - **不带任何令牌与租户头**。公告是公开内容，没有理由把用户凭据发给它；
 * - **origin 与路径都写死**，前端不能借这条路由取任意 URL；
 * - 只认 GET。
 *
 * 响应是 JSON：`{ text, lastModified?, etag? }`。`lastModified` 是文件的发布时间 ——
 * 文件里只有一行字，没有标题与日期，时间只能取 HTTP 头。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostExtensionContext } from "@woohaa3/contracts";

/** 同源路径。前端拼这个，不要改成别的 */
export const ANNOUNCEMENT_ROUTE = "/api/ppserver/announcement";

/** 公告文件的固定地址。 */
export const ANNOUNCEMENT_URL = "https://sixiai.com.cn/gonggao/gonggao.txt";

/** 公告应该是几句话。超过这个体积基本是取错了东西（比如一整页 HTML），宁可拒绝。 */
const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 8_000;

export type AnnouncementResult =
  | { status: 200; body: { text: string; lastModified?: string; etag?: string } }
  | { status: 502; body: { message: string } };

/**
 * 取一次公告。抽出来便于单测。
 *
 * 判定刻意保守：
 * - **404 = 没有公告**，返回空文本。固定静态路径不存在，语义就是「没发布」；
 * - 其它非 2xx、网络错误、超时 = 502，由前端显示「暂时读不到」，**不当成没有公告**；
 * - **只认 `text/plain`**。若官网哪天对缺失路径回 200 + HTML 兜底页，
 *   不判类型的话整页 HTML 会被当成公告显示出来；
 * - 不跟随重定向：origin 固定，跳到别处不是我们要的东西。
 */
export async function fetchAnnouncement(
  fetchImpl: typeof globalThis.fetch,
  url: string = ANNOUNCEMENT_URL,
): Promise<AnnouncementResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 502,
      body: { message: `公告源连不上：${error instanceof Error ? error.message : String(error)}` },
    };
  }

  if (response.status === 404) return { status: 200, body: { text: "" } };
  if (!response.ok) {
    return { status: 502, body: { message: `公告源返回 HTTP ${response.status}` } };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/plain\b/i.test(contentType)) {
    return { status: 502, body: { message: "公告源返回了非文本内容" } };
  }

  // 先看声明的长度，省得把一个大文件整个读进内存；声明缺失或说谎时读完再量一次
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return { status: 502, body: { message: "公告内容过长" } };
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    return { status: 502, body: { message: "公告内容过长" } };
  }

  const lastModified = response.headers.get("last-modified");
  const etag = response.headers.get("etag");
  return {
    status: 200,
    body: {
      text: text.trim(),
      ...(lastModified ? { lastModified } : {}),
      ...(etag ? { etag } : {}),
    },
  };
}

export type RegisterAnnouncementRouteOptions = {
  order?: number;
  url?: string;
  fetchImpl?: typeof globalThis.fetch;
};

type RouteRuntime = {
  gateway: {
    route(
      order: number,
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
    ): () => void;
  };
};

export function registerAnnouncementRoute(
  ctx: HostExtensionContext,
  options: RegisterAnnouncementRouteOptions = {},
): void {
  const runtime = ctx as HostExtensionContext & RouteRuntime;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  ctx.effect(() =>
    runtime.gateway.route(options.order ?? 26, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      if (pathname !== ANNOUNCEMENT_ROUTE) return false;

      if ((req.method ?? "GET") !== "GET") {
        writeJson(res, 405, { message: "只支持 GET" });
        return true;
      }

      const result = await fetchAnnouncement(fetchImpl, options.url);
      writeJson(res, result.status, result.body);
      return true;
    }),
  );
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // 公告改了要尽快看到；文件只有几十字节，不值得在中间层缓存
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
