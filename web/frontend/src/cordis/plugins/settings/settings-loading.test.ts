/**
 * 设置内容首次加载的占位样式与结构回归
 * （change: 2026-10-17-move-settings-into-canvas-dialog）。
 *
 * 背景：早期加载回退直接渲染 `.dlg` + `.status-overlay`，而 `.status-overlay` 是
 * `position: fixed; inset: 0`，于是打开设置在内容 chunk 到达前会铺满整屏、并露出没有
 * 弹窗外框的裸层。这里同时锁住两件事：
 * - 加载提示只占右栏，且不引用任何全屏定位类；
 * - 加载态与内容态共用同一 `SettingsDialogChrome`（固定 Header + 左栏 + 右栏滚动）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./plugin.tsx", import.meta.url)),
  "utf8"
);
const css = readFileSync(fileURLToPath(new URL("./settings.css", import.meta.url)), "utf8");

describe("设置加载态", () => {
  it("加载占位复用弹窗外壳，不使用全屏 status-overlay", () => {
    const loading = source.slice(source.indexOf("function SettingsLoading"));
    expect(loading).toContain("SettingsDialogChrome");
    expect(loading).not.toContain("status-overlay");
    // 不再手写裸 `.dlg` 外壳（那会绕开 Dialog.Content 的 instanceId/aria 绑定）。
    expect(loading).not.toContain("className=\"dlg dlg--lg settings-dialog\"");
  });

  it("加载文案只在右栏，样式不声明全屏定位", () => {
    expect(css).toMatch(/\.settings-workbench__loading\s*\{[^}]*\}/);
    const rule = css.match(/\.settings-workbench__loading\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).not.toContain("position: fixed");
    expect(rule).not.toContain("inset: 0");
    expect(rule).toContain("padding");
    // 左栏占位撑住列宽，避免加载完成后布局跳动。
    expect(css).toMatch(/\.settings-workbench__nav-placeholder\s*\{[^}]*\}/);
  });
});
