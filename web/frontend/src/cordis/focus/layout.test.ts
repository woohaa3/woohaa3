import { expect, it } from "vitest";
import { focusLayout } from "./layout.js";
it("桌面工具区占位只由公共布局计算，Bevy 与透明交互层使用同一内容矩形", () => {
  const layout = focusLayout({ width: 1440, height: 900, toolColumn: 52, toolbar: 96, panel: true, panelMaxWidth: 280 });
  expect(layout.contentRect).toEqual({ x: 52, y: 152, width: 1108, height: 704 });
  expect(layout.insets).toEqual({ left: 52, top: 152, right: 280, bottom: 44 });
  expect(layout.toolbar).toBe(96);
});
it("未提供工具区时保持其他聚焦工作区的几何", () => {
  expect(focusLayout({ width: 1440, height: 900 }).contentRect).toEqual({ x: 0, y: 56, width: 1440, height: 800 });
});
it("较小桌面窗口仍将图片工具放在左右两侧", () => {
  const layout = focusLayout({ desktop: true, width: 800, height: 700, toolColumn: 52, toolbar: 96, panel: true, panelMaxWidth: 280 });
  expect(layout.narrow).toBe(false);
  expect(layout.contentRect).toEqual({ x: 52, y: 152, width: 508, height: 504 });
});
it("聚焦布局不为窗口横栏二次扣减高度（横栏在页面布局里已占位）", () => {
  // 横栏由 `.app:has(> .desktop-canvas-bar)` 整体下移内容区，画布表面尺寸本身已排除横栏；
  // 若这里再加入 chrome 偏移，聚焦标题栏与内容会二次下移 26px。
  const layout = focusLayout({ width: 1440, height: 874 });
  expect(layout.contentRect).toEqual({ x: 0, y: 56, width: 1440, height: 774 });
  expect("chrome" in layout).toBe(false);
});
