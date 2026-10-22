// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopCanvasBar } from "./canvas-window-controls.js";
import { controlWindow } from "./window-controls.js";

vi.mock("./window-controls.js", async (original) => ({
  ...await original<typeof import("./window-controls.js")>(), controlWindow: vi.fn()
}));
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove(); root = undefined; container = undefined;
  vi.unstubAllGlobals(); vi.resetAllMocks();
});
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__WOOHAA_DESKTOP__", { protocol: "woohaa-window-v1", token: "test" });
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(controlWindow).mockResolvedValue({ maximized: false });
  await act(async () => root!.render(<DesktopCanvasBar />));
}
function button(name: string) {
  return container!.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
}
it("桌面窗口始终显示横栏（含节点聚焦与 secondary 路由），浏览器不显示", async () => {
  await mount();
  expect(button("刷新页面")).not.toBeNull();
  // 聚焦编辑由画布继续持有窗口装饰，不因 overview=false 消失。
  await act(async () => root!.render(<DesktopCanvasBar><span data-testid="canvas-content" /></DesktopCanvasBar>));
  expect(button("刷新页面")).not.toBeNull();
  expect(container!.querySelector('[data-testid="canvas-content"]')).not.toBeNull();
  vi.stubGlobal("__WOOHAA_DESKTOP__", undefined);
  await act(async () => root!.render(<DesktopCanvasBar />));
  expect(container!.childElementCount).toBe(0);
});
it("窗口按钮不会启动拖动，空白处可拖动与双击最大化", async () => {
  await mount(); vi.mocked(controlWindow).mockClear();
  await act(async () => {
    const minimize = button("最小化");
    minimize.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
    minimize.click();
  });
  expect(vi.mocked(controlWindow).mock.calls).toEqual([["minimize"]]);
  const handle = container!.querySelector("header")!;
  await act(async () => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 })); });
  expect(controlWindow).toHaveBeenLastCalledWith("drag");
  await act(async () => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 })); });
  expect(controlWindow).toHaveBeenLastCalledWith("toggle-maximize");
});
it("窗口外部改变最大化状态时更新还原按钮，失败后保留可重试控件", async () => {
  await mount(); vi.mocked(controlWindow).mockResolvedValue({ maximized: true });
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(button("还原窗口")).not.toBeNull();
  vi.mocked(controlWindow).mockRejectedValue(new Error("offline"));
  await act(async () => button("还原窗口").click());
  expect(container!.textContent).toContain("窗口操作失败，请重试");
  expect(button("还原窗口").disabled).toBe(false);
  expect(button("刷新页面")).not.toBeNull();
});
