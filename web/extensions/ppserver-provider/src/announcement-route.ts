/**
 * 桌面端公告的**同源转发**。
 *
 * 公告来自官网上的一个目录索引：`https://sixiai.com.cn/gonggao/desktop/index.json`，
 * 里面是**多条**公告（编号、标题、日期、正文），历史就是这个列表本身。
 *
 * 它在官网主域、没有 CORS 头，宿主页面（`localhost:5300`）直接取会被浏览器拦下 ——
 * 与账户、生图是同一个问题，同一个解法：前端调同源地址，由这里代取。
 *
 * ## 与 PS 插件的公告是两回事
 *
 * 同目录下的 `gonggao.txt` 是 PS 插件读的**单行**通知，**这里不读它也不动它**。
 * 桌面端要多条、带历史，所以另起一个子目录 `desktop/`，两边互不影响。
 *
 * ## 与 `account-routes.ts` 的区别
 *
 * - **不带任何令牌与租户头**。公告是公开内容，没有理由把用户凭据发给它；
 * - **origin 与路径都写死**，前端不能借这条路由取任意 URL；
 * - 只认 GET。
 *
 * 响应：`{ data, lastModified?, etag? }`。`data` 是索引文件解析后的 JSON，**原样透传**，
 * 字段的取舍与容错放在前端的契约里（`parseAnnouncements`），这里只管「取得对、取得安全」。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostExtensionContext } from "@woohaa3/contracts";

/** 同源路径。前端拼这个，不要改成别的 */
export const ANNOUNCEMENT_ROUTE = "/api/ppserver/announcements";

/** 公告索引的固定地址。 */
export const ANNOUNCEMENT_URL = "https://sixiai.com.cn/gonggao/desktop/index.json";

/**
 * 索引体积上限。多条公告 + 历史，比单行文本大得多，但仍是几十 KB 量级；
 * 超过这个体积基本是取错了东西（比如一整页 HTML），宁可拒绝。
 */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 8_000;

export type AnnouncementResult =
  | { status: 200; body: { data: unknown; lastModified?: string; etag?: string } }
  | { status: 502; body: { message: string } };

/**
 * 取一次公告索引。抽出来便于单测。
 *
 * 判定刻意保守，因为用户看到的是「公告 / 没有公告 / 暂时读不到」三种之一，三种不能混：
 * - **404 = 没发布**，`data: null`。固定静态路径不存在，语义就是「还没有公告」；
 * - 其它非 2xx、网络错误、超时 = 502，由前端显示「暂时读不到」，**不当成没有公告**；
 * - **只认 JSON / 纯文本类型**。若官网对缺失路径回 200 + HTML 兜底页，
 *   不判类型的话整页 HTML 会进到 JSON 解析里，或者更糟 —— 被当成内容显示；
 * - **解析失败 = 502**，不是「没有公告」：发布的人把 JSON 写坏了，要让它看得见；
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
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 502,
      body: { message: `公告源连不上：${error instanceof Error ? error.message : String(error)}` },
    };
  }

  if (response.status === 404) return { status: 200, body: { data: null } };
  if (!response.ok) {
    return { status: 502, body: { message: `公告源返回 HTTP ${response.status}` } };
  }

  // 有的 nginx 对 .json 没配类型，会回 text/plain，也认；HTML 一律拒
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^(application\/json|text\/plain)\b/i.test(contentType)) {
    return { status: 502, body: { message: "公告源返回了非 JSON 内容" } };
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

  // 空文件按「没发布」处理；有内容但不是合法 JSON，是发布出了问题，要报错而不是吞掉
  if (!text.trim()) return { status: 200, body: { data: null } };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: 502, body: { message: "公告源不是有效的 JSON" } };
  }

  const lastModified = response.headers.get("last-modified");
  const etag = response.headers.get("etag");
  return {
    status: 200,
    body: {
      data,
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
    // 公告改了要尽快看到；索引只有几十 KB，不值得在中间层缓存
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
