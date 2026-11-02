/**
 * 贴底常驻条的行为：默认收起、点一下展开、位置由 `layoutDockedPanel` 算。
 *
 * 这里用 jsdom + 手工矩形桩验证**表面**，不验证展开后的面板内容（那部分由各面板自己的测试覆盖）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExecutionPanelSurface } from "./execution-panel-surface.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;
let canvas: HTMLDivElement;

/** jsdom 没有布局，`getBoundingClientRect` 恒为 0；给画布一个固定的可用区域。 */
function stubCanvasRect() {
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
      right: 1000,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  canvas = document.createElement("div");
  canvas.id = "bevy-canvas";
  document.body.append(canvas);
  stubCanvasRect();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  canvas.remove();
});

function renderSurface(presentation: "compact" | "expanded", child: React.ReactNode, collapsible = true) {
  act(() => {
    root = createRoot(container);
    root.render(
      <ExecutionPanelSurface nodeId="node-1" presentation={presentation} collapsible={collapsible}>
        {child}
      </ExecutionPanelSurface>
    );
  });
  return container;
}

describe("贴底常驻条", () => {
  it("生成面板（collapsible）默认收成一条，不直接把面板展开", () => {
    const host = renderSurface("compact", <div data-testid="full">完整面板</div>);
    expect(host.querySelector(".node-execution-bar-dock")).not.toBeNull();
    expect(host.querySelector(".node-execution-bar-dock")!.getAttribute("data-collapsed")).toBe("true");
  });

  it("参数类面板（非 collapsible）始终完整显示，不会变成一条空条", () => {
    const host = renderSurface("compact", <div>参数面板</div>, false);
    const dock = host.querySelector(".node-execution-bar-dock")!;
    expect(dock.getAttribute("data-collapsed")).toBeNull();
    expect(dock.textContent).toContain("参数面板");
  });

  it("按可用区域贴底居中，并让出底部 16px", async () => {
    const host = renderSurface("compact", <div style={{ height: 200 }}>面板</div>);
    const dock = host.querySelector<HTMLElement>(".node-execution-bar-dock")!;
    // 布局在 rAF 里写，等两帧。
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(dock.style.position).toBe("fixed");
    expect(dock.style.visibility).toBe("visible");
    expect(Number.parseFloat(dock.style.top)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(dock.style.top)).toBeLessThan(800);
    // 居中：左右留白相等。
    const left = Number.parseFloat(dock.style.left);
    const width = Number.parseFloat(dock.style.width);
    expect(Math.abs(left - (1000 - width - left))).toBeLessThan(1.5);
  });

  it("量高度前放开 maxHeight：旧上限不会把展开后变高的面板截断", async () => {
    const host = renderSurface("compact", <div style={{ height: 64 }}>面板</div>);
    const dock = host.querySelector<HTMLElement>(".node-execution-bar-dock")!;
    // 模拟上一帧遗留的小上限（收起时一行高）。
    dock.style.maxHeight = "64px";
    let measuredWith = "";
    Object.defineProperty(dock, "offsetHeight", {
      configurable: true,
      get: () => {
        measuredWith = dock.style.maxHeight;
        return 300;
      },
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(measuredWith).toBe("none");
    // 重新写入的上限基于实测的 300，而不是遗留的 64。
    expect(Number.parseFloat(dock.style.maxHeight)).toBe(300);
  });

  it("画布区不存在时保持隐藏，不闪到左上角", () => {
    canvas.remove();
    const host = renderSurface("compact", <div>面板</div>);
    expect(host.querySelector<HTMLElement>(".node-execution-bar-dock")!.style.visibility).toBe("hidden");
  });

  it("expanded 面仍是全屏宿主，不出现常驻条", () => {
    const host = renderSurface("expanded", <div>面板</div>);
    expect(host.querySelector(".fullscreen-panel-host")).not.toBeNull();
    expect(host.querySelector(".node-execution-bar-dock")).toBeNull();
  });
});
