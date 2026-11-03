/**
 * 卡片右侧版本缩略图列表：最新在上、缩略图地址、点击发出选择请求、位置翻转。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = {
  nodeScreenRect: vi.fn((_nodeId: string) => ({ left: 100, top: 50, width: 400, height: 300 }) as { left: number; top: number; width: number; height: number } | null)
};

const services = {
  canvasRuntime: {
    nodeScreenRect: (nodeId: string) => mocks.nodeScreenRect(nodeId),
    subscribeViewport: () => () => undefined,
    viewportVersion: () => 0,
    subscribeFrame: () => () => undefined,
    subscribeScene: () => () => undefined
  }
} as Record<string, unknown>;

vi.mock("../../react.js", () => ({ useService: (key: string) => services[key] }));

const { historyLayersStore } = await import("../../services/history-layers-store.js");
const { HistoryLayersOverlay, layersColumnPosition, MAX_VISIBLE_LAYERS } = await import("./history-layers-overlay.js");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
  historyLayersStore.reset();
  mocks.nodeScreenRect.mockImplementation(() => ({ left: 100, top: 50, width: 400, height: 300 }));
});

const layer = (presentationId: string, extra: Record<string, unknown> = {}) => ({
  state: "succeeded" as const,
  current: false,
  presentationId,
  entryId: `entry-${presentationId}`,
  operationId: `op-${presentationId}`,
  ...extra
});

function publish(nodeId: string, layers: ReturnType<typeof layer>[], truncated = 0) {
  act(() => {
    historyLayersStore.replace(new Map([[nodeId, { layers, truncated }]]));
  });
}

function render(onSelect = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  const previewUrl = vi.fn((input: { entryId: string }) => `/thumb/${input.entryId}`);
  act(() => {
    root.render(<HistoryLayersOverlay canvasId={() => "canvas-1"} previewUrl={previewUrl as never} onSelect={onSelect} />);
  });
  return { container, onSelect, previewUrl };
}

describe("版本缩略图列表", () => {
  it("没有版本数据时不渲染", () => {
    expect(render().container.querySelector(".history-layers")).toBeNull();
  });

  it("放在卡片右侧外面、顶端对齐；最新的在最上面；成功版本带缩略图地址", () => {
    const { container, previewUrl } = render();
    publish("img", [layer("old"), layer("mid"), layer("new", { current: true })]);
    const column = container.querySelector<HTMLElement>(".history-layers")!;
    // 卡片 left 100 + width 400 + 间距 8
    expect(column.style.left).toBe("508px");
    expect(column.style.top).toBe("50px");
    const buttons = [...column.querySelectorAll<HTMLElement>(".history-layer")];
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.querySelector("img")!.getAttribute("src")).toBe("/thumb/entry-new");
    expect(buttons[0]!.dataset.current).toBe("true");
    expect(buttons[2]!.querySelector("img")!.getAttribute("src")).toBe("/thumb/entry-old");
    expect(previewUrl).toHaveBeenCalledWith({ canvasId: "canvas-1", nodeId: "img", entryId: "entry-new", variant: "thumbnail" });
  });

  it("点击发出选择请求（presentationId / entryId / operationId）", () => {
    const { container, onSelect } = render();
    publish("img", [layer("old"), layer("new")]);
    const buttons = container.querySelectorAll<HTMLElement>(".history-layer");
    act(() => { buttons[1]!.click(); });
    expect(onSelect).toHaveBeenCalledWith({ nodeId: "img", presentationId: "old", entryId: "entry-old", operationId: "op-old" });
  });

  it("运行中没有缩略图只转圈，失败显示标记；不渲染 img", () => {
    const { container } = render();
    publish("img", [layer("done"), layer("run", { state: "running", entryId: undefined }), layer("bad", { state: "failed", entryId: undefined })]);
    const buttons = [...container.querySelectorAll<HTMLElement>(".history-layer")];
    expect(buttons.map((button) => button.dataset.state)).toEqual(["failed", "running", "succeeded"]);
    expect(buttons[0]!.querySelector("img")).toBeNull();
    expect(buttons[1]!.querySelector("img")).toBeNull();
    expect(buttons[0]!.textContent).toBe("!");
  });

  it("超过上限的折成「+N」，并计入被折叠的较早记录", () => {
    const { container } = render();
    const many = Array.from({ length: MAX_VISIBLE_LAYERS + 2 }, (_, index) => layer(`v${index}`));
    publish("img", many, 3);
    expect(container.querySelectorAll(".history-layer")).toHaveLength(MAX_VISIBLE_LAYERS);
    expect(container.querySelector(".history-layers__more")!.textContent).toBe("+5");
  });

  it("卡片缩得太小或量不到矩形时不画", () => {
    const { container } = render();
    mocks.nodeScreenRect.mockImplementation(() => ({ left: 0, top: 0, width: 40, height: 30 }));
    publish("img", [layer("a"), layer("b")]);
    expect(container.querySelector(".history-layers")).toBeNull();
    mocks.nodeScreenRect.mockImplementation(() => null);
    publish("img", [layer("a"), layer("c")]);
    expect(container.querySelector(".history-layers")).toBeNull();
  });
});

describe("layersColumnPosition", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };

  it("右侧放得下就放右侧", () => {
    expect(layersColumnPosition(rect, 1200)).toEqual({ left: 508, top: 50 });
  });

  it("贴着视口右缘放不下就翻到左侧", () => {
    expect(layersColumnPosition(rect, 540)).toEqual({ left: 100 - 8 - 40, top: 50 });
  });

  it("量不到视口宽度（0）时不翻转", () => {
    expect(layersColumnPosition(rect, 0)).toEqual({ left: 508, top: 50 });
  });
});
