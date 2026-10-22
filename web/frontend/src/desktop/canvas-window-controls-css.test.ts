/**
 * 桌面窗口横栏占位回归
 *
 * 实机缺陷：Agent 对话侧栏顶部（标题与会话动作行）被 26px 窗口横栏盖住。根因是横栏
 * `position: absolute; inset: 0 0 auto` 只把 `.bevy-canvas-surface` 往下推，其余页面内容
 * （含 `position: fixed; top: 0` 的详情侧栏）仍在横栏下面。
 *
 * 约定：横栏是**占位**的窗口装饰——内容区整体从横栏下方开始，不是靠各浮层各自叠加偏移；
 * 只有 `position: fixed` 的浮层（包含块是视口）才额外读取 `--canvas-chrome-height`。
 *
 * jsdom 不按 import 的 CSS 计算布局，这里按既有守卫约定直接读样式源断言契约
 * （同 `agent-conversation-panel-layout.test.ts`）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("./canvas-window-controls.css", import.meta.url)),
  "utf8",
);

/** 取出匹配选择器后第一个声明块的内容。 */
function ruleBody(selector: string): string {
  const match = CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未找到规则：${selector}`);
  return match[1];
}

describe("桌面窗口横栏占位（不是覆盖层）", () => {
  it("有横栏时整个内容区从横栏下方开始", () => {
    const body = ruleBody(".app:has(> .desktop-canvas-bar)");
    expect(body).toMatch(/--canvas-chrome-height:\s*26px/);
    expect(body).toMatch(/top:\s*var\(--canvas-chrome-height\)/);
  });

  it("横栏自身固定在窗口顶端，不随内容位移", () => {
    const body = ruleBody(".desktop-canvas-bar");
    expect(body).toMatch(/position:\s*fixed/);
    expect(body).toMatch(/inset:\s*0\s+0\s+auto/);
  });

  it("概览态 Agent 详情侧栏（fixed）显式让出横栏高度，标题行不再被遮住", () => {
    const rule = CSS.split("\n").find((line) =>
      line.includes(".app:has(> .desktop-canvas-bar)") && line.includes(".agent-detail"),
    );
    expect(rule).toBeDefined();
    expect(rule).toMatch(/top:\s*var\(--canvas-chrome-height\)/);
  });
});
