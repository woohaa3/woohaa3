/**
 * 查找作品面板组件测试（change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { CanvasSearchPanel } from "./CanvasSearchPanel.js";
import { CanvasSearchStore } from "../services/canvas-search-store.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-09T00:00:00.000Z";

function canvas(): ServerCanvas {
  const value = createEmptyWoohaa3ServerCanvas("c1", NOW);
  value.document.nodes = [
    { id: "img-aaaa", type: "image", position: { x: 0, y: 0 } },
    { id: "img-bbbb", type: "image", position: { x: 300, y: 0 } },
    { id: "vid-cccc", type: "video", position: { x: 600, y: 0 } }
  ];
  value.nodeData = { "img-aaaa": { title: "海边日落" }, "img-bbbb": { title: "海边日落" }, "vid-cccc": { title: "开场镜头" } };
  return value;
}

function mount(store: CanvasSearchStore, onLocate: (nodeId: string) => { ok: boolean; reason?: string } = () => ({ ok: true })) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CanvasSearchPanel store={store} getCanvas={canvas} onLocate={onLocate} />));
  return { container, root };
}

describe("CanvasSearchPanel", () => {
  it("关闭时不渲染", () => {
    const store = new CanvasSearchStore();
    const { container } = mount(store);
    expect(container.querySelector('[data-testid="canvas-search"]')).toBeNull();
  });

  it("打开后渲染筛选、结果与同名区分", () => {
    const store = new CanvasSearchStore();
    store.open();
    const { container } = mount(store);
    expect(container.querySelector('[data-testid="canvas-search"]')).not.toBeNull();
    expect(container.textContent).toContain("海边日落");
    expect(container.textContent).toContain("开场镜头");
    // 同名用短 ID 区分。
    expect(container.textContent).toContain("aaaa");
    expect(container.textContent).toContain("bbbb");
  });

  it("按查询过滤并可点击定位", () => {
    const store = new CanvasSearchStore();
    store.open();
    store.setQuery("开场");
    const located: string[] = [];
    const { container } = mount(store, (nodeId) => { located.push(nodeId); return { ok: true }; });
    expect(container.textContent).toContain("开场镜头");
    expect(container.textContent).not.toContain("海边日落");
    const result = container.querySelector(".canvas-search__result") as HTMLElement;
    act(() => result.click());
    expect(located).toEqual(["vid-cccc"]);
  });

  it("无结果显示空态提示", () => {
    const store = new CanvasSearchStore();
    store.open();
    store.setQuery("不存在");
    const { container } = mount(store);
    expect(container.textContent).toContain("没有找到匹配的作品");
  });

  it("定位失效时显示原因", () => {
    const store = new CanvasSearchStore();
    store.open();
    const { container } = mount(store, () => ({ ok: false, reason: "目标作品已不存在" }));
    const result = container.querySelector(".canvas-search__result") as HTMLElement;
    act(() => result.click());
    expect(container.textContent).toContain("目标作品已不存在");
  });

  it("Escape 关闭并请求恢复焦点", () => {
    const store = new CanvasSearchStore();
    store.open();
    let restored = false;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<CanvasSearchPanel store={store} getCanvas={canvas} onLocate={() => ({ ok: true })} onRequestFocusRestore={() => { restored = true; }} />));
    const input = container.querySelector("input")!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(store.getSnapshot().open).toBe(false);
    expect(restored).toBe(true);
  });
});
