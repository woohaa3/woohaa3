import { defineConfig, loadEnv, type Plugin } from "vite";
import { externalizeEditorWasm, frontendTarget } from "./frontend-target.js";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** 静态资源 MIME（与 `scripts/lib/static-server.mjs` 的发布资源子集一致）。 */
const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

/**
 * Frontend 运行单元（change: split-web-runtime-services，任务 6.1 / 6.3 / 8.5）。
 *
 * 这个单元**只构建浏览器资源**，不再持有任何服务端组合根：dev/preview 把站点 API 经
 * 同源 ingress 代理到三个独立服务，与生产入口（`scripts/dev-orchestrator.mjs`）行为一致。
 *
 * 服务端环境变量（`COS_*` / `PPTASK_*`）只在**服务进程**里读取，绝不进入本单元的 bundle。
 */

const serviceProxy = (targets: { canvas: string; task: string; media: string; mcp: string; application: string }, basePath: string): Plugin => ({
  name: "service-proxy",
  async configureServer(server) {
    await mountServiceProxy(server, targets, basePath, server.config.logger);
  },
  async configurePreviewServer(server) {
    await mountServiceProxy(server, targets, basePath, server.config.logger);
  }
});

type MiddlewareHost = {
  middlewares: {
    use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void;
  };
  httpServer?: {
    on(event: string, listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
  } | null;
};

type ViteLogger = {
  warn: (message: string) => void;
  info: (message: string, options?: { timestamp?: boolean }) => void;
};

async function mountServiceProxy(
  server: MiddlewareHost,
  targets: { canvas: string; task: string; media: string; mcp: string; application: string },
  basePath: string,
  logger: ViteLogger
): Promise<void> {
  // ingress 位于**仓库根**的 scripts/ 下（web/scripts 是另一个目录），用 import.meta.url
  // 解析绝对路径，避免相对路径随 cwd/文件位置漂移。
  const ingressUrl = new URL("../../scripts/lib/ingress.mjs", import.meta.url).href;
  const mod = (await import(
    /* @vite-ignore */ ingressUrl
  )) as {
    createIngress: (options: {
      targets: { canvas: string; task: string; media: string; mcp: string; application: string };
      basePath?: string;
      logger: (event: { event: string; status?: number; code?: string }) => void;
    }) => {
      handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
      upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
    };
  };
  const ingress = mod.createIngress({
    targets,
    basePath,
    logger: (event) =>
      logger.info(`[service-proxy] ${event.event}${event.status ? ` ${event.status}` : ""}`, {
        timestamp: true
      })
  });
  if (server.httpServer) {
    server.httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // 只有站点 ingress 认领的 upgrade（Canvas 同步）才处理；其余（例如 Vite 自己的
      // `@vite/client` HMR websocket）必须原样放行，否则 HMR 连接会被切断，
      // 表现为「server connection lost. Polling for restart...」并让 Godot 起不来。
      if (ingress.upgrade(req, socket, head)) return;
    });
  }
  server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    void ingress.handle(req, res).then((handled) => {
      if (!handled) next();
    });
  });
  logger.info(
    `[service-proxy] 已启用：canvas=${targets.canvas} task=${targets.task} media=${targets.media} mcp=${targets.mcp}`,
    { timestamp: true }
  );
}

// Bevy WASM 运行时不需要跨源隔离（无 SharedArrayBuffer）；不再注入 COOP/COEP 头。

/**
 * 缺失静态资源守卫（change: 2026-10-09-sync-bevy-assets-and-fail-loud）。
 *
 * Vite dev 的 SPA 回退会对任意缺失路径返回 index.html（200 text/html）。Bevy 运行时按 URL
 * `/assets/...` 直接读取字体，一旦运行副本缺失就拿不到字体、报 `unknown magic`，表现为
 * 「节点名/画布文字全部消失」且无明确原因。生产静态服务器对带扩展名的缺失路径会 404，
 * 因此这里对齐生产语义：`/assets/` 下带扩展名且磁盘上不存在 → 显式 404，让缺失可诊断。
 *
 * 只拦截 Bevy 运行时资源前缀 `/assets/`；Vite 源码图（`/src/...`）、`/@fs/`、`/@vite/`、
 * `node_modules` 等路径不受影响。
 */
const missingStaticGuard = (basePath: string, strip: (basePath: string, pathname: string) => string | null): Plugin => ({
  name: "missing-static-asset-guard",
  configureServer(server) {
    const publicDir = server.config.publicDir;
    server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const rawPathname = (req.url ?? "").split("?")[0];
      // 挂载路径在 Vite base 中间件之前到达本项目中间件；先按挂载前缀归一后再判定。
      const pathname = strip(basePath, rawPathname) ?? rawPathname;
      if (!pathname.startsWith("/assets/")) return next();
      if (!/\.[a-z0-9]+$/i.test(pathname)) return next();
      const filePath = join(publicDir, decodeURIComponent(pathname));
      if (existsSync(filePath) && statSync(filePath).isFile()) return next();
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(
        `缺失静态资源 ${pathname}。\n运行 \`node scripts/sync-bevy-assets.mjs\`（或 \`pnpm run assets:sync\`）补齐后重试。\n`
      );
    });
  }
});

const interactionPerformance = (env: Record<string, string | undefined>, basePath: string): Plugin => ({
  name: "dev-interaction-performance",
  async configureServer(server) {
    if (env.VITE_WOOHAA_PERFORMANCE === "0") return;
    const moduleUrl = new URL("../../scripts/lib/dev-performance.mjs", import.meta.url);
    // Vite config restarts retain Node's ESM cache; reload an edited collector.
    moduleUrl.searchParams.set("mtime", String(statSync(moduleUrl).mtimeMs));
    const { createInteractionPerformanceSink, INTERACTION_PERFORMANCE_PATH } = await import(/* @vite-ignore */ moduleUrl.href);
    const sink = await createInteractionPerformanceSink({
      root: fileURLToPath(new URL("../../", import.meta.url)),
      outputDir: env.WOOHAA3_PERFORMANCE_DIR,
      logger: (message: string) => server.config.logger.warn(message)
    });
    server.middlewares.use((req, res, next) => {
      const pathname = req.url?.split("?")[0];
      const mounted = `${basePath.replace(/\/$/, "")}${INTERACTION_PERFORMANCE_PATH}`;
      if (pathname !== INTERACTION_PERFORMANCE_PATH && pathname !== mounted) return next();
      void sink.handle(req, res);
    });
    server.config.logger.info(`[performance] 启动/素材/交互报告 → ${sink.directory}`);
    server.config.logger.info(`[canvas-input] 输入故障诊断 → ${sink.directory}/canvas-input.jsonl`);
  }
});

/**
 * 同步 Bevy 静态资源（change: 2026-10-09-sync-bevy-assets-and-fail-loud）。
 *
 * 必须在 Vite 建立 public 静态服务**之前**执行：Vite 在配置解析后即扫描 `publicDir`，若
 * 字体在扫描后才出现，dev 会继续对 `/assets/fonts/...` 返回 SPA 回退 HTML。因此这里在
 * `defineConfig` 回调（配置加载期）就同步，覆盖 `vite`/`vite build` 的所有直接调用入口。
 * 同步是轻量文件复制，不依赖 Rust。
 */
function syncBevyAssetsOnConfigLoad(configFileUrl: string): void {
  const script = fileURLToPath(new URL("../../scripts/sync-bevy-assets.mjs", configFileUrl));
  try {
    execFileSync(process.execPath, [script], { stdio: "inherit" });
  } catch (error) {
    // 同步失败不阻断配置加载，但必须显式告警而非静默。
    console.warn(`[assets:sync] 同步失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 扩展发布产物服务（change: 2026-10-12-build-and-load-extensions-independently，任务 6.6）。
 *
 * dev/preview 与生产使用**同一** path 语义：`/extensions/<id>/<artifactId>/...` 与
 * `/extension-releases/<releaseId>.json` 直接从 `dist/`（assembly 输出）静态服务；带扩展名的
 * 缺失资源显式 404（Vite 的 SPA 回退不会把 HTML 当成 JS/CSS 返回）。同时把 assembly 注入到
 * `dist/index.html` 的发布 link 透传给 dev 提供的 index.html，使 dev 也走发布目录加载。
 */
export const extensionReleaseStatic = (
  root: string,
  basePath: string,
  strip: (basePath: string, pathname: string) => string | null,
  backend?: string
): Plugin => {
  let dist = join(root, "dist");
  let building = false;
  const prefixes = ["/extensions/", "/extension-releases/"];
  const serveFromDist = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const rawPathname = (req.url ?? "").split("?")[0];
    // 发布资源在逻辑路径下固定；这里在 Vite base 中间件之前到达，先归一挂载前缀。
    const pathname = strip(basePath, rawPathname) ?? rawPathname;
    if (!prefixes.some((prefix) => pathname.startsWith(prefix))) return next();
    if (backend && !building) return next();
    if (!/\.[a-z0-9]+$/i.test(pathname)) return next();
    const filePath = join(dist, decodeURIComponent(pathname));
    if (!filePath.startsWith(dist) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`扩展发布资源不存在：${pathname}（先运行 build:browser 与 assemble:extensions）\n`);
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
    res.end(readFileSync(filePath));
  };
  return {
    name: "extension-release-static",
    config() {
      return { build: { emptyOutDir: false } };
    },
    configResolved(config) {
      dist = resolve(config.root, config.build.outDir);
      building = config.command === "build";
    },
    buildStart() {
      if (!building || !existsSync(dist)) return;
      // 宿主资源重新生成；独立发布的不可变扩展资源跨宿主构建保留。
      // 旧 index 留到 transformIndexHtml 读取发布指针后由本次构建覆盖。
      for (const entry of readdirSync(dist)) {
        if (["extensions", "extension-releases", "index.html"].includes(entry)) continue;
        rmSync(join(dist, entry), { recursive: true, force: true });
      }
    },
    configureServer(server) {
      server.middlewares.use(serveFromDist);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveFromDist);
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html: string) {
        // 开发期的发布目录由运行中的扩展宿主生成，不依赖旧 dist/index.html。
        if (backend && !building) {
          const response = await fetch(`${backend.replace(/\/$/, "")}${basePath}extension-releases/current.json`,
            { signal: AbortSignal.timeout(3000) }).catch(() => null);
          if (response?.ok) {
            const pointer = await response.json() as { href?: unknown };
            if (typeof pointer.href !== "string" || !/^\/extension-releases\/[a-f0-9]{64}\.json$/.test(pointer.href)) {
              throw new Error("后端扩展发布目录地址无效");
            }
            html = html.replace(/\s*<link\s+rel="woohaa-extension-release"[^>]*>/g, "");
            return html.replace("</head>", `<link rel="woohaa-extension-release" href="${pointer.href}" /></head>`);
          }
          return html;
        }
        const indexPath = join(dist, "index.html");
        if (!existsSync(indexPath)) return html;
        const match = readFileSync(indexPath, "utf8").match(
          /<link\s+rel="woohaa-extension-release"\s+href="([^"]+)"\s*\/?>/
        );
        if (!match || !existsSync(join(dist, match[1]))) return html;
        html = html.replace(/\s*<link\s+rel="woohaa-extension-release"[^>]*>/g, "");
        return html.replace("</head>", `\t\t<link rel="woohaa-extension-release" href="${match[1]}" />\n\t</head>`);
      }
    }
  };
};

/**
 * 应用挂载路径插件（change: 2026-10-15-support-configurable-app-base-path，design D2/D5）。
 *
 * - dev：Vite `base` 取规范化挂载前缀，站点在 `/` 之外也能被 dev 服务器服务；并在所有脚本/
 *   样式之前注入 `<base href>` 与公开 basePath 元数据，供浏览器解析器读取（深链接刷新不猜路径）。
 * - build：保持相对资源地址（`base: "./"`）；**不**把挂载前缀固化进产物（同一产物可部署到任意合法前缀）。
 * - preview：API 代理后，HTML 使用共享静态处理器注入挂载配置和启动标题，资源仍由 Vite 服务。
 */
const appBasePathPlugin = (options: {
  basePath: string;
  pageTitle: string;
  dev: boolean;
  preview: boolean;
  inject: (html: string, basePath: string, pageTitle: string) => string;
  servePreview: (dist: string) => (req: IncomingMessage, res: ServerResponse) => void;
  strip: (basePath: string, pathname: string) => string | null;
}): Plugin => {
  const plugin: Plugin = {
    name: "app-base-path",
    config() {
      return { base: options.dev || options.preview ? options.basePath : "./" };
    }
  };
  if (options.dev) {
    plugin.transformIndexHtml = {
      order: "pre",
      handler(html: string) {
        return options.inject(html, options.basePath, options.pageTitle)
          .replace("</head>", '<meta name="woohaa-development" content="true" /></head>');
      }
    };
  }
  if (options.preview) {
    plugin.configurePreviewServer = (server) => {
      const serveHtml = options.servePreview(resolve(server.config.root, server.config.build.outDir));
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const rawUrl = req.url ?? "/";
        const rawPathname = rawUrl.split("?")[0];
        const stripped = options.strip(options.basePath, rawPathname);
        // API 代理先执行。这里只处理应用 HTML 和 SPA 回退，资源仍交给 Vite。
        if (stripped === null || (extname(stripped) !== "" && extname(stripped) !== ".html")) return next();
        req.url = stripped + rawUrl.slice(rawPathname.length);
        serveHtml(req, res);
      });
    };
  }
  return plugin;
};

/**
 * 前端自身的构建标识（遥测/诊断上报的 `frontendVersion` 来源）。
 *
 * 管理端有 `WOOHAA_ADMIN_BUILD_*` 由 `admin/scripts/deploy.sh` 与服务端**同源**传下；
 * 浏览器前端这份产物没有配套部署脚本，所以缺省在配置加载期用 git 现场取值，而不是编一个
 * 版本号。显式环境变量优先，便于发布流水线注入，以及没有 `.git` 的构建环境。
 *
 * 取值口径（与 `web/frontend/src/cordis/services/build-info.ts` 的注释一致）：
 * - `commit`：短提交号；工作区脏时带 `-dirty`。与服务端 `make build` 的 `COMMIT`
 *   （`git rev-parse --short HEAD`）同格式，干净构建可以直接和管理端遥测页里的服务端提交号对照；
 * - `version`：`git describe --tags --always --dirty`，只在拿不到提交号时兜底。
 *
 * 两边都不做「兜底编造」：拿不到就留空串，前端据此自报"未注入"，而不是报一个像真的版本。
 */
function resolveFrontendBuild(
  env: Record<string, string | undefined>,
  root: string
): { version: string; commit: string } {
  const versionOverride = (env.WOOHAA_FRONTEND_BUILD_VERSION ?? "").trim();
  const commitOverride = (env.WOOHAA_FRONTEND_BUILD_COMMIT ?? "").trim();
  const described = gitOutput(root, ["describe", "--tags", "--always", "--dirty"]);
  const revision = gitOutput(root, ["rev-parse", "--short", "HEAD"]);
  return {
    version: versionOverride !== "" ? versionOverride : described,
    // 显式传入的提交号原样使用（调用方自己决定要不要带 `-dirty`）。
    commit:
      commitOverride !== "" ? commitOverride : revision !== "" && described.endsWith("-dirty") ? `${revision}-dirty` : revision
  };
}

/** 在仓库里跑一条只读 git 命令；git 不可用（无 `.git` / 未安装）时返回空串。 */
function gitOutput(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export default defineConfig(async ({ mode, command, isPreview }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const target = frontendTarget(root, mode);
  const env = { ...loadEnv(mode, root, ""), ...process.env };
  const build = resolveFrontendBuild(env, root);

  // 挂载路径：dev/preview 与生产使用同一规范化实现（scripts 侧共享 contracts 单一来源）。
  const pathModuleUrl = new URL("../../scripts/lib/app-base-path.mjs", import.meta.url).href;
  const htmlModuleUrl = new URL("../../scripts/lib/app-html.mjs", import.meta.url).href;
  const { resolveAppBasePath, stripAppBasePath } = (await import(/* @vite-ignore */ pathModuleUrl)) as {
    resolveAppBasePath: (env: Record<string, string | undefined>) => string;
    stripAppBasePath: (basePath: string, pathname: string) => string | null;
  };
  const { injectAppHtml, resolveAppPageTitle } = (await import(/* @vite-ignore */ htmlModuleUrl)) as {
    injectAppHtml: (html: string, basePath: string, pageTitle: string) => string;
    resolveAppPageTitle: (env: Record<string, string | undefined>) => string;
  };
  const staticModuleUrl = new URL("../../scripts/lib/static-server.mjs", import.meta.url).href;
  const { createStaticHandler } = (await import(/* @vite-ignore */ staticModuleUrl)) as {
    createStaticHandler: (
      dist: string,
      options: { basePath: string; pageTitle: string }
    ) => (req: IncomingMessage, res: ServerResponse) => void;
  };
  const pageTitle = resolveAppPageTitle(env);
  const { devWatchResilience } = await import(/* @vite-ignore */ new URL("../../scripts/lib/vite-dev-watch.mjs", import.meta.url).href);
  let basePath: string;
  try {
    basePath = resolveAppBasePath(env);
  } catch (error) {
    throw new Error(`[app-base-path] ${error instanceof Error ? error.message : String(error)}`);
  }
  const preview = command === "serve" && isPreview === true;
  const dev = command === "serve" && !preview;

  // 配置加载期即同步 Bevy 静态资源：必须早于 Vite 扫描 publicDir（否则 dev 仍对
  // `/assets/fonts/...` 走 SPA 回退返回 HTML）。覆盖 `vite` / `vite build` 所有直接入口。
  syncBevyAssetsOnConfigLoad(import.meta.url);

  // 后端已合并为单一进程（change: 2026-10-06-unify-backend-runtime-with-cordis）：
  // 所有同源路径都指向同一个后端进程。
  const backend = env.WOOHAA3_BACKEND_URL ?? "http://127.0.0.1:5180";
  const serviceTargets = {
    canvas: backend,
    task: backend,
    media: backend,
    mcp: backend,
    application: backend
  };
  // 开发采集的源码/二进制身份（A1）：仅 serve 且采集开启时安装；生产构建无此插件。
  const identityPlugins: Plugin[] = [];
  if (command === "serve" && env.VITE_WOOHAA_PERFORMANCE !== "0") {
    const identityUrl = new URL("../../scripts/lib/dev-build-identity.mjs", import.meta.url).href;
    const { devBuildIdentityPlugin } = await import(/* @vite-ignore */ identityUrl);
    identityPlugins.push(devBuildIdentityPlugin({ root: fileURLToPath(new URL("../../", import.meta.url)) }));
  }

  return {
    // Bevy WASM 运行时不需要跨源隔离（无 SharedArrayBuffer）；保留同源服务代理即可。
    // `missingStaticGuard` 必须排在 SPA 回退之前，使缺失的 `/assets/*` 显式 404。
    plugins: [
      react(),
      ...(target.nativeOnly ? [{
        name: "desktop-managed-image-editor",
        transform(code: string, id: string) {
          return id.endsWith("/src/photocraft-wasm/photocraft_editor.js") ? externalizeEditorWasm(code) : null;
        }
      }] : []),
      devWatchResilience({ outDir: join(root, "dist") }),
      missingStaticGuard(basePath, stripAppBasePath),
      extensionReleaseStatic(root, basePath, stripAppBasePath, dev ? backend : undefined),
      ...identityPlugins,
      interactionPerformance(env, basePath),
      serviceProxy(serviceTargets, basePath),
      // 预览期 HTML 由共享静态处理器在 API 代理之后提供（Vite preview 不执行开发期 transformIndexHtml）。
      appBasePathPlugin({
        basePath,
        pageTitle,
        dev,
        preview,
        inject: injectAppHtml,
        strip: stripAppBasePath,
        servePreview: (dist) => createStaticHandler(dist, { basePath, pageTitle })
      })
    ],
    // PhotoCraft 的 WASM 在根构建时复制到前端源码图；dev 从自身 root 提供，不依赖
    // workspace 外的 `@fs` 路径。子项目源码仍按 linked package 正常编译。
    resolve: {
      alias: [
        { find: "@woohaa3/photocraft-editor/wasm", replacement: resolve(root, "src/photocraft-wasm/photocraft_editor.js") }
      ]
    },
    server: { host: true, port: 5173 },
    // 构建期注入的构建标识：键名必须与 `src/cordis/services/build-info.ts` 里的 declare 一字不差。
    // define 是**文本替换**：写错不会有任何报错，只会在运行时报 ReferenceError；值必须经
    // JSON.stringify，否则字符串会被当成表达式粘进代码里。
    define: {
      __WOOHAA_NATIVE_ONLY__: JSON.stringify(target.nativeOnly),
      __WOOHAA_FRONTEND_BUILD_VERSION__: JSON.stringify(build.version),
      __WOOHAA_FRONTEND_BUILD_COMMIT__: JSON.stringify(build.commit)
    },
    // extensionReleaseStatic 只清宿主产物，不能让 Vite 删掉独立装配的发布目录。
    build: { outDir: "dist", assetsInlineLimit: 0, rollupOptions: { input: target.input } }
  };
});
