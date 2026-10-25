/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { FilmSetContent, FilmSetItemPatchOp } from "@woohaa3/contracts";
import type { FilmSetObjectAction } from "../src/integration/browser/film-set-object-feature.js";
import { FilmSetObjectSession } from "../src/authoring/browser/object-session.js";
import { FilmSetObjectToolbar } from "../src/authoring/browser/film-set-object-toolbar.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
function setup(writable = true, action?: FilmSetObjectAction, onExit?: () => void, onContainerVisibilityChange?: (itemId: string, visible: boolean) => void) {
  const content: FilmSetContent = { schemaVersion: 4, items: [{ id: "photo", name: "照片", kind: "image", assetId: "asset", aspectRatio: 1.5, localTransform: { offset: { x: 1, y: 2, z: 3 }, scale: 1, yaw: 0 } }] };
  const submitted: FilmSetItemPatchOp[] = [];
  const session = new FilmSetObjectSession({ readContent: () => content, isWritable: () => writable, submitItemOp: ({ op }) => {
    submitted.push(op); if (op.kind === "transform") content.items[0].localTransform = op.localTransform;
    return true;
  } });
  session.enter("film"); session.select("photo");
  const element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  act(() => root!.render(<FilmSetObjectToolbar session={session} nodeId="film" writable={writable} readOnly={false} onDelete={() => session.deleteSelected()} {...(action ? { action } : {})} {...(onExit ? { onExit } : {})} {...(onContainerVisibilityChange ? { onContainerVisibilityChange } : {})} />));
  return { session, submitted, content };
}
const input = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
function typeValue(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("numeric position previews before release and commits once on blur", () => {
  const h = setup(); const x = input("对象位置 X");
  act(() => x.focus()); typeValue(x, "4.5");
  expect(h.session.getState().preview?.offset.x).toBe(4.5);
  expect(h.content.items[0].localTransform.offset.x).toBe(1);
  expect(h.submitted).toHaveLength(0);
  act(() => x.blur());
  expect(h.submitted).toHaveLength(1); expect(h.content.items[0].localTransform.offset.x).toBe(4.5);
  expect(document.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector('[role="tablist"]')).toBeNull();
});
it("Escape cancels rotation; an empty scale restores the saved value", () => {
  const h = setup(); const yaw = input("对象 Y 旋转");
  act(() => yaw.focus()); typeValue(yaw, "90"); expect(h.session.getState().preview?.yaw).toBeCloseTo(Math.PI/2);
  act(() => yaw.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(h.submitted).toHaveLength(0); expect(h.session.getState().preview).toBeNull(); expect(yaw.value).toBe("0");
  const scale = input("等比缩放"); act(() => scale.focus()); typeValue(scale, ""); act(() => scale.blur());
  expect(h.submitted).toHaveLength(0); expect(scale.value).toBe("1");
});
it("read-only objects remain selectable while all transform fields are disabled", () => {
  const h = setup(false);
  expect([...document.querySelectorAll("input")].every(element => element.disabled)).toBe(true);
  act(() => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
  expect(h.session.selectedItem()?.id).toBe("photo"); expect(h.submitted).toHaveLength(0);
});

it("列表内 Delete/Backspace 与删除按钮共用 action，并阻止向 2D 冒泡（任务 5.2）", () => {
  const h = setup();
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  let escaped = false;
  // 在 document 上监听：局部处理后不应冒泡到这里（否则会触发 2D 节点删除）。
  const spy = (event: KeyboardEvent) => { escaped = true; event.preventDefault(); };
  document.addEventListener("keydown", spy);
  act(() => option.focus());
  const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
  act(() => option.dispatchEvent(del));
  document.removeEventListener("keydown", spy);
  expect(del.defaultPrevented).toBe(true);
  expect(escaped).toBe(false);
  expect(h.submitted.at(-1)).toMatchObject({ kind: "delete" });
});

it("注入 action 时删除按钮与键盘共用 action.deleteSelected（任务 4.1/4.3）", () => {
  const calls = { delete: 0 };
  const action = {
    active: () => true,
    hasSelection: () => true,
    pending: () => false,
    deleteSelected: () => { calls.delete += 1; return true; },
    clearSelection: () => true,
    cancelGesture: () => false
  };
  setup(true, action);
  // 按钮路径：点击「删除对象」经 action 而非直接 onDelete。
  const del = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("删除对象")) as HTMLButtonElement;
  act(() => del.click());
  expect(calls.delete).toBe(1);
  // 键盘路径：列表内 Delete 走同一 action。
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  act(() => option.focus());
  act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
  expect(calls.delete).toBe(2);
});

it("列表内 Escape 清空选择且不冒泡退出聚焦（任务 5.2/5.4）", () => {
  const h = setup();
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  let bubbled = false;
  const spy = () => { bubbled = true; };
  document.addEventListener("keydown", spy);
  act(() => option.focus());
  const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => option.dispatchEvent(esc));
  document.removeEventListener("keydown", spy);
  expect(esc.defaultPrevented).toBe(true);
  expect(bubbled).toBe(false);
  expect(h.session.getState().selectedItemId).toBeNull();
});

it("列表内 Escape 分层：活动手势优先取消，不清选择也不退出（任务 5.4）", () => {
  const calls = { cancel: 0, exit: 0 };
  const action = {
    active: () => true,
    hasSelection: () => true,
    pending: () => false,
    deleteSelected: () => true,
    clearSelection: () => true,
    cancelGesture: () => { calls.cancel += 1; return true; }
  };
  const h = setup(true, action, () => { calls.exit += 1; });
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  act(() => option.focus());
  const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => option.dispatchEvent(esc));
  expect(calls.cancel).toBe(1);
  expect(calls.exit).toBe(0);
  expect(h.session.getState().selectedItemId).toBe("photo");
});

it("列表内 Escape 分层：无手势但有选择时只清选择、不退出（任务 5.4）", () => {
  const calls = { cancel: 0, exit: 0 };
  const action = {
    active: () => true,
    hasSelection: () => true,
    pending: () => false,
    deleteSelected: () => true,
    clearSelection: () => true,
    cancelGesture: () => { calls.cancel += 1; return false; }
  };
  const h = setup(true, action, () => { calls.exit += 1; });
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  act(() => option.focus());
  act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(calls.cancel).toBe(1);
  expect(calls.exit).toBe(0);
  expect(h.session.getState().selectedItemId).toBeNull();
});

it("列表内 Escape 分层：无手势且无选择时受控退出聚焦（任务 5.4）", () => {
  const calls = { cancel: 0, exit: 0 };
  const action = {
    active: () => true,
    hasSelection: () => false,
    pending: () => false,
    deleteSelected: () => true,
    clearSelection: () => false,
    cancelGesture: () => { calls.cancel += 1; return false; }
  };
  const h = setup(true, action, () => { calls.exit += 1; });
  act(() => h.session.select(null));
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  act(() => option.focus());
  act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(calls.exit).toBe(1);
});

it("列表内 Escape repeat 不推进层级（任务 5.3）", () => {
  const calls = { cancel: 0, exit: 0 };
  const action = {
    active: () => true,
    hasSelection: () => true,
    pending: () => false,
    deleteSelected: () => true,
    clearSelection: () => true,
    cancelGesture: () => { calls.cancel += 1; return true; }
  };
  const h = setup(true, action, () => { calls.exit += 1; });
  const option = document.querySelector('[role="option"]') as HTMLButtonElement;
  act(() => option.focus());
  act(() => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, repeat: true })));
  expect(calls.cancel).toBe(0);
  expect(calls.exit).toBe(0);
  expect(h.session.getState().selectedItemId).toBe("photo");
});


it("对象容器默认显示，列表可关闭且不要求先选择对象", () => {
  const exposed: [string, boolean][] = [];
  const h = setup(true, undefined, undefined, (id, visible) => exposed.push([id, visible]));
  act(() => h.session.select(null));
  const button = [...document.querySelectorAll("button")].find(element => element.textContent === "关闭容器")!;
  expect(button).toBeDefined();
  expect(button.disabled).toBe(false);
  act(() => button.click());
  expect(exposed).toEqual([["photo", false]]);
});


it("外显满六个时关闭按钮仍可用，隐藏对象的显示按钮禁用并说明原因", () => {
  const h = setup();
  const first = h.content.items[0];
  h.content.items = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(first), id: `object-${i}` }));
  const changes: unknown[] = [];
  const render = (hiddenContainerIds: string[]) => act(() => root!.render(<FilmSetObjectToolbar session={h.session} nodeId="film" writable readOnly={false} onDelete={() => {}} hiddenContainerIds={hiddenContainerIds} onContainerVisibilityChange={(...args) => changes.push(args)} />));
  render(["object-6", "object-7"]);
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".film-set-object-list__item > button:last-child")];
  expect(document.body.textContent).toContain("外显 6/6");
  expect(buttons().slice(0, 6).every(button => !button.disabled && button.textContent === "关闭容器")).toBe(true);
  expect(buttons().slice(6).every(button => button.disabled && button.title.includes("最多外显 6 个对象"))).toBe(true);
  render(["object-0", "object-6", "object-7"]);
  expect(document.body.textContent).toContain("外显 5/6");
  expect(buttons()[6].disabled).toBe(false);
  act(() => buttons()[6].click());
  expect(changes).toEqual([["object-6", true]]);
});
