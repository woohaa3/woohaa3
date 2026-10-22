/** @vitest-environment jsdom */
// 菜单替身只检查命令分派和可用状态，不执行图像合成。
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { EditorMenuBar } from "./photo-editor-chrome.js";
import {INITIAL_EDITOR_DISPLAY} from "./editor-display.js";
vi.mock("./ui/Menu.js", () => {
  const entries = (items: readonly import("./ui/Menu.js").MenuItem[]): ReactNode => items.map(item =>
    item.children ? <div key={item.id} data-submenu={item.id}>{entries(item.children)}</div> :
      <button key={item.id} data-command={item.id} disabled={item.disabled} onClick={() => item.onSelect(item.id)}>{item.label}</button>);
  return {DropdownMenu: ({label, items}: {label: string; items: readonly import("./ui/Menu.js").MenuItem[]}) =>
    <div data-menu={label}>{entries(items)}</div>};
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("整图与图层旋转使用不同命令，未允许入口隐藏、暂不可用入口禁用", () => {
  const ids = ["image.imageRotation.90cw", "edit.transform.rotate90Cw", "layer.delete"];
  const commands = new Map(ids.map((id) => [id, { id, allowed: true, enabled: id !== "layer.delete" } as PhotocraftCommand]));
  commands.set("layer.new.group", { id: "layer.new.group", allowed: false, enabled: true } as PhotocraftCommand);
  const onCommand = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<EditorMenuBar commands={commands} readonly={false} canUndo={false} canRedo={false}
      onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false} />));
    const image = container.querySelector<HTMLButtonElement>('[data-menu="图像"] button')!;
    expect(image.textContent).toBe("顺时针旋转图像 90°");
    act(() => image.click());
    expect(onCommand).toHaveBeenLastCalledWith("image.imageRotation.90cw");
    const layer = container.querySelector<HTMLButtonElement>('[data-menu="编辑"] [data-submenu="transform"] button')!;
    act(() => layer.click());
    expect(onCommand).toHaveBeenLastCalledWith("edit.transform.rotate90Cw");
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-menu="图层"] button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("新建图层菜单沿共用入口请求命名，提示与快捷键定义一致", () => {
  const onCommand = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<EditorMenuBar commands={new Map([["layer.new.layer", {id:"layer.new.layer",allowed:true,enabled:true} as PhotocraftCommand]])}
      readonly={false} canUndo={false} canRedo={false} onCommand={onCommand} onApply={vi.fn()}
      canSave={false} saving={false} />));
    const button = container.querySelector<HTMLButtonElement>('[data-menu="图层"] button')!;
    expect(button.textContent).toContain("新建图层");
    expect(button.textContent).toContain("Shift+N");
    act(() => button.click());
    expect(onCommand.mock.calls).toEqual([["layer.new.layer"]]);
  } finally {act(() => root.unmount());}
});

it("视图菜单使用共用显示动作和提示，禁用时不切换或分派文档命令",()=>{
  const toggle=vi.fn(),onCommand=vi.fn();
  const container=document.createElement("div");const root=createRoot(container);
  const render=(disabled=false)=>act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
    onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false}
    display={{state:INITIAL_EDITOR_DISPLAY,toggle}} displayDisabled={disabled}/>));
  try {
    render();
    const buttons=container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button');
    expect(buttons).toHaveLength(1);expect(buttons[0].textContent).toContain("选区与变换边界");
    const windows=container.querySelectorAll<HTMLButtonElement>('[data-menu="窗口"] button');
    expect(windows).toHaveLength(2);expect(windows[1].textContent).toContain("Shift+Tab");
    act(()=>[...buttons,...windows].forEach(button=>button.click()));
    expect(toggle.mock.calls).toEqual([["extras"],["panels"],["sidebar"]]);
    render(true);act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button, [data-menu="窗口"] button').forEach(button=>button.click()));
    expect(toggle).toHaveBeenCalledTimes(3);expect(onCommand).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());}
});

it("菜单变换进入会话、缩放走视图动作，未出现置入入口", () => {
  const ids = ["edit.transform", "select.transformSelection", "edit.undo", "edit.redo"];
  const commands = new Map(ids.map(id => [id, {id, allowed:true, enabled:true} as PhotocraftCommand]));
  const onCommand=vi.fn(),onTransform=vi.fn(),onView=vi.fn();
  const container=document.createElement("div"),root=createRoot(container);
  const render=(readonly=false)=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={readonly} canUndo canRedo={false}
    onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false} onTransform={onTransform} canTransform canTransformSelection
    onView={onView} viewDisabled={readonly} />));
  try {
    render();
    expect(container.textContent).not.toContain("置入");
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="edit.transform"]')!.click());
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="select.transformSelection"]')!.click());
    expect(onTransform.mock.calls).toEqual([[false],[true]]);expect(onCommand).not.toHaveBeenCalled();
    act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button').forEach(button=>button.click()));
    expect(onView.mock.calls).toEqual([["zoomIn"],["zoomOut"],["fit"],["actualSize"]]);
    expect(container.querySelector<HTMLButtonElement>('[data-command="edit.redo"]')!.disabled).toBe(true);
    render(true);
    act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu] button').forEach(button=>button.click()));
    expect(onTransform).toHaveBeenCalledTimes(2);expect(onView).toHaveBeenCalledTimes(4);expect(onCommand).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());}
});
