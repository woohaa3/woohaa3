/**
 * 片场对象局部键盘 action 与分层 Escape 测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 5.1/5.3/5.4）。
 *
 * 覆盖与 Canvas Shell 的唯一输入路由契约：Delete/Backspace 删除选中对象（无选中消费为
 * 无动作，绝不回退删整个片场）；repeat/pending/modifier 不触发；Escape 分层
 * 取消手势 → 清选择 → 回落退出；输入面（input/IME/菜单）优先。
 */
import { describe, expect, it } from "vitest";
import { focusHarness, modelCanvas, modelCenter, targetFor } from "./test-support/model-focus-harness.js";
import type { InteractionControllerOptions } from "./interaction-controller.js";

type ObjectAction = NonNullable<InteractionControllerOptions["filmSetObjectAction"]>;

function actionHarness(overrides: Partial<{
  active: boolean;
  hasSelection: boolean;
  pending: boolean;
  dragging: boolean;
}> = {}) {
  const calls = { delete: 0, clear: 0, cancelGesture: 0 };
  const action: ObjectAction = {
    active: () => overrides.active ?? true,
    hasSelection: () => overrides.hasSelection ?? true,
    pending: () => overrides.pending ?? false,
    deleteSelected: () => {
      calls.delete += 1;
      return true;
    },
    clearSelection: () => {
      calls.clear += 1;
      return overrides.hasSelection ?? true;
    },
    cancelGesture: () => {
      calls.cancelGesture += 1;
      return overrides.dragging ?? false;
    }
  };
  return { action, calls };
}

/** 进入模型聚焦并返回事件与焦点意图捕获。 */
function focusedHarness(action: ObjectAction) {
  const intents: Array<{ type: string }> = [];
  const h = focusHarness({ filmSetObjectAction: action });
  const point = modelCenter(targetFor(modelCanvas()));
  h.dom.fire("dblclick", { clientX: point.x, clientY: point.y });
  return { ...h, intents };
}

function keyEvent(extra: Record<string, unknown> = {}) {
  let prevented = false;
  const event = {
    key: "Delete",
    code: "",
    target: null,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    preventDefault: () => {
      prevented = true;
    },
    ...extra
  };
  return { event, wasPrevented: () => prevented };
}

describe("片场对象键盘 Delete/Backspace（任务 5.1/5.3）", () => {
  it("Delete 删除当前选中对象并阻止默认行为", () => {
    const { action, calls } = actionHarness();
    const h = focusedHarness(action);
    const { event, wasPrevented } = keyEvent({ key: "Delete" });
    h.dom.fireKey("keydown", event);
    expect(calls.delete).toBe(1);
    expect(wasPrevented()).toBe(true);
    h.controller.dispose();
  });

  it("Backspace 与 Delete 共用同一删除 action（并阻止浏览器后退）", () => {
    const { action, calls } = actionHarness();
    const h = focusedHarness(action);
    const { event, wasPrevented } = keyEvent({ key: "Backspace" });
    h.dom.fireKey("keydown", event);
    expect(calls.delete).toBe(1);
    expect(wasPrevented()).toBe(true);
    h.controller.dispose();
  });

  it("无选中时消费按键为无动作，绝不回退删除整个片场", () => {
    const { action, calls } = actionHarness({ hasSelection: false });
    const h = focusedHarness(action);
    const { event, wasPrevented } = keyEvent({ key: "Delete" });
    h.dom.fireKey("keydown", event);
    expect(calls.delete).toBe(0);
    expect(wasPrevented()).toBe(true);
    h.controller.dispose();
  });

  it("keydown repeat 与 pending 目标不触发连删", () => {
    const repeat = actionHarness();
    const h1 = focusedHarness(repeat.action);
    h1.dom.fireKey("keydown", keyEvent({ key: "Delete", repeat: true }).event);
    expect(repeat.calls.delete).toBe(0);
    h1.controller.dispose();

    const pending = actionHarness({ pending: true });
    const h2 = focusedHarness(pending.action);
    h2.dom.fireKey("keydown", keyEvent({ key: "Delete" }).event);
    expect(pending.calls.delete).toBe(0);
    h2.controller.dispose();
  });

  it("带修饰键（Ctrl/Meta/Alt）不触发对象删除", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      const { action, calls } = actionHarness();
      const h = focusedHarness(action);
      h.dom.fireKey("keydown", keyEvent({ key: "Delete", [modifier]: true }).event);
      expect(calls.delete).toBe(0);
      h.controller.dispose();
    }
  });

  it("未处于片场对象编辑（只读/历史）时不消费，回退普通画布语义", () => {
    const { action, calls } = actionHarness({ active: false });
    const h = focusedHarness(action);
    const { event, wasPrevented } = keyEvent({ key: "Delete" });
    h.dom.fireKey("keydown", event);
    expect(calls.delete).toBe(0);
    expect(wasPrevented()).toBe(false);
    h.controller.dispose();
  });
});

describe("片场对象分层 Escape（任务 5.4）", () => {
  it("有活动手势时只取消手势，不清选择、不退出", () => {
    const { action, calls } = actionHarness({ dragging: true, hasSelection: true });
    const h = focusedHarness(action);
    const { event, wasPrevented } = keyEvent({ key: "Escape" });
    h.dom.fireKey("keydown", event);
    expect(calls.cancelGesture).toBe(1);
    expect(calls.clear).toBe(0);
    expect(wasPrevented()).toBe(true);
    expect(h.controller.isModelFocused()).toBe(true);
    h.controller.dispose();
  });

  it("无活动手势但有选择时清空对象选择，仍保持聚焦", () => {
    const { action, calls } = actionHarness({ dragging: false, hasSelection: true });
    const h = focusedHarness(action);
    h.dom.fireKey("keydown", keyEvent({ key: "Escape" }).event);
    expect(calls.cancelGesture).toBe(1);
    expect(calls.clear).toBe(1);
    expect(h.controller.isModelFocused()).toBe(true);
    h.controller.dispose();
  });

  it("无手势且无选择时回落退出聚焦", () => {
    const { action } = actionHarness({ dragging: false, hasSelection: false });
    const h = focusedHarness(action);
    h.dom.fireKey("keydown", keyEvent({ key: "Escape" }).event);
    expect(h.controller.isModelFocused()).toBe(false);
    h.controller.dispose();
  });

  it("Escape repeat 不重复逐层处理", () => {
    const { action, calls } = actionHarness({ dragging: true, hasSelection: true });
    const h = focusedHarness(action);
    h.dom.fireKey("keydown", keyEvent({ key: "Escape", repeat: true }).event);
    expect(calls.cancelGesture).toBe(0);
    expect(calls.clear).toBe(0);
    expect(h.controller.isModelFocused()).toBe(true);
    h.controller.dispose();
  });

  it("输入/IME/菜单面优先：不消费 Delete/Escape", () => {
    const input = { tagName: "INPUT", getAttribute: () => null } as unknown as EventTarget;
    const menu = {
      tagName: "DIV",
      isContentEditable: false,
      getAttribute: (name: string) => (name === "role" ? "menuitem" : null),
      closest: () => null
    } as unknown as EventTarget;
    for (const target of [input, menu]) {
      const { action, calls } = actionHarness({ dragging: true, hasSelection: true });
      const h = focusedHarness(action);
      const del = keyEvent({ key: "Delete", target });
      h.dom.fireKey("keydown", del.event);
      expect(calls.delete).toBe(0);
      expect(del.wasPrevented()).toBe(false);
      const esc = keyEvent({ key: "Escape", target });
      h.dom.fireKey("keydown", esc.event);
      expect(calls.cancelGesture).toBe(0);
      expect(esc.wasPrevented()).toBe(false);
      h.controller.dispose();
    }
  });
});
