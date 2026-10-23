/**
 * 命令搜索与工作区定制的偏好回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 只锁定本域契约：组合键解析、冲突解决、存储失败不伪造保存、版本失配拒绝、工作区往返、
 * 工具选项记忆边界与按键匹配。偏好本身不进入工程内容，因此这里不涉及像素或内核调用。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMIZATION_ACTIONS,
  CUSTOMIZATION_LIMITS,
  CUSTOMIZATION_STORAGE_KEY,
  CUSTOMIZATION_TOOL_ACTIONS,
  CUSTOMIZATION_VERSION,
  CustomizationStore,
  chordConflicts,
  chordFromEvent,
  chordLabel,
  customizationAction,
  decodePreferences,
  defaultPreferences,
  effectiveChord,
  formatChord,
  isBrowserReserved,
  matchCustomizationBinding,
  parseChord,
  type CustomizationPreferences,
  type PreferenceStorage
} from "./preferences.js";

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    read: (key) => data[key] ?? null,
    write: (key, value) => { data[key] = value; }
  };
}

function store(initial?: Record<string, string>) {
  const storage = memoryStorage(initial);
  return { storage, store: new CustomizationStore(storage) };
}

const event = (patch: Partial<Parameters<typeof matchCustomizationBinding>[1]>) => ({
  key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  isComposing: false, keyCode: 0, ...patch
});

describe("组合键解析", () => {
  it("接受规范写法并固定修饰键顺序", () => {
    const parsed = parseChord("shift+mod+k");
    expect(parsed.ok && parsed.chord && formatChord(parsed.chord)).toBe("Mod+Shift+K");
    expect(parseChord("alt+backspace")).toMatchObject({ ok: true, chord: { key: "Backspace", alt: true } });
    expect(parseChord("B")).toMatchObject({ ok: true, chord: { key: "B", mod: false } });
    expect(parseChord("Mod+]")).toMatchObject({ ok: true, chord: { key: "]", mod: true } });
  });

  it("把空串当作解绑，拒绝非法结构", () => {
    expect(parseChord("  ")).toEqual({ ok: true, chord: null });
    expect(parseChord("Shift")).toMatchObject({ ok: false });
    expect(parseChord("Mod+K+L")).toMatchObject({ ok: false });
    expect(parseChord("K+Mod")).toMatchObject({ ok: false });
    expect(parseChord("Mod+Mod+K")).toMatchObject({ ok: false });
    expect(parseChord("Mod+未知")).toMatchObject({ ok: false });
  });

  it("按键转组合时忽略输入法合成与平台错误的修饰键", () => {
    expect(chordFromEvent(event({ key: "Process", isComposing: true }), false)).toMatchObject({ ok: false });
    expect(chordFromEvent(event({ key: "Dead", keyCode: 229 }), false)).toMatchObject({ ok: false });
    expect(chordFromEvent(event({ key: "Shift", shiftKey: true }), false)).toMatchObject({ ok: false });
    expect(chordFromEvent(event({ key: "k", ctrlKey: true }), false)).toEqual({ ok: true, chord: "Mod+K" });
    expect(chordFromEvent(event({ key: "k", ctrlKey: true }), true)).toMatchObject({ ok: false });
    expect(chordFromEvent(event({ key: "]", code: "BracketRight", metaKey: true }), true)).toEqual({ ok: true, chord: "Mod+]" });
    expect(chordFromEvent(event({ key: "F3" }), false)).toEqual({ ok: true, chord: "F3" });
  });

  it("标注浏览器保留键但不拒绝保存", () => {
    expect(isBrowserReserved({ key: "W", mod: true, alt: false, shift: false })).toBe(true);
    expect(isBrowserReserved({ key: "K", mod: true, alt: false, shift: false })).toBe(false);
  });

  it("展示标签沿用平台换算", () => {
    expect(chordLabel({ key: "Backspace", mod: true, alt: false, shift: false }, false)).toBe("Ctrl+Backspace");
    expect(chordLabel({ key: "Backspace", mod: true, alt: false, shift: false }, true)).toBe("⌘+Delete");
  });
});

describe("出厂动作清单", () => {
  it("只登记已接通命令、工具与显示动作，默认值唯一（组内共用除外）", () => {
    expect(CUSTOMIZATION_ACTIONS.length).toBeGreaterThan(30);
    expect(new Set(CUSTOMIZATION_ACTIONS.map((action) => action.id)).size).toBe(CUSTOMIZATION_ACTIONS.length);
    expect(customizationAction("edit.undo")).toMatchObject({ kind: "command", defaultChord: "Mod+Z" });
    expect(customizationAction("tool.brush")).toMatchObject({ kind: "tool", defaultChord: "B" });
    expect(customizationAction("display.panels")).toMatchObject({ kind: "display", defaultChord: "Tab" });
    expect(effectiveChord(defaultPreferences(), "tool.wand")).toBe("W");
    expect(chordConflicts(defaultPreferences())).toEqual([]);
    expect(CUSTOMIZATION_TOOL_ACTIONS.map((action) => action.id)).toContain("tool.pen");
  });

  it("每个默认组合都能被重新解析", () => {
    for (const action of CUSTOMIZATION_ACTIONS) {
      const parsed = parseChord(action.defaultChord);
      expect(parsed.ok, action.id).toBe(true);
      if (parsed.ok && parsed.chord) expect(formatChord(parsed.chord)).toBe(action.defaultChord);
    }
  });
});

describe("偏好解码", () => {
  it("版本失配整体拒绝并说明原因", () => {
    const result = decodePreferences({ ...defaultPreferences(), version: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("version");
    expect(decodePreferences(null)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("丢弃未知动作/非法组合与超限条目，保留其余有效设置", () => {
    const raw = {
      version: CUSTOMIZATION_VERSION,
      shortcuts: { "edit.undo": "mod+alt+z", "nope.command": "Mod+K", "edit.redo": "Mod+K+L" },
      toolbarHidden: ["tool.brush", "tool.brush", "bad id!"],
      menuHidden: ["layer.delete"],
      toolOptions: { brush: { size: 24, opacity: 0.5, nested: { x: 1 } }, "bad id": { size: 1 } },
      workspaces: [{ id: "ws-1", name: "审查", shortcuts: { "edit.undo": "Mod+U" }, toolbarHidden: [], toolbarOrder: null, menuHidden: [], panelLayout: { width: 300, floating: true }, createdAt: 5 }],
      activeWorkspace: "ws-1"
    };
    const decoded = decodePreferences(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.preferences.shortcuts).toEqual({ "edit.undo": "Mod+Alt+Z" });
    expect(decoded.preferences.toolbarHidden).toEqual(["tool.brush"]);
    expect(decoded.preferences.toolOptions).toEqual({ brush: { size: 24, opacity: 0.5 } });
    expect(decoded.preferences.workspaces[0]).toMatchObject({ id: "ws-1", name: "审查", panelLayout: { width: 300, floating: true } });
    expect(decoded.preferences.activeWorkspace).toBe("ws-1");
    expect(decoded.warnings.join()).toContain("nope.command");
  });

  it("超量工作区被截断而不是让整份偏好失效", () => {
    const workspaces = Array.from({ length: CUSTOMIZATION_LIMITS.workspaces + 2 }, (_, index) => ({
      id: `ws-${index}`, name: `工作区 ${index}`, shortcuts: {}, toolbarHidden: [], toolbarOrder: null, menuHidden: [], panelLayout: null, createdAt: index
    }));
    const decoded = decodePreferences({ ...defaultPreferences(), workspaces });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.preferences.workspaces).toHaveLength(CUSTOMIZATION_LIMITS.workspaces);
    expect(decoded.warnings.join()).toContain("上限");
  });
});

describe("偏好仓库", () => {
  it("首次读取为空时给出出厂值，并把每次修改写进本机存储", () => {
    const { storage, store: preferences } = store();
    expect(preferences.snapshot().preferences).toEqual(defaultPreferences());
    expect(preferences.snapshot().persistence).toBe("local");
    expect(preferences.setShortcut("edit.undo", "Mod+U")).toEqual({ ok: true });
    const persisted = JSON.parse(storage.data[CUSTOMIZATION_STORAGE_KEY]!);
    expect(persisted).toMatchObject({ version: CUSTOMIZATION_VERSION, shortcuts: { "edit.undo": "Mod+U" } });
    expect(preferences.snapshot().loadError).toBeNull();
  });

  it("重新打开时恢复偏好，坏 JSON 与版本失配保留旧数据并提示", () => {
    const first = store();
    first.store.setShortcut("edit.undo", "Mod+U");
    const reopened = new CustomizationStore(first.storage);
    expect(effectiveChord(reopened.snapshot().preferences, "edit.undo")).toBe("Mod+U");

    const broken = memoryStorage({ [CUSTOMIZATION_STORAGE_KEY]: "{not json" });
    const brokenStore = new CustomizationStore(broken);
    expect(brokenStore.snapshot().preferences).toEqual(defaultPreferences());
    expect(brokenStore.snapshot().loadError).toContain("JSON");
    expect(broken.data[CUSTOMIZATION_STORAGE_KEY]).toBe("{not json");

    const stale = memoryStorage({ [CUSTOMIZATION_STORAGE_KEY]: JSON.stringify({ version: 0, shortcuts: {} }) });
    const staleStore = new CustomizationStore(stale);
    expect(staleStore.snapshot().loadError).toContain("版本");
    expect(JSON.parse(stale.data[CUSTOMIZATION_STORAGE_KEY]!).version).toBe(0);
  });

  it("存储写入失败时拒绝操作并保留原设置", () => {
    const storage: PreferenceStorage = { read: () => null, write: () => { throw new Error("quota"); } };
    const preferences = new CustomizationStore(storage);
    const result = preferences.setShortcut("edit.undo", "Mod+U");
    expect(result).toMatchObject({ ok: false, code: "storage" });
    expect(preferences.snapshot().preferences).toEqual(defaultPreferences());
  });

  it("没有本机存储时只在会话内生效并明确提示", () => {
    const preferences = new CustomizationStore(null);
    expect(preferences.snapshot()).toMatchObject({ persistence: "memory" });
    expect(preferences.snapshot().loadError).toContain("本机存储");
    expect(preferences.setShortcut("edit.undo", "Mod+U")).toEqual({ ok: true });
    expect(effectiveChord(preferences.snapshot().preferences, "edit.undo")).toBe("Mod+U");
  });

  it("冲突必须先解决：取消保留原绑定，覆盖只解绑同一组合的其他动作", () => {
    const { store: preferences } = store();
    const conflict = preferences.setShortcut("edit.redo", "Mod+C");
    expect(conflict).toMatchObject({ ok: false, code: "conflict" });
    if (!conflict.ok) expect(conflict.conflicts?.[0]?.actionIds).toEqual(["edit.copy", "edit.redo"]);
    expect(effectiveChord(preferences.snapshot().preferences, "edit.copy")).toBe("Mod+C");
    expect(effectiveChord(preferences.snapshot().preferences, "edit.redo")).toBe("Mod+Shift+Z");

    expect(preferences.setShortcut("edit.redo", "Mod+C", { force: true })).toEqual({ ok: true });
    expect(effectiveChord(preferences.snapshot().preferences, "edit.redo")).toBe("Mod+C");
    expect(effectiveChord(preferences.snapshot().preferences, "edit.copy")).toBe("");
    expect(chordConflicts(preferences.snapshot().preferences)).toEqual([]);
    // 被覆盖的动作恢复出厂值后冲突重新出现，界面必须继续报告。
    expect(preferences.resetShortcut("edit.copy")).toEqual({ ok: true });
    expect(chordConflicts(preferences.snapshot().preferences).map((entry) => entry.chord)).toEqual(["Mod+C"]);
  });

  it("工具组共用字母不算冲突，跨组重复要解决", () => {
    const { store: preferences } = store();
    expect(preferences.setShortcut("tool.brush", "W")).toMatchObject({ ok: false, code: "conflict" });
    expect(preferences.setShortcut("tool.wand", "J")).toMatchObject({ ok: false, code: "conflict" });
    expect(preferences.setShortcut("tool.quick", "B", { force: true })).toEqual({ ok: true });
    expect(effectiveChord(preferences.snapshot().preferences, "tool.brush")).toBe("");
  });

  it("解绑与恢复出厂都按动作粒度生效", () => {
    const { store: preferences } = store();
    preferences.setShortcut("edit.undo", "");
    expect(effectiveChord(preferences.snapshot().preferences, "edit.undo")).toBe("");
    expect(preferences.snapshot().preferences.shortcuts["edit.undo"]).toBe("");
    expect(preferences.resetShortcut("edit.undo")).toEqual({ ok: true });
    expect(effectiveChord(preferences.snapshot().preferences, "edit.undo")).toBe("Mod+Z");
    preferences.setShortcut("edit.redo", "Mod+Y");
    preferences.resetShortcuts();
    expect(preferences.snapshot().preferences.shortcuts).toEqual({});
  });

  it("拒绝未知动作与非法组合", () => {
    const { store: preferences } = store();
    expect(preferences.setShortcut("nope", "Mod+K")).toMatchObject({ ok: false, code: "invalid" });
    expect(preferences.setShortcut("edit.undo", "Mod+K+L")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("工具栏与菜单隐藏/顺序有界，并能恢复出厂", () => {
    const { store: preferences } = store();
    expect(preferences.setToolbarHidden(["tool.brush", "tool.brush"])).toEqual({ ok: true });
    expect(preferences.snapshot().preferences.toolbarHidden).toEqual(["tool.brush"]);
    expect(preferences.setToolbarHidden(["bad id!"])).toMatchObject({ ok: false, code: "invalid" });
    expect(preferences.setToolbarOrder(["tool.pen", "tool.brush"])).toEqual({ ok: true });
    expect(preferences.setToolbarOrder(null)).toEqual({ ok: true });
    expect(preferences.snapshot().preferences.toolbarOrder).toBeNull();
    expect(preferences.setMenuHidden(["layer.delete"])).toEqual({ ok: true });
    expect(preferences.snapshot().preferences.menuHidden).toEqual(["layer.delete"]);
    preferences.setToolbarHidden(["tool.brush"]);
    preferences.resetToolbar();
    preferences.resetMenus();
    expect(preferences.snapshot().preferences).toMatchObject({ toolbarHidden: [], toolbarOrder: null, menuHidden: [] });
  });
});

describe("工具选项记忆", () => {
  it("只接受有界原始值，超量工具被拒绝", () => {
    const { store: preferences } = store();
    expect(preferences.rememberToolOptions("brush", { size: 24, opacity: 0.6, hardness: true, tip: "soft" })).toEqual({ ok: true });
    expect(preferences.snapshot().preferences.toolOptions.brush).toEqual({ size: 24, opacity: 0.6, hardness: true, tip: "soft" });
    expect(preferences.rememberToolOptions("brush", { nested: { size: 2 } })).toMatchObject({ ok: false, code: "invalid" });
    expect(preferences.rememberToolOptions("brush", { text: "x".repeat(CUSTOMIZATION_LIMITS.toolOptionString + 1) })).toMatchObject({ ok: false, code: "invalid" });
    for (let index = 0; index < CUSTOMIZATION_LIMITS.toolOptions - 1; index += 1) {
      expect(preferences.rememberToolOptions(`tool-${index}`, { size: index + 1 })).toEqual({ ok: true });
    }
    expect(preferences.rememberToolOptions("overflow", { size: 1 })).toMatchObject({ ok: false, code: "limit" });
    expect(preferences.clearToolOptions("tool-0")).toEqual({ ok: true });
    expect(preferences.snapshot().preferences.toolOptions["tool-0"]).toBeUndefined();
    expect(preferences.clearToolOptions()).toEqual({ ok: true });
    expect(preferences.snapshot().preferences.toolOptions).toEqual({});
  });
});

describe("工作区预设", () => {
  const layout = { width: 320, floating: true, layersCollapsed: false, detachedPanels: { layers: { x: 40, y: 60 } } };

  it("保存捕获当前快捷键/工具栏/菜单与面板几何，应用后恢复并可删除", () => {
    const { store: preferences } = store();
    preferences.setShortcut("edit.undo", "Mod+U");
    preferences.setToolbarHidden(["tool.pen"]);
    preferences.setMenuHidden(["layer.delete"]);
    expect(preferences.saveWorkspace("审查", { panelLayout: layout })).toEqual({ ok: true });
    const preset = preferences.snapshot().preferences.workspaces[0]!;
    expect(preset).toMatchObject({ name: "审查", panelLayout: layout, toolbarHidden: ["tool.pen"], menuHidden: ["layer.delete"] });
    expect(preset.shortcuts["edit.undo"]).toBe("Mod+U");

    preferences.resetAll();
    expect(preferences.snapshot().preferences.workspaces).toEqual([]);

    const restored = new CustomizationStore(memoryStorage());
    restored.setShortcut("edit.redo", "Mod+Y");
    restored.saveWorkspace("基线", { panelLayout: layout });
    const id = restored.snapshot().preferences.workspaces[0]!.id;
    restored.setShortcut("edit.redo", "Mod+Shift+Y");
    const applied = restored.applyWorkspace(id);
    expect(applied).toMatchObject({ ok: true, panelLayout: layout });
    expect(effectiveChord(restored.snapshot().preferences, "edit.redo")).toBe("Mod+Y");
    expect(restored.snapshot().preferences.activeWorkspace).toBe(id);
    expect(restored.deleteWorkspace(id)).toEqual({ ok: true });
    expect(restored.snapshot().preferences.workspaces).toEqual([]);
    expect(restored.snapshot().preferences.activeWorkspace).toBeNull();
    expect(restored.deleteWorkspace(id)).toMatchObject({ ok: false, code: "missing" });
    expect(restored.applyWorkspace(id)).toMatchObject({ ok: false, code: "missing" });
  });

  it("应用工作区后再改设置就离开该工作区标记，重新应用才回到当前", () => {
    const { store: preferences } = store();
    preferences.setShortcut("edit.undo", "Mod+U");
    preferences.saveWorkspace("看图");
    const id = preferences.snapshot().preferences.workspaces[0]!.id;
    preferences.applyWorkspace(id);
    expect(preferences.snapshot().preferences.activeWorkspace).toBe(id);

    // 改任一被工作区快照覆盖的分组 → 不再声称「当前工作区就是它」。
    preferences.setShortcut("edit.redo", "Mod+Y");
    expect(preferences.snapshot().preferences.activeWorkspace).toBeNull();
    // 工具栏/菜单也属于快照内容。
    preferences.applyWorkspace(id);
    expect(preferences.snapshot().preferences.activeWorkspace).toBe(id);
    preferences.setToolbarHidden(["tool.brush"]);
    expect(preferences.snapshot().preferences.activeWorkspace).toBeNull();

    // 与快照无关的分组（工具选项、面板几何以外的会话状态）不打断标记。
    preferences.applyWorkspace(id);
    preferences.rememberToolOptions("brush", { size: 30 });
    expect(preferences.snapshot().preferences.activeWorkspace).toBe(id);
  });

  it("拒绝空名、超长名与非法布局，并限制数量", () => {
    const { store: preferences } = store();
    expect(preferences.saveWorkspace("   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(preferences.saveWorkspace("名".repeat(CUSTOMIZATION_LIMITS.workspaceName + 1))).toMatchObject({ ok: false, code: "limit" });
    expect(preferences.saveWorkspace("坏布局", { panelLayout: { width: { nested: true } } })).toMatchObject({ ok: false, code: "invalid" });
    for (let index = 0; index < CUSTOMIZATION_LIMITS.workspaces; index += 1) {
      expect(preferences.saveWorkspace(`工作区 ${index}`)).toEqual({ ok: true });
    }
    expect(preferences.saveWorkspace("超出")).toMatchObject({ ok: false, code: "limit" });
  });
});

describe("导出与导入", () => {
  it("导出 JSON 可原样导入；版本失配或坏 JSON 拒绝且不改动当前设置", () => {
    const source = store();
    source.store.setShortcut("edit.undo", "Mod+U");
    source.store.saveWorkspace("审查", { panelLayout: { width: 300 } });
    const text = source.store.exportJson();

    const target = store();
    expect(target.store.importJson(text)).toEqual({ ok: true });
    expect(target.store.snapshot().preferences.shortcuts).toEqual({ "edit.undo": "Mod+U" });
    expect(target.store.snapshot().preferences.workspaces[0]?.name).toBe("审查");

    const before = JSON.parse(target.store.exportJson()) as CustomizationPreferences;
    expect(target.store.importJson("{oops")).toMatchObject({ ok: false, code: "invalid" });
    expect(target.store.importJson(JSON.stringify({ version: 7 }))).toMatchObject({ ok: false, code: "invalid" });
    expect(JSON.parse(target.store.exportJson())).toEqual(before);
  });

  it("导入时被丢弃的条目必须回报，而不是静默少了设置", () => {
    const target = store();
    const text = JSON.stringify({
      version: 1,
      shortcuts: { "edit.undo": "Mod+U", "nope.command": "Mod+K", "edit.redo": "不是组合" },
      toolbarHidden: ["tool.brush", "tool.brush"]
    });
    const result = target.store.importJson(text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("未知动作「nope.command」"),
      expect.stringContaining("「不是组合」无效")
    ]));
    // 有效条目仍然导入，未知动作不进入偏好。
    expect(target.store.snapshot().preferences.shortcuts).toEqual({ "edit.undo": "Mod+U" });
    expect(target.store.snapshot().preferences.toolbarHidden).toEqual(["tool.brush"]);

    // 版本失配的报错要说明版本，而不是笼统的「格式非法」。
    const versioned = target.store.importJson(JSON.stringify({ version: 7 }));
    expect(versioned).toMatchObject({ ok: false, code: "invalid" });
    expect(versioned.ok === false && versioned.message).toContain("偏好版本不匹配");

    // 完全干净的导入不带告警。
    const clean = store();
    expect(clean.store.importJson(JSON.stringify({ version: 1, shortcuts: { "edit.undo": "Mod+U" } }))).toEqual({ ok: true });
  });

  it("订阅者在每次成功保存后收到通知，失败时不通知", () => {
    const storage: PreferenceStorage = { read: () => null, write: vi.fn() };
    const preferences = new CustomizationStore(storage);
    const listener = vi.fn();
    preferences.subscribe(listener);
    preferences.setShortcut("edit.undo", "Mod+U");
    expect(listener).toHaveBeenCalledTimes(1);
    preferences.setShortcut("edit.undo", "Mod+U");
    expect(listener).toHaveBeenCalledTimes(1);
    preferences.setShortcut("nope", "Mod+U");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("按键匹配", () => {
  it("匹配已绑定动作，跳过合成输入和平台错误的修饰键", () => {
    const preferences = defaultPreferences();
    expect(matchCustomizationBinding(preferences, event({ key: "z", ctrlKey: true }), false)).toMatchObject({ actionId: "edit.undo" });
    expect(matchCustomizationBinding(preferences, event({ key: "z", ctrlKey: true, shiftKey: true }), false)).toMatchObject({ actionId: "edit.redo" });
    expect(matchCustomizationBinding(preferences, event({ key: "b" }), false)).toMatchObject({ actionId: "tool.brush" });
    expect(matchCustomizationBinding(preferences, event({ key: "Tab" }), false)).toMatchObject({ actionId: "display.panels" });
    expect(matchCustomizationBinding(preferences, event({ key: "Tab", shiftKey: true }), false)).toMatchObject({ actionId: "display.sidebar" });
    expect(matchCustomizationBinding(preferences, event({ key: "z", ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchCustomizationBinding(preferences, event({ key: "z", metaKey: true }), false)).toBeNull();
    expect(matchCustomizationBinding(preferences, event({ key: "z", metaKey: true }), true)).toMatchObject({ actionId: "edit.undo" });
  });

  it("自定义绑定替换默认值，解绑后不再匹配", () => {
    const { store: preferences } = store();
    preferences.setShortcut("edit.undo", "Mod+U");
    expect(matchCustomizationBinding(preferences.snapshot().preferences, event({ key: "u", ctrlKey: true }), false)).toMatchObject({ actionId: "edit.undo" });
    expect(matchCustomizationBinding(preferences.snapshot().preferences, event({ key: "z", ctrlKey: true }), false)).toBeNull();
    preferences.setShortcut("edit.undo", "");
    expect(matchCustomizationBinding(preferences.snapshot().preferences, event({ key: "u", ctrlKey: true }), false)).toBeNull();
  });

  it("`=` 绑定同时接受 Shift+= 产出的 `+`", () => {
    expect(matchCustomizationBinding(defaultPreferences(), event({ key: "+", ctrlKey: true, shiftKey: true }), false))
      .toMatchObject({ actionId: "view.zoomIn" });
  });
});
