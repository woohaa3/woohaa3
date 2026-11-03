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
const { HistoryLayersOverlay, layerVariant, layersColumnPosition, MAX_VISIBLE_LAYERS } = await import("./history-layers-overlay.js");

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

function publish(nodeId: string, layers: ReturnType<typeof layer>[], truncated = 0, nodeType = "image") {
  act(() => {
    historyLayersStore.replace(new Map([[nodeId, { nodeType, layers, truncated }]]));
  });
}

function render(onSelect = vi.fn(), overrides: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  const previewUrl = vi.fn((input: { entryId: string }) => `/thumb/${input.entryId}`);
  act(() => {
    root.render(<HistoryLayersOverlay canvasId={() => "canvas-1"} previewUrl={previewUrl as never} onSelect={onSelect}
      getInput={() => undefined} assetUrl={() => null} modelLabel={(key) => key} onReedit={vi.fn()} {...(overrides as object)} />);
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
    expect(previewUrl).toHaveBeenCalledWith({ canvasId: "canvas-1", nodeId: "img", entryId: "entry-new", variant: "preview" });
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

describe("缩略图变体", () => {
  it("图片取 preview（302 到原图），视频取 poster；绝不用模型专用的 thumbnail", () => {
    expect(layerVariant("image")).toBe("preview");
    expect(layerVariant("video")).toBe("poster");
  });

  it("视频节点的列表项按 poster 请求图片", () => {
    const { container, previewUrl } = render();
    publish("vid", [layer("a")], 0, "video");
    expect(container.querySelector("img")).not.toBeNull();
    expect(previewUrl).toHaveBeenCalledWith({ canvasId: "canvas-1", nodeId: "vid", entryId: "entry-a", variant: "poster" });
  });
});

describe("当时的输入卡片", () => {
  const snapshot = {
    prompt: "变成夜景",
    modelKey: "ppserver:m1",
    references: [{ assetId: "asset-1", role: "reference_image" }, { assetId: "asset-gone", role: "reference_image" }],
    selfReferenceAssetId: "asset-1"
  };

  it("点成功版本的缩略图展开卡片，显示提示词、模型与参考图（已删除的标出来）；再点收起", () => {
    const { container } = render(vi.fn(), {
      getInput: (_nodeId: string, entryId: string) => (entryId === "entry-new" ? snapshot : undefined),
      assetUrl: (assetId: string) => (assetId === "asset-1" ? "/media/a1" : null),
      modelLabel: () => "全能生图 Pro"
    });
    publish("img", [layer("old"), layer("new")]);
    const buttons = container.querySelectorAll<HTMLElement>(".history-layer");
    act(() => { buttons[0]!.click(); });
    const card = container.querySelector<HTMLElement>(".history-input-card")!;
    expect(card.textContent).toContain("变成夜景");
    expect(card.textContent).toContain("全能生图 Pro");
    expect(card.querySelector("img")!.getAttribute("src")).toBe("/media/a1");
    expect(card.textContent).toContain("已删除");
    act(() => { buttons[0]!.click(); });
    expect(container.querySelector(".history-input-card")).toBeNull();
  });

  it("旧版本没有快照：只说明没有记录，不给重新编辑", () => {
    const { container } = render();
    publish("img", [layer("old")]);
    act(() => { container.querySelector<HTMLElement>(".history-layer")!.click(); });
    const card = container.querySelector<HTMLElement>(".history-input-card")!;
    expect(card.textContent).toContain("没有保存当时的输入");
    expect(card.textContent).not.toContain("重新编辑");
  });

  it("重新编辑把节点与快照交给回调并收起卡片；失败版本不展开", () => {
    const onReedit = vi.fn();
    const { container } = render(vi.fn(), { getInput: () => snapshot, onReedit });
    publish("img", [layer("bad", { state: "failed", entryId: undefined }), layer("ok")]);
    const buttons = container.querySelectorAll<HTMLElement>(".history-layer");
    act(() => { buttons[1]!.click(); });
    expect(container.querySelector(".history-input-card")).toBeNull();
    act(() => { buttons[0]!.click(); });
    const edit = [...container.querySelectorAll<HTMLElement>(".history-input-card__button")].find((b) => b.textContent === "重新编辑")!;
    act(() => { edit.click(); });
    expect(onReedit).toHaveBeenCalledWith("img", snapshot);
    expect(container.querySelector(".history-input-card")).toBeNull();
  });
});
