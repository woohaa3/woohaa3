/**
 * 宿主业务 extension 生产依赖审计
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 6.4 / design D9）。
 *
 * 宿主生产构建 MUST NOT 传递拉入任何业务 extension 包：宿主 `dependencies` 只允许保留
 * 合约与真正需要的第三方运行时依赖。源码型测试 / Showcase 若确需扩展源码，只能经
 * **devDependencies** 或显式 fixture 依赖声明。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = path.join(FRONTEND_ROOT, "src");
const EXTENSIONS_ROOT = path.resolve(FRONTEND_ROOT, "..", "extensions");

/** 当前工作区中所有 `@woohaa3/extension-*` 包名。 */
function workspaceExtensionPackageNames(): string[] {
  return readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(EXTENSIONS_ROOT, entry.name, "package.json"))
    .filter((pkgPath) => {
      try {
        readFileSync(pkgPath, "utf8");
        return true;
      } catch {
        return false;
      }
    })
    .map((pkgPath) => JSON.parse(readFileSync(pkgPath, "utf8")).name as string)
    .filter((name) => name.startsWith("@woohaa3/extension-"));
}

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

describe("宿主业务 extension 生产依赖审计（任务 6.4）", () => {
  it("frontend 生产 dependencies 不含任何业务 extension 包", () => {
    const pkg = JSON.parse(readFileSync(path.join(FRONTEND_ROOT, "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const name of workspaceExtensionPackageNames()) {
      expect(deps, `${name} 不得出现在 frontend dependencies`).not.toContain(name);
    }
  });

  it("生产源码不静态 import 任何业务 extension 包（源码型消费者只在 test-support/.test. 中）", () => {
    const files = walk(SRC_ROOT, /\.(ts|tsx)$/).filter(
      (file) => !file.includes(".test.") && !file.includes(`${path.sep}test-support${path.sep}`)
    );
    for (const file of files) {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      for (const name of workspaceExtensionPackageNames()) {
        const imports = source.match(new RegExp(`from\\s+["']${name.replace(/[/]/g, "\\/")}(?:/[^"']*)?["']`, "g")) ?? [];
        expect(imports, `${path.relative(SRC_ROOT, file)} 不得生产 import ${name}`).toEqual([]);
      }
    }
  });
});
