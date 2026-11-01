/**
 * 悬停胶囊「添加到对话框」组件测试
 * （参考稿：指针停在图片上时卡片下缘浮出大胶囊，不再依赖「先选中卡片」）。
 *
 * 覆盖两条容易坏的路径：
 * 1. 指针移进胶囊会让画布补发 `pointerleave` 并清空 hover —— 胶囊必须留在原位；
 * 2. 点胶囊等同选中该卡片（面板内容跟随 selection）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mocks = {
  selectNode: vi.fn(() => true),
  writable: true,
  nodeScreenRect: vi.fn(() => ({ left: 100, top: 50, width: 400, height: 300 })),
  mode: { type: "overview" }
};

/**
 * 订阅快照必须是**稳定引用**（与真实 store 一致：`getSnapshot` 返回同一个对象直到状态变化）。
 * 每次调用新建对象会让 `useSyncExternalStore` 判定「变了」而无限重渲染。
 */
const canvasSnapshot = {
  document: { nodes: [{ id: "img", type: "image" }, { id: "grp", type: "group" }] }
};
/** 同上：只在 `mocks.mode` 换引用时重建，其余时刻返回同一个对象。 */
let navigationCache = { mode: mocks.mode };
const navigationSnapshot = () => {
  if (navigationCache.mode !== mocks.mode) navigationCache = { mode: mocks.mode };
  return navigationCache;
};
/** 会话状态同样要稳定引用（组件订阅它只是为了在可写性变化时重渲染）。 */
const sessionStatusCache = { phase: "ready", error: null, hydrated: true, remote: {} };
const sessionStatusSnapshot = () => sessionStatusCache;

const services = {
  canvasRuntime: {
    controller: () => ({ selectNode: mocks.selectNode }),
    nodeScreenRect: mocks.nodeScreenRect,
    subscribeViewport: () => () => undefined,
    viewportVersion: () => 0
  },
  canvasNavigation: {
    getSnapshot: navigationSnapshot,
    subscribe: () => () => undefined
  },
  canvasState: {
    getCanvas: () => canvasSnapshot,
    getWorkingCanvas: () => null,
    subscribe: () => () => undefined
  },
  canvasSession: {
    isWritable: () => mocks.writable,
    getStatus: () => sessionStatusSnapshot(),
    subscribe: () => () => undefined
  }
} as Record<string, unknown>;

vi.mock("../../react.js", () => ({ useService: (key: string) => services[key] }));

const { hoverNodeStore } = await import("../../services/hover-store.js");
const { HoverComposerButton } = await import("./hover-composer-button.js");

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
  hoverNodeStore.reset();
  mocks.selectNode.mockClear();
  mocks.writable = true;
  mocks.mode = { type: "overview" };
  vi.useRealTimers();
});

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => { root.render(<HoverComposerButton />); });
  return container;
}

const pill = (container: HTMLElement) => container.querySelector<HTMLElement>(".hover-composer");

describe("悬停胶囊「添加到对话框」", () => {
  it("没有悬停节点时不渲染", () => {
    expect(pill(render())).toBeNull();
  });

  it("悬停图片时在卡片下缘浮出，点它选中该卡片", () => {
    const container = render();
    act(() => { hoverNodeStore.setNodeId("img"); });
    const element = pill(container)!;
    expect(element).not.toBeNull();
    expect(element.textContent).toContain("添加到对话框");
    // 浮在卡片下方外侧：top = 50 + 300 + 8（不压卡片底部，历史条/抓手仍可点）
    expect(element.style.top).toBe("358px");
    act(() => { element.querySelector("button")!.click(); });
    expect(mocks.selectNode).toHaveBeenCalledWith("img");
  });

  it("指针移进胶囊（画布清空 hover）后胶囊仍在，延迟到点才收", () => {
    vi.useFakeTimers();
    const container = render();
    act(() => { hoverNodeStore.setNodeId("img"); });
    // 画布补发 pointerleave 的等价效果。
    act(() => { hoverNodeStore.setNodeId(null); });
    expect(pill(container)).not.toBeNull();
    // 指针落到胶囊上：取消这次收起。
    // React 的 `onPointerEnter` 由冒泡的 `pointerover` 派生，直接派发 `pointerenter` 不触发它。
    act(() => {
      pill(container)!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    act(() => { vi.advanceTimersByTime(500); });
    expect(pill(container)).not.toBeNull();
  });

  it("离开卡片且没进胶囊时延迟收起", () => {
    vi.useFakeTimers();
    const container = render();
    act(() => { hoverNodeStore.setNodeId("img"); });
    act(() => { hoverNodeStore.setNodeId(null); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(pill(container)).toBeNull();
  });

  it("分组节点不浮出，换成图片后浮出", () => {
    const container = render();
    act(() => { hoverNodeStore.setNodeId("grp"); });
    expect(pill(container)).toBeNull();

    act(() => { hoverNodeStore.setNodeId("img"); });
    expect(pill(container)).not.toBeNull();
  });

  it("聚焦工作区里不浮出", () => {
    const container = render();
    act(() => { hoverNodeStore.setNodeId("img"); });
    expect(pill(container)).not.toBeNull();

    mocks.mode = { type: "node-focus" };
    // 状态变化通过 navigation 订阅通知；测试桩不广播，换悬停节点触发一次重渲染。
    act(() => {
      hoverNodeStore.setNodeId(null);
      hoverNodeStore.setNodeId("img");
    });
    expect(pill(container)).toBeNull();
  });

  it("只读画布仍浮出，按钮禁用、带原因提示且点击不选中", () => {
    mocks.writable = false;
    const container = render();
    act(() => { hoverNodeStore.setNodeId("img"); });
    const button = pill(container)!.querySelector("button")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // 只置灰不说明原因等于静默失败：保留旧横条动作的 reason。
    expect(button.getAttribute("title")).toContain("只读");
    act(() => { button.click(); });
    expect(mocks.selectNode).not.toHaveBeenCalled();
  });
});
