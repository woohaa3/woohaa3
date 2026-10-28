/**
 * 扩展 route 命名空间门禁。
 *
 * 公开映射的 HTTP / raw HTTP 路由，分派时用的是 publicPath 之后的**相对**子路径：注册键
 * 由宿主拼 `<extensionId>/<route>`，插件再自带一份前缀就永远查不到，对外只剩 404
 * 「插件未激活」。`c5f1cce` 把前缀统一收到宿主后只顺带改了 remote-server / oauth-agent，
 * local-agent 与 sdk-agent 的 4 + 6 条路由全挂（扩展是 active，路由全 404）。
 *
 * 口径：**客户端扩展一律声明相对 route**，前缀只由宿主添加。JSON handler 自带前缀其实
 * 还能工作（公开 URL 原样携带声明的 route），但对自有扩展统一成一种写法更省事，也能避免
 * 「看起来能跑、换到公开映射就 404」的错觉；第三方扩展由宿主在激活期记
 * `extension-route-namespace-mismatch` 诊断，不在此门禁范围内。
 *
 * 边界：静态扫描只认 `register*("...")` / `route: "..."` 的字面量形态（包括扩展内部的
 * `register(route)` 小助手）；route 由常量间接传入时扫不到，靠宿主诊断兜。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain JS module without type declarations (shared with the startup host).
import { scanExtensions } from "../../scripts/lib/extension-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** 扫描时不进入的生成物目录。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "browser-dist", "backend-dist", ".browser-build", ".browser-test"]);

/** route 字面量：`register("x")`、`registerRawHttpHandler({ route: "x" })` 两种写法都覆盖。 */
const ROUTE_LITERAL = /(?:\bregister\w*\(\s*|\broute:\s*)["'`]([^"'`]+)["'`]/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(absolute, out);
      continue;
    }
    if (!/\.(ts|tsx|mjs)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) continue;
    out.push(absolute);
  }
  return out;
}

describe("扩展 route 命名空间", () => {
  it("扩展声明的 route 不自带自己的 extensionId 前缀（前缀由宿主添加）", () => {
    const scan = scanExtensions({ repoRoot: REPO_ROOT });
    const violations: string[] = [];
    let scanned = 0;
    for (const extension of scan.extensions) {
      for (const file of sourceFiles(extension.dir)) {
        scanned += 1;
        const source = readFileSync(file, "utf8");
        ROUTE_LITERAL.lastIndex = 0;
        for (let match = ROUTE_LITERAL.exec(source); match; match = ROUTE_LITERAL.exec(source)) {
          const route = match[1];
          if (!route.startsWith(`${extension.extensionId}/`)) continue;
          violations.push(
            `${path.relative(REPO_ROOT, file)}: ${route}（宿主拼键后变成 ${extension.extensionId}/${route}）`
          );
        }
      }
    }
    // 扫描空转（根配错 / 目录改名）时门禁必须失败，而不是默默通过。
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
