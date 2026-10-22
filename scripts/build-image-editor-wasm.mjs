#!/usr/bin/env node
/**
 * 转发入口：构建 PhotoCraft 编辑内核 WASM
 * （change: 2026-10-21-extract-photocraft-subproject，任务 2.4）。
 *
 * 实现已迁入子项目：[`photocraft/scripts/build-wasm.mjs`](../photocraft/scripts/build-wasm.mjs)。
 * 本文件只转发构建，然后把生成物复制到 `web/frontend/src/photocraft-wasm/`；
 * 子项目产物仍在 `photocraft/packages/editor/dist/wasm/`，宿主 Vite 从自身源码根加载副本。
 *
 *   node scripts/build-image-editor-wasm.mjs [--debug] [--skip-opt] [--keep-names]
 *
 * 也保留了旧签名，方便既有本地习惯与文档继续可用。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncPhotocraftWasm } from "./lib/photocraft-wasm-copy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "photocraft", "scripts", "build-wasm.mjs");

const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(`✗ 无法启动子项目构建脚本：${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
const copied = syncPhotocraftWasm(join(here, ".."));
if (copied.copied) console.log(`✓ 宿主 WASM 副本 → ${copied.destination}`);
process.exit(0);
