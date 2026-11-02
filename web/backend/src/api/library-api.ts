/**
 * 素材库 HTTP 面：`/api/library/*`。
 *
 * 一个独立来源（浏览器扩展「保存到四喜」）往里存图片，画布与资源栏从里面取用。
 * **它不属于任何画布** —— 存进来只是「攒着」，加进画布是另一个显式动作。
 *
 * 路由：
 * - `POST   /api/library/import`  `{ url, title?, pageUrl? }` → 下载、落媒体、记索引
 * - `GET    /api/library`         列出（按保存时间倒序）
 * - `DELETE /api/library/<id>`    删除索引（**不删媒体对象** —— 它可能被别的画布引用）
 *
 * 安全：
 * - 只接受 http / https 地址；`file:`、`data:` 一律拒绝 —— 放行等于开一条读本机文件的通路；
 * - 令牌从环境变量读，未配置时**直接 503**，绝不退化成「没令牌就当通过」。
 *   这个接口能从任意网页上下文被触发（通过扩展），没有令牌就是给本机开了一个后门。
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
      writeCors(req, res, 204);
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

    if (pathname === LIBRARY_BASE_PATH) {
      if (req.method !== "GET") return methodNotAllowed(req, res);
      const items = await store.list();
      writeJson(req, res, 200, { items, total: items.length });
      return true;
    }

    const id = pathname.slice(LIBRARY_BASE_PATH.length + 1);
    if (id && !id.includes("/")) {
      if (req.method !== "DELETE") return methodNotAllowed(req, res);
      if (!requireToken(req, res, token)) return true;
      const removed = await store.remove(id);
      writeJson(req, res, removed ? 200 : 404, removed ? { removed: true } : { error: "素材不存在" });
      return true;
    }

    writeJson(req, res, 404, { error: "没有这个接口" });
    return true;
  };

  async function importOne(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requireToken(req, res, token)) return;

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

/** 校验令牌；返回是否通过（未通过时已经写过响应）。 */
function requireToken(req: IncomingMessage, res: ServerResponse, expected: string): boolean {
  if (expected === "") {
    // 没配置令牌就不开放写操作：这个接口能被任意网页上下文经由扩展触发，
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
 * CORS。
 *
 * 只对扩展来源回 `Access-Control-Allow-Origin`：普通网页发不出 `X-Save-Token`
 * 这个自定义头（会先被预检挡下），所以它即使知道端口也存不进东西。
 */
function writeCors(req: IncomingMessage, res: ServerResponse, status: number): void {
  const origin = req.headers.origin ?? "";
  const headers: Record<string, string> = {};
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Save-Token";
    headers["Access-Control-Max-Age"] = "600";
  }
  res.writeHead(status, headers);
}

function writeJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  writeCors(req, res, status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse): boolean {
  writeJson(req, res, 405, { error: "方法不允许" });
  return true;
}
