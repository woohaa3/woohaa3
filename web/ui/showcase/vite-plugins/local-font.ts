import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * 面板字体：源工程用 `@fontsource/noto-sans-sc`，仓库里已有 Godot 侧的
 * `game/assets/fonts/NotoSansSC-Regular.otf`。直接复用它，避免重复提交 8MB。
 *
 * 抽成独立模块是因为 Ladle 不读应用自己的插件列表 —— 它只加载项目根目录的
 * `vite.config.ts`（或用 config 的 `viteConfig` 指定）。把插件放在这里，Vite
 * 应用与 Ladle 两个宿主可以共用同一份实现。
 *
 * 路径基于本文件位置解析（而非 cwd），所以 Ladle 替换 Vite `root` 也不受影响。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
// `web/ui/showcase/vite-plugins` → 仓库根的 web 目录；字体在 web/frontend/public 下，
// 与生产构建使用同一份（Bevy 运行时按 URL 读取，不经 Vite 模块图）。
const webRoot = path.resolve(here, "..", "..", "..");

const FONT_FILE = path.join(webRoot, "frontend", "public", "assets", "fonts", "NotoSansSC-Regular.otf");
const FONT_URL = "/fonts/NotoSansSC-Regular.otf";
// Bevy 的 AssetPlugin（`file_path: "assets"`）相对**页面 base** 读取字体；
// 与生产同构的路径是 `assets/fonts/...`，因此同一个文件要在两个 URL 都可见。
const ASSET_FONT_URL = "/assets/fonts/NotoSansSC-Regular.otf";
const FONT_URLS = [FONT_URL, ASSET_FONT_URL];

export function localFont(): Plugin {
	return {
		name: "local-noto-sans-sc",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url || !FONT_URLS.some((url) => req.url!.startsWith(url))) {
					next();
					return;
				}
				if (!existsSync(FONT_FILE)) {
					next();
					return;
				}
				const body = readFileSync(FONT_FILE);
				res.writeHead(200, {
					"content-type": "font/otf",
					"content-length": body.length,
					"cache-control": "no-cache",
				});
				res.end(body);
			});
		},
		generateBundle() {
			if (existsSync(FONT_FILE)) {
				const source = readFileSync(FONT_FILE);
				this.emitFile({ type: "asset", fileName: "fonts/NotoSansSC-Regular.otf", source });
				this.emitFile({ type: "asset", fileName: "assets/fonts/NotoSansSC-Regular.otf", source });
			}
		},
	};
}
