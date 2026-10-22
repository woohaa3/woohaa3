/**
 * 维护业务源码规模分类器（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility）。
 *
 * 这是 change 引入的 **500 行业务源码守卫** 的共享统计口径，与既有 800 行
 * Frontend/Rust 全源码守卫（`web/frontend/src/cordis/file-budget.test.ts`、
 * `bevy/tests/file_size.rs`）并存，**不降低**后者的上限。
 *
 * 口径（与 `reports/business-code-line-ranking.csv` 的 869 个业务文件一致）：
 * - 覆盖 `web/**`、`bevy/**`、`scripts/**` 的维护源码；
 * - 扩展名 ts/tsx/mts/cts/js/jsx/mjs/cjs/rs/wgsl；
 * - 排除构建产物（node_modules/dist/server-dist/target/build/public）、
 *   测试与测试支持（`*.test.*`、`*.spec.*`、`tests/`、`test-support/`、`e2e/`）、
 *   fixture、有来源标识的生成文件（`*generated*`、`.wasm`、`bevy-wasm/` 的 wasm-bindgen
 *   glue）与快照。
 * - 统计物理行（与 `wc -l` 一致：末尾换行不额外计数、`\r\n` 归一化）。
 *
 * 该分类器是**唯一事实源**：门禁测试与规模报告脚本都调用这里的函数，避免两套口径。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** 业务源码扫描根（相对仓库根）。 */
export const BUSINESS_SOURCE_ROOTS = ["web", "bevy", "scripts"] as const;

/** 计入业务行的扩展名。 */
export const BUSINESS_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
  ".wgsl"
]);

/** 直接剪枝的目录名（构建产物、测试支持与快照）。
 *
 * 注意：`vendor/` **不再**按目录名豁免——[web/vendor](../vendor) 里是我们随产品维护/发布的
 * 库源码（`@sdppp/pptask` 等），不是第三方构建产物，必须与业务源码同口径受 500 行门禁约束。
 */
export const BUSINESS_EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "server-dist",
  /**
   * 扩展浏览器产物（`build-extension-browser.mjs` 产出，已 gitignore）：只排 `dist` 会漏掉它们，
   * 扩展的 entry/chunk 会被当成业务源码——门禁结论随"有没有构建过"变化，还会把生成的 chunk
   * 记成超限文件。
   */
  "browser-dist",
  ".browser-build",
  ".browser-test",
  "target",
  "build",
  "public",
  ".git",
  ".godot",
  "test-results",
  "playwright-report",
  "coverage",
  "__snapshots__",
  "__fixtures__",
  "test-support",
  "tests",
  "fixtures",
  "e2e",
  /**
   * wasm-bindgen JS glue 生成目录（Bevy 与图片内核构建脚本产出，gitignored）。
   * 计数它会把机器生成的胶水（约 2500 行）当成维护业务源码，使门禁在「已构建 WASM」
   * 的正常开发/CI 状态下产生假阳性。运行时资源在 `public/assets`（已排除）。
   */
  "bevy-wasm"
]);

/** 排除的测试/夹具/生成声明文件名模式。 */
const EXCLUDE_FILE_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[a-z]+$/,
  /^tests\.rs$/,
  /^tests_.*\.rs$/,
  /fixture/i,
  /(^|[.\-_])generated([.\-_]|$)/i,
  /\.d\.(ts|mts|cts)$/,
  /\.wasm/
];

/** 业务单文件物理行目标上限。 */
export const MAX_BUSINESS_SOURCE_LINES = 500;

/** 与 `wc -l` 一致的物理行计数（末尾换行不额外产生一行，`\r\n`/`\r` 归一化）。 */
export function physicalLines(source: string): number {
  if (source === "") return 0;
  const parts = source.replace(/\r\n?/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** 判定相对仓库根的 posix 路径是否为维护业务源码。 */
export function isBusinessSourceFile(relativePosix: string): boolean {
  const segments = relativePosix.split("/");
  if (segments.some((segment) => BUSINESS_EXCLUDE_DIRS.has(segment))) return false;
  const base = segments[segments.length - 1] ?? "";
  if (!BUSINESS_SOURCE_EXTENSIONS.has(path.extname(base))) return false;
  return !EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export type SourceSizeEntry = { path: string; lines: number };

/**
 * 扫描业务源码根，返回全部业务文件的物理行数（相对路径以 posix 表示）。
 * `repoRoot` 为仓库根目录的绝对路径。
 */
export function collectBusinessSourceSizes(repoRoot: string): SourceSizeEntry[] {
  const entries: SourceSizeEntry[] = [];
  const walk = (dir: string): void => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (BUSINESS_EXCLUDE_DIRS.has(child.name)) continue;
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(repoRoot, full).split(path.sep).join("/");
      if (!isBusinessSourceFile(relative)) continue;
      entries.push({ path: relative, lines: physicalLines(readFileSync(full, "utf8")) });
    }
  };
  for (const root of BUSINESS_SOURCE_ROOTS) walk(path.join(repoRoot, root));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}
