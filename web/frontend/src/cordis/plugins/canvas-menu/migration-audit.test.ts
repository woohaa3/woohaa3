/**
 * Menus / Switcher 迁移零引用审计（change: adopt-radix-lucide-canvas-ui，任务 4.3）。
 *
 * 静态保证：
 * - Canvas context menu 不再保留手工 viewport 翻转或 window/document dismiss listener；
 * - 迁移后的 menu/switcher 不再使用被替代的旧手工定位/shortcut 选择器；
 * - dispose 后 portal/listener 由 primitive（Radix DismissableLayer）释放，不新增全局监听。
 *
 * @vitest-environment node
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MENU_FILE = path.resolve(HERE, "canvas-context-menu.tsx");
const SWITCHER_FILE = path.resolve(HERE, "../canvas-switcher/chrome.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("menus/switcher 迁移零引用（任务 4.3）", () => {
  it("context menu 不再维护手工 viewport 翻转或全局 dismiss listener", () => {
    const source = stripComments(readFileSync(MENU_FILE, "utf8"));
    expect(source).not.toMatch(/getBoundingClientRect/);
    expect(source).not.toMatch(/innerWidth|innerHeight/);
    expect(source).not.toMatch(/addEventListener\(\s*["'](keydown|pointerdown|resize|blur|wheel)["']/);
    expect(source).not.toMatch(/removeEventListener/);
  });

  it("context menu 通过共享 CursorMenu primitive 组合，不自绘 menu markup", () => {
    const source = stripComments(readFileSync(MENU_FILE, "utf8"));
    expect(source).toContain("CursorMenu");
    expect(source).not.toMatch(/role="menu"/);
    expect(source).not.toMatch(/role="menuitem"/);
  });

  it("switcher 迁移到生产 Button/ScrollArea，删除 dlg__button 旧手工类", () => {
    const source = stripComments(readFileSync(SWITCHER_FILE, "utf8"));
    expect(source).not.toContain("dlg__button");
    expect(source).toContain("ScrollArea");
    expect(source).toContain("Button");
    // 不自绘 icon svg。
    expect(source).not.toMatch(/<svg/);
  });
});
