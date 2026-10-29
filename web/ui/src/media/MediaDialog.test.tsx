/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaDialog, type MediaDialogProps } from "./MediaDialog.js";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(props: Partial<MediaDialogProps> = {}) {
  act(() => root.render(<MediaDialog instanceId="preview" title="图片" url="/fixture.png" onClose={vi.fn()} {...props} />));
}
function click(label: string) { act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()); }
function pointer(type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  act(() => host.querySelector(".dlg__media-viewport")!.dispatchEvent(event));
}
it("zooms with bounded controls/wheel, pans only the active pointer, and resets both", () => {
  render();
  const media = host.querySelector<HTMLImageElement>("img")!;
  click("放大"); expect(media.style.transform).toContain("scale(1.12)");
  pointer("pointerdown", 10, 20); pointer("pointermove", 90, 90, 2);
  expect(media.style.transform).toContain("translate(0px, 0px)");
  pointer("pointermove", 40, 70); pointer("pointerup", 40, 70); pointer("pointermove", 100, 100);
  expect(media.style.transform).toContain("translate(30px, 50px)");
  act(() => host.querySelector(".dlg__media-viewport")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -10 })));
  expect(media.style.transform).toContain("scale(1.2544");
  act(() => { for (let i = 0; i < 50; i++) host.querySelector<HTMLButtonElement>('button[aria-label="放大"]')!.click(); });
  expect(media.style.transform).toContain("scale(5)");
  act(() => { for (let i = 0; i < 80; i++) host.querySelector<HTMLButtonElement>('button[aria-label="缩小"]')!.click(); });
  expect(media.style.transform).toContain("scale(0.25)");
  click("适应屏幕并重置"); expect(media.style.transform).toBe("translate(0px, 0px) scale(1)");
});
it("renders unavailable diagnostics with one close request and no stale media controls", () => {
  const close = vi.fn(); render(); render({ url: null, unavailableReason: "来源已失效", onClose: close });
  expect(host.textContent).toContain("来源已失效");
  expect(host.querySelector("img, video, audio, .dlg__media-viewport")).toBeNull();
  click("关闭"); expect(close).toHaveBeenCalledOnce();
});
