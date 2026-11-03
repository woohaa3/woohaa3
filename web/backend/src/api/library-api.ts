/**
 * 素材库 HTTP 面：`/api/library/*`。
 *
 * 一个独立来源（浏览器扩展「保存到四喜」）往里存图片，画布与资源栏从里面取用。
 * **它不属于任何画布** —— 存进来只是「攒着」，加进画布是另一个显式动作。
 *
 * 路由：
 * - `POST   /api/library/import`    `{ url, title?, pageUrl? }` → 下载、落媒体、记索引（浏览器扩展用）
 * - `POST   /api/library/register`  `{ storageKey, title?, sourceUrl?, pageUrl? }` → 把**已经上传**的媒体对象记进索引
 *   （桌面端 Pinterest 窗口用：字节由桌面壳下载、主窗口经 `/api/media` 上传，这里只登记）
 * - `GET    /api/library`           列出（按保存时间倒序）
 * - `DELETE /api/library/<id>`      删除索引（**不删媒体对象** —— 它可能被别的画布引用）
 *
 * 安全：
 * - 只接受 http / https 地址；`file:`、`data:` 一律拒绝 —— 放行等于开一条读本机文件的通路；
 * - 写操作鉴权二选一（见 {@link authorize}）：令牌有效，或「同源且 Host 是回环地址」的浏览器请求。
 *   两个都不满足就拒绝；令牌没配置且不是同源请求时**直接 503**，绝不退化成「没令牌就当通过」。
 *   这个接口能从任意网页上下文被触发（通过扩展），没有令牌也不同源就是给本机开了一个后门。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaMetadata } from "@woohaa3/contracts";
import type { LibraryItem, LibraryStore } from "../host/core/library-store.js";

export const LIBRARY_BASE_PATH = "/api/library";
/** 媒体读取前缀。素材的 `url` 指向这里，前端直接 `<img src>`。 */
const MEDIA_BASE_PATH = "/api/media";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TITLE = 200;
const MAX_URL = 2048;

/** import 需要的媒体能力。只取用到的那一个，便于测试替身。 */
export type LibraryMediaPort = {
  importFromUrl(input: { url: string; contentType?: string; maxBytes?: number }): Promise<MediaMetadata>;
  /** 核验媒体对象是否存在且 metadata 一致（`register` 不信任客户端自报）。 */
  verify(
    storageKey: string,
    expected?: Partial<Omit<MediaMetadata, "storageKey">>
  ): Promise<{ exists: boolean; matches: boolean; metadata?: MediaMetadata }>;
};

export type LibraryApiOptions = {
  store: LibraryStore;
  media: LibraryMediaPort;
  /** 期望的访问令牌。空字符串表示未配置 → 所有写操作 503。 */
  token: string;
};

export function createLibraryApi(options: LibraryApiOptions) {
  const { store, media, token } = options;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== LIBRARY_BASE_PATH && !pathname.startsWith(`${LIBRARY_BASE_PATH}/`)) {
      return false;
    }

    // 预检：浏览器扩展的自定义头会触发它。
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return true;
    }

    if (pathname === `${LIBRARY_BASE_PATH}/ping`) {
      if (req.method !== "GET") return methodNotAllowed(req, res);
      writeJson(req, res, 200, { app: "sixi", library: true });
      return true;
    }

    if (pathname === `${LIBRARY_BASE_PATH}/import`) {
      if (req.method !== "POST") return methodNotAllowed(req, res);
      await importOne(req, res);
      return true;
    }

    if (pathname === `${LIBRARY_BASE_PATH}/register`) {
      if (req.method !== "POST") return methodNotAllowed(req, res);
      await registerOne(req, res);
      return true;
    }

    if (pathname === LIBRARY_BASE_PATH) {
      if (req.method !== "GET") return methodNotAllowed(req, res);
      const items = await store.list();
      writeJson(req, res, 200, { items, total: items.length });
      return true;
    }

    const id = pathname.slice(LIBRARY_BASE_PATH.length + 1);
    if (id && !id.includes("/")) {
      if (req.method !== "DELETE") return methodNotAllowed(req, res);
      if (!authorize(req, res, token)) return true;
      const removed = await store.remove(id);
      writeJson(req, res, removed ? 200 : 404, removed ? { removed: true } : { error: "素材不存在" });
      return true;
    }

    writeJson(req, res, 404, { error: "没有这个接口" });
    return true;
  };

  async function importOne(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req, res, token)) return;

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      writeJson(req, res, 400, { error: `请求体无法解析：${(error as Error).message}` });
      return;
    }

    const body = (payload ?? {}) as Record<string, unknown>;
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.trim() : "";

    if (rawUrl.length === 0 || rawUrl.length > MAX_URL) {
      writeJson(req, res, 400, { error: "缺少图片地址，或地址过长" });
      return;
    }
    const scheme = schemeOf(rawUrl);
    if (scheme !== "http" && scheme !== "https") {
      writeJson(req, res, 400, { error: "只支持 http / https 的图片地址" });
      return;
    }

    let metadata: MediaMetadata;
    try {
      metadata = await media.importFromUrl({ url: rawUrl, maxBytes: 32 * 1024 * 1024 });
    } catch (error) {
      // 下载失败的根因（DNS / 403 / 防盗链 / 超时）要原样带给用户，
      // 否则界面上只剩一句「保存失败」，无从下手。
      writeJson(req, res, 502, { error: `下载失败：${(error as Error).message}` });
      return;
    }

    const title = sanitizeTitle(body.title, metadata.storageKey);
    const item: LibraryItem = {
      // 内容哈希：与媒体层同一套寻址，重复保存天然幂等。
      id: metadata.checksum,
      title,
      sourceUrl: rawUrl,
      ...(pageUrl && pageUrl.length <= MAX_URL ? { pageUrl } : {}),
      // 稳定同源地址；不存临时签名 URL。
      url: `${MEDIA_BASE_PATH}/${metadata.storageKey}`,
      storageKey: metadata.storageKey,
      contentType: metadata.contentType,
      bytes: metadata.size,
      createdAt: Date.now()
    };

    const { item: saved, duplicated } = await store.put(item);
    writeJson(req, res, duplicated ? 200 : 201, {
      item: saved,
      duplicated
    });
  }

  /**
   * 登记一个**已上传**的媒体对象。
   *
   * 不信任客户端自报的 contentType / size / checksum：以 `media.verify` 核验后返回的 metadata 为准，
   * 对象不存在直接 404，声明与实际不一致直接 409。只收图片 —— 素材库本来就是图片收集箱。
   */
  async function registerOne(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorize(req, res, token)) return;

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      writeJson(req, res, 400, { error: `请求体无法解析：${(error as Error).message}` });
      return;
    }
    const body = (payload ?? {}) as Record<string, unknown>;
    const storageKey = typeof body.storageKey === "string" ? body.storageKey.trim() : "";
    if (storageKey === "" || storageKey.length > 256) {
      writeJson(req, res, 400, { error: "缺少 storageKey" });
      return;
    }

    const expected: Partial<Omit<MediaMetadata, "storageKey">> = {};
    if (typeof body.checksum === "string" && body.checksum !== "") expected.checksum = body.checksum;
    if (typeof body.contentType === "string" && body.contentType !== "") expected.contentType = body.contentType;
    if (typeof body.size === "number" && Number.isFinite(body.size)) expected.size = body.size;

    let verified: Awaited<ReturnType<LibraryMediaPort["verify"]>>;
    try {
      verified = await media.verify(storageKey, expected);
    } catch (error) {
      writeJson(req, res, 502, { error: `核验媒体对象失败：${(error as Error).message}` });
      return;
    }
    if (!verified.exists) {
      writeJson(req, res, 404, { error: "媒体对象不存在，请先上传" });
      return;
    }
    if (!verified.matches || !verified.metadata) {
      writeJson(req, res, 409, { error: "媒体对象与声明的信息不一致" });
      return;
    }
    const metadata = verified.metadata;
    if (!metadata.contentType.startsWith("image/")) {
      writeJson(req, res, 415, { error: "素材库只收图片" });
      return;
    }

    const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.trim() : "";
    const item: LibraryItem = {
      id: metadata.checksum,
      title: sanitizeTitle(body.title, metadata.storageKey),
      sourceUrl: isHttpUrl(sourceUrl) ? sourceUrl : "",
      ...(isHttpUrl(pageUrl) ? { pageUrl } : {}),
      url: `${MEDIA_BASE_PATH}/${metadata.storageKey}`,
      storageKey: metadata.storageKey,
      contentType: metadata.contentType,
      bytes: metadata.size,
      createdAt: Date.now()
    };
    const { item: saved, duplicated } = await store.put(item);
    writeJson(req, res, duplicated ? 200 : 201, { item: saved, duplicated });
  }
};

function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match ? match[1]!.toLowerCase() : "";
}

function sanitizeTitle(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "未命名图片";
  return text.slice(0, MAX_TITLE) || fallback;
}

function isHttpUrl(value: string): boolean {
  if (value === "" || value.length > MAX_URL) return false;
  const scheme = schemeOf(value);
  return scheme === "http" || scheme === "https";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * 「同源且 Host 是回环地址」的浏览器请求。
 *
 * - 带 `Origin` 且与 `Host` 同源：这是应用自己的页面在调（浏览器的 `Origin` 头页面脚本改不了）；
 * - **还要求 Host 是回环地址**：DNS 重绑定时攻击页的 `Origin` 与 `Host` 都是它自己的域名，
 *   单看「同源」会通过；而它的 Host 不可能是 `127.0.0.1`；
 * - 扩展的 `chrome-extension://…` 来源与 Host 不同源，走不到这里，仍然要令牌。
 *
 * 上游 `originGuard` 已经对非安全方法做了 Origin 同源校验，这里**不依赖它**，自己再判一次，
 * 让这个 API 单独可测，也不会因为有人调整守卫的放行规则而悄悄放宽。
 */
function isSameOriginLoopback(req: IncomingMessage): boolean {
  const origin = headerOf(req.headers.origin).trim();
  if (origin === "") return false;
  const forwarded = headerOf(req.headers["x-forwarded-host"]).trim();
  const host = (forwarded !== "" ? forwarded : headerOf(req.headers.host).trim()).toLowerCase();
  if (host === "") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost !== host) return false;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return LOOPBACK_HOSTS.has(hostname);
}

function headerOf(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * 写操作鉴权；返回是否通过（未通过时已经写过响应）。
 *
 * 1. 同源回环的浏览器请求直接通过（应用自己的页面，不需要令牌）；
 * 2. 否则必须带有效令牌：没配置令牌 → 503（说明原因），令牌不对 → 401。
 */
function authorize(req: IncomingMessage, res: ServerResponse, expected: string): boolean {
  if (isSameOriginLoopback(req)) return true;
  if (expected === "") {
    // 没配置令牌又不是同源请求就不开放写操作：这个接口能被任意网页上下文经由扩展触发，
    // 「没配置 = 放行」等于给本机开一个后门。
    writeJson(req, res, 503, { error: "素材库未配置访问令牌" });
    return false;
  }
  const provided = req.headers["x-save-token"];
  if (typeof provided !== "string" || provided !== expected) {
    writeJson(req, res, 401, { error: "令牌不对" });
    return false;
  }
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * CORS 头（只对扩展来源回）。
 *
 * 只**计算**头，不写响应：`res.writeHead` 一调用响应头就发出去了，之后再 `setHeader`
 * （`Content-Type` / `Content-Length`）会抛 `ERR_HTTP_HEADERS_SENT`，请求直接挂起。
 * 所以调用方必须把这里的头和自己的头合并后**只 `writeHead` 一次**（见 `writeJson` / OPTIONS 分支）。
 *
 * 普通网页发不出 `X-Save-Token` 这个自定义头（会先被预检挡下），所以它即使知道端口也存不进东西。
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin ?? "";
  if (!origin.startsWith("chrome-extension://") && !origin.startsWith("moz-extension://")) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Save-Token",
    "Access-Control-Max-Age": "600"
  };
}

function writeJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse): boolean {
  writeJson(req, res, 405, { error: "方法不允许" });
  return true;
}
