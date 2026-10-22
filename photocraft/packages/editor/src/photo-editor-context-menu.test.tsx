/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { EditorCanvasMenu } from "./photo-editor-context-menu.js";
import { UiProvider } from "./ui/UiProvider.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const commands = new Map(["edit.transform", "select.transformSelection", "select.deselect"]
  .map(id => [id, {id,allowed:true,enabled:true} as PhotocraftCommand]));
async function mount(overrides: Partial<ComponentProps<typeof EditorCanvasMenu>> = {}) {
  const onTransform = vi.fn(), onEndTransform = vi.fn(), onCommand = vi.fn();
  const hostContext = vi.fn(), hostKey = vi.fn();
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<UiProvider><div onContextMenu={hostContext} onKeyDown={hostKey}>
    <EditorCanvasMenu commands={commands} disabled={false} transforming={false} canTransform
      canTransformSelection={false} canConfirm hasGesture={() => false}
      onTransform={onTransform} onEndTransform={onEndTransform} onCommand={onCommand} {...overrides}>
      <div data-surface /><textarea />
    </EditorCanvasMenu>
  </div></UiProvider>));
  return {container,onTransform,onEndTransform,onCommand,hostContext,hostKey};
}
async function context(target: Element) {
  // 每次鼠标输入是独立任务，先完成 Radix 上一次关闭后的焦点恢复。
  await act(async () => { await new Promise(resolve => setTimeout(resolve,0)); });
  const event = new MouseEvent("contextmenu",{button:2,clientX:180,clientY:140,bubbles:true,cancelable:true});
  await act(async () => target.dispatchEvent(event));
  return event;
}
function item(label: string) {
  return [...document.querySelectorAll<HTMLElement>(".ui-menu__item")].find(node => node.textContent === label)!;
}

it("图片右键阻止原生和宿主菜单，按当前选区提供变换及取消选择", async () => {
  const {container,onTransform,onCommand,hostContext} = await mount({canTransformSelection:true});
  const surface = container.querySelector("[data-surface]")!;
  expect((await context(surface)).defaultPrevented).toBe(true);
  expect(hostContext).not.toHaveBeenCalled();
  const anchor = container.querySelector<HTMLElement>(".ui-menu__anchor")!;
  expect([anchor.style.left,anchor.style.top]).toEqual(["180px","140px"]);
  await act(async () => item("变换选区").click());
  expect(onTransform.mock.calls).toEqual([[true]]);
  await context(surface);
  await act(async () => item("取消选择").click());
  expect(onCommand.mock.calls).toEqual([["select.deselect"]]);
});

it("变换中 Esc 只关闭菜单，确认和取消分别结束当前会话", async () => {
  const {container,onEndTransform,hostKey} = await mount({transforming:true});
  const surface = container.querySelector("[data-surface]")!;
  await context(surface);
  expect(item("自由变换")).toBeUndefined();
  await act(async () => document.querySelector("[data-cursor-menu]")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(document.querySelector("[data-cursor-menu]")).toBeNull();
  expect(onEndTransform).not.toHaveBeenCalled(); expect(hostKey).not.toHaveBeenCalled();
  await context(surface); await act(async () => item("确认变换").click());
  await context(surface); await act(async () => item("取消变换").click());
  expect(onEndTransform.mock.calls).toEqual([[true],[false]]);
});

it.each([{disabled:true},{hasGesture:() => true}])("只读、草稿或拖动期间不打开菜单：%o", async overrides => {
  const {container,onTransform} = await mount(overrides);
  expect((await context(container.querySelector("[data-surface]")!)).defaultPrevented).toBe(true);
  expect(document.querySelector("[data-cursor-menu]")).toBeNull();
  expect(onTransform).not.toHaveBeenCalled();
});

it("禁用命令、缺少变换外框和无效变换参数无法确认", async () => {
  const {container,onTransform} = await mount({commands:new Map(),canTransform:false});
  await context(container.querySelector("[data-surface]")!);
  expect(item("自由变换").hasAttribute("data-disabled")).toBe(true);
  await act(async () => item("自由变换").click()); expect(onTransform).not.toHaveBeenCalled();
  expect(item("变换选区")).toBeUndefined();
  act(() => root!.unmount());
  const next = await mount({transforming:true,canConfirm:false});
  await context(next.container.querySelector("[data-surface]")!);
  expect(item("确认变换").hasAttribute("data-disabled")).toBe(true);
  expect(item("取消变换").hasAttribute("data-disabled")).toBe(false);
});

it("原位文字保留浏览器右键，菜单本身右键不再弹出浏览器菜单", async () => {
  const {container,hostContext} = await mount();
  expect((await context(container.querySelector("textarea")!)).defaultPrevented).toBe(false);
  expect(document.querySelector("[data-cursor-menu]")).toBeNull();
  expect(hostContext).not.toHaveBeenCalled();
  await context(container.querySelector("[data-surface]")!);
  expect((await context(item("自由变换"))).defaultPrevented).toBe(true);
  expect(document.querySelectorAll("[data-cursor-menu]")).toHaveLength(1);
});
