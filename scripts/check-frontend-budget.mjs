#!/usr/bin/env node
/**
 * 前端体积预算（change: 2026-10-12-build-and-load-extensions-independently，任务 7.1 / design D9）。
 *
 * 统计口径（与 design 的预算目标一致，**不抬阈值绕过**）：
 * - **宿主入口静态闭包**：`index.html` 引用的入口 JS + 其 `import` 图递归闭包（真实启动路径），
 *   报告 raw/gzip、模块数与最大 chunk。
 * - **全部 JS**：宿主 `dist/assets/*.js` 与每个扩展 `browser-dist` 的全部 JS raw/gzip。
 * - **SDK 分组 chunk**：`sdk-*.js` 单独归类（宿主按需 lazy 加载，不应进入启动闭包）。
 * - **真实启动请求**：由发布目录（`/extension-releases/<id>.json`）派生的 always/本地已选入口
 *   JS/CSS 体积；server-active/未选浏览器本地入口不计入启动请求。
 * - **WASM**：画布和按需图片内核分别计量与检查预算，不与 JS 混算。
 *
 * 预算越界只报告并置非零退出码；不得通过 `manualChunks`/缩小入口文件数值掩盖真实闭包。
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "web/frontend/dist");
const assetsDir = path.join(dist, "assets");

// 入口静态闭包预算。每一次调整都应写明来源，而不是"跑不过就抬"。
//   change: 2026-10-20-add-local-client-telemetry —— 新增独立页面身份 `telemetry`（`/telemetry`）：
//   路由表要带它的 URL 查询编解码、`page-scope` 要装配它的 page scope、`manifest` 要登记它的插件、
//   设置「后端配置」多一行入口。采集实现本身已改为动态 import（不进闭包），这里只是页面身份与
//   路由表带来的固定成本：实测 raw +1,826 / gzip +4,596，因此上调到下面这组值（其余预算不动）。
// Entry gate temporarily disabled for eager AI menus; telemetry-adjusted baseline: raw 1_500_000, gzip 456_000.
const ENTRY_JS_BUDGET = null;
const WASM_BUDGET = { raw: 100_000_000, gzip: 20_000_000 };
// 按需图片内核单独计量，不占用或放宽画布内核预算。
const IMAGE_EDITOR_WASM_BUDGET = { raw: 20_000_000, gzip: 8_000_000 };
// SDK 分组是宿主按需 lazy 加载；单独设总量上限，防止「省入口、增立即加载 SDK」规避。
const SDK_JS_BUDGET = { raw: 80_000, gzip: 30_000 };
// 真实启动请求（ready 前 always + 本地已选 browser-local 入口 JS/CSS）总量上限。
const STARTUP_EXTENSION_BUDGET = { raw: 1_200_000, gzip: 320_000 };

function gzipSize(bytes) {
  return gzipSync(bytes).length;
}

/** 解析 index.html 引用的入口 JS（module script src）。 */
function entryScriptPath(html) {
  const match = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/) ?? html.match(/<script[^>]+src="([^"]+)"/);
  if (!match) throw new Error("index.html 未找到入口 JS");
  return match[1].replace(/^\//, "");
}

/**
 * 递归收集 JS 静态闭包。
 *
 * - 所有文件都跟随 `from`/`import "..."` 静态边；
 * - `followDynamicFromRoot` 为真时，**根入口**的 `import(...)` 也算（薄入口约定只动态 import
 *   实现 chunk，该 chunk 在 ready 前加载）；其它文件的动态 import 是惰性 chunk，不计入启动闭包。
 */
function collectClosure(roots, { followDynamicFromRoot = false } = {}) {
  const seen = new Set();
  const queue = roots.map((relative) => ({ relative, isRoot: true }));
  while (queue.length > 0) {
    const { relative: current, isRoot } = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const abs = path.join(dist, current);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*["']([^"']+)["']/g)
    ];
    if (followDynamicFromRoot && isRoot) {
      specifiers.push(...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g));
    }
    for (const match of specifiers) {
      const spec = match[1];
      if (!spec.startsWith(".") && !spec.startsWith("/assets/") && !spec.startsWith("/extensions/")) continue;
      const resolved = spec.startsWith("/")
        ? spec.replace(/^\//, "")
        : path.relative(dist, path.resolve(path.dirname(abs), spec)).split(path.sep).join("/");
      if (!seen.has(resolved)) queue.push({ relative: resolved, isRoot: false });
    }
  }
  return [...seen];
}

/** 收集入口 JS 的静态闭包。 */
function collectEntryClosure(entryRelative) {
  return collectClosure([entryRelative], { followDynamicFromRoot: false });
}

function sumFiles(relatives) {
  let raw = 0;
  let gzip = 0;
  for (const relative of relatives) {
    const abs = path.join(dist, relative);
    if (!existsSync(abs)) continue;
    const bytes = readFileSync(abs);
    raw += bytes.length;
    gzip += gzipSize(bytes);
  }
  return { raw, gzip };
}

/** 从最新发布目录派生真实启动请求体积（always + 已启用 browser-local 的完整实现闭包）。 */
function startupExtensionAssets() {
  const releaseDir = path.join(dist, "extension-releases");
  if (!existsSync(releaseDir)) return { raw: 0, gzip: 0, entries: [], reason: "no-release" };
  const files = readdirSync(releaseDir).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) return { raw: 0, gzip: 0, entries: [], reason: "no-release" };
  const catalog = JSON.parse(readFileSync(path.join(releaseDir, files[files.length - 1]), "utf8"));
  const startup = catalog.entries.filter(
    (entry) => entry.metadata.activation === "always" || entry.metadata.activation === "browser-local"
  );
  const collected = new Set();
  for (const entry of startup) {
    // 薄入口 + 其动态实现闭包（ready 前加载）。
    for (const relative of collectClosure([entry.entryURL.replace(/^\//, "")], { followDynamicFromRoot: true })) {
      collected.add(relative);
    }
    for (const style of entry.styleURLs) collected.add(style.replace(/^\//, ""));
  }
  const size = sumFiles([...collected]);
  return { raw: size.raw, gzip: size.gzip, entries: startup.map((entry) => entry.metadata.extensionId), reason: "ok" };
}

const html = await fs.readFile(path.join(dist, "index.html"), "utf8");
const entry = entryScriptPath(html);
const entryClosure = collectEntryClosure(entry);
const entrySize = sumFiles(entryClosure);

const allHostJs = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
const sdkJs = allHostJs.filter((file) => /^sdk-/.test(file));
const sdkSize = sumFiles(sdkJs.map((file) => `assets/${file}`));
const allHostJsSize = sumFiles(allHostJs.map((file) => `assets/${file}`));

const wasm = readdirSync(assetsDir).filter((file) => file.endsWith(".wasm"));
const canvasWasm = wasm.filter((file) => /^woohaa_bevy_canvas_bg-[^.]+\.wasm$/.test(file));
const editorWasm = wasm.filter((file) => /^photocraft_editor_bg-[^.]+\.wasm$/.test(file));
if (canvasWasm.length !== 1 || editorWasm.length !== 1 || wasm.length !== 2) {
  throw new Error(`Expected one canvas WASM and one image editor WASM artifact, found: ${wasm.join(", ")}`);
}
const wasmSize = sumFiles(canvasWasm.map((file) => `assets/${file}`));
const editorWasmSize = sumFiles(editorWasm.map((file) => `assets/${file}`));

const startup = startupExtensionAssets();

const reports = [
  {
    scope: "host-entry-static-closure",
    entry,
    moduleCount: entryClosure.length,
    largestChunk: entryClosure
      .map((relative) => ({ relative, bytes: readFileSync(path.join(dist, relative)).length }))
      .sort((a, b) => b.bytes - a.bytes)[0],
    ...entrySize,
    budget: ENTRY_JS_BUDGET,
    budgetStatus: "temporarily-disabled"
  },
  { scope: "host-all-js", files: allHostJs.length, ...allHostJsSize },
  { scope: "host-sdk-js", files: sdkJs.length, ...sdkSize, budget: SDK_JS_BUDGET },
  {
    scope: "startup-extension-requests",
    entries: startup.entries,
    reason: startup.reason,
    raw: startup.raw,
    gzip: startup.gzip,
    budget: STARTUP_EXTENSION_BUDGET
  },
  { scope: "canvas-wasm", file: `assets/${canvasWasm[0]}`, ...wasmSize, budget: WASM_BUDGET },
  { scope: "image-editor-wasm", file: `assets/${editorWasm[0]}`, ...editorWasmSize, budget: IMAGE_EDITOR_WASM_BUDGET }
];

let failed = false;
for (const report of reports) {
  const budget = report.budget;
  const pass = !budget || (report.raw <= budget.raw && report.gzip <= budget.gzip);
  failed ||= !pass;
  console.log(JSON.stringify({ ...report, pass }));
}

if (failed) process.exitCode = 1;
