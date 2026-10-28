/**
 * 节点历史抽屉的退出与缩略图回归（2026-10-24 审片 A3 / A10）。
 *
 * - A10：抽屉盖住「返回」时，Esc 必须能收掉抽屉（此前 Esc 只会退出整个聚焦）。
 * - A3：「当前版本」项必须有缩略图，不能固定是空白格。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NodeHistoryPanel } from "./panel.js";
import { NodeHistoryController, type NodeHistoryClient } from "./controller.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE_ITEM = {
  entryId: "e1",
  kind: "image" as const,
  createdAt: "2026-10-24T05:52:55.000Z",
  outcome: "succeeded" as const,
  current: true,
  recoverable: true,
  previewable: true,
  source: { label: "图片生成" },
  preview: { kind: "image" as const, href: "/api/canvas-node-history/c/n1/e1/preview" }
};

const EMPTY_ITEM = {
  ...IMAGE_ITEM,
  entryId: "e2",
  current: false,
  preview: { kind: "image" as const, href: "/api/canvas-node-history/c/n1/e2/preview" }
};

async function mount(options: { items?: unknown[]; onClose?: () => void; onRefreshCurrent?: () => void } = {}) {
  const client: NodeHistoryClient = {
    list: async () => ({ ok: true, items: (options.items ?? [IMAGE_ITEM, EMPTY_ITEM]) as never, nextCursor: null }),
    detail: async () => ({ ok: false, code: "not-found", error: "no" }),
    apply: async () => ({ ok: true }),
    previewUrl: () => "/preview"
  };
  const controller = new NodeHistoryController(client);
  await controller.open({ canvasId: "c", nodeId: "n1", kind: "image", writable: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <NodeHistoryPanel
        controller={controller}
        writable
        {...(options.onClose ? { onClose: options.onClose } : {})}
        {...(options.onRefreshCurrent ? { onRefreshCurrent: options.onRefreshCurrent } : {})}
      />
    );
  });
  return {
    container,
    controller,
    root,
    unmount: () => act(() => root.unmount())
  };
}

describe("节点历史抽屉", () => {
  it("打开时立即刷新草稿状态，并短周期重读以覆盖并排编辑", async () => {
    vi.useFakeTimers();
    try {
      const onRefreshCurrent = vi.fn();
      const mounted = await mount({ onRefreshCurrent });
      expect(onRefreshCurrent).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(onRefreshCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
      mounted.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Esc 收起抽屉，且不把这次按键冒泡给画布（A10）", async () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const mounted = await mount({ onClose });
    // 抽屉打开即获得焦点（见 panel.tsx），Esc 由抽屉自己消费并阻止冒泡。
    const drawer = mounted.container.querySelector<HTMLElement>("[data-node-history-panel='true']")!;
    expect(document.activeElement).toBe(drawer);
    act(() => {
      drawer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
    mounted.unmount();
  });

  it("「当前版本」项用当前归档条目的受控预览，而不是空白格（A3）", async () => {
    const mounted = await mount();
    const current = mounted.container.querySelector<HTMLElement>("[data-current-entry='true']")!;
    expect(current).not.toBeNull();
    const image = current.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("/api/canvas-node-history/c/n1/e1/preview");
    mounted.unmount();
  });

  it("没有归档条目时「当前版本」显示可读占位，不留空白（A3）", async () => {
    const mounted = await mount({ items: [] });
    const current = mounted.container.querySelector<HTMLElement>("[data-current-entry='true']")!;
    expect(current.querySelector("img")).toBeNull();
    expect(current.textContent).toContain("当前");
    mounted.unmount();
  });
});
