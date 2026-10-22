/**
 * 任务列表行内「在画布中打开」入口测试（change: task-monitor-canvas-roundtrip）。
 *
 * 覆盖：只有带 canvasId 的行渲染入口；点击把 canvasId(+nodeId) 交给导航；无导航回调时不渲染。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TaskTable } from "./list-panels.js";
import type { MonitorItem } from "./monitor-model.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-10-20T10:00:00.000Z";
const roots = new Set<Root>();

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

function item(overrides: Partial<MonitorItem> = {}): MonitorItem {
  return {
    taskKey: "task-1",
    state: "succeeded",
    providerId: "ark",
    providerName: "Ark",
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: NOW,
    durationMs: 1200,
    recordRevision: 1,
    events: [],
    ...overrides
  };
}

function renderTable(
  items: MonitorItem[],
  onOpenCanvas?: (input: { canvasId: string; nodeId?: string }) => void
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  act(() => {
    root.render(
      <TaskTable
        items={items}
        nowMs={Date.parse(NOW)}
        onSelect={() => undefined}
        {...(onOpenCanvas ? { onOpenCanvas } : {})}
      />
    );
  });
  return container;
}

function openCanvasButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("在画布中打开"));
}

describe("任务列表行内画布入口", () => {
  it("仅当行带 canvasId 时渲染「在画布中打开」", () => {
    const container = renderTable(
      [item({ taskKey: "t1", canvasId: "c1", nodeId: "n1" }), item({ taskKey: "t2" })],
      () => undefined
    );
    expect(openCanvasButtons(container)).toHaveLength(1);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[1]!.textContent).not.toContain("在画布中打开");
  });

  it("点击分别把 canvasId(+nodeId) 交给导航", () => {
    const calls: Array<{ canvasId: string; nodeId?: string }> = [];
    const container = renderTable(
      [
        item({ taskKey: "t1", canvasId: "c1", nodeId: "n1" }),
        item({ taskKey: "t2", canvasId: "c2" })
      ],
      (input) => calls.push(input)
    );
    act(() => openCanvasButtons(container)[0]!.click());
    act(() => openCanvasButtons(container)[1]!.click());
    expect(calls).toEqual([{ canvasId: "c1", nodeId: "n1" }, { canvasId: "c2" }]);
  });

  it("没有导航回调时保留「查看详情」但不渲染画布入口", () => {
    const container = renderTable([item({ taskKey: "t1", canvasId: "c1" })]);
    expect(openCanvasButtons(container)).toHaveLength(0);
    expect(container.textContent).toContain("查看详情");
  });
});
