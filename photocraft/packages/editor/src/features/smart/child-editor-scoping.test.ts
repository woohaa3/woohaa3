/**
 * 子文档编辑器不被宿主定位规则裁切（U65 回归）。
 *
 * 宿主把最外层编辑器的菜单/参数栏/工具栏/侧栏/状态条绝对定位到内容矩形之外；这些
 * 后代选择器会命中嵌在子文档弹层里的第二个编辑器。这里锁定：
 * 1. 子文档编辑器带作用域属性并引入本域样式；
 * 2. 宿主每一条 `position: absolute` 的 `.photo-editor__*` 规则，本域都有对应还原；
 * 3. 本域样式不改写宿主作用域（不出现 `.image-edit-workspace` 选择器）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = readFileSync(resolve(HERE, "../../photo-editor.css"), "utf8");
const DOMAIN = readFileSync(resolve(HERE, "smart-child.css"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");
const COMPONENT = readFileSync(resolve(HERE, "child-editor.tsx"), "utf8");

/** 宿主里被绝对定位到内容矩形之外的编辑器部件。 */
function absolutelyPositionedParts(): string[] {
  const parts = new Set<string>();
  const rule = /\.image-edit-workspace\s+\.(photo-editor__[a-z-]+)([^{}]*)\{([^}]*)\}/g;
  for (const match of SHELL.matchAll(rule)) {
    if (/position:\s*absolute/.test(match[3])) parts.add(match[1]);
  }
  return [...parts].sort();
}

describe("子文档编辑器作用域", () => {
  it("宿主确实用后代选择器外置编辑器部件（前提成立，回归才有意义）", () => {
    expect(absolutelyPositionedParts()).toEqual([
      "photo-editor__contextbar",
      "photo-editor__menubar",
      "photo-editor__sidebar",
      "photo-editor__status",
      "photo-editor__toolrail"
    ]);
  });

  it("每个外置部件在子文档作用域内都有还原", () => {
    const blocks = [...DOMAIN.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(match => ({
      selectors: match[1].split(",").map(selector => selector.replaceAll(/\s+/g, " ").trim()),
      body: match[2]
    }));
    for (const part of absolutelyPositionedParts()) {
      const scoped = `.photo-editor__smart-child[data-smart-child-editor] .${part}`;
      const restored = blocks.find(block => block.selectors.includes(scoped) && /position:\s*static/.test(block.body));
      expect(restored, `${part} 缺少子文档作用域的还原规则`).toBeDefined();
      expect(restored!.body).toMatch(/inset:\s*auto/);
    }
  });

  it("子文档样式只作用于弹层内部，不改写宿主作用域", () => {
    expect(DOMAIN).not.toMatch(/\.image-edit-workspace/);
    expect(DOMAIN).not.toMatch(/(^|\})\s*\.app\[/);
    for (const block of DOMAIN.matchAll(/([^{}]+)\{/g)) {
      const selector = block[1].replaceAll("\n", " ").trim();
      if (!selector) continue;
      expect(selector).toContain("data-smart-child-editor");
    }
  });

  it("宿主按聚焦面板隐藏侧栏时，子文档侧栏仍显示", () => {
    expect(SHELL).toMatch(/\.app\[data-focus-panel="history"\] \.photo-editor__sidebar[^{]*\{[^}]*display:\s*none/);
    expect(DOMAIN).toMatch(
      /> \.photo-editor \.photo-editor__sidebar\s*\{[^}]*display:\s*flex/
    );
  });

  it("组件带作用域属性并引入本域样式", () => {
    expect(COMPONENT).toContain('import "./smart-child.css"');
    expect(COMPONENT).toContain('data-smart-child-editor="true"');
  });
});
