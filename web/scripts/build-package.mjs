/**
 * Bundle one workspace package's public entry into `dist/` with esbuild.
 *
 *   node scripts/build-package.mjs [--cwd <packageDir>] [--watch]
 *
 * 约定（workspace 构建约定，见 openspec/changes/move-canvas-state-to-web/notes/source-inventory.md）：
 *
 * - JS 只由 esbuild 产出。tsc 在本仓库只用于类型检查（`--noEmit`），从不 emit JS。
 * - 入口固定为 `src/index.ts`，产物固定为 `dist/index.js`（单文件 ESM bundle）。
 *   单文件意味着产物里没有相对导入，纯 Node 也能直接加载（目录式/无扩展名相对导入
 *   是 Node ESM 不支持的，这正是 source-first 无法被 Node 消费的原因）。
 * - `dependencies` / `peerDependencies` 全部 external（含子路径）。自己写的代码内联，
 *   声明过的依赖留给消费方解析 —— 这样依赖不会被复制进产物，也不会出现两份实例。
 * - CSS 走 `copy` loader，而不是让 esbuild 抽成独立文件：抽取模式下 esbuild 会把
 *   `import "./x.css"` 从 JS 里删掉，消费方就再也拿不到样式（静默丢样式）。
 *   用 `copy` 时 esbuild 把 CSS 复制进 `dist/` 并**保留** JS 里的相对 import，
 *   由消费方的打包器（Vite）照常处理，行为与 source-first 时一致。
 * - 类型入口仍指向 `src`（`exports.types`）：本仓库不生成 .d.ts。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const DEFAULT_ENTRY = "src/index.ts";
const DEFAULT_OUTDIR = "dist";
/** 源码扫描范围；用于未声明依赖守卫。 */
const SOURCE_ROOT = "src";
const PACKAGE_NAME = /^(@[^/]+\/[^/]+|[^/]+)/;

/**
 * 扫描裸说明符用的正则，必须在使用它的 `await` 之前初始化（否则会踩 TDZ）。
 * 三种形态都要覆盖，尤其是没有 `from` 的副作用导入 —— 漏掉它守卫就形同虚设：
 *   import { a } from "x" / export * from "x" / import type { T } from "x"
 *   import "x"
 *   import("x")
 */
const IMPORT_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

const packageDir = path.resolve(readArg("cwd") ?? process.cwd());
const watch = process.argv.includes("--watch");
// 默认按「包」的方式构建（src/index.ts → dist/）；站点 server 这类非包入口
// 通过 --entry/--outdir/--platform 覆盖。
const entry = readArg("entry") ?? DEFAULT_ENTRY;
const outdir = readArg("outdir") ?? DEFAULT_OUTDIR;
const platform = readArg("platform") ?? "neutral";
const sourceRoot = readArg("source-root") ?? SOURCE_ROOT;
// 插件包按入口分别构建：使用 `--entry-name` 产出 `dist/<name>.js` 而不是固定的 `dist/index.js`。
const entryName = readArg("entry-name") ?? "index";

const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));

/** 声明过的依赖一律 external；同时 external 其子路径（例如 `zustand/vanilla`）。 */
const declared = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
];
const external = [...new Set(declared.flatMap((name) => [name, `${name}/*`]))].sort();

/**
 * 包边界守卫：源码里出现的每个裸说明符，都必须声明在 dependencies /
 * peerDependencies 里。
 *
 * 为什么需要它：`devDependencies` 不在 external 列表里，所以一旦源码 import 了
 * 只有 devDependency 声明的包，esbuild 会把它**内联进产物** —— 产物悄悄多出一份
 * 依赖副本，而且消费方永远不会知道它该装什么。这类问题不会报错，只会在运行时
 * 以「两份实例」「版本不符」的形式爆出来，所以必须在构建期拦住。
 */
// 站点 server 目录不是包：它的依赖由站点 package.json 声明，同样要守。
const undeclared = await findUndeclaredImports(path.join(packageDir, sourceRoot), declared);
if (undeclared.length > 0) {
  console.error(
    `[build-package] ${manifest.name} 有未声明的裸依赖导入（会被内联进产物）：`
  );
  for (const { file, specifier } of undeclared) {
    console.error(`  ${path.relative(packageDir, file)} -> ${specifier}`);
  }
  console.error("把它们加进 dependencies / peerDependencies，或从源码里移除该导入。");
  process.exit(1);
}

/**
 * 构建期常量注入（`WOOHAA3_DEFINES`，JSON 对象）。
 *
 * 存在的理由：有些值不该进公开仓库，但需要在构建时固定下来（例如内置公开桶的域名）。
 * 公开仓库只保留这条机制，具体值由构建环境提供；未提供时源码里的标识符保持为
 * `undefined`，对应功能要求运行期配置齐全才启用。
 */
const buildDefines = (() => {
  const raw = process.env.WOOHAA3_DEFINES;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[build-package] WOOHAA3_DEFINES 不是合法 JSON，已忽略。");
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  // esbuild 的 define 值必须是 JS 表达式文本：这里统一用 JSON 字面量。
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, JSON.stringify(value)]));
})();

const options = {
  entryPoints: [path.join(packageDir, entry)],
  outdir: path.join(packageDir, outdir),
  entryNames: entryName,
  bundle: true,
  format: "esm",
  platform,
  target: "es2022",
  // 组件包需要自动 JSX runtime；对非 JSX 包无副作用。react/jsx-runtime 由
  // peerDependencies 的 external 规则覆盖。
  jsx: "automatic",
  sourcemap: true,
  external,
  loader: { ".css": "copy" },
  define: buildDefines,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log(`[build-package] watching ${manifest.name} -> ${outdir}/`);
} else {
  await esbuild.build(options);
}

/**
 * 递归扫描 `src/` 下的 TS 源码，返回未声明依赖的裸说明符。
 * 用正则而不是 AST：本仓库的导入写法统一，且这样可以避免引入额外依赖。
 */
async function findUndeclaredImports(dir, declaredNames) {
  const files = await collectSourceFiles(dir);
  const allowed = (specifier) => {
    if (specifier.startsWith("node:") || specifier.startsWith("data:")) return true;
    const root = PACKAGE_NAME.exec(specifier)?.[1] ?? specifier;
    return declaredNames.includes(root);
  };

  const offenders = new Map();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        const specifier = match[1];
        if (specifier.startsWith(".") || allowed(specifier)) continue;
        offenders.set(`${file}\u0000${specifier}`, { file, specifier });
      }
    }
  }
  return [...offenders.values()];
}

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectSourceFiles(full)));
    } else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}
