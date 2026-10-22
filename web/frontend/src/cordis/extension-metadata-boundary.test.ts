/**
 * 扩展纯 metadata 依赖图守卫
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.3 / design D4）。
 *
 * 每个 `web/extensions/<dir>/src/frontend/metadata.ts` 是扩展的**唯一身份来源**，必须在
 * 宿主构建期与发布发现期都可安全求值，因此其依赖闭包 MUST NOT 可达 plugin / UI / CSS /
 * 业务 store / 后端实现 / React / 宿主私有代码。
 *
 * 本守卫从 metadata 出发沿**相对 import** 递归解析（不依赖打包器），拒绝：
 * - 非相对且非 `@woohaa3/contracts` 的 bare specifier（React / SDK / 后端 SDK）；
 * - 相对路径命中禁止目录/后缀（`frontend/` 业务实现、`plugin`、`.tsx`、`.css`、store、backend）；
 * - 解析到 extension 目录之外的文件（宿主/其它扩展）。
 *
 * 测试 fixture（无 metadata.ts 的包）自动跳过；不被发布发现登记。
 *
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB_ROOT = path.resolve(FRONTEND_ROOT, "..");
const EXTENSIONS_ROOT = path.join(WEB_ROOT, "extensions");

const ALLOWED_BARE = new Set(["@woohaa3/contracts"]);
const FORBIDDEN_SEGMENT = /(^|\/)(plugins?|frontend|store|backend)(\/|$)/i;
const FORBIDDEN_SUFFIX = /\.(tsx|css)$/i;
const FORBIDDEN_BARE = /^(react|react-dom|react\/|@deepseek-ai\/cordis|@woohaa3\/frontend\/|@woohaa3\/extension-)/;

/** 从源码抽取 import/export-from 的 module specifier。 */
function specifiers(source: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const found = new Set<string>();
  for (const match of clean.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.add(match[1]!);
  for (const match of clean.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.add(match[1]!);
  for (const match of clean.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.add(match[1]!);
  return [...found];
}

/** 尝试把无扩展名的相对 specifier 解析为真实文件。 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function metadataFiles(): string[] {
  return readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(EXTENSIONS_ROOT, entry.name, "src", "frontend", "metadata.ts"))
    .filter((file) => existsSync(file))
    .sort();
}

describe("扩展纯 metadata 依赖图守卫（任务 1.3）", () => {
  const files = metadataFiles();

  it("至少发现已知生产扩展的 metadata", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("metadata 依赖闭包不可达 plugin/UI/CSS/store/backend/React/宿主", () => {
    const offenders: string[] = [];
    for (const root of files) {
      const extensionDir = path.resolve(root, "..", "..", "..", "..");
      const seen = new Set<string>();
      const queue: string[] = [root];
      while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined) break;
        if (seen.has(current)) continue;
        seen.add(current);
        const source = readFileSync(current, "utf8");
        for (const specifier of specifiers(source)) {
          if (!specifier.startsWith(".")) {
            if (ALLOWED_BARE.has(specifier)) continue;
            if (FORBIDDEN_BARE.test(specifier) || !specifier.startsWith("@woohaa3/contracts")) {
              offenders.push(`${path.relative(WEB_ROOT, current)} -> ${specifier}`);
            }
            continue;
          }
          const resolved = resolveRelative(current, specifier);
          if (!resolved) {
            offenders.push(`${path.relative(WEB_ROOT, current)} -> 未解析 ${specifier}`);
            continue;
          }
          if (!path.resolve(resolved).startsWith(extensionDir)) {
            offenders.push(`${path.relative(WEB_ROOT, current)} -> 越出扩展目录 ${path.relative(WEB_ROOT, resolved)}`);
            continue;
          }
          if (FORBIDDEN_SUFFIX.test(resolved) || FORBIDDEN_SEGMENT.test(resolved.slice(extensionDir.length))) {
            offenders.push(`${path.relative(WEB_ROOT, current)} -> 禁止依赖 ${path.relative(WEB_ROOT, resolved)}`);
            continue;
          }
          if (!seen.has(resolved)) queue.push(resolved);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
