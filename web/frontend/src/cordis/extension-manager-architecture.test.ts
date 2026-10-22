/**
 * Plugin Manager 架构审计
 * （change: add-frontend-plugin-manager，任务 1.3）。
 *
 * 静态保证：
 * - 所有可执行 Canvas Plugin 仍来自静态 import 的受信清单；
 * - 用户配置只能引用固定可配置 optional allowlist，无法解析模块名、URL 或脚本；
 * - Task History page scope 不装配 Canvas manifest 或 Plugin Manager；
 * - Plugin Manager 不直接创建/释放 Context fiber（apply 策略仍由 composition root 拥有）。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CORDIS_DIR = path.join(SRC_ROOT, "cordis");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "bevy-wasm"]);

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function read(relative: string): string {
  return readFileSync(path.join(SRC_ROOT, relative), "utf8");
}

describe("静态可信清单审计（任务 1.3）", () => {
  it("Canvas manifest 只静态 import 插件，不含动态 import/require", () => {
    const source = stripComments(read("cordis/canvas-manifest.ts"));
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    // 每个 plugin 通过 create() 返回静态 import 的 Plugin；不解析字符串模块名。
    expect(source).not.toMatch(/canvasRemote\.|fetch\(|https?:\/\//);
  });

  it("偏好 codec/store/selector 不解析模块名、URL 或脚本", () => {
    const files = walk(path.join(CORDIS_DIR, "services", "extension-preferences"), /\.ts$/).filter(
      (file) => !file.includes(".test.")
    );
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      const relative = path.relative(SRC_ROOT, file);
      expect(source, relative).not.toMatch(/\bimport\s*\(/);
      expect(source, relative).not.toMatch(/\brequire\s*\(/);
      expect(source, relative).not.toMatch(/\bnew Function\b|\beval\s*\(/);
      expect(source, relative).not.toMatch(/https?:\/\//);
      expect(source, relative).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("可配置 optional allowlist 由内置 node-history + 运行时发布目录 ID 合并，required override 固定", () => {
    const source = read("cordis/canvas-manifest.ts");
    // change: 2026-10-12-build-and-load-extensions-independently：宿主构建不再扫描 extension 源码。
    // 内置 allowlist 只剩 node-history；browser-local optional 由发布目录纯 metadata 在运行时合并。
    const match = source.match(/CONFIGURABLE_OPTIONAL_PLUGIN_IDS\s*:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/NODE_HISTORY_PLUGIN_ID/);
    expect(match![1]).not.toMatch(/PROMPT_SNIPPETS_PLUGIN_ID|TASK_ACTIVITY_PLUGIN_ID|BROWSER_LOCAL_ENTRIES/);
    // 发布目录扩展 ID 经 resolveConfigurableOptionalIds 在运行时合并，不扩张静态 allowlist。
    expect(source).toMatch(/resolveConfigurableOptionalIds\(/);
    // required 强制装配：paste-import/model-editor/plugin-manager 在 catalog 中 required: true。
    for (const entry of ["PASTE_IMPORT_PLUGIN_ID", "MODEL_EDITOR_PLUGIN_ID", "EXTENSION_MANAGER_ID"]) {
      expect(new RegExp(`id:\\s*${entry}[\\s\\S]*?required:\\s*true`).test(source), entry).toBe(true);
    }
  });

  it("Task History page scope 不装配 Canvas manifest 或 Plugin Manager", () => {
    // 页面实现与插件适配层都不得装配 Canvas manifest / Plugin Manager
    // （change: 2026-10-10-extract-task-history-page：页面迁到 pages/task-history）。
    const pageDir = path.join(SRC_ROOT, "pages", "task-history");
    const pluginDir = path.join(CORDIS_DIR, "plugins", "task-history");
    const offenders: string[] = [];
    for (const dir of [pageDir, pluginDir]) {
      for (const file of walk(dir, /\.(ts|tsx)$/)) {
        if (file.includes(".test.")) continue;
        const source = stripComments(readFileSync(file, "utf8"));
        if (/canvas-manifest|plugin-manager|createCanvasExtensionManifest/.test(source)) {
          offenders.push(path.relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
    const manifest = read("cordis/manifest.ts");
    expect(manifest).toMatch(/createTaskHistoryExtensionManifest[\s\S]*taskHistoryExtension/);
    expect(stripComments(manifest).split("createTaskHistoryExtensionManifest")[1]).not.toContain("extension-manager");
  });

  it("Plugin Manager 不直接创建/释放 Context fiber（apply 策略归 composition root）", () => {
    const dir = path.join(CORDIS_DIR, "plugins", "extension-manager");
    const offenders: string[] = [];
    for (const file of walk(dir, /\.(ts|tsx)$/)) {
      if (file.includes(".test.")) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/\bctx\.plugin\s*\(/.test(source) || /\.fiber\b/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("用户配置不进入 Cordis / Y.Doc / 后端：store 只触碰 Storage facade", () => {
    const source = stripComments(read("cordis/services/extension-preferences/store.ts"));
    expect(source).not.toMatch(/\bctx\b|canvasRemote|taskRemote|mediaRemote|Y\.Doc|woohaa3CanvasStore/);
  });
});
