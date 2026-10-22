/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantComposer } from "./composer.js";
import { AssistantExecutionStatus } from "./status.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function render(element: React.ReactNode) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); act(() => root!.render(element)); return container; }
describe.each(["dock", "inspector", "creation", "reply"])("assistant composer in %s layout", layout => {
  it("uses newline and explicit shortcuts, including composition events without native isComposing", () => {
    const submit = vi.fn();
    const container = render(<div data-layout={layout}><AssistantComposer value="Draft" placeholder="Prompt" onChange={() => undefined} onSubmit={submit} /></div>);
    const field = container.querySelector("textarea")!;
    const key = (options = {}) => act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options })); });
    key(); expect(submit).not.toHaveBeenCalled();
    act(() => { field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    key({ ctrlKey: true }); key({ metaKey: true }); expect(submit).not.toHaveBeenCalled();
    act(() => { field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    key({ ctrlKey: true }); key({ metaKey: true }); expect(submit).toHaveBeenCalledTimes(2);
  });
});
it("opens the exact old execution and only queries on explicit action", async () => {
  const execution = { canvasId: "canvas", targetNodeId: "target-a", conversationId: "conversation-a", turnRequestId: "old-failed" };
  const open = vi.fn(); const query = vi.fn(async () => ({ ok: true }));
  const container = render(<AssistantExecutionStatus target={{ execution, status: "failed", stage: "Failed", query }} writable onOpenDetail={open} />);
  expect(query).not.toHaveBeenCalled();
  await act(async () => { container.querySelectorAll("button")[0]!.click(); });
  expect(open).toHaveBeenCalledWith(execution);
  expect(query).not.toHaveBeenCalled();
  await act(async () => { container.querySelectorAll("button")[1]!.click(); });
  expect(query).toHaveBeenCalledOnce();
});

it("keeps legacy domain receipts readable without inventing a conversation", async () => {
  const query = vi.fn(async () => ({ ok: true }));
  const open = vi.fn();
  const container = render(<AssistantExecutionStatus target={{ status: "succeeded", stage: "Completed", query,
    domain: { requestId: "legacy-request", sourceNodeId: "source", targetNodeId: "target", commandId: "durable-receipt" } }} writable onOpenDetail={open} />);
  expect(container.textContent).toContain("此记录未保存助手对话");
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "查看任务详情")!.click(); });
  expect(container.textContent).toContain("legacy-request");
  expect(container.textContent).toContain("durable-receipt");
  expect(query).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
