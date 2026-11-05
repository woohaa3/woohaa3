/**
 * 画布快捷键路由（change: align-godot-canvas-interactions，任务 3.4）。
 */
import { describe, expect, it } from "vitest";
import { isEditableElement, isMacPlatform, resolveCanvasShortcut, type ShortcutContext } from "./shortcuts.js";

it("only duplicates when canvas input is writable and not editing", () => {
  const event = { key: "d", ctrlKey: true, metaKey: false };
  const context = { keyboardActive: true, editingFocus: false, isMac: false, writable: true };
  expect(resolveCanvasShortcut(event, context)).toBe("duplicate");
  expect(resolveCanvasShortcut(event, { ...context, writable: false })).toBeNull();
  expect(resolveCanvasShortcut({ ...event, editableTarget: true }, context)).toBeNull();
  expect(resolveCanvasShortcut(event, { ...context, editingFocus: true })).toBeNull();
});

function ctx(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
  return { keyboardActive: true, editingFocus: false, isMac: false, writable: true, ...overrides };
}

function key(overrides: Partial<Parameters<typeof resolveCanvasShortcut>[0]> = {}) {
  return { key: "c", ctrlKey: false, metaKey: false, ...overrides };
}

describe("快捷键路由", () => {
  it("Windows/Linux 使用 Ctrl，macOS 使用 Cmd", () => {
    expect(resolveCanvasShortcut(key({ ctrlKey: true }), ctx())).toBe("copy");
    expect(resolveCanvasShortcut(key({ metaKey: true }), ctx({ isMac: true }))).toBe("copy");
    // 平台不匹配：macOS 下 Ctrl 不触发。
    expect(resolveCanvasShortcut(key({ ctrlKey: true }), ctx({ isMac: true }))).toBeNull();
    expect(resolveCanvasShortcut(key({ metaKey: true }), ctx())).toBeNull();
  });

  it("Mod+V 仍解析为 paste 动作（由控制器交给原生 paste event）", () => {
    // 路由只负责识别按键；runClipboardShortcut 不再抢先 consume（见 interaction-controller）。
    expect(resolveCanvasShortcut(key({ key: "v", ctrlKey: true }), ctx())).toBe("paste");
  });

  it("Delete/Backspace 删除", () => {
    expect(resolveCanvasShortcut(key({ key: "Delete" }), ctx())).toBe("delete");
    expect(resolveCanvasShortcut(key({ key: "Backspace" }), ctx())).toBe("delete");
  });

  it("编辑面获得焦点时不触发画布命令", () => {
    expect(resolveCanvasShortcut(key({ ctrlKey: true }), ctx({ editingFocus: true }))).toBeNull();
    expect(resolveCanvasShortcut(key({ key: "Delete" }), ctx({ editingFocus: true }))).toBeNull();
    expect(resolveCanvasShortcut(key({ ctrlKey: true, editableTarget: true }), ctx())).toBeNull();
  });

  it("页面已有文字选区时保留浏览器复制", () => {
    expect(resolveCanvasShortcut(key({ ctrlKey: true, textSelectionActive: true }), ctx())).toBeNull();
  });

  it("画布未获得键盘范围时不触发", () => {
    expect(resolveCanvasShortcut(key({ ctrlKey: true }), ctx({ keyboardActive: false }))).toBeNull();
  });

  it("离线（不可写）时删除被禁用，但复制仍可用", () => {
    expect(resolveCanvasShortcut(key({ key: "Delete" }), ctx({ writable: false }))).toBeNull();
    expect(resolveCanvasShortcut(key({ ctrlKey: true }), ctx({ writable: false }))).toBe("copy");
  });

  it("无关按键返回 null", () => {
    expect(resolveCanvasShortcut(key({ key: "a", ctrlKey: true }), ctx())).toBeNull();
    expect(resolveCanvasShortcut(key({ key: "c" }), ctx())).toBeNull();
  });
});

describe("平台与编辑面判定", () => {
  it("isMacPlatform 识别 macOS", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });

  it("isEditableElement 识别常见编辑面", () => {
    const make = (tag: string, extra: Record<string, unknown> = {}) =>
      ({ tagName: tag, getAttribute: () => null, ...extra }) as unknown as EventTarget;
    expect(isEditableElement(make("INPUT"))).toBe(true);
    expect(isEditableElement(make("TEXTAREA"))).toBe(true);
    expect(isEditableElement(make("DIV", { isContentEditable: true }))).toBe(true);
    expect(isEditableElement(make("DIV"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});
