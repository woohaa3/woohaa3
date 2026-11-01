/**
 * 静态站点服务。
 *
 * 抽成模块是为了让生产入口（`scripts/serve-web.mjs`）、组合入口（`scripts/dev-orchestrator.mjs`）
 * 与 E2E 入口（`web/e2e/server.mjs`）**共用同一份静态实现**：生产入口注入真实 COS handler，
 * E2E 入口注入内存实现。
 *
 * change: 2026-10-15-support-configurable-app-base-path：本模块只处理**应用逻辑路径**
 * （挂载前缀已由公开边界适配器剥离）。应用 HTML 在响应时注入运行时 `<base href>` 与公开
 * basePath 元数据，使同一份相对资源产物可在任意挂载下正确解析（深链接回退同样生效）。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";
import { injectAppHtml } from "./app-html.mjs";

function acceptsGzip(header = "") {
	const qualities = new Map(String(header).split(",").map(part => {
		const [encoding, ...params] = part.trim().toLowerCase().split(";");
		const quality = params.find(param => param.trim().startsWith("q="));
		return [encoding, quality ? Number(quality.trim().slice(2)) : 1];
	}));
	return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0;
}

export const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".pck": "application/octet-stream",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".otf": "font/otf",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

/** 静态资源默认响应头（无跨源隔离需求）。 */
export const ISOLATION_HEADERS = {};

export function send(res, status, body, type = "text/plain; charset=utf-8") {
	res.writeHead(status, {
		"content-type": type,
		"content-length": Buffer.byteLength(body),
		...ISOLATION_HEADERS,
		"cache-control": "no-cache",
	});
	res.end(body);
}

/**
 * 内存响应的 JSON（带可选 gzip）。运行期扩展发布目录的 catalog 从这里出，不走文件系统。
 * `immutable` 为真时按内容寻址给长期缓存（releaseId 即在路径里）。
 *
 * 与 master 口径一致；分支的 `createStaticHandler` 仍是就地实现，不合并。
 */
export function sendJson(req, res, body, { immutable = false, status = 200 } = {}) {
	const payload = Buffer.from(body, "utf8");
	const gzip = payload.length >= 1024 && acceptsGzip(req.headers["accept-encoding"]);
	const headers = {
		"content-type": "application/json; charset=utf-8",
		...ISOLATION_HEADERS,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	};
	if (gzip) {
		headers["content-encoding"] = "gzip";
		res.writeHead(status, headers);
		res.end(req.method === "HEAD" ? undefined : gzipSync(payload));
		return;
	}
	headers["content-length"] = payload.length;
	res.writeHead(status, headers);
	res.end(req.method === "HEAD" ? undefined : payload);
}

/**
 * 响应磁盘上的静态文件（gzip + 缓存策略）。运行期扩展发布目录按请求路径声明内容寻址
 * （`options.immutable`）；缺省按磁盘路径的 hash 段推断。
 */
export function serveFile(req, res, filePath, options = {}) {
	const type = MIME[path.extname(filePath)] || "application/octet-stream";
	/*
	 * **文件可能在路由判定之后、读盘之前消失**：`browser-dist/` 是整目录替换的，
	 * 宿主启动时按当时的目录建了映射，重建扩展之后旧入口就没了。
	 * 这里必须兜住：`statSync` 抛出的 ENOENT 没有被接住的话会一路冒到
	 * `uncaughtException`，**把整个宿主进程打死**（实测两次：桌面端卡在启动页、
	 * 5174/5181 一起消失，日志里只有一条 ENOENT）。
	 * 缺一个静态资源只该是 404，不该是服务退出。
	 */
	let size;
	try {
		size = fs.statSync(filePath).size;
	} catch (error) {
		if (!res.headersSent) send(res, 404, "not found");
		else if (!res.destroyed) res.destroy();
		return;
	}
	const compressible = /\.(?:html|js|mjs|css|json|svg|wasm)$/.test(filePath);
	const gzip = compressible && size >= 1024 && acceptsGzip(req.headers["accept-encoding"]);
	const normalizedPath = filePath.replaceAll(path.sep, "/");
	const immutable =
		options.immutable ??
		(/\/assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(normalizedPath) ||
			/\/extensions\/[^/]+\/[0-9a-f]{64}\//.test(normalizedPath) ||
			/\/extension-releases\/[0-9a-f]{64}\.json$/.test(normalizedPath));
	res.writeHead(200, {
		"content-type": type,
		...(gzip ? { "content-encoding": "gzip" } : { "content-length": size }),
		...(compressible ? { vary: "Accept-Encoding" } : {}),
		...ISOLATION_HEADERS,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	if (req.method === "HEAD") { res.end(); return; }
	const streams = [fs.createReadStream(filePath), ...(gzip ? [createGzip()] : []), res];
	pipeline(...streams, error => { if (error && !res.destroyed) res.destroy(error); });
}

/**
 * 返回一个静态请求处理器。`dist` 是构建产物目录；SPA 回退只对无扩展名路由生效
 * （缺失的 .wasm 必须 404，否则运行时加载会拿到 HTML）。
 *
 * `options.basePath` 是当前公开挂载路径（规范化），用于在应用 HTML 中注入运行时 `<base>`
 * 与公开 basePath 元数据。处理器收到的已是应用逻辑路径。
 * `options.pageTitle` 可在响应时替换标题，不修改构建文件。
 * `options.transformHtml(html, { pathname })` 是可选的服务期改写钩子，只对 `index.html` 生效；
 * 生产/组合入口用它注入运行期发布目录 link（`/extension-releases/<releaseId>.json`），
 * 使发布指针不再依赖构建期就地改写 HTML。
 */
export function createStaticHandler(dist, options = {}) {
	const resolvedDist = path.resolve(dist);
	const basePath = typeof options.basePath === "string" && options.basePath !== "" ? options.basePath : "/";
	// `options.prefix` 仅供 E2E 的 showcase 子站挂载到另一目录段使用；应用入口不再使用它
	// （应用挂载由公开边界适配器处理，静态处理器只接收应用逻辑路径）。
	const prefix = typeof options.prefix === "string" ? options.prefix.replace(/\/$/, "") : "";
	const transformHtml = typeof options.transformHtml === "function" ? options.transformHtml : null;
	return (req, res) => {
		const url = new URL(req.url || "/", "http://localhost");
		let pathname;
		try { pathname = decodeURIComponent(url.pathname); }
		catch { send(res, 400, "invalid path"); return; }
		if (prefix) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
				send(res, 404, "not found");
				return;
			}
			pathname = pathname.slice(prefix.length) || "/";
		}
		let filePath = path.normalize(path.join(resolvedDist, pathname));
		if (filePath !== resolvedDist && !filePath.startsWith(`${resolvedDist}${path.sep}`)) {
			send(res, 403, "forbidden");
			return;
		}
		const exists = fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory();
		if (!exists) {
			if (path.extname(pathname) !== "") {
				send(res, 404, "not found");
				return;
			}
			filePath = path.join(resolvedDist, "index.html");
		}
		if (!fs.existsSync(filePath)) {
			send(res, 404, "not found");
			return;
		}
		const type = MIME[path.extname(filePath)] || "application/octet-stream";
		// Only content-addressed build assets are immutable; HTML and named WASM revalidate.
		// 发布扩展资源也按内容寻址：`/extensions/<id>/<artifactId>/...` 与
		// `/extension-releases/<releaseId>.json` 的目录段均为 sha256，可长期 immutable 缓存；
		// `index.html` 与具名 WASM 仍 revalidate（发布时 link 会被就地改写）。
		const normalizedPath = filePath.replaceAll(path.sep, "/");
		const hashedAsset =
			/\/assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(normalizedPath) ||
			/\/extensions\/[^/]+\/[0-9a-f]{64}\//.test(normalizedPath) ||
			/\/extension-releases\/[0-9a-f]{64}\.json$/.test(normalizedPath);
		if (path.extname(filePath) === ".html") {
			// 应用 HTML：注入运行时挂载基准；HTML 体积小，直接内存改写后再走压缩/长度语义。
			let html;
			try { html = fs.readFileSync(filePath, "utf8"); }
			catch { send(res, 404, "not found"); return; }
			// 服务期发布目录 link：只改写应用入口 HTML，普通 .html 资源保持原样。
			const rendered = transformHtml && path.basename(filePath) === "index.html" ? transformHtml(html, { pathname }) : html;
			const body = Buffer.from(injectAppHtml(rendered, basePath, options.pageTitle), "utf8");
			const gzip = body.length >= 1024 && acceptsGzip(req.headers["accept-encoding"]);
			res.writeHead(200, {
				"content-type": type,
				...(gzip ? { "content-encoding": "gzip" } : { "content-length": body.length }),
				vary: "Accept-Encoding",
				...ISOLATION_HEADERS,
				"cache-control": "no-cache",
			});
			if (req.method === "HEAD") { res.end(); return; }
			if (gzip) pipeline(Readable.from(body), createGzip(), res, error => { if (error && !res.destroyed) res.destroy(error); });
			else res.end(body);
			return;
		}
		const size = fs.statSync(filePath).size;
		const compressible = /\.(?:js|mjs|css|json|svg|wasm)$/.test(filePath);
		const gzip = compressible && size >= 1024 && acceptsGzip(req.headers["accept-encoding"]);
		res.writeHead(200, {
			"content-type": type,
			...(gzip ? { "content-encoding": "gzip" } : { "content-length": size }),
			...(compressible ? { vary: "Accept-Encoding" } : {}),
			...ISOLATION_HEADERS,
			"cache-control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
		});
		if (req.method === "HEAD") { res.end(); return; }
		const streams = [fs.createReadStream(filePath), ...(gzip ? [createGzip()] : []), res];
		pipeline(...streams, error => { if (error && !res.destroyed) res.destroy(error); });
	};
}
