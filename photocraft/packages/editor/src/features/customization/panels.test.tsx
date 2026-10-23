/** @vitest-environment jsdom */
/**
 * 工作区定制面板的交互回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 只验证界面契约：搜索结果来自已接通命令、执行走同一 `dispatch` 门禁、冲突需要明确覆盖、
 * 偏好操作不触发文档命令、存储失败有可见反馈。像素与内核语义由 Rust 侧回归覆盖。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { WorkspaceCustomizationPanel, type CustomizationEndpoint } from "./panels.js";
import { CustomizationStore, CUSTOMIZATION_STORAGE_KEY, type PreferenceStorage } from "./preferences.js";
import { EDITOR_MENUS } from "../../photo-editor-menu.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

function command(patch: Partial<PhotocraftCommand> & { id: string }): PhotocraftCommand {
  return {
    id: patch.id,
    label: patch.label ?? patch.id,
    menu: patch.menu ?? ["编辑"],
    shortcut: patch.shortcut ?? null,
    params: "{}",
    enabled: patch.enabled ?? true,
    disabledReason: patch.disabledReason ?? null,
    needsDocument: patch.needsDocument ?? true,
    allowed: patch.allowed ?? true
  };
}

/** 由基础命令表派生一份覆盖指定字段的新表（模拟控制器推送新快照）。 */
function commandsWith(patch: Record<string, Partial<PhotocraftCommand>>): Map<string, PhotocraftCommand> {
  const base = [
    command({ id: "edit.undo", label: "撤销", shortcut: "Cmd+Z" }),
    command({ id: "edit.copy", label: "复制" }),
    command({ id: "edit.redo", label: "重做" }),
    command({ id: "layer.mergeVisible", label: "合并可见图层", enabled: false, disabledReason: "没有可见图层" })
  ];
  return new Map(base.map((entry) => [entry.id, { ...entry, ...patch[entry.id] }]));
}

function memoryStorage(): PreferenceStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

function setup(options: { storage?: PreferenceStorage | null; dispatch?: CustomizationEndpoint["dispatch"]; commands?: Map<string, PhotocraftCommand> } = {}) {
  const commands = options.commands ?? new Map<string, PhotocraftCommand>([
    ["edit.undo", command({ id: "edit.undo", label: "撤销", shortcut: "Cmd+Z" })],
    ["edit.copy", command({ id: "edit.copy", label: "复制" })],
    ["edit.redo", command({ id: "edit.redo", label: "重做" })],
    ["layer.mergeVisible", command({ id: "layer.mergeVisible", label: "合并可见图层", enabled: false, disabledReason: "没有可见图层" })],
    ["filter.liquify", command({ id: "filter.liquify", label: "液化", allowed: false })]
  ]);
  const dispatch = vi.fn(options.dispatch ?? (() => ({ ok: true as const, value: null })));
  // 订阅端口可选：控制器推新命令表时面板必须刷新（真实控制器在每次写操作后推送）。
  const listeners = new Set<() => void>();
  const commandTable = { value: commands };
  const controller: CustomizationEndpoint = {
    snapshot: () => ({ commands: commandTable.value }),
    dispatch,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const pushCommands = (next: Map<string, PhotocraftCommand>) => act(() => {
    commandTable.value = next;
    for (const listener of listeners) listener();
  });
  const store = new CustomizationStore(options.storage === undefined ? memoryStorage() : options.storage);
  const capturePanelLayout = vi.fn(() => ({ width: 320, floating: true }));
  const applyPanelLayout = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (readonly = false) => act(() => root!.render(
    <WorkspaceCustomizationPanel controller={controller} locked={readonly} store={store}
      capturePanelLayout={capturePanelLayout} applyPanelLayout={applyPanelLayout} />
  ));
  render();
  const search = () => container.querySelector<HTMLInputElement>("[data-command-search]")!;
  const hits = () => [...container.querySelectorAll<HTMLElement>("[data-command-hit]")];
  const type = (value: string) => act(() => {
    const input = search();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const press = (key: string, init: KeyboardEventInit = {}) => act(() => {
    search().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  return { container, commands, dispatch, store, capturePanelLayout, applyPanelLayout, render, search, hits, type, press, pushCommands };
}

describe("命令搜索", () => {
  it("默认列出已接通命令，未开放命令不出现", () => {
    const { hits } = setup();
    const ids = hits().map((hit) => hit.dataset.commandHit);
    expect(ids).toContain("edit.undo");
    expect(ids).not.toContain("filter.liquify");
  });

  it("内核自报英文名时，搜索显示菜单中文标签且中文/英文都能命中", () => {
    // 真实内核命令表给的是英文 label（Undo/Redo），界面菜单是中文。面板必须用同一 id 换成菜单
    // 标签，否则用户照着屏幕上写的「撤销」搜不到任何结果。
    const { hits, type } = setup({
      commands: new Map<string, PhotocraftCommand>([
        ["edit.undo", command({ id: "edit.undo", label: "Undo", shortcut: "Cmd+Z" })],
        ["edit.redo", command({ id: "edit.redo", label: "Redo", shortcut: "Cmd+Shift+Z" })]
      ])
    });
    // 默认列表的标题就是中文，不是内核的 Undo。
    const labels = hits().map((hit) => hit.textContent ?? "");
    expect(labels.some((text) => text.includes("撤销"))).toBe(true);
    expect(labels.some((text) => text.includes("Undo"))).toBe(false);
    // 中文查询命中。
    type("撤销");
    expect(hits().map((hit) => hit.dataset.commandHit)).toEqual(["edit.undo"]);
    // 英文仍能命中同一条命令。
    type("undo");
    expect(hits().map((hit) => hit.dataset.commandHit)).toEqual(["edit.undo"]);
  });

  it("回车执行同一命令门，并记录最近使用", () => {
    const { dispatch, type, press, hits, container } = setup();
    type("撤销");
    expect(hits().map((hit) => hit.dataset.commandHit)).toEqual(["edit.undo"]);
    press("Enter");
    expect(dispatch).toHaveBeenCalledWith("edit.undo");
    expect(container.querySelector("[data-customization-notice]")?.textContent).toContain("已执行");
  });

  it("禁用命令显示原因且不执行，执行失败保留可见错误", () => {
    const dispatch = vi.fn(() => ({ ok: false as const, code: "frozen", message: "导出期间不接受内容修改" }));
    const { type, press, hits, container } = setup({ dispatch });
    type("合并");
    expect(hits()[0]?.querySelector("button")?.disabled).toBe(true);
    press("Enter");
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-customization-message]")?.textContent).toContain("没有可见图层");

    type("撤销");
    press("Enter");
    expect(dispatch).toHaveBeenCalledWith("edit.undo");
    expect(container.querySelector("[data-customization-message]")?.textContent).toContain("导出期间不接受内容修改");
  });

  it("输入法合成中不执行，方向键只移动高亮", () => {
    const { dispatch, type, press, hits } = setup();
    type("撤");
    press("Enter", { isComposing: true });
    press("Enter", { keyCode: 229 });
    expect(dispatch).not.toHaveBeenCalled();
    type("");
    const before = hits().length;
    press("ArrowDown");
    expect(hits().length).toBe(before);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("只读预览下搜索不执行命令", () => {
    const { dispatch, type, press, render, container } = setup();
    render(true);
    type("撤销");
    press("Enter");
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-customization-message]")?.textContent).toContain("只读");
  });

  it("浏览器保留键显示提示但仍可保存", () => {
    const { container, store } = setup();
    act(() => { store.setShortcut("edit.undo", "Mod+W"); });
    const row = container.querySelector('[data-shortcut-action="edit.undo"]')!;
    expect(row.querySelector("kbd")?.textContent).toContain("浏览器可能拦截");
    expect(row.querySelector("kbd")?.getAttribute("title")).toContain("改用菜单或命令搜索");
  });

  it("没有匹配时给出空结果说明", () => {
    const { type, hits, container } = setup();
    type("液化");
    expect(hits()).toEqual([]);
    expect(container.querySelector("[data-command-empty]")?.textContent).toBe("没有匹配的已接通命令");
  });

  it("搜索结果随控制器命令表刷新，且显示当前生效的组合", () => {
    const { container, dispatch, store, pushCommands } = setup();
    // 用户自定义组合后，搜索结果立刻按新绑定显示。
    act(() => store.setShortcut("edit.undo", "Mod+U"));
    const row = container.querySelector('[data-command-hit="edit.undo"]')!;
    expect(row.textContent).toContain("Ctrl+U");
    expect(row.textContent).not.toContain("Ctrl+Z");

    // 解绑后不显示过期提示。
    act(() => { store.setShortcut("edit.undo", ""); });
    expect(container.querySelector('[data-command-hit="edit.undo"]')?.textContent).not.toContain("Ctrl+U");

    // 控制器推送新的命令表（例如撤销后「重做」变为可用）时，禁用状态与原因同步更新。
    act(() => store.setShortcut("edit.undo", "Mod+Z"));
    expect(container.querySelector<HTMLButtonElement>('[data-command-hit="layer.mergeVisible"] button')?.disabled).toBe(true);
    const refreshed = new Map(commandsWith({ "layer.mergeVisible": { enabled: true, disabledReason: null } }));
    pushCommands(refreshed);
    expect(container.querySelector<HTMLButtonElement>('[data-command-hit="layer.mergeVisible"] button')?.disabled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("快捷键定制", () => {
  it("捕获组合键后保存，冲突需要覆盖或取消", () => {
    const { container, store } = setup();
    const bind = (actionId: string) => act(() =>
      [...container.querySelectorAll<HTMLElement>("[data-shortcut-action]")].find((row) => row.dataset.shortcutAction === actionId)!
        .querySelector<HTMLButtonElement>("button")!.click()
    );
    bind("edit.redo");
    const capture = () => container.querySelector<HTMLElement>('[data-shortcut-capture="edit.redo"]')!;
    act(() => capture().dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(container.querySelector("[data-shortcut-conflict-prompt]")?.textContent).toContain("已被「复制、重做」使用");
    expect(container.querySelector("[data-shortcut-conflict-prompt]")?.textContent).toContain("复制");
    expect(store.snapshot().preferences.shortcuts["edit.redo"]).toBeUndefined();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-shortcut-conflict-prompt] button")];
    act(() => buttons.find((button) => button.textContent === "取消")!.click());
    expect(store.snapshot().preferences.shortcuts["edit.redo"]).toBeUndefined();

    bind("edit.redo");
    act(() => capture().dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true })));
    const overwrite = [...container.querySelectorAll<HTMLButtonElement>("[data-shortcut-conflict-prompt] button")].find((button) => button.textContent === "覆盖")!;
    act(() => overwrite.click());
    expect(store.snapshot().preferences.shortcuts).toMatchObject({ "edit.redo": "Mod+C", "edit.copy": "" });
  });

  it("输入法合成中不绑定，Esc 取消捕获", () => {
    const { container, store } = setup();
    const bind = (actionId: string) => act(() =>
      [...container.querySelectorAll<HTMLElement>("[data-shortcut-action]")].find((row) => row.dataset.shortcutAction === actionId)!
        .querySelector<HTMLButtonElement>("button")!.click()
    );
    bind("edit.undo");
    const capture = () => container.querySelector<HTMLElement>('[data-shortcut-capture="edit.undo"]')!;
    act(() => capture().dispatchEvent(new KeyboardEvent("keydown", { key: "Process", isComposing: true, bubbles: true, cancelable: true })));
    expect(store.snapshot().preferences.shortcuts).toEqual({});
    expect(container.querySelector('[data-shortcut-capture="edit.undo"]')).not.toBeNull();
    act(() => capture().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[data-shortcut-capture="edit.undo"]')).toBeNull();
  });

  it("恢复出厂按键只清覆盖，不改其它分组", () => {
    const { container, store } = setup();
    act(() => { store.setShortcut("edit.undo", "Mod+U"); });
    act(() => root!.render(
      <WorkspaceCustomizationPanel controller={{ snapshot: () => ({ commands: new Map() }), dispatch: vi.fn() }} locked={false} store={store} capturePanelLayout={() => null} applyPanelLayout={vi.fn()} />
    ));
    act(() => container.querySelector<HTMLButtonElement>('[data-shortcut-action="edit.undo"] button:nth-of-type(2)')!.click());
    expect(store.snapshot().preferences.shortcuts).toEqual({});
  });

  it("解绑清掉键盘组合但保留动作入口，出厂可再恢复", () => {
    const { container, store } = setup();
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-shortcut-action="edit.undo"] button')]
      .find((button) => button.textContent === label)!;

    // 出厂组合可以直接解绑：用户不需要先随便改绑一次才能「不要这个键」。
    expect(find("解绑").disabled).toBe(false);
    act(() => find("绑定").click());
    act(() => {
      const capture = container.querySelector<HTMLElement>('[data-shortcut-capture="edit.undo"]')!;
      capture.dispatchEvent(new KeyboardEvent("keydown", { key: "u", code: "KeyU", ctrlKey: true, bubbles: true }));
    });
    expect(store.snapshot().preferences.shortcuts["edit.undo"]).toBe("Mod+U");
    expect(find("解绑").disabled).toBe(false);

    act(() => find("解绑").click());
    expect(store.snapshot().preferences.shortcuts["edit.undo"]).toBe("");
    expect(container.querySelector('[data-shortcut-action="edit.undo"] kbd')?.textContent).toContain("未绑定");
    expect(container.querySelector("[data-customization-notice]")?.textContent).toContain("已解除该动作的快捷键");

    // 已空绑时「解绑」不可点（没有可解的）；「出厂」把组合恢复回来。
    expect(find("解绑").disabled).toBe(true);
    act(() => find("出厂").click());
    expect(store.snapshot().preferences.shortcuts["edit.undo"]).toBeUndefined();
    expect(find("解绑").disabled).toBe(false);
  });

  it("出厂组合无需先改绑即可直接解绑", () => {
    const { container, store } = setup();
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-shortcut-action="edit.undo"] button')]
      .find((button) => button.textContent === label)!;
    // 未做任何自定义时直接解绑：写入空串覆盖，出厂组合不再生效。
    expect(find("解绑").disabled).toBe(false);
    act(() => find("解绑").click());
    expect(store.snapshot().preferences.shortcuts["edit.undo"]).toBe("");
    expect(container.querySelector('[data-shortcut-action="edit.undo"] kbd')?.textContent).toContain("未绑定");
    // 再点一次不可点（已经是空的），避免重复写入。
    expect(find("解绑").disabled).toBe(true);
  });
});

describe("工具栏、菜单与工作区", () => {
  it("隐藏工具栏工具与菜单项写入偏好，不执行文档命令", () => {
    const { container, store, dispatch } = setup();
    const toolbar = container.querySelector<HTMLInputElement>('[data-toolbar-tool="tool.brush"] input')!;
    act(() => toolbar.click());
    expect(store.snapshot().preferences.toolbarHidden).toContain("tool.brush");

    const menuLeaf = EDITOR_MENUS.flatMap((menu) => menu.items).find((item) => !item.children)!;
    const checkbox = container.querySelector<HTMLInputElement>(`[data-menu-item="${menuLeaf.id}"] input`)!;
    act(() => checkbox.click());
    expect(store.snapshot().preferences.menuHidden).toContain(menuLeaf.id);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("保存工作区捕获面板几何，应用时交回布局端口", () => {
    const { container, store, capturePanelLayout, applyPanelLayout } = setup();
    const name = container.querySelector<HTMLInputElement>('[data-customization-section="workspaces"] input[type="text"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "审查");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>('[data-customization-section="workspaces"] button')]
      .find((button) => button.textContent === "保存当前工作区")!;
    act(() => save.click());
    expect(capturePanelLayout).toHaveBeenCalled();
    const preset = store.snapshot().preferences.workspaces[0]!;
    expect(preset).toMatchObject({ name: "审查", panelLayout: { width: 320, floating: true } });

    const apply = container.querySelector<HTMLButtonElement>(`[data-workspace="${preset.id}"] button`)!;
    act(() => apply.click());
    expect(applyPanelLayout).toHaveBeenCalledWith({ width: 320, floating: true });
    // 外壳提供实时重排端口时不再宣称「需要重开编辑器」。
    expect(container.querySelector("[data-customization-notice]")?.textContent).toBe("工作区已应用");

    const remove = [...container.querySelectorAll<HTMLButtonElement>(`[data-workspace="${preset.id}"] button`)]
      .find((button) => button.textContent === "删除")!;
    act(() => remove.click());
    expect(store.snapshot().preferences.workspaces).toEqual([]);
    expect(container.querySelector("[data-workspace-empty]")).not.toBeNull();
  });
});

describe("偏好存储反馈", () => {
  it("本机存储不可用或写入失败时明确提示，并保留原设置", () => {
    const { container, store } = setup({ storage: null });
    expect(container.querySelector("[data-customization-storage]")?.textContent).toContain("本机存储");
    expect(container.querySelector("[data-customization-persistence]")?.textContent).toContain("只在本次会话内保留");
    act(() => container.querySelector<HTMLInputElement>('[data-toolbar-tool="tool.brush"] input')!.click());
    expect(store.snapshot().preferences.toolbarHidden).toContain("tool.brush");

    const failing: PreferenceStorage = { read: () => null, write: () => { throw new Error("quota"); } };
    const second = setup({ storage: failing });
    act(() => second.container.querySelector<HTMLInputElement>('[data-toolbar-tool="tool.brush"] input')!.click());
    expect(second.container.querySelector("[data-customization-message]")?.textContent).toContain("无法写入本机偏好存储");
    expect(second.store.snapshot().preferences.toolbarHidden).toEqual([]);
  });

  it("导出给出可直接解析的 JSON，全部恢复出厂清空偏好", () => {
    const storage = memoryStorage();
    const { container, store } = setup({ storage });
    act(() => container.querySelector<HTMLInputElement>('[data-toolbar-tool="tool.brush"] input')!.click());
    expect(JSON.parse(storage.data[CUSTOMIZATION_STORAGE_KEY]!).toolbarHidden).toEqual(["tool.brush"]);

    const reset = [...container.querySelectorAll<HTMLButtonElement>('[data-customization-section="storage"] button')]
      .find((button) => button.textContent === "全部恢复出厂")!;
    act(() => reset.click());
    expect(store.snapshot().preferences).toEqual({ ...store.snapshot().preferences, toolbarHidden: [], toolbarOrder: null, menuHidden: [], shortcuts: {}, workspaces: [], toolOptions: {}, activeWorkspace: null });
    expect(container.querySelector("[data-customization-notice]")?.textContent).toContain("恢复出厂");
  });

  it("导出走宿主端口；离线不可下载时明确说明而不是假装已保存", () => {
    const exported = vi.fn((_text: string) => true);
    const store = new CustomizationStore(memoryStorage());
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(
      <WorkspaceCustomizationPanel controller={{ snapshot: () => ({ commands: new Map() }), dispatch: vi.fn() }}
        locked={false} store={store} capturePanelLayout={() => null} exportPreferences={exported} />
    ));
    const button = [...container.querySelectorAll<HTMLButtonElement>('[data-customization-section="storage"] button')]
      .find((entry) => entry.textContent === "导出 JSON")!;
    act(() => button.click());
    expect(exported).toHaveBeenCalledTimes(1);
    expect(JSON.parse(exported.mock.calls[0]![0])).toMatchObject({ version: 1 });
    expect(container.querySelector("[data-customization-notice]")?.textContent).toContain("偏好 JSON 已保存为");

    const offline = vi.fn((_text: string) => false);
    act(() => root!.render(
      <WorkspaceCustomizationPanel controller={{ snapshot: () => ({ commands: new Map() }), dispatch: vi.fn() }}
        locked={false} store={store} capturePanelLayout={() => null} exportPreferences={offline} />
    ));
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[data-customization-section="storage"] button')]
      .find((entry) => entry.textContent === "导出 JSON")!.click());
    expect(container.querySelector("[data-customization-notice]")?.textContent).toContain("无法自动下载");
  });

  it("导入时被丢弃的条目在界面说清楚，不静默少设置", async () => {
    const { container, store } = setup();
    const input = container.querySelector<HTMLInputElement>('[data-customization-import] input[type="file"]')!;
    const file = new File([JSON.stringify({ version: 1, shortcuts: { "edit.undo": "Mod+U", "nope.command": "Mod+K" } })], "prefs.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    // 文件读取是异步的，等一拍再断言。
    await act(async () => { await Promise.resolve(); });

    expect(store.snapshot().preferences.shortcuts).toEqual({ "edit.undo": "Mod+U" });
    const notice = container.querySelector("[data-customization-notice]")?.textContent ?? "";
    expect(notice).toContain("偏好已导入");
    expect(notice).toContain("未知动作「nope.command」");
  });

  it("文档门禁只挡命令执行，偏好编辑仍可用且不造内容修改", () => {
    const { container, store, dispatch, render, type, press } = setup();
    act(() => { store.setShortcut("edit.undo", "Mod+U"); });
    render(true);
    // 唯一被门禁挡住的是命令执行（搜索/回车不落任何写操作）。
    type("撤销");
    press("Enter");
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-customization-message]")?.textContent).toContain("当前不可执行命令");
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('[data-customization-section="toolbar"] input[type="checkbox"], [data-customization-section="menus"] input[type="checkbox"]')) {
      expect(checkbox.disabled).toBe(false);
    }
    // 偏好是工具状态：仍可保存，且不会借道执行文档命令。
    act(() => container.querySelector<HTMLInputElement>('[data-toolbar-tool="tool.brush"] input')!.click());
    expect(store.snapshot().preferences.toolbarHidden).toContain("tool.brush");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
