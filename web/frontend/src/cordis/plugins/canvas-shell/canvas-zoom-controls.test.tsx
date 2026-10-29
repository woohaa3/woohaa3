/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasZoomControls } from "./canvas-zoom-controls.js";
import type { InteractionController } from "./interaction-controller.js";
import { UiProvider } from "@woohaa3/ui/primitives";

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
    zoomTo: vi.fn(),
    zoomBy: vi.fn()
  } as unknown as InteractionController & {
    zoomTo: ReturnType<typeof vi.fn>;
    zoomBy: ReturnType<typeof vi.fn>;
  };
}

describe("CanvasZoomControls（任务 3.1）", () => {
  it("渲染窄竖向缩放条：百分比、滑杆与上下叠放的放大/缩小", () => {
    const html = renderToStaticMarkup(<CanvasZoomControls getController={() => null} revision={0} />);
    expect(html).toContain("canvas-zoom__value");
    expect(html).toContain("canvas-zoom__slider-track");
    expect(html).toContain('type="range"');
    expect(html).toContain("canvas-zoom__slider");
    expect(html).toContain('aria-label="放大"');
    expect(html).toContain('aria-label="缩小"');
    expect(html).toContain("canvas-zoom__step--in");
    expect(html).toContain("canvas-zoom__step--out");
    // 适合屏幕在小地图悬停边缘，不放进缩放条。
    expect(html).not.toContain("适合屏幕");
  });

  it("放大/缩小步进经 InteractionController 提交", () => {
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
    click("放大");
    click("缩小");
    expect(controller.zoomBy).toHaveBeenNthCalledWith(1, 1.2);
    expect(controller.zoomBy).toHaveBeenNthCalledWith(2, 1 / 1.2);
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
