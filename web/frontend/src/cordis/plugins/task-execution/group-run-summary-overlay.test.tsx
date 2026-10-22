/**
 * 分组批量执行结果摘要 overlay 渲染测试
 * （change: 2026-10-16-add-group-selection-toolbar，任务 4.1 / design D6）。
 *
 * 关键回归：`GroupRunSummaryStore` 的快照读取必须绑定 `this`。React 以裸函数引用调用
 * `useSyncExternalStore` 的 `getSnapshot`，若它是普通方法（非箭头属性）会丢失 `this`，
 * 挂载即抛 `Cannot read properties of undefined (reading 'state')`。此处直接渲染 overlay，
 * 覆盖该订阅路径。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GroupRunSummaryOverlay } from "./group-run-summary-overlay.js";
import { GroupRunSummaryStore } from "./group-run-actions.js";

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

const SUMMARY = {
  groupId: "g",
  accepted: ["a"],
  skipped: [{ nodeId: "b", reason: "缺提示词" }],
  failed: []
};

describe("GroupRunSummaryOverlay（任务 4.1）", () => {
  it("空摘要时渲染为空且不因未绑定 getState 抛错", () => {
    const store = new GroupRunSummaryStore();
    const container = render(<GroupRunSummaryOverlay store={store} />);
    expect(container.querySelector('[data-testid="group-run-summary"]')).toBeNull();
  });

  it("有摘要时显示三类计数，不把受理显示为生成完成", () => {
    const store = new GroupRunSummaryStore();
    store.show({ canvasId: "c1", summary: SUMMARY });
    const container = render(<GroupRunSummaryOverlay store={store} />);
    const text = container.querySelector('[data-testid="group-run-summary"]')!.textContent ?? "";
    expect(text).toContain("已提交 1 项，跳过 1 项，失败 0 项");
    expect(text).not.toContain("生成完成");
  });

  it("挂载后 store 更新触发重渲染", () => {
    const store = new GroupRunSummaryStore();
    const container = render(<GroupRunSummaryOverlay store={store} />);
    act(() => {
      store.show({ canvasId: "c1", summary: { groupId: "h", accepted: [], skipped: [], failed: [{ nodeId: "n", error: "网络错误" }] } });
    });
    const text = container.querySelector('[data-testid="group-run-summary"]')!.textContent ?? "";
    expect(text).toContain("已提交 0 项，跳过 0 项，失败 1 项");
  });

  it("dismiss 后 overlay 隐藏", () => {
    const store = new GroupRunSummaryStore();
    store.show({ canvasId: "c1", summary: SUMMARY });
    const container = render(<GroupRunSummaryOverlay store={store} />);
    act(() => {
      store.dismiss();
    });
    expect(container.querySelector('[data-testid="group-run-summary"]')).toBeNull();
  });
});
