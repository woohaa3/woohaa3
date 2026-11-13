/**
 * 画布「全部生成历史」弹窗组件测试
 * （change: add-canvas-generation-history-dialog）。
 *
 * 覆盖：筛选计数、空/错误/加载更多状态、选中详情，以及只读（无写入控件）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasGenerationHistoryListItem, NodeHistoryKindCounts } from "@woohaa3/contracts";
import { CanvasHistoryBrowser } from "./canvas-history-browser.js";
import { CanvasHistoryController, type CanvasHistoryClient } from "./canvas-history-controller.js";

const COUNTS: NodeHistoryKindCounts = { text: 1, image: 1, video: 0, audio: 0, motion: 0, model: 0 };

function item(entryId: string, overrides: Partial<CanvasGenerationHistoryListItem> = {}): CanvasGenerationHistoryListItem {
  return {
    entryId,
    kind: "text",
    createdAt: "2026-09-27T00:00:00.000Z",
    current: false,
    recoverable: true,
    previewable: true,
    source: { label: "文本生成" },
    preview: { kind: "text", excerpt: "摘要" },
    nodeId: "n1",
    nodeTitle: "节点一",
    ...overrides
  };
}

function client(page: {
  items: CanvasGenerationHistoryListItem[];
  nextCursor?: string | null;
}): CanvasHistoryClient {
  return {
    listCanvas: async () => ({
      ok: true,
      items: page.items,
      nextCursor: page.nextCursor ?? null,
      total: page.items.length,
      kindCounts: COUNTS
    })
  };
}

describe("CanvasHistoryBrowser", () => {
  it("渲染列表、筛选计数与选中详情，且不含任何写入控件", async () => {
    const controller = new CanvasHistoryController(client({
      items: [item("a", { current: true }), item("b", { kind: "image", preview: { kind: "image", href: "/api/x/preview" }, nodeTitle: "节点二" })]
    }));
    await controller.open({ canvasId: "c1" });
    controller.select("b");
    const html = renderToStaticMarkup(<CanvasHistoryBrowser controller={controller} onClose={() => undefined} />);
    expect(html).toContain("全部");
    expect(html).toContain("图片");
    expect(html).toContain("节点二");
    expect(html).toContain("当前");
    // 只读：不出现恢复/添加动作。
    expect(html).not.toContain("设为当前");
    expect(html).not.toContain("添加到画布");
    // 安全：不泄露 storageKey。
    expect(html).not.toContain("sha256-");
  });

  it("空态显示明确空提示", async () => {
    const controller = new CanvasHistoryController(client({ items: [] }));
    await controller.open({ canvasId: "c1" });
    const html = renderToStaticMarkup(<CanvasHistoryBrowser controller={controller} onClose={() => undefined} />);
    expect(html).toContain("暂无生成记录");
  });

  it("错误态显示可诊断信息与重试", async () => {
    const controller = new CanvasHistoryController({
      listCanvas: async () => ({ ok: false, code: "unavailable", error: "服务不可用" })
    });
    await controller.open({ canvasId: "c1" });
    const html = renderToStaticMarkup(<CanvasHistoryBrowser controller={controller} onClose={() => undefined} />);
    expect(html).toContain("服务不可用");
    expect(html).toContain("重试");
  });

  it("存在下一页时显示加载更多", async () => {
    const controller = new CanvasHistoryController(client({ items: [item("a")], nextCursor: "cur" }));
    await controller.open({ canvasId: "c1" });
    const html = renderToStaticMarkup(<CanvasHistoryBrowser controller={controller} onClose={() => undefined} />);
    expect(html).toContain("加载更多");
  });

  it("state 为 null 时不渲染", () => {
    const controller = new CanvasHistoryController(client({ items: [] }));
    const html = renderToStaticMarkup(<CanvasHistoryBrowser controller={controller} onClose={() => undefined} />);
    expect(html).toBe("");
  });

  it("移除孤立的“可恢复：是”，不直接恢复", async () => {
    const controller = new CanvasHistoryController(client({ items: [item("a")] }));
    await controller.open({ canvasId: "c1" });
    const html = renderToStaticMarkup(<CanvasHistoryBrowser controller={controller} onClose={() => undefined} />);
    expect(html).not.toContain("可恢复");
  });

  it("提供“前往节点查看版本”，目标失效时禁用并说明原因", async () => {
    const controller = new CanvasHistoryController(client({ items: [item("a")] }));
    await controller.open({ canvasId: "c1" });
    const html = renderToStaticMarkup(
      <CanvasHistoryBrowser
        controller={controller}
        onClose={() => undefined}
        onOpenNodeVersion={() => undefined}
        canOpenNodeVersion={() => ({ ok: false, reason: "该作品已被删除，无法查看版本" })}
      />
    );
    expect(html).toContain("前往节点查看版本");
    expect(html).toContain("该作品已被删除，无法查看版本");
    expect(html).toContain("disabled");
  });

  it("可跳转时不显示原因且按钮可用", async () => {
    const controller = new CanvasHistoryController(client({ items: [item("a")] }));
    await controller.open({ canvasId: "c1" });
    const html = renderToStaticMarkup(
      <CanvasHistoryBrowser
        controller={controller}
        onClose={() => undefined}
        onOpenNodeVersion={() => undefined}
        canOpenNodeVersion={() => ({ ok: true })}
      />
    );
    expect(html).toContain("前往节点查看版本");
    expect(html).not.toContain("disabled=\"\"");
  });
});

it("节点在点击前删除、关闭被拒绝时不导航；成功关闭后传递确切 entryId", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { vi } = await import("vitest");
  const controller = new CanvasHistoryController(client({ items: [item("version")] }));
  await controller.open({ canvasId: "c1" });
  let available = true; let closeAllowed = false;
  const jump = vi.fn(); const close = vi.fn(() => closeAllowed);
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<CanvasHistoryBrowser embedded controller={controller} onClose={close} onOpenNodeVersion={jump} canOpenNodeVersion={() => available ? { ok: true } : { ok: false, reason: "节点已删除" }} />));
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === "前往节点查看版本")!;
  act(() => button.click()); expect(jump).not.toHaveBeenCalled();
  expect(container.textContent).toContain("当前界面无法关闭");
  available = false; closeAllowed = true;
  act(() => button.click()); expect(jump).not.toHaveBeenCalled();
  expect(container.textContent).toContain("节点已删除");
  available = true;
  act(() => root.render(<CanvasHistoryBrowser embedded controller={controller} onClose={close} onOpenNodeVersion={jump} canOpenNodeVersion={() => ({ ok: true })} />));
  act(() => button.click()); expect(jump).toHaveBeenCalledWith({ nodeId: "n1", entryId: "version" });
  expect(close).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});
