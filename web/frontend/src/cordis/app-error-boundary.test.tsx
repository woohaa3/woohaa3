/**
 * 渲染错误边界回归
 * （change: fix-delete-node-crash-and-white-screen）。
 *
 * 页面级边界必须把 render 异常限制在自己的 fallback 内，而不是让整棵 React 树被卸载
 * （白屏）；Panel 级边界必须只替换出错的 panel，并能在 route identity 变化后自动重试。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppErrorBoundary,
  PanelRenderErrorFallback,
  RenderErrorBoundary,
  reloadApplication
} from "./app-error-boundary.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<>{node}</>);
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Boom(): React.ReactNode {
  throw new Error("面板炸了");
}

describe("RenderErrorBoundary", () => {
  it("隔离子树异常：同级内容仍渲染，错误被兜底显示", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = await mount(
      <>
        <div data-testid="healthy">仍然可用</div>
        <RenderErrorBoundary fallback={({ error }) => <PanelRenderErrorFallback error={error} />}>
          <Boom />
        </RenderErrorBoundary>
      </>
    );

    expect(container.querySelector('[data-testid="healthy"]')?.textContent).toBe("仍然可用");
    const fallback = container.querySelector('[data-testid="app-render-error"], .render-error-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toContain("面板炸了");
    // 边界不静默吞错。
    expect(errorSpy).toHaveBeenCalled();
  });

  it("resetKey 变化后自动重试渲染", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const renderWith = async (key: string, shouldThrow: boolean) => {
      await act(async () => {
        root!.render(
          <RenderErrorBoundary
            resetKey={key}
            fallback={({ error }) => <PanelRenderErrorFallback error={error} />}
          >
            {shouldThrow ? <Boom /> : <div data-testid="recovered">恢复</div>}
          </RenderErrorBoundary>
        );
      });
    };

    await renderWith("a", true);
    expect(container.querySelector('[data-testid="recovered"]')).toBeNull();

    await renderWith("b", false);
    expect(container.querySelector('[data-testid="recovered"]')).not.toBeNull();
  });

  it("点击刷新调用 location.reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    const original = globalThis.location;
    Object.defineProperty(globalThis, "location", { value: { reload }, configurable: true });
    try {
      const container = await mount(
        <RenderErrorBoundary fallback={({ error }) => <PanelRenderErrorFallback error={error} />}>
          <Boom />
        </RenderErrorBoundary>
      );
      const button = [...container.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("刷新页面")
      );
      expect(button).toBeDefined();
      await act(async () => {
        button!.click();
      });
      expect(reload).toHaveBeenCalledTimes(1);
      // 生产 helper 与按钮走同一条刷新路径。
      reloadApplication();
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(globalThis, "location", { value: original, configurable: true });
    }
  });

  it("页面级兜底隐藏失败子树并显示可诊断错误", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = await mount(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );
    const alert = container.querySelector('[data-testid="app-render-error"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("页面渲染失败");
    expect(alert!.textContent).toContain("面板炸了");
    expect(alert!.textContent).toContain("刷新页面");
  });
});
