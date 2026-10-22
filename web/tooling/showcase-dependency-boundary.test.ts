/** Radix/Lucide 已进入生产；业务入口必须经过 shared/ui。 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 共享 UI 适配层的 vendor 依赖。 */
export const UI_VENDOR_PACKAGES = [
  "@radix-ui/react-toggle-group",
  "@radix-ui/react-collapsible",
  "@radix-ui/react-tooltip",
  "lucide-react",
] as const;

export type DependencyViolation = { file: string; specifier: string; rule: string };

/** 纯函数门禁（供测试用 fixture 注入验证守卫有效）。 */
export function scanUiVendorImports(input: {
  file: string;
  source: string;
}): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  const withoutComments = input.source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const pattern =
    /(?:from\s*["']([^"']+)["'])|(?:import\s*["']([^"']+)["'])|(?:import\s*\(\s*["']([^"']+)["']\s*\))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutComments))) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    if (!input.file.startsWith("frontend/src/shared/ui/")) {
      if (specifier.startsWith("@radix-ui/") || specifier === "lucide-react" || specifier.startsWith("lucide-react/")) {
        violations.push({ file: input.file, specifier, rule: "shared-ui-vendor-boundary" });
      }
    }
  }
  return violations;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "server-dist") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  return files;
}

describe("生产 UI vendor 只能从 shared/ui 适配层引入", () => {
  it("frontend 明确声明共享适配层所需 Radix / Lucide", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(WEB_ROOT, "frontend", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of UI_VENDOR_PACKAGES) {
      expect(deps[name], name).toBeTruthy();
    }
  });

  it("frontend 业务源码不绕过 shared/ui import Radix / Lucide", () => {
    const offenders: DependencyViolation[] = [];
    for (const file of collectSourceFiles(path.join(WEB_ROOT, "frontend", "src"))) {
      offenders.push(
        ...scanUiVendorImports({ file: path.relative(WEB_ROOT, file), source: readFileSync(file, "utf8") }),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("shared/ui 可以引入 vendor（fixture）", () => {
    expect(scanUiVendorImports({ file: "frontend/src/shared/ui/Tooltip.tsx", source: 'import * as Tooltip from "@radix-ui/react-tooltip";' })).toEqual([]);
  });

  it("守卫能检出 frontend 中故意引入的 Radix / Lucide import（fixture）", () => {
    expect(
      scanUiVendorImports({ file: "frontend/src/x.tsx", source: `import { Root } from "@radix-ui/react-collapsible";` }),
    ).toEqual([{ file: "frontend/src/x.tsx", specifier: "@radix-ui/react-collapsible", rule: "shared-ui-vendor-boundary" }]);
    expect(
      scanUiVendorImports({ file: "frontend/src/x.tsx", source: `import { Sun } from "lucide-react/icons";` }),
    ).toHaveLength(1);
    // 注释中的提及不算 import。
    expect(
      scanUiVendorImports({ file: "frontend/src/x.tsx", source: `// 参考 lucide-react 的图标命名\nconst x = 1;` }),
    ).toEqual([]);
  });
});
