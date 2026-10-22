/**
 * 画布切换器顶栏触发器的水平对齐约束（回归：图标、标题、展开箭头与相邻状态徽标
 * 共用一条水平中心线）。
 *
 * jsdom 不做布局，量不到真实基线；这里守住让它成立的三条样式前提：
 * 1. 触发器高度来自 `.ui-button--sm` 的 26px，不能再叠加垂直内边距（7px + 7px + 边框
 *    会把内容盒压到 10px，子元素按各自基线溢出，标题比图标低约 4px）；
 * 2. 承载图标与标题的 `.ui-button__label` 是 flex 容器并垂直居中（inline 基线布局
 *    会把 13px 标题排到 18px 箭头下方）；
 * 3. 展开箭头自身也是 flex 容器，跟随同一条中心线。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./ui.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("画布切换器顶栏对齐", () => {
  it("触发器只保留水平内边距，高度交给 .ui-button--sm", () => {
    const body = ruleBody(".canvas-switcher-trigger");
    expect(body).not.toBe("");
    expect(body).toMatch(/padding:\s*0\s+12px\s+0\s+10px/);
  });

  it("图标与标题所在的 label 垂直居中", () => {
    const body = ruleBody(".canvas-switcher-trigger .ui-button__label");
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/align-items:\s*center/);
  });

  it("展开箭头与文字共用同一条水平中心线", () => {
    const body = ruleBody(".canvas-switcher-trigger__caret");
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/align-items:\s*center/);
  });
});
