/**
 * Web 主题消费不变量（change: unify-application-theme-tokens，任务 2.2–2.5）。
 *
 * 静态断言：
 * - `--mc-*` compatibility alias 只引用 canonical `--app-*`，不含独立颜色 literal；
 * - 组件样式不再出现品牌 hex/rgba literal（只允许语义变量）；
 * - Dialog Host（portal）位于 ThemeProvider 内，继承同一 theme root。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { THEME_SELECTION_STORAGE_KEY } from "./services/theme/service.js";

const here = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(here, "ui");
const UI_CSS = readFileSync(resolve(UI_DIR, "ui.css"), "utf8");
const INDEX_CSS = readFileSync(resolve(here, "../index.css"), "utf8");
// 页面专属样式随页面拥有（change: 2026-10-10-extract-task-history-page，design D4）：
// 与 index.css 同等约束——只消费语义 token，不复制品牌色 literal。
const TASK_HISTORY_CSS = readFileSync(resolve(here, "../pages/task-history/task-history.css"), "utf8");
const APP_HOST = readFileSync(resolve(here, "app-host.tsx"), "utf8");
const APP_HTML = readFileSync(resolve(here, "../../index.html"), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 匹配「看起来像品牌色」的字面值；透明/命名色与 var() 不算。 */
function colorLiterals(source: string): string[] {
  const body = stripComments(source);
  const matches = body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
  return matches;
}

describe("Web theme 消费（任务 2.2/2.3/2.5）", () => {
  it("--mc-* alias 只引用 canonical --app-*，无独立 literal", () => {
    const aliasBlock = UI_CSS.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(aliasBlock).toContain("--mc-backdrop: var(--app-web-backdrop)");
    expect(aliasBlock).toContain("--mc-accent: var(--app-interaction-accent)");
    // alias 块内不得含任何颜色 literal（font 除外）。
    const mcLines = aliasBlock
      .split("\n")
      .filter((line) => line.trim().startsWith("--mc-"))
      .filter((line) => !line.trim().startsWith("--mc-font"));
    for (const line of mcLines) {
      expect(line, line).toMatch(/var\(--app-/);
      expect(colorLiterals(line), line).toEqual([]);
    }
  });

  it("ui.css、index.css 与页面专属 CSS 组件规则不再含品牌色 literal", () => {
    // generated-theme.css 是 canonical 生成物，单独排除；这三份是消费方。
    for (const [name, source] of [
      ["ui.css", UI_CSS],
      ["index.css", INDEX_CSS],
      ["pages/task-history/task-history.css", TASK_HISTORY_CSS]
    ] as const) {
      const literals = colorLiterals(source).filter((value) => !isAllowedLiteral(value));
      expect(literals, `${name} 含未登记 literal`).toEqual([]);
    }
  });

  it("首帧暗色引导与 ThemeService 使用同一存储键和 preset id", () => {
    // 内联脚本在模块执行前运行，无法 import 常量；值必须与 THEME_SELECTION_STORAGE_KEY 一致。
    expect(APP_HTML).toContain(`localStorage.getItem("${THEME_SELECTION_STORAGE_KEY}")`);
    expect(APP_HTML).toContain('=== "dark"');
    expect(APP_HTML).toContain('dataset.appTheme = "dark"');
  });

  it("accent 实底上的文字使用 interaction-on-accent，不得误用 web-text-inverse", () => {
    // inverse 表示「深色浮层上的浅色文字」，不是 accent 的前景色；暗色下误用会低到约 2.3:1。
    const blocks = UI_CSS.match(/\{[^{}]*\}/g) ?? [];
    const offenders = blocks.filter(
      (block) =>
        /background:\s*var\(--app-interaction-accent\)/.test(block) &&
        /color:\s*var\(--app-web-text-inverse\)/.test(block)
    );
    expect(offenders, `accent 实底误用 inverse：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("Dialog Host（portal）位于 ThemeProvider 内，继承同一 theme root", () => {
    expect(APP_HOST).toContain("<ThemeProvider service={theme}>");
    // DialogHost 必须渲染在 ThemeProvider 的子树中。
    const providerIndex = APP_HOST.indexOf("<ThemeProvider service={theme}>");
    const dialogIndex = APP_HOST.indexOf("<DialogHost");
    const closeIndex = APP_HOST.lastIndexOf("</ThemeProvider>");
    expect(providerIndex).toBeGreaterThan(-1);
    expect(dialogIndex).toBeGreaterThan(providerIndex);
    expect(closeIndex).toBeGreaterThan(dialogIndex);
  });
});

/** 允许的例外：透明/中性合成常量（design D9 允许清单）。 */
function isAllowedLiteral(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  return (
    normalized === "transparent" ||
    /^rgba?\(0,0,0,0(\.0+)?\)$/.test(normalized) ||
    /^rgba?\(255,255,255,0(\.0+)?\)$/.test(normalized)
  );
}
