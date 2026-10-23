/**
 * 外壳接入适配回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 适配层是「域内实现」与「共享外壳」之间唯一的新增契约：偏好必须先翻译成外壳既有的
 * `EditorShortcut`、菜单项与工具栏顺序形状，外壳才只需要加一行调用。这里锁定：
 * - 每个出厂绑定翻译出的分派形状与 `resolveEditorShortcut` 一致（不存在第二套语义）；
 * - 未绑定的按键返回 `null`，让外壳回退出厂解析；
 * - 菜单/工具栏/面板几何/画笔选项的过滤与恢复都只读偏好、不改偏好。
 */
import { describe, expect, it } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { DEFAULT_PANEL_LAYOUT } from "../../editor-panel-layout.js";
import { EDITOR_MENUS } from "../../photo-editor-menu.js";
import { resolveEditorShortcut } from "../../photo-editor-shortcuts.js";
import { paletteEntries } from "./command-palette.js";
import {
  CUSTOMIZATION_ACTIONS,
  CUSTOMIZATION_TOOL_ACTIONS,
  CustomizationStore,
  chordFromEvent,
  defaultPreferences,
  effectiveChord,
  parseChord,
  type CustomizationPreferences,
  type PreferenceStorage
} from "./preferences.js";
import {
  brushOptionValues,
  filterHiddenMenuItems,
  isMenuItemHidden,
  preferredChordLabel,
  preferredShortcut,
  restoreBrushOptions,
  resolveWithPreferences,
  shortcutForAction,
  shortcutHint,
  storedToolOptions,
  toolbarOrderedIds,
  toolbarRenderGroups,
  toolbarToolIds,
  workspacePanelLayout
} from "./shell-adapter.js";

function memoryStorage(): PreferenceStorage {
  const data: Record<string, string> = {};
  return { read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

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

type KeyInput = Parameters<typeof resolveEditorShortcut>[0];

/** 组合文本 → 键盘事件替身（`Mod` 在非 macOS 上是 ctrl）。 */
function eventForChord(chord: string, isMac = false): KeyInput {
  const parsed = parseChord(chord);
  if (!parsed.ok || !parsed.chord) throw new Error(`无法解析组合：${chord}`);
  const { key, mod, alt, shift } = parsed.chord;
  const named = /^(Tab|Escape|Enter|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|F\d{1,2})$/.test(key);
  return {
    key: named ? key : key.toLowerCase(),
    code: key === "[" ? "BracketLeft" : key === "]" ? "BracketRight" : /^[A-Z]$/.test(key) ? `Key${key}` : "",
    ctrlKey: mod && !isMac,
    metaKey: mod && isMac,
    altKey: alt,
    shiftKey: shift,
    isComposing: false,
    keyCode: 0
  };
}

describe("按键翻译与出厂解析一致", () => {
  it("每个出厂绑定的分派形状与 resolveEditorShortcut 相同", () => {
    const preferences = defaultPreferences();
    for (const action of CUSTOMIZATION_ACTIONS) {
      if (!action.defaultChord) continue;
      const event = eventForChord(action.defaultChord);
      // 共用组合的工具组保留出厂循环语义，因此这里对全部动作都要求与出厂解析一致：
      // 自定义键位不能改变「同一字母在组内切换」这个既有行为。
      expect(preferredShortcut(preferences, event, false), action.id).toEqual(resolveEditorShortcut(event, false));
    }
  });

  it("工具组共用一个字母时仍按组内循环，独占绑定直达该工具", () => {
    const store = new CustomizationStore(memoryStorage());
    // 出厂 W / J 是组内共用：偏好命中后仍交给出厂解析器的组内循环。
    expect(preferredShortcut(store.snapshot().preferences, eventForChord("W"), false)).toEqual({ kind: "tool", tool: "wand", cycle: false });
    // 把快速选择改成独占字母后，该字母直达该工具。
    store.setShortcut("tool.quick", "Q");
    expect(preferredShortcut(store.snapshot().preferences, eventForChord("Q"), false)).toEqual({ kind: "tool", tool: "quick", cycle: false });
    expect(preferredShortcut(store.snapshot().preferences, eventForChord("W"), false)).toEqual({ kind: "tool", tool: "wand", cycle: false });
  });

  it("自定义绑定替换出厂按键，解绑后回退到出厂解析", () => {
    const store = new CustomizationStore(memoryStorage());
    const preferences = store.snapshot().preferences;
    expect(preferredShortcut(preferences, eventForChord("Mod+Z"), false)).toEqual({ kind: "command", id: "edit.undo" });

    store.setShortcut("edit.undo", "Mod+U");
    const custom = store.snapshot().preferences;
    expect(preferredShortcut(custom, eventForChord("Mod+U"), false)).toEqual({ kind: "command", id: "edit.undo" });
    // 旧出厂键位不再由偏好命中，但外壳仍可用出厂解析兜底（这里只断言偏好不再认领）。
    expect(preferredShortcut(custom, eventForChord("Mod+Z"), false)).toBeNull();
    expect(resolveEditorShortcut(eventForChord("Mod+Z"), false)).toEqual({ kind: "command", id: "edit.undo" });

    store.setShortcut("edit.undo", "");
    expect(preferredShortcut(store.snapshot().preferences, eventForChord("Mod+U"), false)).toBeNull();
  });

  it("输入法合成、平台错误修饰键与未绑定按键都返回 null", () => {
    const preferences = defaultPreferences();
    expect(preferredShortcut(preferences, { ...eventForChord("Mod+Z"), isComposing: true }, false)).toBeNull();
    expect(preferredShortcut(preferences, { ...eventForChord("Mod+Z"), keyCode: 229 }, false)).toBeNull();
    expect(preferredShortcut(preferences, eventForChord("Mod+Z"), true)).toBeNull();
    expect(preferredShortcut(preferences, eventForChord("Mod+Shift+Alt+K"), false)).toBeNull();
  });

  it("完整解析：出厂未改绑时与原解析器一致，改绑/解绑后旧组合真的失效", () => {
    const store = new CustomizationStore(memoryStorage());

    // 未做任何自定义：与出厂解析完全相同（接入不能改变既有按键行为）。
    for (const action of CUSTOMIZATION_ACTIONS) {
      if (!action.defaultChord) continue;
      const event = eventForChord(action.defaultChord);
      expect(resolveWithPreferences(store.snapshot().preferences, event, false), action.id)
        .toEqual(resolveEditorShortcut(event, false));
    }

    // 改绑后：新组合生效，旧出厂组合不再触发该动作（否则「改键位」是假的）。
    store.setShortcut("edit.undo", "Mod+U");
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Mod+U"), false))
      .toEqual({ kind: "command", id: "edit.undo" });
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Mod+Z"), false)).toBeNull();

    // 解绑后同样不触发；其它未改动的出厂键位继续工作。
    store.setShortcut("edit.undo", "");
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Mod+Z"), false)).toBeNull();
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Mod+Shift+Z"), false))
      .toEqual({ kind: "command", id: "edit.redo" });

    // 恢复出厂后旧组合重新生效。
    store.resetShortcut("edit.undo");
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Mod+Z"), false))
      .toEqual({ kind: "command", id: "edit.undo" });
  });

  it("完整解析：工具组/剪贴蒙版共用组合，只解绑其中一个仍保留组内语义", () => {
    const store = new CustomizationStore(memoryStorage());
    // 魔棒换成独占字母：W 仍属于快速选择（组内共用因此继续循环）。
    store.setShortcut("tool.quick", "Q");
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("W"), false))
      .toEqual({ kind: "tool", tool: "wand", cycle: false });
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Q"), false))
      .toEqual({ kind: "tool", tool: "quick", cycle: false });
    // 两个都放弃 W 之后，W 才真正空闲。
    store.setShortcut("tool.wand", "");
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("W"), false)).toBeNull();
  });

  it("完整解析：Delete 这类按文档状态分派的组合不被偏好抑制", () => {
    const store = new CustomizationStore(memoryStorage());
    store.setShortcut("edit.clear", "Mod+Shift+Backspace");
    // 清除已改绑，但 Delete 仍走外壳原来的「按选区/蒙版/所选对象」分派，不由偏好接管。
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("Delete"), false))
      .toEqual({ kind: "delete" });
    // 不可定制的按键（方向键、空格、画笔尺寸）也原样通过。
    expect(resolveWithPreferences(store.snapshot().preferences, eventForChord("ArrowLeft"), false))
      .toEqual({ kind: "nudge", dx: -1, dy: 0 });
    const space = { key: " ", code: "Space", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 };
    expect(resolveWithPreferences(store.snapshot().preferences, space, false)).toEqual({ kind: "pan" });
  });

  it("未知动作没有分派形状", () => {
    expect(shortcutForAction("nope.command")).toBeNull();
    expect(shortcutForAction("tool.nope")).toBeNull();
    expect(shortcutForAction("display.nope")).toBeNull();
    expect(shortcutForAction("file.save")).toEqual({ kind: "save" });
  });

  it("菜单提示按平台换算并反映自定义绑定", () => {
    const store = new CustomizationStore(memoryStorage());
    expect(preferredChordLabel(store.snapshot().preferences, "edit.undo", false)).toBe("Ctrl+Z");
    expect(preferredChordLabel(store.snapshot().preferences, "edit.undo", true)).toBe("⌘+Z");
    store.setShortcut("edit.undo", "Mod+U");
    expect(preferredChordLabel(store.snapshot().preferences, "edit.undo", false)).toBe("Ctrl+U");
    store.setShortcut("edit.undo", "");
    expect(preferredChordLabel(store.snapshot().preferences, "edit.undo", false)).toBeNull();
    expect(preferredChordLabel(store.snapshot().preferences, "nope", false)).toBeNull();
  });

  it("搜索提示优先用当前绑定，解绑后不给过期提示，未知命令退回内核值", () => {
    const store = new CustomizationStore(memoryStorage());
    expect(shortcutHint(store.snapshot().preferences, "edit.undo", false, "Cmd+Z")).toBe("Ctrl+Z");
    // 内核自报值与偏好默认值不一致时，以偏好为准（平台文本统一）。
    expect(shortcutHint(store.snapshot().preferences, "edit.undo", true, "Cmd+Z")).toBe("⌘+Z");
    store.setShortcut("edit.undo", "Mod+U");
    expect(shortcutHint(store.snapshot().preferences, "edit.undo", false, "Cmd+Z")).toBe("Ctrl+U");
    // 显式解绑：不显示任何提示，而不是回落到内核自报的出厂值。
    store.setShortcut("edit.undo", "");
    expect(shortcutHint(store.snapshot().preferences, "edit.undo", false, "Cmd+Z")).toBeNull();
    // 不在可定制清单里的命令（例如宿主扩展命令）沿用调用方提示。
    expect(shortcutHint(store.snapshot().preferences, "plugin.run", false, "F9")).toBe("F9");
  });
});

describe("菜单隐藏", () => {
  const menus = [
    { id: "edit", label: "编辑", children: [{ id: "edit.undo", label: "撤销" }, { id: "edit.redo", label: "重做" }] },
    { id: "layer", label: "图层", children: [{ id: "layer.delete", label: "删除" }, { id: "layer.new", label: "新建" }] },
    { id: "view", label: "视图" }
  ];

  it("隐藏叶子，分组全隐藏时整组消失，未知 id 不影响其它项", () => {
    expect(filterHiddenMenuItems(menus, [])).toEqual(menus);
    const one = filterHiddenMenuItems(menus, ["edit.undo", "nope.item"]);
    expect(one[0]!.children?.map((item) => item.id)).toEqual(["edit.redo"]);
    const whole = filterHiddenMenuItems(menus, ["edit.undo", "edit.redo"]);
    expect(whole.map((item) => item.id)).toEqual(["layer", "view"]);
    const leaf = filterHiddenMenuItems(menus, ["view"]);
    expect(leaf.map((item) => item.id)).toEqual(["edit", "layer"]);
  });

  it("按偏好判断单项是否隐藏", () => {
    const preferences: CustomizationPreferences = { ...defaultPreferences(), menuHidden: ["layer.delete"] };
    expect(isMenuItemHidden(preferences, "layer.delete")).toBe(true);
    expect(isMenuItemHidden(preferences, "edit.undo")).toBe(false);
  });
});

describe("工具栏顺序", () => {
  it("出厂顺序去掉隐藏项", () => {
    const store = new CustomizationStore(memoryStorage());
    store.setToolbarHidden(["tool.brush"]);
    expect(toolbarToolIds(store.snapshot().preferences)).not.toContain("tool.brush");
    expect(toolbarToolIds(store.snapshot().preferences)[0]).toBe("tool.move");
  });

  it("设置界面使用完整顺序，隐藏的工具仍能重新启用", () => {
    const store = new CustomizationStore(memoryStorage());
    store.setToolbarHidden(["tool.brush"]);
    // 渲染顺序去掉隐藏项，但设置列表必须保留它，否则用户无法取消隐藏。
    expect(toolbarToolIds(store.snapshot().preferences)).not.toContain("tool.brush");
    expect(toolbarOrderedIds(store.snapshot().preferences)).toContain("tool.brush");
    expect(toolbarOrderedIds(store.snapshot().preferences)).toEqual(
      CUSTOMIZATION_TOOL_ACTIONS.map((action) => action.id)
    );
  });

  it("保存顺序优先，过期 id 丢弃，未列出的出厂工具补在末尾", () => {
    const preferences: CustomizationPreferences = { ...defaultPreferences(), toolbarOrder: ["tool.pen", "ghost.tool", "tool.move"] };
    const ids = toolbarToolIds(preferences);
    expect(ids.slice(0, 2)).toEqual(["tool.pen", "tool.move"]);
    expect(ids).not.toContain("ghost.tool");
    expect(ids).toContain("tool.brush");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("共用按钮的工具组按组渲染：隐藏一个成员不连累同组另一个", () => {
    const store = new CustomizationStore(memoryStorage());
    const groups = () => toolbarRenderGroups(store.snapshot().preferences);

    // 出厂：魔棒/快速选择、修复/修饰各折成一个按钮。
    const initial = groups();
    expect(initial.find((entry) => entry.tool === "wand")?.group).toEqual(["wand", "quick"]);
    expect(initial.find((entry) => entry.tool === "heal")?.group).toEqual(["heal", "retouch"]);
    expect(initial.map((entry) => entry.tool)).not.toContain("quick");
    expect(initial.map((entry) => entry.tool)).not.toContain("retouch");

    // 隐藏组内第二项：按钮还在，只是呼出菜单里少了它（否则会连魔棒一起藏掉）。
    store.setToolbarHidden(["tool.quick"]);
    expect(groups().find((entry) => entry.tool === "wand")?.group).toEqual(["wand"]);
    // 隐藏组首：代表换成仍在的成员，按钮不消失。
    store.setToolbarHidden(["tool.wand"]);
    expect(groups().find((entry) => entry.tool === "quick")?.group).toEqual(["quick"]);
    // 两个都隐藏，整组才消失。
    store.setToolbarHidden(["tool.wand", "tool.quick"]);
    expect(groups().some((entry) => entry.group.includes("wand") || entry.group.includes("quick"))).toBe(false);
  });

  it("组渲染顺序跟随偏好顺序，且每组只出现一次", () => {
    const preferences: CustomizationPreferences = { ...defaultPreferences(), toolbarOrder: ["tool.quick", "tool.wand", "tool.brush"] };
    const groups = toolbarRenderGroups(preferences);
    // 快速选择在前时，组锚点就是它，且魔棒不会再单独出现一次。
    expect(groups[0]).toEqual({ tool: "quick", group: ["wand", "quick"] });
    expect(groups.filter((entry) => entry.group.includes("wand"))).toHaveLength(1);
    expect(groups[1]!.tool).toBe("brush");
  });
});

describe("工作区面板几何", () => {
  it("只覆盖工作区记录的字段并做规范化", () => {
    const layout = workspacePanelLayout({ width: 320, floating: true }, DEFAULT_PANEL_LAYOUT);
    expect(layout).toMatchObject({ width: 320, floating: true, height: DEFAULT_PANEL_LAYOUT.height });
    // 超出范围的值被规范化而不是拒绝整个工作区。
    expect(workspacePanelLayout({ width: 9999 }, DEFAULT_PANEL_LAYOUT)?.width).toBe(480);
  });

  it("无几何或非法值时返回 null，调用方保留现有布局", () => {
    expect(workspacePanelLayout(null, DEFAULT_PANEL_LAYOUT)).toBeNull();
    expect(workspacePanelLayout({}, DEFAULT_PANEL_LAYOUT)).toBeNull();
  });
});

describe("工具选项记忆恢复", () => {
  it("只挑有界数值字段，未记忆时不覆盖当前设置", () => {
    const store = new CustomizationStore(memoryStorage());
    expect(storedToolOptions(store.snapshot().preferences, "brush")).toBeNull();
    expect(restoreBrushOptions(store.snapshot().preferences, "brush", { size: 12 })).toEqual({ size: 12 });

    store.rememberToolOptions("brush", { size: 40, hardness: 0.5, opacity: 0.8 });
    const preferences = store.snapshot().preferences;
    expect(brushOptionValues({ size: 40, hardness: Number.NaN, opacity: 0.8 })).toEqual({ size: 40, opacity: 0.8 });
    expect(restoreBrushOptions(preferences, "brush", { size: 12, flow: 0.4 }))
      .toEqual({ size: 40, flow: 0.4, hardness: 0.5, opacity: 0.8 });
    // 恢复只读偏好，不改动偏好本身。
    expect(store.snapshot().preferences.toolOptions.brush).toEqual({ size: 40, hardness: 0.5, opacity: 0.8 });
    // 其它工具不受影响。
    expect(restoreBrushOptions(preferences, "eraser", { size: 12 })).toEqual({ size: 12 });
  });

  it("记忆值超出画笔字段范围时被忽略", () => {
    const preferences: CustomizationPreferences = { ...defaultPreferences(), toolOptions: { brush: { size: 40, weird: "x" } } };
    expect(restoreBrushOptions(preferences, "brush", { size: 12, hardness: 1 })).toEqual({ size: 40, hardness: 1 });
    expect(storedToolOptions(preferences, "brush")).toEqual({ size: 40, weird: "x" });
  });
});

describe("偏好与出厂表的一致性", () => {
  it("每个出厂动作的组合都能被解析回同一个动作", () => {
    for (const action of CUSTOMIZATION_ACTIONS) {
      const chord = effectiveChord(defaultPreferences(), action.id);
      if (!action.defaultChord) { expect(chord, action.id).toBe(""); continue; }
      expect(chordFromEvent(eventForChord(chord), false).ok, action.id).toBe(true);
    }
  });

  it("隐藏菜单项不移除命令的鼠标/搜索入口", () => {
    const store = new CustomizationStore(memoryStorage());
    // 隐藏「编辑」下的全部叶子（含嵌套分组），命令仍必须出现在命令搜索里
    // （D1：所有动作保留菜单或鼠标入口）。
    const collect = (items: readonly { id: string; children?: readonly unknown[] }[]): string[] => items.flatMap((item) =>
      item.children?.length ? collect(item.children as readonly { id: string; children?: readonly unknown[] }[]) : [item.id]);
    const editLeaves = collect(EDITOR_MENUS.find((menu) => menu.label === "编辑")!.items);
    expect(editLeaves.length).toBeGreaterThan(0);
    store.setMenuHidden(editLeaves);
    const editMenu = EDITOR_MENUS.find((menu) => menu.label === "编辑")!;
    // 过滤作用于菜单项（不是菜单本身）：全隐藏时该菜单渲染为空并由外壳整菜单省略。
    const visible = filterHiddenMenuItems(editMenu.items, store.snapshot().preferences.menuHidden);
    expect(visible).toEqual([]);
    const commands = new Map(editLeaves.map((id) => [id, command({ id })]));
    expect(paletteEntries(commands).map((entry) => entry.id)).toEqual(editLeaves);
  });
});
