/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { CanvasMinimap } from "./canvas-minimap.js";
import { fitMinimapTransform, minimapPointToWorld, viewportCenteredOn } from "./minimap-projection.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionController } from "./interaction-controller.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
  woohaa3CanvasStore.setState({ canvas: null, working: null });
  nodeSelectionStore.reset();
});

function canvas(nodes: Array<{ id: string; type: string; x: number; y: number }>): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: { x: node.x, y: node.y }
      }))
    },
    nodeData: { model: { title: "积木小屋" } } as ServerCanvas["nodeData"]
  };
}

function makeController() {
  return {
    viewport: () => ({ x: 0, y: 0, zoom: 1 }),
    surface: () => ({ width: 800, height: 600 }),
    subscribeViewport: () => () => undefined,
    restoreViewport: vi.fn(),
    zoomToFit: vi.fn()
  } as unknown as InteractionController & {
    restoreViewport: ReturnType<typeof vi.fn>;
    zoomToFit: ReturnType<typeof vi.fn>;
  };
}

function mount(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(ui);
  });
  return container;
}

describe("CanvasMinimap（2026-10-26）", () => {
  it("渲染全部可见节点、连线、视口框与 3D 节点的小方块缩略图", () => {
    woohaa3CanvasStore.getState().hydrate(canvas([
      { id: "image", type: "image", x: 0, y: 0 },
      { id: "model", type: "model3d", x: 320, y: 40 }
    ]));
    const controller = makeController();
    const container = mount(<CanvasMinimap getController={() => controller} revision={0} />);
    expect(container.querySelectorAll(".canvas-minimap__node")).toHaveLength(2);
    expect(container.querySelectorAll(".canvas-minimap__node--model")).toHaveLength(1);
    expect(container.querySelector(".canvas-minimap__block-top")).not.toBeNull();
    expect(container.querySelector(".canvas-minimap__viewport-rect")).not.toBeNull();
    expect(container.textContent).toContain("积木小屋");
  });

  it("空画布只显示空状态，不画视口框", () => {
    woohaa3CanvasStore.getState().hydrate(canvas([]));
    const container = mount(<CanvasMinimap getController={() => makeController()} revision={0} />);
    expect(container.querySelectorAll(".canvas-minimap__node")).toHaveLength(0);
    expect(container.querySelector(".canvas-minimap__empty")?.textContent).toContain("画布还没有节点");
    // 空画布上视口覆盖整个可见范围，画出满框的强调色边框只会像装饰，不提供信息。
    expect(container.querySelector(".canvas-minimap__viewport-rect")).toBeNull();
  });

  it("没有标题与节点计数，边缘按钮提供收起与适合屏幕", () => {
    woohaa3CanvasStore.getState().hydrate(canvas([{ id: "image", type: "image", x: 0, y: 0 }]));
    const onCollapse = vi.fn();
    const container = mount(
      <CanvasMinimap getController={() => makeController()} revision={0} onCollapse={onCollapse} />
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".canvas-minimap__header")).toBeNull();
    expect(container.textContent).not.toContain("小地图");
    expect(container.textContent).not.toContain("个节点");
    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="收起小地图"]');
    expect(collapse).not.toBeNull();
    act(() => collapse!.click());
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="适合屏幕"]')).not.toBeNull();
  });

  it("悬停边缘的适合屏幕按钮经同一控制器适配画面", () => {
    woohaa3CanvasStore.getState().hydrate(canvas([{ id: "image", type: "image", x: 0, y: 0 }]));
    const controller = makeController();
    const container = mount(<CanvasMinimap getController={() => controller} revision={0} />);
    const fit = container.querySelector<HTMLButtonElement>('button[aria-label="适合屏幕"]');
    expect(fit).not.toBeNull();
    act(() => fit!.click());
    expect(controller.zoomToFit).toHaveBeenCalledTimes(1);
  });

  it("点击小地图把对应世界点移到画布中心并保持缩放", () => {
    woohaa3CanvasStore.getState().hydrate(canvas([{ id: "image", type: "image", x: 0, y: 0 }]));
    const controller = makeController();
    const container = mount(<CanvasMinimap getController={() => controller} revision={0} />);
    const svg = container.querySelector<SVGSVGElement>(".canvas-minimap__svg")!;
    svg.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 216,
      bottom: 136,
      width: 216,
      height: 136,
      toJSON: () => ({})
    });
    // 单节点包围盒 248×232 等比放进 216×136（padding 8）后的映射。
    const transform = fitMinimapTransform({ x: 0, y: 0, width: 248, height: 232 }, null, 216, 136, 8);
    const world = minimapPointToWorld({ x: 108, y: 68 }, transform);
    const expected = viewportCenteredOn(world, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
    act(() => {
      svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 108, clientY: 68, button: 0 }));
    });
    expect(controller.restoreViewport).toHaveBeenCalledTimes(1);
    const next = controller.restoreViewport.mock.calls[0]![0] as { x: number; y: number; zoom: number };
    expect(next.x).toBeCloseTo(expected.x, 5);
    expect(next.y).toBeCloseTo(expected.y, 5);
    expect(next.zoom).toBe(1);
  });
});
