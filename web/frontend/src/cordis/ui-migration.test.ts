/**
 * Canvas DOM chrome 迁移盘点（change: adopt-radix-lucide-canvas-ui，任务 1.1）。
 *
 * 用源码清单测试锁定**首批迁移范围**（按 surface 归属）与**允许保留的产品专有图形**。
 * 该测试是迁移期间的作用域契约：每个 surface 迁移完成后，其旧实现必须从本清单移除
 * （见任务 3–8 的零引用审计）。
 *
 * @vitest-environment node
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.resolve(SRC_ROOT, relative), "utf8");
}

/**
 * 首批迁移的 surface → 生产文件。每个 surface 只在此登记其当前实现文件；
 * 迁移到 primitives 后，文件仍存在，但其"旧实现特征"由后续审计锁定为零引用。
 */
export const FIRST_WAVE_SURFACES: Record<string, string[]> = {
  "canvas-zoom": ["cordis/plugins/canvas-shell/canvas-zoom-controls.tsx"],
  // model-focus-back 已由公共 `cordis/focus/header`（返回/历史/标题）与各 editor 工作区取代
  // （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D1/D2），不再登记独立 surface。
  "canvas-context-menu": ["cordis/plugins/canvas-menu/canvas-context-menu.tsx"],
  "canvas-switcher": ["cordis/plugins/canvas-switcher/chrome.tsx"],
  // task-activity 浮层已迁至独立 extension 包
  // （change: 2026-10-10-extract-optional-feature-extensions），宿主不再持有该 surface 实现。
  "dialog-surface": ["cordis/services/dialogs/DialogHost.tsx"],
  "model-editor-toolbar": ["cordis/plugins/model-editor/model-editor-toolbar.tsx"]
};

/**
 * 允许保留的自绘 svg 图形（Lucide 无等价语义的产品专有资产）。
 * 迁移期间由本清单显式放行；迁移完成后应只剩真正的产品标记。
 */
export const CUSTOM_GRAPHIC_ALLOWLIST: readonly string[] = [];

describe("首批迁移范围盘点（任务 1.1）", () => {
  it("所有登记的 surface 生产文件存在", () => {
    for (const [surface, files] of Object.entries(FIRST_WAVE_SURFACES)) {
      for (const file of files) {
        expect(() => read(file), `${surface} -> ${file}`).not.toThrow();
      }
    }
  });

  it("每个首批 surface 都已登记至少一个实现文件（无遗漏归属）", () => {
    for (const files of Object.values(FIRST_WAVE_SURFACES)) {
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it("允许保留的产品专有图形都在清单内（迁移期例外表）", () => {
    // 同步图标已由工具栏性能小字取代，首批 surface 不再保留自绘操作图标例外。
    expect(CUSTOM_GRAPHIC_ALLOWLIST).toHaveLength(0);
    // 允许清单不得登记已有 Lucide 等价的通用操作图标（防止用例外复制通用图标）。
    for (const entry of CUSTOM_GRAPHIC_ALLOWLIST) {
      expect(entry.toLowerCase()).not.toMatch(/zoom|close|copy|play|pause|trash|volume|chevron/);
    }
  });
});
