/**
 * 提示词提交键盘策略测试（change: 2026-10-09-improve-canvas-workflow，任务 3.1/3.2）。
 */
import { describe, expect, it } from "vitest";
import { promptSubmitHint, resolvePromptSubmitKey, type PromptKeyboardContext, type PromptKeyboardEvent } from "./prompt-keyboard.js";

function key(overrides: Partial<PromptKeyboardEvent> = {}): PromptKeyboardEvent {
  return { key: "Enter", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

function ctx(overrides: Partial<PromptKeyboardContext> = {}): PromptKeyboardContext {
  return { isMac: false, readOnly: false, blocked: false, busy: false, candidateMenuOpen: false, ...overrides };
}

describe("Enter 默认换行", () => {
  it("普通 Enter 换行，不提交", () => {
    expect(resolvePromptSubmitKey(key(), ctx()).action).toBe("newline");
  });
  it("Shift+Enter 换行", () => {
    expect(resolvePromptSubmitKey(key({ shiftKey: true }), ctx()).action).toBe("newline");
  });
  it("非 Enter 键不处理", () => {
    expect(resolvePromptSubmitKey(key({ key: "a" }), ctx()).action).toBe("none");
  });
});

describe("平台生成快捷键", () => {
  it("Windows/Linux Ctrl+Enter 提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ isMac: false })).action).toBe("submit");
  });
  it("macOS Meta+Enter 提交，Ctrl 不触发", () => {
    expect(resolvePromptSubmitKey(key({ metaKey: true }), ctx({ isMac: true })).action).toBe("submit");
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ isMac: true })).action).toBe("newline");
  });
  it("带 Shift 的快捷键不提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true, shiftKey: true }), ctx()).action).toBe("newline");
  });
  it("重复 keydown 不提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true, repeat: true }), ctx()).action).toBe("none");
  });
});

describe("输入法与候选", () => {
  it("组合中（isComposing）不提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true, isComposing: true }), ctx()).action).toBe("ime");
  });
  it("IME 229 不提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true, keyCode: 229 }), ctx()).action).toBe("ime");
  });
  it("候选菜单打开时 Enter 先选候选", () => {
    expect(resolvePromptSubmitKey(key(), ctx({ candidateMenuOpen: true })).action).toBe("candidate");
    // 即使按生成快捷键也不提交
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ candidateMenuOpen: true })).action).toBe("candidate");
  });
});

describe("门禁", () => {
  it("只读不提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ readOnly: true })).action).toBe("none");
  });
  it("阻止原因存在时不提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ blocked: true })).action).toBe("none");
  });
  it("正在提交时不重复提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ busy: true })).action).toBe("none");
  });
});

describe("帮助文案", () => {
  it("按平台给出中文快捷键说明", () => {
    expect(promptSubmitHint(false)).toBe("回车换行，Ctrl+Enter 生成");
    expect(promptSubmitHint(true)).toBe("回车换行，⌘+Enter 生成");
  });
});
