#!/usr/bin/env node
/**
 * PhotoCraft 子项目的宿主转发入口
 * （change: 2026-10-21-extract-photocraft-subproject，design D1）。
 *
 *   node scripts/photocraft.mjs <install|setup|check|dev|wasm|verifier> [...args]
 *
 * 为什么需要这层：核心是**独立工作区**（自己的 `package.json` / `pnpm-lock.yaml` / Cargo
 * workspace），宿主的 `web/pnpm-workspace.yaml` 只以精确成员路径安装 `integrations/woohaa`，
 * 因此 `web` 能解析到核心包的前提是核心**已经 install 并 build** 过。把顺序收在这里，
 * 而不是让 `install` / `prepare` 隐式联网构建 Rust：
 *
 * - `install`  只做核心的 frozen 安装（不构建、不联网拉 Rust 依赖）；
 * - `setup`    核心 frozen 安装 → 构建核心包（宿主 `link:` 解析依赖这一步）；
 * - `check`    核心 typecheck + test + 非渲染 Rust 检查；
 * - `dev`      启动子项目自己的编辑宿主（真实 WASM，不接 Canvas 服务）；
 * - `wasm` / `verifier` 构建内核产物与原生核验工具。
 *
 * 命令失败时如实返回非零，不打印「已就绪」。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncPhotocraftWasm } from "./lib/photocraft-wasm-copy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const projectDir = join(root, "photocraft");

const [, , command, ...rest] = process.argv;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(step, args, options = {}) {
  console.log(`\n▶ ${step}`);
  // Windows 上 pnpm 是 `.cmd`，Node 不能直接 spawn（EINVAL），也不该拼命令行 → 交给 cmd.exe
  // 以**固定参数数组**调用 `pnpm.cmd`。参数只来自本脚本内的字面量，不接收用户输入拼接。
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec || "cmd.exe" : "pnpm";
  const commandArgs = isWindows ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? projectDir,
    stdio: "inherit"
  });
  if (result.error) fail(`${step} 无法启动：${result.error.message}`);
  if (result.status !== 0) fail(`${step} 失败（exit ${result.status}）`);
}

if (!existsSync(projectDir)) {
  fail(`找不到子项目目录 ${projectDir}；请确认 change 2026-10-21-extract-photocraft-subproject 已实施`);
}

switch (command) {
  case "install":
    run("PhotoCraft 核心 frozen 安装", ["install", "--frozen-lockfile"]);
    break;
  case "setup":
    run("PhotoCraft 核心 frozen 安装", ["install", "--frozen-lockfile"]);
    run("PhotoCraft 核心构建", ["run", "build"]);
    break;
  case "check":
    run("PhotoCraft 核心构建", ["run", "build"]);
    run("PhotoCraft 类型检查", ["run", "typecheck"]);
    run("PhotoCraft 单元与回归", ["run", "test"]);
    run("PhotoCraft 非渲染 Rust 检查（cargo test --workspace）", ["run", "rust:test"]);
    break;
  case "dev":
    run("PhotoCraft 独立编辑宿主", ["run", "dev", ...rest]);
    break;
  case "wasm":
    run("PhotoCraft 内核 WASM 构建", ["run", "wasm", ...rest]);
    {
      const copied = syncPhotocraftWasm(root);
      if (copied.copied) console.log(`✓ 宿主 WASM 副本 → ${copied.destination}`);
    }
    break;
  case "verifier":
    run("PhotoCraft 原生核验工具构建", ["run", "verifier", ...rest]);
    break;
  default:
    fail(`未知命令 ${command ?? "(空)"}；可用：install | setup | check | dev | wasm | verifier`);
}
