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

describe("Enter 生成", () => {
  it("普通 Enter 提交", () => {
    expect(resolvePromptSubmitKey(key(), ctx()).action).toBe("submit");
  });
  it("Shift+Enter 换行，不提交", () => {
    expect(resolvePromptSubmitKey(key({ shiftKey: true }), ctx()).action).toBe("newline");
  });
  it("Alt+Enter 换行，不提交", () => {
    expect(resolvePromptSubmitKey(key({ altKey: true }), ctx()).action).toBe("newline");
  });
  it("非 Enter 键不处理", () => {
    expect(resolvePromptSubmitKey(key({ key: "a" }), ctx()).action).toBe("none");
  });
});

describe("兼容的生成快捷键", () => {
  it("Windows/Linux Ctrl+Enter 提交", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ isMac: false })).action).toBe("submit");
  });
  it("macOS Meta+Enter 提交", () => {
    expect(resolvePromptSubmitKey(key({ metaKey: true }), ctx({ isMac: true })).action).toBe("submit");
  });
  it("Ctrl/⌘+Shift+Enter 仍换行", () => {
    expect(resolvePromptSubmitKey(key({ ctrlKey: true, shiftKey: true }), ctx()).action).toBe("newline");
  });
  it("重复 keydown 不提交", () => {
    expect(resolvePromptSubmitKey(key({ repeat: true }), ctx()).action).toBe("none");
  });
});

describe("输入法与候选", () => {
  it("组合中（isComposing）不提交", () => {
    expect(resolvePromptSubmitKey(key({ isComposing: true }), ctx()).action).toBe("ime");
  });
  it("IME 229 不提交", () => {
    expect(resolvePromptSubmitKey(key({ keyCode: 229 }), ctx()).action).toBe("ime");
  });
  it("候选菜单打开时 Enter 先选候选", () => {
    expect(resolvePromptSubmitKey(key(), ctx({ candidateMenuOpen: true })).action).toBe("candidate");
    // 即使按生成快捷键也不提交
    expect(resolvePromptSubmitKey(key({ ctrlKey: true }), ctx({ candidateMenuOpen: true })).action).toBe("candidate");
  });
});

describe("门禁", () => {
  it("只读不提交", () => {
    expect(resolvePromptSubmitKey(key(), ctx({ readOnly: true })).action).toBe("none");
  });
  it("阻止原因存在时不提交", () => {
    expect(resolvePromptSubmitKey(key(), ctx({ blocked: true })).action).toBe("none");
  });
  it("正在提交时不重复提交", () => {
    expect(resolvePromptSubmitKey(key(), ctx({ busy: true })).action).toBe("none");
  });
});

describe("帮助文案", () => {
  it("给出 Enter 生成与 Shift+Enter 换行说明", () => {
    expect(promptSubmitHint()).toBe("Enter 生成，Shift+Enter 换行");
  });
});
