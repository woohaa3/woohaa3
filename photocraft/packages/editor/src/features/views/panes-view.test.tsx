/** @vitest-environment jsdom */
/**
 * 并排窗格容器的输入归属回归（U72）。
 *
 * 只测布局层的契约：两块画布都真实渲染并都能接收手势；按在非活动窗格上时先切换归属，且这次
 * 按下不再落笔（否则一次点击会同时激活和画一笔）。像素与内核事务在 Rust/WASM 侧验证。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ViewPanes } from "./panes-view.js";
import type { CanvasPane } from "./panes.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });

const panes: CanvasPane[] = [
  { id: "view-1", label: "视图 1", active: true },
  { id: "view-2", label: "视图 2", active: false },
];

function render(onActivate = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const received: { id: string; active: boolean }[] = [];
  const painted: string[] = [];
  act(() => root!.render(
    <ViewPanes
      panes={panes}
      onActivate={onActivate}
      renderPane={(pane, active) => {
        received.push({ id: pane.id, active });
        // 画布替身：只有真的收到按下才算「落笔」。
        return <div data-canvas={pane.id} onPointerDown={() => painted.push(pane.id)} />;
      }}
    />,
  ));
  return { container, onActivate, received, painted };
}

it("两个视图都渲染成真实画布，各自绑定自己的视图与归属", () => {
  const { container, received } = render();
  expect(container.querySelectorAll("[data-view-pane]")).toHaveLength(2);
  // 两块画布都真的渲染出来（并排不是缩略图），归属分别由调用方按视图决定。
  expect(received).toEqual([
    { id: "view-1", active: true },
    { id: "view-2", active: false },
  ]);
  expect(container.querySelector('[data-view-pane="view-1"]')!.getAttribute("data-view-pane-active")).toBe("true");
  expect(container.querySelector('[data-view-pane="view-2"]')!.getAttribute("data-view-pane-active")).toBeNull();
});

it("按在非活动窗格上先切换归属，这次按下不落笔", () => {
  const { container, onActivate, painted } = render();
  const idle = container.querySelector('[data-canvas="view-2"]') as HTMLElement;
  act(() => {
    idle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onActivate).toHaveBeenCalledWith("view-2");
  expect(painted).toEqual([]);
});

it("活动窗格原样接收按下：第一笔不会被吞掉", () => {
  const { container, onActivate, painted } = render();
  const active = container.querySelector('[data-canvas="view-1"]') as HTMLElement;
  act(() => {
    active.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  expect(onActivate).not.toHaveBeenCalled();
  expect(painted).toEqual(["view-1"]);
});

it("窗格标签来自内核视图名，并标出当前输入归属", () => {
  const { container } = render();
  const labels = [...container.querySelectorAll(".photo-editor__pane-label")].map((node) => node.textContent ?? "");
  expect(labels[0]).toContain("视图 1");
  expect(labels[0]).toContain("活动");
  expect(labels[1]).toContain("视图 2");
  expect(labels[1]).toContain("点击激活");
});
