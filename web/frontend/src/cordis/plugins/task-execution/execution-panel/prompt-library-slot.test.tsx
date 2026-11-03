/**
 * ExecutionPanel 的「提示词」入口。
 *
 * 只锁两件事：插槽给了就出现按钮、没给就不出现；以及选中一条时正文**追加**进草稿
 * （而不是把用户已经写的内容清掉）。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPanel } from "./ExecutionPanel.js";

const BASE_PROPS = {
  taskKind: "image-generation" as const,
  surface: "dock" as const,
  modelConfig: {
    modelOptions: [{ label: "M", value: "m" }],
    defaultModel: "m",
    parameterSchemaByModel: {}
  }
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Popover 的内容渲染在 portal 里（`usePortalContainer()`），查询要扫整个 document。 */
const openButton = () => document.querySelector('[aria-label="打开提示词库"]') as HTMLButtonElement | null;
const find = (selector: string) => document.querySelector(selector) as HTMLElement | null;

describe("ExecutionPanel 提示词库入口", () => {
  it("没有插槽时不显示入口", async () => {
    await act(async () => {
      root.render(
        <ExecutionPanel
          {...BASE_PROPS}
          data={{ title: "节点", panelPrompt: "", parameters: { model: "m" } }}
          onRun={() => undefined}
        />
      );
    });
    expect(openButton()).toBeNull();
  });

  it("有插槽时在发送键左侧出现入口，点开渲染插槽内容", async () => {
    await act(async () => {
      root.render(
        <ExecutionPanel
          {...BASE_PROPS}
          data={{ title: "节点", panelPrompt: "", parameters: { model: "m" } }}
          onRun={() => undefined}
          promptLibrarySlot={() => <div data-testid="library-body">词库</div>}
        />
      );
    });
    const trigger = openButton();
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(find('[data-testid="library-body"]')).not.toBeNull();
  });

  it("选中一条时追加进草稿，不覆盖已写的文字", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ExecutionPanel
          {...BASE_PROPS}
          data={{ title: "节点", panelPrompt: "我想要的:", parameters: { model: "m" } }}
          onRun={() => undefined}
          onChange={onChange}
          promptLibrarySlot={({ onUse }) => (
            <button type="button" data-testid="use-prompt" onClick={() => onUse("一段提示词")}>
              使用
            </button>
          )}
        />
      );
    });

    await act(async () => {
      openButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const useButton = find('[data-testid="use-prompt"]') as HTMLButtonElement;
    await act(async () => {
      useButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 面板自己持有的 prompt 变了 -> 通过 onChange 回流给父级（内部字段是 panelPrompt）。
    expect(onChange).toHaveBeenCalledWith({ panelPrompt: "我想要的:\n一段提示词" });
  });
});
