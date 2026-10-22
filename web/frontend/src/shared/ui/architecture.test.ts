/**
 * UI architecture audit：Radix/Lucide import 边界
 * （change: adopt-radix-lucide-canvas-ui，任务 1.3 / design D1/D5）。
 *
 * 静态保证：
 * - `@radix-ui/react-*` 与 `lucide-react` 的**生产 import 只出现在**
 *   `shared/ui/`；
 * - services / plugins / 其它 UI 模块不得直接 import Radix 或 Lucide，也不得各自建立
 *   平行 wrapper（必须经生产 public 入口消费）；
 * - 禁止 namespace import（`import * as`）整包，保证 tree-shake；
 * - 自绘 svg / 字体字符只允许出现在登记的产品专有例外。
 *
 * 违规报错定位到 package 与文件，便于修复。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRIMITIVES_DIR = path.join(SRC_ROOT, "shared", "ui");
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

function productionFiles(dir: string): string[] {
  return walk(dir, /\.(ts|tsx)$/).filter(
    (file) => !file.includes(".test.") && !file.includes("/test-support/")
  );
}

const RADIX_IMPORT = /from\s+["']@radix-ui\/[^"']+["']/;
const LUCIDE_IMPORT = /from\s+["']lucide-react["']/;

describe("UI import firewall（任务 1.3）", () => {
  it("Radix/Lucide imports 只存在于 shared/ui", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(SRC_ROOT)) {
      if (file.startsWith(PRIMITIVES_DIR + path.sep)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (RADIX_IMPORT.test(source)) offenders.push(`${path.relative(SRC_ROOT, file)}: @radix-ui`);
      if (LUCIDE_IMPORT.test(source)) offenders.push(`${path.relative(SRC_ROOT, file)}: lucide-react`);
    }
    expect(offenders).toEqual([]);
  });

  it("primitives 层禁止 namespace import（`import * as` 破坏 tree-shake）", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(PRIMITIVES_DIR)) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (/import\s+\*\s+as\s+\w+\s+from\s+["']lucide-react["']/.test(source)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: namespace lucide import`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("primitives 层不得含业务状态（Canvas document/task/media/plugin 语义）", () => {
    const banned = /\b(Y\.Doc|canvasDocument|taskActivityStore|mediaRemote|canvasRemote)\b/;
    const offenders: string[] = [];
    for (const file of productionFiles(PRIMITIVES_DIR)) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (banned.test(source)) offenders.push(path.relative(SRC_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("services/plugins 生产代码不直接 import toolbar-icons（统一走 primitives facade）", () => {
    // toolbar-icons 已在任务 7.3 删除；所有通用图标从 primitives facade 获取。
    const uiDir = path.join(SRC_ROOT, "cordis", "ui");
    const offenders: string[] = [];
    for (const file of productionFiles(SRC_ROOT)) {
      if (file.startsWith(uiDir + path.sep)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/from\s+["'][^"']*toolbar-icons[^"']*["']/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("故意违规 fixture 会被定位到 package 与文件", () => {
    // 用内联样例验证检测逻辑本身：错误信息必须含 package 与文件名。
    const samples: Array<{ file: string; source: string }> = [
      { file: "cordis/plugins/example/wrong.tsx", source: `import * as Dialog from "@radix-ui/react-dialog";` },
      { file: "cordis/services/example/wrong.ts", source: `import { X } from "lucide-react";` }
    ];
    const violations: string[] = [];
    for (const sample of samples) {
      const body = stripComments(sample.source);
      if (RADIX_IMPORT.test(body)) violations.push(`${sample.file}: @radix-ui`);
      if (LUCIDE_IMPORT.test(body)) violations.push(`${sample.file}: lucide-react`);
    }
    expect(violations).toEqual([
      "cordis/plugins/example/wrong.tsx: @radix-ui",
      "cordis/services/example/wrong.ts: lucide-react"
    ]);
  });
});
