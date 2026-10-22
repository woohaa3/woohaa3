/**
 * 设置 edit-session：dirty/pending 汇总、放弃与强制释放
 * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.3/3.4 / design D4）。
 *
 * 纯状态机测试：不渲染、不请求；覆盖「逐项保存」下的退出保护所需最小事实。
 */
import { describe, expect, it, vi } from "vitest";
import { createSettingsEditSession } from "./edit-session.js";

describe("设置 edit-session", () => {
  it("汇总多个编辑项的 dirty/pending，并在变化时通知", () => {
    const session = createSettingsEditSession();
    const listener = vi.fn();
    session.subscribe(listener);

    const a = session.register({ id: "row:a" });
    const b = session.register({ id: "row:b" });
    expect(session.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });

    a.report({ dirty: true, pending: false });
    expect(session.getSnapshot()).toMatchObject({ dirty: true, hasChanges: true });

    b.report({ dirty: false, pending: true });
    expect(session.getSnapshot()).toEqual({ dirty: true, pending: true, hasChanges: true });
    expect(session.isPending()).toBe(true);

    // 重复上报相同状态不通知。
    const calls = listener.mock.calls.length;
    a.report({ dirty: true, pending: false });
    expect(listener.mock.calls.length).toBe(calls);

    // 保存成功：清 dirty；pending 仍由另一项决定。
    a.report({ dirty: false, pending: false });
    expect(session.getSnapshot()).toMatchObject({ dirty: false, pending: true });
    b.report({ dirty: false, pending: false });
    expect(session.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });
  });

  it("确认放弃只清 dirty，不影响进行中的 pending", () => {
    const session = createSettingsEditSession();
    const a = session.register({ id: "row:a" });
    const b = session.register({ id: "row:b" });
    a.report({ dirty: true, pending: false });
    b.report({ dirty: false, pending: true });

    session.discardDrafts();
    expect(session.getSnapshot()).toEqual({ dirty: false, pending: true, hasChanges: true });
  });

  it("注销后不再计入；reset 清空一切并停止通知", () => {
    const session = createSettingsEditSession();
    const listener = vi.fn();
    session.subscribe(listener);
    const registration = session.register({ id: "row:a" });
    registration.report({ dirty: true, pending: false });
    registration.dispose();
    expect(session.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });

    registration.report({ dirty: true, pending: false });
    expect(session.getSnapshot().dirty).toBe(false);

    session.reset();
    const calls = listener.mock.calls.length;
    session.register({ id: "row:c" });
    expect(listener.mock.calls.length).toBe(calls);
    expect(session.getSnapshot()).toEqual({ dirty: false, pending: false, hasChanges: false });
  });

  it("未注册的编辑项上报被忽略（旧实例/迟到结果不污染新会话）", () => {
    const session = createSettingsEditSession();
    const stale = session.register({ id: "row:a" });
    session.reset();
    stale.report({ dirty: true, pending: true });
    expect(session.getSnapshot().hasChanges).toBe(false);
  });
});
