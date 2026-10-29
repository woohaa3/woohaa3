/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AlertDialog, type AsyncConfirmResult } from "./AlertDialog.js";
let root: Root; let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); });
function mount(instanceId: string, onConfirm: () => Promise<AsyncConfirmResult>, onBusyChange = vi.fn()) {
  if (!container?.isConnected) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  act(() => root.render(<AlertDialog instanceId={instanceId} title="确认" description="保留内容" onCancel={vi.fn()} onConfirm={onConfirm} onBusyChange={onBusyChange} />));
}
const confirm = () => [...container.querySelectorAll("button")].find(b => b.textContent === "确认")!;
it("synchronously deduplicates, preserves a failed instance and retries", async () => {
  let resolve!: (result: AsyncConfirmResult) => void;
  const action = vi.fn(() => new Promise<AsyncConfirmResult>(r => { resolve = r; }));
  mount("a", action);
  await act(async () => { confirm().click(); confirm().click(); }); expect(action).toHaveBeenCalledOnce();
  await act(async () => resolve({ ok: false, error: "失败可重试" })); expect(container.textContent).toContain("失败可重试");
  await act(async () => confirm().click()); expect(action).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ ok: true })); expect(confirm().disabled).toBe(true);
});
it("old completion cannot alter another instance or call its busy owner", async () => {
  let resolve!: (result: AsyncConfirmResult) => void; const busy = vi.fn();
  mount("a", () => new Promise(r => { resolve = r; }), busy);
  await act(async () => confirm().click()); mount("b", async () => ({ ok: true }), busy);
  await act(async () => resolve({ ok: false, error: "旧错误" }));
  expect(container.textContent).not.toContain("旧错误"); expect(confirm().disabled).toBe(false); expect(busy.mock.calls).toEqual([[true]]);
});
it("sync throws become retryable feedback", async () => {
  mount("a", () => { throw new Error("失败"); }); await act(async () => confirm().click());
  expect(container.textContent).toContain("失败"); expect(confirm().disabled).toBe(false);
});
