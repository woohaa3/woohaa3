#!/usr/bin/env node
/**
 * 确保 PhotoCraft 内核 WASM 产物存在
 * （change: 2026-10-21-extract-photocraft-subproject，任务 2.4/5.4）。
 *
 * 独立 dev 宿主通过 `@woohaa3/photocraft-editor/wasm` 从子项目产物加载；宿主前端使用复制到
 * `web/frontend/src/photocraft-wasm/` 的源码根副本，避免跨 workspace 的 `@fs` 请求。两边产物
 * 都是生成物，不入 Git。
 *
 * - 子项目与宿主副本都已就绪 → 直接返回，不重复编译。
 * - 缺任一 → 调用子项目构建，并同步 `web/frontend/src/photocraft-wasm/`。
 *
 * 只在显式 dev/build 流程调用；**不放进** install/prepare，避免安装时隐式联网构建 Rust。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncPhotocraftWasm } from "./lib/photocraft-wasm-copy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = join(root, "photocraft", "packages", "editor", "dist", "wasm");
const glue = join(wasmDir, "photocraft_editor.js");
const binary = join(wasmDir, "photocraft_editor_bg.wasm");

if (existsSync(glue) && existsSync(binary)) {
  const copied = syncPhotocraftWasm(root);
  if (copied.copied) console.log(`✓ 宿主 WASM 副本 → ${copied.destination}`);
  process.exit(0);
}

console.log("▶ PhotoCraft 内核 WASM 尚未构建，先构建一次（photocraft/scripts/build-wasm.mjs）");
const result = spawnSync(process.execPath, [join(root, "scripts", "build-image-editor-wasm.mjs")], {
  cwd: root,
  stdio: "inherit"
});
if (result.error) {
  console.error(`✗ 无法启动 PhotoCraft WASM 构建：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
