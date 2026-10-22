#!/usr/bin/env node
/**
 * 构建 PhotoCraft 编辑内核的 WASM 并生成 wasm-bindgen web 绑定
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 1.2/1.3 / design D1/D8；
 *  change: 2026-10-21-extract-photocraft-subproject，任务 2.4 —— 从根脚本迁入子项目）。
 *
 *   node scripts/build-wasm.mjs [--debug] [--skip-opt] [--keep-names] [--out-dir <dir>]
 *
 * 默认产物目录 `packages/editor/dist/wasm/`，与编辑器包自己的构建产物放在一起：
 * 由包的 `exports` 暴露，宿主用**字面量**动态 `import()` 让 Vite 切成按需 chunk，
 * glue 内部的 `new URL('./photocraft_editor_bg.wasm', import.meta.url)` 相对同一目录解析
 * 并由 Vite 改写为资源 URL。**不能**放进 `public/`：Vite 开发服务器会给动态 import 补
 * `?import` 走转换管线，而 `public/` 下的 `.js` 不经插件转换，会直接报错。
 *
 * 仓库根的同名旧入口（`scripts/build-image-editor-wasm.mjs`）只做转发，不留第二份实现。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const skipOpt = process.argv.includes("--skip-opt");
const keepNames = debug || process.argv.includes("--keep-names");
const optArgs = ["-Oz", ...(keepNames ? ["-g"] : [])];
const profile = debug ? "debug" : "release";
const release = !debug;
const outDir = resolve(root, readArg("out-dir") ?? "packages/editor/dist/wasm");

const OUT_NAME = "photocraft_editor";
/** Cargo 以 lib 名产出 `.wasm`；`OUT_NAME` 只决定 wasm-bindgen 的输出名。 */
const CRATE_ARTIFACT = "photocraft_embed_editor.wasm";
const glueName = `${OUT_NAME}.js`;
const wasmName = `${OUT_NAME}_bg.wasm`;
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, ".local/wasm-target");
const profileDir = debug ? "debug" : "wasm-release";
const rawArtifact = join(targetDir, "wasm32-unknown-unknown", profileDir, CRATE_ARTIFACT);

const env = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH}`
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    throw new Error(
      `未找到命令 \`${command}\`，请安装 Rust（rustup target add wasm32-unknown-unknown）与 wasm-bindgen-cli 0.2.x。`,
      { cause: result.error }
    );
  }
  if (result.status !== 0) {
    const error = new Error(`命令失败（exit ${result.status}）：${command} ${args.join(" ")}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

/** Vite 只对 `new URL('./relative', import.meta.url)` 做静态资源改写：补上 `./`。 */
function postprocessGlue(source) {
  return source.replace(
    new RegExp(`new URL\\((['"])${wasmName}\\1, import\\.meta\\.url\\)`),
    `new URL('./${wasmName}', import.meta.url)`
  );
}

function main() {
  console.log(
    `[photocraft-wasm] 模式：profile=${profile}，names=${keepNames ? "retained" : "default"}，optimize=${skipOpt ? "skipped" : `wasm-opt ${optArgs.join(" ")}`}`
  );

  run(
    "cargo",
    [
      "build",
      "--target",
      "wasm32-unknown-unknown",
      "-p",
      "photocraft-embed-editor",
      ...(release ? ["--profile", "wasm-release"] : [])
    ],
    workspace
  );
  if (!existsSync(rawArtifact)) throw new Error(`缺少 WASM 产物 ${rawArtifact}`);

  const staging = join(outDir, `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    run("wasm-bindgen", [rawArtifact, "--target", "web", "--out-dir", staging, "--out-name", OUT_NAME], workspace);

    const stagedWasm = join(staging, wasmName);
    if (!skipOpt) {
      const optimized = join(staging, `${OUT_NAME}_bg.optimized.wasm`);
      const result = spawnSync("wasm-opt", [...optArgs, stagedWasm, "-o", optimized], { stdio: "inherit" });
      if (result.error || result.status !== 0) {
        console.warn("⚠ 未运行 wasm-opt（缺失或失败），保留未优化产物");
      } else {
        renameSync(optimized, stagedWasm);
      }
    }

    const stagedGlue = join(staging, glueName);
    writeFileSync(stagedGlue, postprocessGlue(readFileSync(stagedGlue, "utf8")));

    mkdirSync(outDir, { recursive: true });
    for (const name of [glueName, wasmName, `${OUT_NAME}.d.ts`, `${OUT_NAME}_bg.wasm.d.ts`]) {
      const from = join(staging, name);
      // wasm-bindgen 生成的 .d.ts 名可能随版本变化；缺失不视为失败。
      if (existsSync(from)) renameSync(from, join(outDir, name));
    }

    const wasmBytes = statSync(join(outDir, wasmName)).size;
    const glueBytes = statSync(join(outDir, glueName)).size;
    console.log(
      `✓ 编辑内核就绪 → ${outDir}（wasm ${(wasmBytes / 1024 / 1024).toFixed(2)} MiB，glue ${(glueBytes / 1024).toFixed(1)} KiB）`
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`✗ 编辑内核 WASM 构建失败：${error?.message ?? error}`);
  process.exit(error?.exitCode ?? 1);
}
