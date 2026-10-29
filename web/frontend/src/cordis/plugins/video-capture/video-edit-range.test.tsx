/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { IntentList } from "./video-edit-intents.js";

it("非法草稿保留原区间，取消恢复，确认只提交选中区间的时间", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const update = vi.fn();
  const dirty = vi.fn();
  const intent = { id: "one", startSeconds: 1, endSeconds: 2, prompt: "保留", annotationShapes: [], frameWidth: 100, frameHeight: 100 };
  await act(async () => root.render(<IntentList ordered={[intent]} activeIntentId="one" busyNow={false} rangeDirty={false} setActiveIntentId={() => {}} removeIntent={() => {}} activeIntent={intent} updateActive={update} duration={10} onRangeDirty={dirty} />));
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
  const change = async (element: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
  const click = async (label: string) => act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click(); });
  await change(inputs[1]!, "1.01");
  await click("确认时间");
  expect(container.textContent).toContain("区间至少为 0.05 秒");
  expect(inputs[1]!.value).toBe("1.01");
  expect(update).not.toHaveBeenCalled();
  await click("取消");
  expect(inputs[1]!.value).toBe("2");
  await change(inputs[1]!, "3");
  await click("确认时间");
  expect(update).toHaveBeenCalledWith({ startSeconds: 1, endSeconds: 3 });
  await act(async () => root.unmount());
  container.remove();
});
