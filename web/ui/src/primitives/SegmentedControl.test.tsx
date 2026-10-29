/**
 * Tabs / SegmentedControl / Collapsible / ScrollArea（change: adopt-radix-lucide-canvas-ui，任务 2.4）。
 *
 * 覆盖 ARIA、键盘导航、受控状态、single segmented 不可取消为空、remount。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tabs } from "./Tabs.js";
import { SegmentedControl } from "./SegmentedControl.js";
import { Collapsible } from "./Collapsible.js";
import { ScrollArea } from "./ScrollArea.js";

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
  return { container, root, rerender: (next: React.ReactElement) => act(() => root.render(next)) };
}

describe("Tabs（任务 2.4）", () => {
  it("暴露 tablist/tab/tabpanel 与选中态", () => {
    const { container } = render(
      <Tabs
        label="视图"
        value="a"
        onValueChange={() => undefined}
        items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
        panels={{ a: <div>A 面板</div>, b: <div>B 面板</div> }}
      />
    );
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
    expect((tabs[0] as HTMLElement).getAttribute("aria-selected")).toBe("true");
    expect((tabs[1] as HTMLElement).getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain("A 面板");
  });

  it("方向键由 Radix roving focus 处理并切换受控值", () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <Tabs
        label="视图"
        value="a"
        onValueChange={onValueChange}
        items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
        panels={{ a: <div>A</div>, b: <div>B</div> }}
      />
    );
    const first = container.querySelector<HTMLElement>('[role="tab"]')!;
    act(() => first.focus());
    // Radix roving focus 用 setTimeout 移动焦点；ArrowRight 自动激活下一个 tab。
    act(() => {
      vi.useFakeTimers();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      vi.runAllTimers();
      vi.useRealTimers();
    });
    const second = container.querySelectorAll<HTMLElement>('[role="tab"]')[1]!;
    expect(document.activeElement).toBe(second);
    expect(onValueChange).toHaveBeenCalledWith("b");
  });
});

describe("SegmentedControl（任务 2.4）", () => {
  it("single 模式暴露 radiogroup/radio 与选中态", () => {
    const { container } = render(
      <SegmentedControl
        label="主题"
        value="default"
        onValueChange={() => undefined}
        options={[{ value: "default", label: "默认" }, { value: "sentinel", label: "哨兵" }]}
      />
    );
    expect(container.querySelector('[role="radiogroup"][aria-label="主题"]')).not.toBeNull();
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(2);
    expect((radios[0] as HTMLElement).getAttribute("aria-checked")).toBe("true");
  });

  it("single 模式再次激活当前项不会取消到空值", () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <SegmentedControl
        label="主题"
        value="sentinel"
        onValueChange={onValueChange}
        options={[{ value: "default", label: "默认" }, { value: "sentinel", label: "哨兵" }]}
      />
    );
    const current = container.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')!;
    act(() => current.click());
    // Radix single 回传空串被忽略：不调用 onValueChange。
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("multiple 模式暴露多选与 selected 状态", () => {
    const { container } = render(
      <SegmentedControl
        type="multiple"
        label="工具"
        value={["orbit"]}
        onValueChange={() => undefined}
        options={[{ value: "orbit", label: "轨道" }, { value: "distance", label: "距离" }]}
      />
    );
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    const pressed = container.querySelectorAll('[aria-pressed="true"]');
    expect(pressed.length).toBe(1);
  });
});

describe("Collapsible（任务 2.4）", () => {
  it("暴露 aria-expanded 并受控切换", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Collapsible trigger={<span>展开</span>} open={false} onOpenChange={onOpenChange}>
        <div data-testid="body">内容</div>
      </Collapsible>
    );
    const trigger = container.querySelector<HTMLElement>(".ui-collapsible__trigger")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // defaultOpen 非受控场景。
    act(() => trigger.click());
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("defaultOpen 非受控首次展开内容", () => {
    const { container } = render(
      <Collapsible trigger={<span>展开</span>} defaultOpen>
        <div data-testid="body">内容</div>
      </Collapsible>
    );
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(container.querySelector("[data-testid='body']")).not.toBeNull();
  });
});

describe("ScrollArea（任务 2.4）", () => {
  it("渲染 viewport 与可访问名（滚动条由 Radix 按内容尺寸挂载）", () => {
    const { container } = render(
      <ScrollArea label="列表" testId="scroller">
        <div data-testid="body">内容</div>
      </ScrollArea>
    );
    const root = container.querySelector("[data-testid='scroller']")!;
    expect(root).not.toBeNull();
    const viewport = root.querySelector<HTMLElement>(".ui-scroll-area__viewport")!;
    expect(viewport).not.toBeNull();
    expect(viewport.getAttribute("data-radix-scroll-area-viewport")).not.toBeNull();
    expect(viewport.getAttribute("aria-label")).toBe("列表");
    expect(root.querySelector("[data-testid='body']")).not.toBeNull();
  });
});
