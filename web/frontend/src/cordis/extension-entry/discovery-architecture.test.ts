/**
 * 前端入口发现/装配架构守卫
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 3.4 / design D3/D6；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 4.6/5.1 / design D3/D5/D6：
 *  宿主构建**不再扫描/编译** extension 业务源码。生产发现改为发布目录
 *  （`<link rel="woohaa-extension-release">` → `/extension-releases/<releaseId>.json`）在运行时
 *  登记异步入口；宿主 manifest 为空纯组装，无 eager glob。
 *
 * 静态保证：
 * - 无构建期静态 glob 扫描 extension 源码；
 * - 无业务逐项手写前端清单（ChatGPT 不在宿主目录或常驻 canvas 目录）；
 * - 无 import-time 注册副作用；
 * - 只有 loader/catalog 构造同源版本化地址，且地址由纯 metadata/发布目录派生，不做任意模块名解析。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CORDIS_DIR = path.join(SRC_ROOT, "cordis");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("extension 前端入口发现/装配架构（任务 3.4/4.6）", () => {
  it("宿主 manifest 不再构建期扫描 extension 源码（无 eager glob / 远端加载 / 动态执行）", () => {
    const manifest = readFileSync(path.join(CORDIS_DIR, "extension-entry", "manifest.ts"), "utf8");
    expect(manifest).not.toMatch(/import\.meta\.glob/);
    expect(manifest).not.toMatch(/fetch\s*\(/);
    expect(manifest).not.toMatch(/new Function|eval\s*\(/);
    expect(manifest).not.toMatch(/import\s*\(\s*[^"')]/);
  });

  it("发布目录地址由 catalog 从同源 link 派生，不做任意模块名解析或远端执行", () => {
    const catalog = stripComments(readFileSync(path.join(CORDIS_DIR, "extension-runtime", "catalog.ts"), "utf8"));
    // 只读同源 link 的 rel 属性，地址前缀固定。
    expect(catalog).toMatch(/woohaa-extension-release/);
    expect(catalog).toMatch(/\/extension-releases\//);
    expect(catalog).toMatch(/\/extensions\//);
    // 不做任意模块名解析 / 动态执行 / 远端任意 URL fetch。
    expect(catalog).not.toMatch(/new Function|eval\s*\(/);
    expect(catalog).not.toMatch(/https?:\/\//);
  });

  it("无业务逐项手写前端清单：ChatGPT 不在常驻 canvas 目录或宿主插件目录", () => {
    const canvasManifest = stripComments(readFileSync(path.join(CORDIS_DIR, "canvas-manifest.ts"), "utf8"));
    expect(canvasManifest).not.toMatch(/plugins\/chatgpt/);
    expect(canvasManifest).not.toMatch(/oauthAgentExtension/);
    expect(existsSync(path.join(CORDIS_DIR, "plugins", "chatgpt"))).toBe(false);

    // ChatGPT 业务入口只存在于 extension 包。
    const extEntry = fileURLToPath(new URL("../../../../extensions/oauth-agent/src/frontend/index.ts", import.meta.url));
    expect(existsSync(extEntry)).toBe(true);
  });

  it("宿主 paths 不再持有 ChatGPT 业务前缀；常量归 extension 包", () => {
    const paths = stripComments(readFileSync(path.join(CORDIS_DIR, "services", "paths.ts"), "utf8"));
    expect(paths).not.toMatch(/CHATGPT_BASE_PATH/);
    const routes = readFileSync(
      fileURLToPath(new URL("../../../../extensions/oauth-agent/src/frontend/routes.ts", import.meta.url)),
      "utf8"
    );
    expect(routes).toMatch(/CHATGPT_BASE_PATH\s*=\s*"\/api\/oauth-agent"/);
  });

  it("发现/装配模块无 import-time 注册副作用", () => {
    for (const name of ["manifest.ts", "contract.ts", "reconciler.ts"]) {
      const source = stripComments(readFileSync(path.join(CORDIS_DIR, "extension-entry", name), "utf8"));
      expect(source, name).not.toMatch(/^\s*\w+\.register\s*\(/m);
      expect(source, name).not.toMatch(/^\s*registerBuiltinDialogs\s*\(/m);
    }
  });

  it("入口 descriptor 是无副作用工厂：只有装配时才调用 loadDescriptor().plugin()", () => {
    const reconciler = stripComments(readFileSync(path.join(CORDIS_DIR, "extension-entry", "reconciler.ts"), "utf8"));
    expect(reconciler).toMatch(/loadDescriptor/);
    const manifest = stripComments(readFileSync(path.join(CORDIS_DIR, "extension-entry", "manifest.ts"), "utf8"));
    expect(manifest).not.toMatch(/loadDescriptor\s*\(\)/);
  });
});
