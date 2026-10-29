/** @vitest-environment jsdom */
/**
 * 执行面板提示词输入框的 Enter 语义：Enter 生成、Shift+Enter 换行。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionPanel } from "./ExecutionPanel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function renderPanel(onRun: (input: { prompt: string }) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ExecutionPanel
        taskKind="image-generation"
        surface="dock"
        modelConfig={{
          modelOptions: [{ label: "M", value: "m" }],
          defaultModel: "m",
          parameterSchemaByModel: {},
        }}
        data={{ title: "节点", panelPrompt: "一只猫", parameters: { model: "m" } }}
        onRun={onRun}
      />
    )
  );
  return container.querySelector("textarea")!;
}

describe("执行面板提示词回车", () => {
  it("Enter 提交，Shift+Enter 保留换行", () => {
    const onRun = vi.fn();
    const field = renderPanel(onRun);
    const shiftEnter = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    act(() => field.dispatchEvent(shiftEnter));
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onRun).not.toHaveBeenCalled();

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => field.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun.mock.calls[0]![0].prompt).toBe("一只猫");
  });

  it("Ctrl/Cmd+Enter 仍可提交", () => {
    const onRun = vi.fn();
    const field = renderPanel(onRun);
    const modified = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => field.dispatchEvent(modified));
    expect(modified.defaultPrevented).toBe(true);
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("结构化编辑器插槽拿到同一个提交入口", () => {
    const onRun = vi.fn();
    let slotSubmit: (() => void) | undefined;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <ExecutionPanel
          taskKind="image-generation"
          surface="dock"
          modelConfig={{
            modelOptions: [{ label: "M", value: "m" }],
            defaultModel: "m",
            parameterSchemaByModel: {},
          }}
          data={{ title: "节点", panelPrompt: "一只猫", parameters: { model: "m" } }}
          promptEditorSlot={({ onSubmit }) => {
            slotSubmit = onSubmit;
            return <div data-testid="structured-prompt" />;
          }}
          onRun={onRun}
        />
      )
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(slotSubmit).toBeTypeOf("function");
    act(() => slotSubmit!());
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun.mock.calls[0]![0].prompt).toBe("一只猫");
  });
});
