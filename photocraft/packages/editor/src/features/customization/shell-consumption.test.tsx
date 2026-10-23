/** @vitest-environment jsdom */
/**
 * 外壳真正消费偏好的回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 这一组测试针对的是**最危险的失败模式**：适配层函数齐全、单元测试全绿，但外壳根本没接入，
 * 于是「自定义快捷键」实际不生效。因此这里断言的是**外壳组件**的行为，而不是适配函数本身：
 * - 菜单栏隐藏项消失、快捷键提示跟随当前绑定（解绑后不再显示出厂组合）；
 * - 工具栏按偏好顺序/隐藏渲染，共用按钮的工具组隐藏一项不连累另一项；
 * - 「窗口」菜单出现定制入口。
 *
 * 同时验证外壳读的是**订阅**而不是一次性快照：仓库在渲染后改变，界面必须跟着刷新。
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { EditorMenuBar, EditorToolRail } from "../../photo-editor-chrome.js";
import { INITIAL_EDITOR_DISPLAY } from "../../editor-display.js";
import { CustomizationStore, setDefaultCustomizationStore, type PreferenceStorage } from "./preferences.js";

vi.mock("../../ui/Menu.js", () => {
  const entries = (items: readonly import("../../ui/Menu.js").MenuItem[]): ReactNode => items.map(item =>
    item.children ? <div key={item.id} data-submenu={item.id}>{entries(item.children)}</div> :
      <button key={item.id} data-command={item.id} disabled={item.disabled} onClick={() => item.onSelect(item.id)}>{item.label}</button>);
  return {
    DropdownMenu: ({ label, items }: { label: string; items: readonly import("../../ui/Menu.js").MenuItem[] }) =>
      <div data-menu={label}>{entries(items)}</div>
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(): PreferenceStorage {
  const data: Record<string, string> = {};
  return { read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

let root: Root | null = null;
function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  // 共享仓库是进程级的；每个用例换成独立仓库，避免互相污染。
  setDefaultCustomizationStore(null);
});

function commandsFor(ids: readonly string[]): Map<string, PhotocraftCommand> {
  return new Map(ids.map((id) => [id, {
    id, label: id, menu: "编辑", shortcut: null, params: "{}",
    enabled: true, disabledReason: null, needsDocument: true, allowed: true
  } as unknown as PhotocraftCommand]));
}

function menuBar(commands: Map<string, PhotocraftCommand>): HTMLDivElement {
  return mount(
    <EditorMenuBar commands={commands} readonly={false} canUndo canRedo={false}
      onCommand={vi.fn()} onApply={vi.fn()} canSave={false} saving={false}
      onOpenFeature={vi.fn()} display={{ state: INITIAL_EDITOR_DISPLAY, toggle: vi.fn() }} />
  );
}

function toolRail(): HTMLDivElement {
  return mount(
    <EditorToolRail tool="move" onTool={vi.fn()} readonly={false}
      color="#000000" onColor={vi.fn()} />
  );
}

/** 换上独立仓库并设为外壳读取的共享仓库。 */
function useStore(): CustomizationStore {
  const store = new CustomizationStore(memoryStorage());
  setDefaultCustomizationStore(store);
  return store;
}

describe("菜单栏消费偏好", () => {
  it("隐藏的菜单项从界面消失，其它项保留", () => {
    const store = useStore();
    const commands = commandsFor(["edit.undo", "edit.redo"]);
    act(() => { store.setMenuHidden(["edit.redo"]); });
    const container = menuBar(commands);
    expect(container.querySelector('[data-command="edit.undo"]')).not.toBeNull();
    expect(container.querySelector('[data-command="edit.redo"]')).toBeNull();
    // 运行时取消隐藏后立即回到界面（说明读的是订阅，不是一次性快照）。
    act(() => { store.setMenuHidden([]); });
    expect(container.querySelector('[data-command="edit.redo"]')).not.toBeNull();
  });

  it("快捷键提示跟随自定义绑定，解绑后不再显示出厂组合", () => {
    const store = useStore();
    const container = menuBar(commandsFor(["edit.undo"]));
    const editMenu = () => container.querySelector('[data-menu="编辑"]')!.textContent ?? "";

    expect(editMenu()).toContain("Ctrl+Z");
    act(() => { store.setShortcut("edit.undo", "Mod+U"); });
    expect(editMenu()).toContain("Ctrl+U");
    expect(editMenu()).not.toContain("Ctrl+Z");
    act(() => { store.setShortcut("edit.undo", ""); });
    expect(editMenu()).not.toContain("Ctrl+Z");
    expect(editMenu()).not.toContain("Ctrl+U");
  });

  it("「窗口」菜单出现工作区定制入口，且能打开对应面板", () => {
    useStore();
    const onOpenFeature = vi.fn();
    const container = mount(
      <EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
        onCommand={vi.fn()} onApply={vi.fn()} canSave={false} saving={false}
        onOpenFeature={onOpenFeature} display={{ state: INITIAL_EDITOR_DISPLAY, toggle: vi.fn() }} />
    );
    const windowMenu = container.querySelector('[data-menu="窗口"]')!;
    expect(windowMenu.textContent).toContain("工作区、快捷键与命令搜索");
    act(() => { container.querySelector<HTMLButtonElement>('[data-command="feature.customization"]')!.click(); });
    expect(onOpenFeature).toHaveBeenCalledWith("customization");
  });
});

describe("工具栏消费偏好", () => {
  const labels = (container: HTMLDivElement): string[] =>
    [...container.querySelectorAll(".photo-editor__toolrail [aria-label]")].map((node) => node.getAttribute("aria-label") ?? "");

  it("隐藏的工具从工具栏消失，顺序偏好生效", () => {
    const store = useStore();
    act(() => { store.setToolbarHidden(["tool.brush"]); });
    const container = toolRail();
    expect(labels(container)).not.toContain("画笔");
    expect(labels(container)).toContain("橡皮");
    // 把钢笔提到最前：第一颗按钮换成钢笔。
    act(() => { store.setToolbarOrder(["tool.pen", "tool.move"]); });
    expect(labels(container)[0]).toBe("钢笔");
  });

  it("隐藏组内一个工具不连累同组另一个（魔棒/快速选择）", () => {
    const store = useStore();
    act(() => { store.setToolbarHidden(["tool.quick"]); });
    const container = toolRail();
    // 组按钮仍在（代表魔棒），整组没有消失。
    expect(labels(container)).toContain("魔棒");
    // 隐藏魔棒后组按钮仍在，代表换成快速选择。
    act(() => { store.setToolbarHidden(["tool.wand"]); });
    expect(labels(container)).toContain("快速选择");
    expect(labels(container)).not.toContain("魔棒");
    // 两个都隐藏，整组才消失。
    act(() => { store.setToolbarHidden(["tool.wand", "tool.quick"]); });
    expect(labels(container)).not.toContain("魔棒");
    expect(labels(container)).not.toContain("快速选择");
  });
});
