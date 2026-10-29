/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CopyField } from "./CopyField.js";
let root: Root;
let container: HTMLDivElement;
function render(value: string, copyText: (value: string) => Promise<boolean | void>) {
  if (!container) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  act(() => root.render(<CopyField value={value} label="标识" copyText={copyText}>{value}</CopyField>));
}
async function click() { await act(async () => container.querySelector("button")!.click()); }
afterEach(() => { act(() => root?.unmount()); container?.remove(); container = undefined!; vi.useRealTimers(); });
it.each([false, "reject", true] as const)("reports %s and supports explicit retry", async outcome => {
  const copy = vi.fn().mockImplementationOnce(() => outcome === "reject" ? Promise.reject(new Error("blocked")) : Promise.resolve(outcome)).mockResolvedValue(true);
  render("a", copy); await click(); expect(container.textContent).toContain(outcome === true ? "已复制" : "复制失败");
  await click(); expect(container.textContent).toContain("已复制"); expect(copy).toHaveBeenCalledTimes(2);
});
it("ignores old operations after repeated clicks, value change and unmount", async () => {
  const resolvers: Array<(value: boolean) => void> = [];
  const copy = vi.fn(() => new Promise<boolean>(resolve => resolvers.push(resolve)));
  render("a", copy); await click(); await click();
  await act(async () => resolvers[1]!(true)); await act(async () => resolvers[0]!(false));
  expect(container.textContent).toContain("已复制");
  await click(); render("b", copy); await act(async () => resolvers[2]!(false));
  expect(container.textContent).not.toContain("复制失败");
  await click(); act(() => root.unmount()); await act(async () => resolvers[3]!(true));
});
