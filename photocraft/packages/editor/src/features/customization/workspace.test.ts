/**
 * 定制域会话端口回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 会话只暴露本机偏好，不读文档、不造 dirty；按键解析结果仍由外壳的命令门二次校验。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import {
  CustomizationStore,
  defaultPreferences,
  effectiveChord,
  setDefaultCustomizationStore,
  type PreferenceStorage
} from "./preferences.js";
import {
  applyCustomizationWorkspace,
  createSession,
  customizationChord,
  customizationState,
  rememberCustomizationToolOptions,
  resetCustomizationShortcuts,
  resolveCustomizationShortcut,
  setCustomizationShortcut,
  subscribeCustomization
} from "./workspace.js";

function memoryStorage(): PreferenceStorage {
  const data: Record<string, string> = {};
  return {
 read: (key) => data[key] ?? null, write: (key, value) => { data[key] = value; } };
}

function context(): WorkspaceFeatureContext {
  // 偏好端口不读取文档、句柄或草稿门禁；其余字段保持显式不可用，避免测试掩盖意外依赖。
  return {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    handle: null,
    view: { hasDocument: false, document: null, sessionActiveIndex: null },
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => false,
    blockingDraft: () => null,
    unavailable: () => ({ ok: false, code: "unavailable", message: "unavailable" }),
    fail: () => ({ ok: false, code: "failed", message: "failed" }),
    afterWrite: () => ({ ok: false, code: "unavailable", message: "unavailable" })
  };
}

type KeyInput = Parameters<typeof resolveCustomizationShortcut>[0];

const key = (patch: Partial<KeyInput>): KeyInput => ({
  key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  isComposing: false, keyCode: 0, ...patch
});

afterEach(() => setDefaultCustomizationStore(null));

describe("定制域会话", () => {
  it("读取共享仓库快照，并按偏好解析按键", () => {
    const store = new CustomizationStore(memoryStorage());
    setDefaultCustomizationStore(store);
    const ctx = context();
    expect(customizationState.call(ctx).preferences).toEqual(defaultPreferences());
    expect(resolveCustomizationShortcut.call(ctx, key({ key: "z", ctrlKey: true }), false)).toMatchObject({ actionId: "edit.undo" });

    expect(setCustomizationShortcut.call(ctx, "edit.undo", "Mod+U")).toEqual({ ok: true });
    expect(customizationChord.call(ctx, "edit.undo")).toBe("Mod+U");
    expect(resolveCustomizationShortcut.call(ctx, key({ key: "z", ctrlKey: true }), false)).toBeNull();
    expect(resolveCustomizationShortcut.call(ctx, key({ key: "u", ctrlKey: true }), false)).toMatchObject({ actionId: "edit.undo" });

    resetCustomizationShortcuts.call(ctx);
    expect(customizationChord.call(ctx, "edit.undo")).toBe("Mod+Z");
  });

  it("订阅共享仓库变化，取消后不再通知", () => {
    const store = new CustomizationStore(memoryStorage());
    setDefaultCustomizationStore(store);
    const ctx = context();
    const listener = vi.fn();
    const unsubscribe = subscribeCustomization.call(ctx, listener);
    setCustomizationShortcut.call(ctx, "edit.redo", "Mod+Y");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setCustomizationShortcut.call(ctx, "edit.redo", "Mod+Shift+Y");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("工作区应用交回面板几何，工具选项记忆只存工具状态", () => {
    const store = new CustomizationStore(memoryStorage());
    setDefaultCustomizationStore(store);
    const ctx = context();
    store.saveWorkspace("审查", { panelLayout: { width: 320, floating: true } });
    const id = store.snapshot().preferences.workspaces[0]!.id;
    expect(applyCustomizationWorkspace.call(ctx, id)).toMatchObject({ ok: true, panelLayout: { width: 320, floating: true } });
    expect(applyCustomizationWorkspace.call(ctx, "missing")).toMatchObject({ ok: false, code: "missing" });

    expect(rememberCustomizationToolOptions.call(ctx, "brush", { size: 40 })).toEqual({ ok: true });
    expect(store.snapshot().preferences.toolOptions.brush).toEqual({ size: 40 });
    // 工具选项不改按键绑定，也不产生文档内容变化。
    expect(store.snapshot().preferences.shortcuts).toEqual({});
    expect(effectiveChord(store.snapshot().preferences, "edit.undo")).toBe("Mod+Z");
  });

  it("会话方法在共享装配里以同一仓库工作", () => {
    const store = new CustomizationStore(memoryStorage());
    setDefaultCustomizationStore(store);
    const session = createSession(() => context());
    session.setCustomizationShortcut("edit.copy", "Mod+Shift+K", true);
    expect(session.customizationChord("edit.copy")).toBe("Mod+Shift+K");
    expect(session.customizationState().persistence).toBe("local");
  });

  it("外壳按键端口：改绑后旧出厂组合不再触发，恢复出厂后重新生效", () => {
    const store = new CustomizationStore(memoryStorage());
    setDefaultCustomizationStore(store);
    const session = createSession(() => context());
    const undoOnZ = key({ key: "z", code: "KeyZ", ctrlKey: true });

    expect(session.resolveCustomizationKey(undoOnZ, false)).toEqual({ kind: "command", id: "edit.undo" });
    // 改绑：Ctrl+U 生效，Ctrl+Z 不再撤销（这是「自定义快捷键」的实际含义）。
    session.setCustomizationShortcut("edit.undo", "Mod+U");
    expect(session.resolveCustomizationKey(key({ key: "u", code: "KeyU", ctrlKey: true }), false))
      .toEqual({ kind: "command", id: "edit.undo" });
    expect(session.resolveCustomizationKey(undoOnZ, false)).toBeNull();
    // 解绑后同样不触发，且不影响其它动作。
    session.setCustomizationShortcut("edit.undo", "");
    expect(session.resolveCustomizationKey(undoOnZ, false)).toBeNull();
    expect(session.resolveCustomizationKey(key({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true }), false))
      .toEqual({ kind: "command", id: "edit.redo" });
    // 恢复出厂后旧组合重新生效。
    session.resetCustomizationShortcuts();
    expect(session.resolveCustomizationKey(undoOnZ, false)).toEqual({ kind: "command", id: "edit.undo" });
  });
});
