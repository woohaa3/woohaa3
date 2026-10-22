/**
 * 提示词输入框最大高度回归
 * （compact / dock 面：长提示词必须内部滚动，而不是把面板无限撑高，上限 5 行）。
 *
 * jsdom 不会根据 import 的 CSS 文件计算样式，这里按既有守卫约定直接读样式源，
 * 断言「输入框有 5 行上限 + 超出滚动」以及「仅 expanded 面放开」。覆盖两种输入实现：
 * 默认 `<textarea class="mc-panel__textarea">` 与宿主提供的结构化 `MentionEditor`。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("./execution-panel.css", import.meta.url)),
  "utf8",
);

/** 取出匹配选择器后第一个声明块的内容。 */
function ruleBody(selector: string): string {
  const match = CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未找到规则：${selector}`);
  return match[1];
}

describe("执行面板提示词输入框最大高度", () => {
  it("在面板上定义 5 行上限 token", () => {
    const body = ruleBody(".mc-panel");
    expect(body).toMatch(/--mc-prompt-max-lines:\s*5\s*;/);
  });

  it("默认 textarea 限到 5 行且超出滚动", () => {
    const body = ruleBody(".mc-panel__textarea");
    expect(body).toMatch(/max-height:\s*calc\(var\(--mc-prompt-max-lines\)[^)]*\*\s*26px/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it("结构化 prompt 编辑器在紧凑面同样限到 5 行", () => {
    const body = ruleBody(
      '.mc-panel[data-surface="dock"]:not(.mc-panel--expanded) .mc-panel__prompt-box .mention-editor__input',
    );
    expect(body).toMatch(/max-height:\s*calc\(var\(--mc-prompt-max-lines\)/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  });

  it("仅 expanded 面放开 textarea 最大高度以填满全屏", () => {
    const body = ruleBody(".mc-panel--expanded .mc-panel__sectioned-prompt .mc-panel__textarea");
    expect(body).toMatch(/max-height:\s*none/);
  });
});
