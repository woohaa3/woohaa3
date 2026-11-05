/**
 * 前端文件体积守卫（change: 2026-09-28-split-frontend-god-plugins，design D6）。
 *
 * 遍历 `web/frontend/src` 下全部 `.ts`/`.tsx`（排除 `bevy-wasm/` 生成
 * 产物），按**物理行**计数（与 `wc -l` 一致；末尾未换行的一行计为一行，注释、空行与测试代码
 * 都计入），任何超过 800 行的文件都会让测试失败并逐一列出。
 *
 * 这是导航与可评审性护栏，不是复杂度指标。禁止用压缩格式、拼接生成源码或删除测试
 * 规避；也禁止把代码切成无独立职责的碎片模块。
 *
 * 拆分完成前，`cordis/` 下已知超限文件暂列于 `ALLOWLIST`；tasks 2–6 完成后该列表清空，
 * 守卫转为强制。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** 单文件物理行上限（含注释、空行与测试）。 */
const MAX_PHYSICAL_LINES = 800;

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
/**
 * 生成产物目录：都是构建脚本写入、`.gitignore` 忽略的派生物，不由人维护，因此不参与
 * 可评审性计行。
 * - `bevy-wasm/`：`scripts/build-bevy-wasm.mjs` 产出的 glue 与 `.d.ts`；
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "bevy-wasm"]);

/**
 * 拆分进行中的豁免清单（相对 SRC_ROOT 的 posix 路径）。
 * change 完成后必须为空：空列表即“任何文件都不得超限”。
 */
const ALLOWLIST = new Set<string>([
  // 待拆分（本轮删除分组/片场后体量变化，拆分未完成前登记在此，保持守卫可见）。
  "cordis/page-scope.ts",
  "cordis/plugins/canvas-runtime/bevy-runtime.ts",
  "cordis/services/canvas-session.ts",
  "cordis/services/canvas-remote.ts",
  "cordis/services/canvas-session.test.ts",
  "cordis/ui/assistant-execution/authoring-composer.tsx",
  "cordis/plugins/node-history/plugin.test.tsx",
  "cordis/plugins/task-execution/authoring-generate-panel.test.tsx",
  "cordis/plugins/canvas-runtime/host.ts",
  "cordis/plugins/canvas-runtime/texture-sync.ts",
  "cordis/plugins/canvas-shell/interaction-2d-input.ts",
  "cordis/plugins/canvas-shell/interaction-controller.ts",
  "cordis/plugins/world-scopes/gestures.test.ts",
  "cordis/plugins/world-scopes/gestures.ts"
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

/**
 * 物理行数：与 Bevy 守卫 `physical_lines`（Rust `str::lines()`）语义一致。
 * 末尾换行不产生额外空行；末尾未换行的最后一行仍计为一行；`\r\n`/`\r` 归一化。
 */
function physicalLines(source: string): number {
  if (source === "") return 0;
  const parts = source.replace(/\r\n?/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

describe("前端文件体积守卫", () => {
  it("web/frontend/src 下没有超过 800 物理行的源码/测试文件", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    expect(files.length, "守卫扫描集不应为空").toBeGreaterThan(0);

    files.sort();
    const violations: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (ALLOWLIST.has(relative)) continue;
      const lines = physicalLines(readFileSync(file, "utf8"));
      if (lines > MAX_PHYSICAL_LINES) violations.push(`  ${relative}: ${lines} 行`);
    }

    expect(
      violations,
      `以下文件超过 ${MAX_PHYSICAL_LINES} 物理行上限（共 ${violations.length} 个）：\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("计数规则与 wc -l 一致", () => {
    expect(physicalLines("")).toBe(0);
    expect(physicalLines("\n")).toBe(1);
    expect(physicalLines("a\n")).toBe(1);
    expect(physicalLines("a\nb\n")).toBe(2);
    expect(physicalLines("a\nb")).toBe(2);
    expect(physicalLines("a\r\nb\r\n")).toBe(2);
  });
});
