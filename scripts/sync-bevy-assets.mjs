#!/usr/bin/env node
/**
 * 同步 Bevy 运行时静态资源到 Vite public 目录。
 *
 *   node scripts/sync-bevy-assets.mjs
 *
 * 背景（change: 2026-10-09-sync-bevy-assets-and-fail-loud）：
 *   Bevy `AssetPlugin` 的 `file_path: "assets"` 相对**页面 base** 解析，运行时按 URL
 *   `/assets/...` 读取（不经 Vite 模块图）。因此 `bevy/assets/` 下的资源必须出现在
 *   `web/frontend/public/assets/`。
 *
 *   权威源 `bevy/assets/`（入库）→ 运行副本 `web/frontend/public/assets/`（.gitignore 忽略）。
 *   过去只有重量级 `build:bevy`（需要 Rust/wasm-bindgen）会复制字体。当 wasm glue 已存在
 *   （worktree、CI 缓存、手动拷贝）但运行副本缺失时，`pnpm dev` 会静默缺字体，表现为
 *   「节点名/画布文字全部消失」且无报错。本脚本把复制拆成**不依赖 Rust 的独立步骤**，
 *   可挂在 install / dev / build 上，保证任何开发入口都有资源。
 *
 * 幂等：仅当源与目标大小或 mtime 不同才复制；重复运行无副作用。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
export const BEVY_ASSETS_SOURCE_DIR = join(root, "bevy", "assets");
/** Vite 的 publicDir 根；`/assets/x` 映射到 `<publicDir>/assets/x`。 */
export const FRONTEND_PUBLIC_DIR = join(root, "web", "frontend", "public");
export const BEVY_ASSETS_TARGET_DIR = join(FRONTEND_PUBLIC_DIR, "assets");

/** 递归收集 `dir` 下所有普通文件。 */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

/** 目标是否需要（重新）写入：缺失，或大小/内容与源不同。 */
function needsCopy(source) {
	const target = join(BEVY_ASSETS_TARGET_DIR, relative(BEVY_ASSETS_SOURCE_DIR, source));
	if (!existsSync(target)) return true;
	const s = statSync(source);
	const t = statSync(target);
	if (s.size !== t.size) return true;
	// 大小相同再比对内容，避免依赖 mtime（copyFileSync 会重置目标 mtime）。
	return !readFileSync(source).equals(readFileSync(target));
}

/**
 * 幂等同步 `bevy/assets/` → `web/frontend/public/assets/`。
 * @returns {{ copied: number, total: number, target: string }}
 */
export function syncBevyAssets() {
	if (!existsSync(BEVY_ASSETS_SOURCE_DIR)) {
		throw new Error(`[assets:sync] 缺少源目录 ${BEVY_ASSETS_SOURCE_DIR}`);
	}
	const files = walk(BEVY_ASSETS_SOURCE_DIR);
	mkdirSync(BEVY_ASSETS_TARGET_DIR, { recursive: true });
	let copied = 0;
	for (const source of files) {
		if (!needsCopy(source)) continue;
		const target = join(BEVY_ASSETS_TARGET_DIR, relative(BEVY_ASSETS_SOURCE_DIR, source));
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		copied += 1;
	}
	return { copied, total: files.length, target: BEVY_ASSETS_TARGET_DIR };
}

// 直接执行（`node scripts/sync-bevy-assets.mjs`）时运行并打印摘要；被 import 时只导出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const { copied, total, target } = syncBevyAssets();
		const suffix = copied === 0 ? "已是最新" : `复制 ${copied}/${total} 个文件`;
		process.stdout.write(`[assets:sync] ${suffix} → ${target}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
