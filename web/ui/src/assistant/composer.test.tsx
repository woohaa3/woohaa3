/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantComposer } from "./composer.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function render(element: React.ReactNode) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); act(() => root!.render(element)); return container; }
describe.each(["dock", "inspector", "creation", "reply"])("assistant composer in %s layout", layout => {
  it("submits on Enter, keeps Shift+Enter for newlines and still accepts the explicit shortcuts", () => {
    const submit = vi.fn();
    const container = render(<div data-layout={layout}><AssistantComposer value="Draft" placeholder="Prompt" onChange={() => undefined} onSubmit={submit} /></div>);
    const field = container.querySelector("textarea")!;
    const key = (options = {}) => act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options })); });
    key(); expect(submit).toHaveBeenCalledTimes(1);
    key({ shiftKey: true }); expect(submit).toHaveBeenCalledTimes(1);
    key({ altKey: true }); expect(submit).toHaveBeenCalledTimes(1);
    key({ ctrlKey: true }); key({ metaKey: true }); expect(submit).toHaveBeenCalledTimes(3);
  });
  it("does not submit during composition, including composition events without native isComposing", () => {
    const submit = vi.fn();
    const container = render(<div data-layout={layout}><AssistantComposer value="Draft" placeholder="Prompt" onChange={() => undefined} onSubmit={submit} /></div>);
    const field = container.querySelector("textarea")!;
    const key = (options = {}) => act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options })); });
    act(() => { field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    key(); key({ ctrlKey: true }); key({ metaKey: true }); expect(submit).not.toHaveBeenCalled();
    act(() => { field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    key(); expect(submit).toHaveBeenCalledTimes(1);
  });
});
