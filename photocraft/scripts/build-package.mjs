#!/usr/bin/env node
/**
 * PhotoCraft 工作区的包构建（change: 2026-10-21-extract-photocraft-subproject，design D1/D8）。
 *
 *   node scripts/build-package.mjs [--cwd <packageDir>] [--watch]
 *
 * 与 Woohaa 的 `web/scripts/build-package.mjs` 同一套约定，但**完全独立**：子项目不读宿主
 * 源码或脚本，隔离副本里也能构建。
 *
 * - JS 只由 esbuild 产出；tsc 只做类型检查（`--noEmit`），从不 emit。
 * - 入口 `src/index.ts` → 单文件 ESM `dist/index.js`，因此纯 Node 也能直接加载。
 * - `dependencies` / `peerDependencies`（含子路径）全部 external；自己写的代码内联。
 * - CSS 走 `copy` loader：保留 JS 里的相对 import，交给消费方打包器处理，避免静默丢样式。
 * - 类型入口仍指向 `src`（`exports.types`）：本工作区不生成 .d.ts。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const DEFAULT_ENTRY = "src/index.ts";
const DEFAULT_OUTDIR = "dist";
const SOURCE_ROOT = "src";

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
];

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const packageDir = path.resolve(readArg("cwd") ?? process.cwd());
const watch = process.argv.includes("--watch");
const entry = readArg("entry") ?? DEFAULT_ENTRY;
const outdir = readArg("outdir") ?? DEFAULT_OUTDIR;
const platform = readArg("platform") ?? "neutral";
const sourceRoot = readArg("source-root") ?? SOURCE_ROOT;
const entryName = readArg("entry-name") ?? "index";

const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));

const declared = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {})
];
const external = [...new Set(declared.flatMap((name) => [name, `${name}/*`]))].sort();

/** 递归收集源码文件，用于未声明依赖守卫。 */
async function collectSources(dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...(await collectSources(full)));
    else if (/\.(ts|tsx|mts|cts)$/.test(item.name) && !/\.test\.(ts|tsx)$/.test(item.name)) out.push(full);
  }
  return out;
}

/** 守卫：源码里出现的裸说明符必须已在 package.json 声明，否则产物会在消费方解析失败。 */
async function assertDeclaredDependencies() {
  const root = path.join(packageDir, sourceRoot);
  const declaredSet = new Set(declared);
  for (const file of await collectSources(root)) {
    const text = await readFile(file, "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!declaredSet.has(name)) {
          throw new Error(`${path.relative(packageDir, file)} 使用了未声明的依赖 ${name}；请写进 package.json 或改为相对导入。`);
        }
      }
    }
  }
}

await assertDeclaredDependencies();

const options = {
  entryPoints: [path.join(packageDir, entry)],
  outfile: path.join(packageDir, outdir, `${entryName}.js`),
  bundle: true,
  format: "esm",
  platform,
  target: "es2022",
  sourcemap: true,
  external,
  logLevel: "info",
  loader: { ".css": "copy" }
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log(`[watch] ${manifest.name} → ${path.relative(packageDir, options.outfile)}`);
} else {
  await esbuild.build(options);
}
