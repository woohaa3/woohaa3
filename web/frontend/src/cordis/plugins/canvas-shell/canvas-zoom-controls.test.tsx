/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasZoomControls } from "./canvas-zoom-controls.js";
import type { InteractionController } from "./interaction-controller.js";
import { UiProvider } from "../../../shared/ui/UiProvider.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(ui);
  });
  return container;
}

function makeController() {
  return {
    viewport: () => ({ zoom: 1 }),
    subscribeViewport: () => () => undefined,
    zoomBy: vi.fn(),
    zoomTo: vi.fn(),
    zoomToFit: vi.fn()
  } as unknown as InteractionController & {
    zoomBy: ReturnType<typeof vi.fn>;
    zoomTo: ReturnType<typeof vi.fn>;
    zoomToFit: ReturnType<typeof vi.fn>;
  };
}

describe("CanvasZoomControls（任务 3.1）", () => {
  it("渲染紧凑缩放控件：图标放大/缩小、滑杆、百分比、图标适合屏幕", () => {
    const html = renderToStaticMarkup(<CanvasZoomControls getController={() => null} revision={0} />);
    // IconButton 仍带无障碍名；可见说明改由共享 Tooltip 承载（不再是 title）。
    expect(html).toContain('aria-label="缩小"');
    expect(html).toContain('aria-label="放大"');
    expect(html).toContain('aria-label="适合屏幕"');
    expect(html).toContain('type="range"');
    expect(html).toContain("canvas-zoom__slider");
    expect(html).not.toContain(">适合屏幕<");
  });

  it("缩小/放大/适合屏幕经 InteractionController 提交，数值与调用次数不变", () => {
    const controller = makeController();
    const container = render(
      <UiProvider>
        <CanvasZoomControls getController={() => controller} revision={0} />
      </UiProvider>
    );
    const click = (label: string) => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
      expect(button).not.toBeNull();
      act(() => button.click());
    };
    click("缩小");
    click("放大");
    click("适合屏幕");
    expect(controller.zoomBy).toHaveBeenNthCalledWith(1, 1 / 1.2);
    expect(controller.zoomBy).toHaveBeenNthCalledWith(2, 1.2);
    expect(controller.zoomToFit).toHaveBeenCalledTimes(1);
  });

  it("滑杆仅调用一次 zoomTo 且百分比由受控缩放驱动", () => {
    const controller = makeController();
    const container = render(
      <UiProvider>
        <CanvasZoomControls getController={() => controller} revision={0} />
      </UiProvider>
    );
    const slider = container.querySelector<HTMLInputElement>(".canvas-zoom__slider")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(slider, "250");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(controller.zoomTo).toHaveBeenCalledWith(2.5);
    expect(controller.zoomTo).toHaveBeenCalledTimes(1);
  });
});
