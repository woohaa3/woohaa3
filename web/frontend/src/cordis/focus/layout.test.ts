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
it("缺省由宿主自绘 chrome：保留标题栏与底部基座占位", () => {
  const layout = focusLayout({ width: 1440, height: 900 });
  expect(layout).toMatchObject({ header: 56, footer: 44 });
  expect(layout.contentRect).toEqual({ x: 0, y: 56, width: 1440, height: 800 });
});
it("自绘 chrome 的工作区拿到全高内容矩形，且不把标志写回 layout", () => {
  const layout = focusLayout({ width: 1440, height: 900, chromeOwner: "workspace", panel: true });
  expect(layout).toMatchObject({ header: 0, footer: 0, player: 0, panelWidth: 320 });
  expect(layout.insets).toEqual({ left: 0, top: 0, right: 320, bottom: 0 });
  expect(layout.contentRect).toEqual({ x: 0, y: 0, width: 1120, height: 900 });
  expect("chromeOwner" in layout).toBe(false);
});
it("自绘 chrome 的窄屏仍由底部 sheet 占位，内容矩形相应收缩", () => {
  const layout = focusLayout({ width: 700, height: 900, chromeOwner: "workspace", panel: true });
  expect(layout.narrow).toBe(true);
  expect(layout).toMatchObject({ header: 0, footer: 0, panelWidth: 0, panelHeight: 280 });
  expect(layout.insets).toEqual({ left: 0, top: 0, right: 0, bottom: 280 });
  expect(layout.contentRect).toEqual({ x: 0, y: 0, width: 700, height: 620 });
});

it.each([{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }])("三栏与全宽底栏共用唯一内容矩形：$width×$height", ({ width, height }) => {
  const input = { desktop: true, width, height, navigationWidth: 224, bottomBar: 240, toolbar: 48, panel: true, panelMaxWidth: 320 };
  const layout = focusLayout(input);
  expect(layout.narrow).toBe(false);
  expect(layout.insets).toEqual({ left: 224, right: Math.min(320, width * 0.3), top: 104, bottom: 240 });
  expect(layout.contentRect.width + layout.insets.left + layout.insets.right).toBe(width);
  expect(layout.contentRect.height + layout.insets.top + layout.insets.bottom).toBe(height);
  const collapsed = focusLayout({ ...input, navigationWidth: 40, bottomBar: 144 });
  expect(collapsed.contentRect.width - layout.contentRect.width).toBeCloseTo(184);
  expect(collapsed.contentRect.height - layout.contentRect.height).toBe(96);
});

it("缺省不带卡片留白：cardRect 即整个表面，内容矩形与此前一致", () => {
  const layout = focusLayout({ width: 1440, height: 900 });
  expect(layout.cardRect).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  expect(layout.contentRect).toEqual({ x: 0, y: 56, width: 1440, height: 800 });
});

it("cardInset 把整个工作区收进居中卡片：内容矩形相对卡片布局，而不是只缩内容区", () => {
  const layout = focusLayout({ width: 1440, height: 900, cardInset: 48, panel: true, panelMaxWidth: 320 });
  expect(layout.cardRect).toEqual({ x: 48, y: 48, width: 1344, height: 804 });
  // 检查器宽度按卡片宽度的 30% 取：1344 * 0.3 = 403.2，被 320 封顶。
  expect(layout.panelWidth).toBe(320);
  // 内容矩形 = 卡片内扣掉顶栏（56）、底栏（44）与右侧检查器。
  expect(layout.contentRect).toEqual({ x: 48, y: 48 + 56, width: 1344 - 320, height: 804 - 56 - 44 });
  // 内容矩形始终落在卡片内。
  expect(layout.contentRect.x + layout.contentRect.width).toBeLessThanOrEqual(layout.cardRect.x + layout.cardRect.width);
  expect(layout.contentRect.y + layout.contentRect.height).toBeLessThanOrEqual(layout.cardRect.y + layout.cardRect.height);
});

it("cardInset 在极小窗口下被夹住：卡片与内容矩形尺寸始终为正", () => {
  const layout = focusLayout({ width: 60, height: 40, cardInset: 48 });
  expect(layout.cardRect.width).toBeGreaterThan(0);
  expect(layout.cardRect.height).toBeGreaterThan(0);
  expect(layout.contentRect.width).toBeGreaterThan(0);
  expect(layout.contentRect.height).toBeGreaterThan(0);
});
