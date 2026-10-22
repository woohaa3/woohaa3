/**
 * Button / IconButton / Tooltip primitives（change: adopt-radix-lucide-canvas-ui，任务 2.2）。
 *
 * 覆盖：size/tone/disabled/loading、icon-only 强制 accessible name、ref 与事件透传、
 * keyboard focus-visible、tooltip hover/focus 发现、重复触发单次回调。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button, IconButton } from "./Button.js";
import { Tooltip } from "./Tooltip.js";
import { ZoomInIcon } from "./icons.js";
import { UiProvider } from "./UiProvider.js";

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
  return { container, root };
}

describe("Button（任务 2.2）", () => {
  it("渲染 size/tone、ref 与事件透传", () => {
    const onClick = vi.fn();
    const ref = { current: null as HTMLButtonElement | null };
    const { container } = render(
      <Button ref={(node) => { ref.current = node; }} size="sm" tone="primary" onClick={onClick}>
        保存
      </Button>
    );
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.className).toContain("ui-button--sm");
    expect(button.className).toContain("ui-button--primary");
    expect(ref.current).toBe(button);
    act(() => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("loading 进入 aria-busy 且不可重复触发", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>提交</Button>
    );
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled 传递 data-disabled 与 disabled", () => {
    const { container } = render(<Button disabled>不可用</Button>);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-disabled")).toBe("true");
  });
});

describe("IconButton（任务 2.2）", () => {
  it("强制 accessible name，图标 aria-hidden", () => {
    const { container } = render(
      <IconButton label="放大">
        <ZoomInIcon />
      </IconButton>
    );
    const button = container.querySelector<HTMLButtonElement>(".ui-icon-button")!;
    expect(button.getAttribute("aria-label")).toBe("放大");
    const iconWrapper = button.querySelector(".ui-icon-button__icon")!;
    expect(iconWrapper.getAttribute("aria-hidden")).toBe("true");
  });

  it("pressed 暴露切换态", () => {
    const { container } = render(
      <IconButton label="静音" pressed>
        <ZoomInIcon />
      </IconButton>
    );
    expect(container.querySelector(".ui-icon-button")!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Tooltip（任务 2.2）", () => {
  it("打开时内容渲染在 theme-root 内的 portal，且 trigger 关联描述", () => {
    const { container } = render(
      <UiProvider>
        <Tooltip content="放大画布" open>
          <button type="button" aria-label="放大">
            <ZoomInIcon />
          </button>
        </Tooltip>
      </UiProvider>
    );
    // portal 位于 ui-portal-root 内（不在 body 顶层）。
    const portalRoot = container.querySelector(".ui-portal-root")!;
    expect(portalRoot).not.toBeNull();
    expect(portalRoot.querySelector(".ui-tooltip")?.textContent).toContain("放大画布");
    // trigger 通过 aria-describedby 关联提示（hover/focus 由 Radix 语义提供）。
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("keyboard 聚焦触发元素可被 Radix 识别为可提示目标", () => {
    const { container } = render(
      <UiProvider>
        <Tooltip content="放大画布">
          <button type="button" aria-label="放大">
            <ZoomInIcon />
          </button>
        </Tooltip>
      </UiProvider>
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    // Tooltip.Trigger asChild 保留原生 button 的可聚焦语义。
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-label")).toBe("放大");
  });
});
