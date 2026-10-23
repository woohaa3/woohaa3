/** @vitest-environment jsdom */
/**
 * 自定义键位真正接管按键分派的回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 真实缺陷：域内 `resolveWithPreferences` 已能算出「改绑后旧组合失效」，但 `PhotoEditorApp`
 * 的按键分派仍调用 `resolveEditorShortcut`，于是**旧键位照旧生效、新键位没反应**——面板里改完
 * 键位像是什么都没发生。这组用例走真实的键盘事件分派，因此能锁住「外壳确实用了偏好」这件事；
 * 只测适配函数是锁不住的。
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, press } from "../src/test-support/photo-editor-harness.js";
import {
  CUSTOMIZATION_STORAGE_KEY,
  CustomizationStore,
  setDefaultCustomizationStore,
  type PreferenceStorage
} from "../../../packages/editor/src/features/customization/preferences.js";

function memoryStorage(): PreferenceStorage {
  const data: Record<string, string> = {};
  return { read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

let store: CustomizationStore;

/** `dispatch` 的替身签名是 `vi.fn()`（无参），这里统一取「最近一次命令 id」。 */
function dispatchedCommand(dispatch: { mock: { calls: unknown[][] } }): unknown {
  const call = dispatch.mock.calls.at(-1);
  return call?.[0];
}

beforeEach(() => {
  // 偏好仓库是进程级共享的；每个用例换独立仓库，避免键位设置串到下一个用例。
  store = new CustomizationStore(memoryStorage());
  setDefaultCustomizationStore(store);
});

afterEach(() => {
  setDefaultCustomizationStore(null);
  localStorage.removeItem(CUSTOMIZATION_STORAGE_KEY);
});

describe("应用按键分派消费自定义键位", () => {
  it("改绑后旧组合不再触发、新组合立即触发；解绑后两者都不触发", () => {
    const { container, dispatch } = setup();
    const editor = container.querySelector(".photo-editor")!;

    // 出厂：Mod+Z 撤销。
    expect(press(editor, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(dispatchedCommand(dispatch)).toBe("edit.undo");

    // 改绑到 Mod+U：旧组合必须失效，新组合必须生效。
    act(() => { store.setShortcut("edit.undo", "Mod+U"); });
    dispatch.mockClear();
    expect(press(editor, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(press(editor, "u", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(dispatchedCommand(dispatch)).toBe("edit.undo");

    // 解绑：两个组合都不再触发，也不会偷偷回退到出厂键位。
    act(() => { store.setShortcut("edit.undo", ""); });
    dispatch.mockClear();
    expect(press(editor, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(editor, "u", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("解绑一个动作不会连带抑制共用同一组合的其它动作", () => {
    const { container, dispatch } = setup();
    const editor = container.querySelector(".photo-editor")!;
    // 工具组共用字母：解绑「魔棒」后「快速选择」仍按 W 循环，不能整组哑掉。
    act(() => { store.setShortcut("tool.wand", ""); });
    press(editor, "w");
    // 工具切换不改文档命令，但界面必须已经离开原本的矩形选框。
    expect(container.querySelector<HTMLElement>(".photo-editor")
      ?.querySelector('[data-tool]')?.getAttribute("data-tool")).not.toBe("marquee");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("工具选项记忆", () => {
  /** 画笔参数栏里的尺寸输入（工具面）。 */
  const sizeInput = (container: HTMLElement): HTMLInputElement =>
    [...container.querySelectorAll<HTMLInputElement>(".photo-editor__contextbar input[type=number]")]
      .find((node) => node.closest("label")?.textContent?.includes("尺寸"))!;

  const setSize = (container: HTMLElement, value: number) => {
    const input = sizeInput(container);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("切走再切回画笔时恢复上次尺寸，且不写文档、不造修订", () => {    const { container, dispatch, snapshot } = setup();
    const revision = snapshot.view.document?.revision;
    const choose = (label: string) =>
      act(() => container.querySelector<HTMLButtonElement>(`.photo-editor__toolrail [aria-label="${label}"]`)!.click());

    choose("画笔");
    setSize(container, 77);
    // 写进本机偏好，而不是文档内容。
    expect(store.snapshot().preferences.toolOptions.brush?.size).toBe(77);

    choose("套索");
    choose("画笔");
    expect(sizeInput(container).value).toBe("77");
    // 工具选项属于工具偏好：修订不变、没有文档命令。
    expect(snapshot.view.document?.revision).toBe(revision);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("全新会话直接选画笔时按已记忆的选项起始（出厂 24 被覆盖）", () => {
    // 先把偏好写好，再挂载界面：证明恢复读的是偏好，而不是上一次会话的内存状态。
    act(() => { store.rememberToolOptions("brush", { size: 96, hardness: 0.35 }); });
    const { container } = setup();
    act(() => container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());
    expect(sizeInput(container).value).toBe("96");
    const hardness = [...container.querySelectorAll<HTMLInputElement>(".photo-editor__contextbar input[type=range]")]
      .find((node) => node.closest("label")?.textContent?.includes("硬度"));
    // 硬度以百分比呈现：0.35 → 35。
    expect(hardness?.value).toBe("35");
  });
});

describe("工作区应用后当场重排", () => {
  it("应用命名工作区立刻改变面板几何并如实提示，不要求重开编辑器", () => {
    // 预置一个带面板几何的工作区：宽 420、图层槽折叠。
    act(() => { store.saveWorkspace("宽面板", { panelLayout: { width: 420, layersCollapsed: true } }); });
    const preset = store.snapshot().preferences.workspaces[0]!;
    const { container } = setup();
    const sidebar = container.querySelector<HTMLElement>(".photo-editor__sidebar")!;
    // 起始不是工作区的几何。
    expect(sidebar.style.getPropertyValue("--editor-panel-width")).toBe(`${280}px`);

    // 从面板列表打开定制面板，沿真实外壳操作。
    const advanced = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "面板…")!;
    act(() => advanced.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".photo-editor__feature-picker button")].find(button => button.textContent === "工作区、快捷键与命令搜索…")!.click());
    const apply = container.querySelector<HTMLButtonElement>(`[data-workspace="${preset.id}"] button`)!;
    act(() => apply.click());

    // 当场重排：几何立刻生效，而不是等下次打开编辑器。
    expect(sidebar.style.getPropertyValue("--editor-panel-width")).toBe("420px");
    const collapsed = [...container.querySelectorAll("[data-collapsed]")].map((node) => node.getAttribute("data-collapsed"));
    // 三个槽位依次是属性 / 图层 / 历史：只有图层被工作区折叠。
    expect(collapsed.slice(0,3)).toEqual(["false", "true", "false"]);
    expect(container.querySelector("[data-customization-notice]")?.textContent).toBe("工作区已应用");
  });
});
