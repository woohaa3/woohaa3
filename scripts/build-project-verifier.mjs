#!/usr/bin/env node
/**
 * 转发入口：构建原生工程核验工具
 * （change: 2026-10-21-extract-photocraft-subproject，任务 2.4）。
 *
 * 实现已迁入子项目：[`photocraft/scripts/build-verifier.mjs`](../photocraft/scripts/build-verifier.mjs)。
 * 本文件**只转发**，不再持有第二份实现；产物默认在
 * `photocraft/packages/project-verifier/dist/bin/`（按平台带后缀，Windows 为 `.exe`）。
 *
 *   node scripts/build-project-verifier.mjs [--debug] [--offline]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "photocraft", "scripts", "build-verifier.mjs");

const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(`✗ 无法启动子项目构建脚本：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
