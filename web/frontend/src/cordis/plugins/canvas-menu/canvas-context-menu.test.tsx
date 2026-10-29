/**
 * 画布上下文菜单渲染测试（change: 后续 change 补齐右键菜单；
 *  change: adopt-radix-lucide-canvas-ui 任务 4.1：迁移后为受控 Radix 菜单，需 jsdom）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CanvasContextMenu } from "./canvas-context-menu.js";
import { UiProvider } from "@woohaa3/ui/primitives";

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

describe("CanvasContextMenu（任务 4.1）", () => {
  it("把插入项渲染为 menuitem，并标记禁用/危险/分隔线", () => {
    const container = render(
      <UiProvider>
        <CanvasContextMenu
          x={20}
          y={30}
          label="插入节点"
          items={[
            { id: "text", label: "文本" },
            { id: "upload", label: "上传…", separatorBefore: true, disabled: true },
            { id: "delete", label: "删除节点", danger: true }
          ]}
          onSelect={() => undefined}
          onClose={() => undefined}
        />
      </UiProvider>
    );
    const menu = container.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(menu.className).toContain("canvas-context-menu");
    expect(menu.getAttribute("aria-label")).toBe("插入节点");
    const items = container.querySelectorAll('.canvas-context-menu__item[role="menuitem"]');
    expect(items.length).toBe(3);
    // 禁用项 Radix 用 aria-disabled + data-disabled 表达。
    const disabled = [...items].find((item) => item.textContent === "上传…")!;
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("data-disabled")).toBe("");
    // 危险项带 danger class。
    const danger = [...items].find((item) => item.textContent === "删除节点")!;
    expect(danger.className).toContain("ui-menu__item--danger");
    // 分隔线。
    expect(container.querySelector(".canvas-context-menu__separator")).not.toBeNull();
  });

  it("禁用项的原因以桌面悬停提示呈现（change: 2026-10-16-add-group-selection-toolbar）", () => {
    const container = render(
      <UiProvider>
        <CanvasContextMenu
          x={0}
          y={0}
          items={[
            { id: "run-group", label: "批量执行", disabled: true, reason: "提交中" },
            { id: "tidy-group", label: "整理" }
          ]}
          onSelect={() => undefined}
          onClose={() => undefined}
        />
      </UiProvider>
    );
    const run = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "批量执行"
    )!;
    expect(run.getAttribute("title")).toBe("提交中");
    const tidy = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "整理"
    )!;
    expect(tidy.getAttribute("title")).toBeNull();
  });

  it("单次 action：宿主在 select 后收起菜单时不重复触发", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <UiProvider>
          {open ? (
            <CanvasContextMenu
              x={0}
              y={0}
              items={[{ id: "text", label: "文本" }, { id: "image", label: "图片" }]}
              onSelect={(id) => {
                onSelect(id);
                setOpen(false);
              }}
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          ) : (
            <span data-testid="closed" />
          )}
        </UiProvider>
      );
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.add(root);
    act(() => root.render(<Harness />));
    const item = container.querySelector<HTMLElement>('[role="menuitem"]')!;
    act(() => item.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("text");
    // 菜单已收起，DOM 不再暴露 menuitem。
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("Escape 关闭时调用 onClose", () => {
    const onClose = vi.fn();
    const container = render(
      <UiProvider>
        <CanvasContextMenu
          x={0}
          y={0}
          items={[{ id: "text", label: "文本" }]}
          onSelect={() => undefined}
          onClose={onClose}
        />
      </UiProvider>
    );
    const menu = container.querySelector('[role="menu"]')!;
    act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
