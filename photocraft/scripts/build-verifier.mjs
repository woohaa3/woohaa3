#!/usr/bin/env node
/**
 * 构建原生工程核验工具（Media 内部适配调用）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 1.2 / design D5；
 *  change: 2026-10-21-extract-photocraft-subproject，任务 2.4 —— 从根脚本迁入子项目）。
 *
 *   node scripts/build-verifier.mjs [--debug] [--offline] [--out-dir <dir>]
 *
 * 只做一件事：构建 `rust/crates/project-verify` 的原生二进制并打印路径与体积。它不链接任何
 * UI（egui/eframe/wgpu），由 Media 以参数数组方式调用、限时、限输出、限并发。
 *
 * 默认产物目录 `packages/project-verifier/dist/bin/`，按平台带后缀：
 * Windows 产出 `photocraft-project-verify.exe`。部署方仍可用原有的绝对路径配置覆盖。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const workspace = join(root, "rust");

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const debug = process.argv.includes("--debug");
const offline = process.argv.includes("--offline");
const profile = debug ? "debug" : "release";
const outDir = resolve(root, readArg("out-dir") ?? "packages/project-verifier/dist/bin");
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, ".local/native-target");

/** 平台后缀：Windows 必须带 `.exe`，否则 Media 按裸名调用会 ENOENT。 */
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const builtBinary = join(targetDir, profile, `photocraft-project-verify${exeSuffix}`);
const outputBinary = join(outDir, `photocraft-project-verify${exeSuffix}`);

const env = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}`
};

function main() {
  const args = [
    "build",
    "-p",
    "photocraft-project-verify",
    ...(debug ? [] : ["--release"]),
    ...(offline ? ["--offline"] : [])
  ];
  const result = spawnSync("cargo", args, { cwd: workspace, env, stdio: "inherit" });
  if (result.error) throw new Error("未找到 cargo，请安装 Rust 工具链。", { cause: result.error });
  if (result.status !== 0) {
    const error = new Error(`cargo build 失败（exit ${result.status}）`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  if (!existsSync(builtBinary)) throw new Error(`找不到核验工具产物 ${builtBinary}`);

  mkdirSync(outDir, { recursive: true });
  copyFileSync(builtBinary, outputBinary);
  console.log(
    `✓ 工程核验工具就绪 → ${outputBinary}（${(statSync(outputBinary).size / 1024 / 1024).toFixed(2)} MiB）`
  );
}

try {
  main();
} catch (error) {
  console.error(`✗ 工程核验工具构建失败：${error?.message ?? error}`);
  process.exit(error?.exitCode ?? 1);
}
