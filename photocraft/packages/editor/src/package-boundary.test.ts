/**
 * 编辑器包边界回归
 * （change: 2026-10-21-extract-photocraft-subproject，任务 4.1/6.1）。
 *
 * 这里守住两条与目录迁移直接相关的约束：
 * 1. 包的源码只经公共包名依赖纯协议，不 import Woohaa 宿主（frontend/services/contracts）、
 *    私有源码或仓库外的相对路径；
 * 2. 公共 exports 仍以字面子路径暴露内核产物，宿主不能靠拼目录深引。
 *
 * 测试只读本包与自己的 package.json，不读取 `web/`、`bevy/` 或主仓脚本；因此隔离副本里同样成立。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = [
  "@woohaa3/frontend",
  "@woohaa3/contracts",
  "@woohaa3/application-service",
  "@woohaa3/canvas-service",
  "@woohaa3/backend",
  "@woohaa3/photocraft-woohaa"
];
const IMPORT = /(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "test-support") continue;
      files.push(...sources(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("编辑器包边界", () => {
  const files = sources(join(PACKAGE_ROOT, "src"));

  it("源码不依赖宿主包、私有实现或包外相对路径", () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      IMPORT.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = IMPORT.exec(text))) {
        const specifier = match[1] ?? match[2];
        if (!specifier) continue;
        if (FORBIDDEN.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
          violations.push(`${relative(PACKAGE_ROOT, file)} → ${specifier}`);
        }
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (relative(PACKAGE_ROOT, target).startsWith("..")) {
            violations.push(`${relative(PACKAGE_ROOT, file)} → ${specifier}（包外）`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("package.json 只声明纯协议与通用 UI 依赖，并保留字面 wasm 子路径", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      exports: Record<string, unknown>;
    };
    const allowed = /^(?:@woohaa3\/photocraft-protocol|@radix-ui\/|lucide-react$)/;
    expect(Object.keys(manifest.dependencies).filter((name) => !allowed.test(name))).toEqual([]);
    expect(manifest.exports["./wasm"]).toBeDefined();
    expect(manifest.exports["./styles.css"]).toBeDefined();
  });
});
