/**
 * Cordis 依赖边界审计（change: adopt-frontend-cordis-plugin-runtime，任务 1.1）。
 *
 * 保证首阶段只引入 Cordis 核心：不安装/引用 Loader、Include、HMR 或第三方插件市场，
 * 生产入口是静态可信清单。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = path.join(FRONTEND_ROOT, "src");

const FORBIDDEN_PACKAGES = [
  "@deepseek-ai/cordis-plugin-loader",
  "@deepseek-ai/cordis-plugin-include",
  "@deepseek-ai/cordis-plugin-hmr",
  "@deepseek-ai/cordis-plugin-group",
  "@deepseek-ai/cordis-plugin-timer",
  "@cordisjs/plugin-loader",
  "@cordisjs/plugin-include",
  "@cordisjs/plugin-hmr",
  "@cordisjs/plugin-group",
  "@cordisjs/plugin-timer"
];

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "bevy-wasm"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

describe("Cordis 依赖边界审计", () => {
  it("manifest 只固定 @deepseek-ai/cordis，不含 Loader/Include/HMR", () => {
    const pkg = JSON.parse(readFileSync(path.join(FRONTEND_ROOT, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["@deepseek-ai/cordis"]).toBe("4.0.5");
    for (const forbidden of FORBIDDEN_PACKAGES) {
      expect(deps[forbidden]).toBeUndefined();
    }
  });

  it("源码不 import 任何 Cordis 扩展包", () => {
    const files = walk(SRC_ROOT, /\.(ts|tsx)$/).filter((file) => !file.includes(".test."));
    for (const file of files) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(source, `${path.relative(SRC_ROOT, file)} 不应依赖 ${forbidden}`).not.toContain(forbidden);
      }
      // 只允许从 cordis 包根导入。
      const cordisImports = source.match(/from\s+["'](@deepseek-ai\/cordis[^"']*)["']/g) ?? [];
      for (const spec of cordisImports) {
        expect(spec).toContain('"@deepseek-ai/cordis"');
      }
    }
  });

  it("生产 bundle 不存在 Loader/Include/HMR 动态执行入口（若已构建）", () => {
    const dist = path.join(FRONTEND_ROOT, "dist", "assets");
    if (!existsSync(dist)) return;
    let bundle = "";
    for (const entry of readdirSync(dist, { withFileTypes: true })) {
      if (entry.isFile() && /\.js$/.test(entry.name) && !entry.name.includes("bevy")) {
        bundle += readFileSync(path.join(dist, entry.name), "utf8");
      }
    }
    if (bundle === "") return;
    for (const needle of ["plugin-loader", "plugin-include", "plugin-hmr", "cordis-plugin"]) {
      expect(bundle, needle).not.toContain(needle);
    }
    // Cordis 核心确实被打包（fiber 生命周期字符串存在）。
    expect(bundle).toContain("internal/plugin");
  });
});
