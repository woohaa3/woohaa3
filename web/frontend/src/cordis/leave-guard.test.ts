/**
 * 页面离开守卫回归
 * （change: 2026-10-21-add-photocraft-document-workspace，task 4.1 / design D6）。
 *
 * 覆盖：无未保存时不询问、失败停止离开、重复请求合并，以及参与者异常的安全默认值。
 */
import { describe, expect, it, vi } from "vitest";
import { PageLeaveGuard } from "./leave-guard.js";

describe("PageLeaveGuard", () => {
  it("没有未保存文档时直接允许离开（不调用结算）", async () => {
    const guard = new PageLeaveGuard();
    const settle = vi.fn(async () => ({ ok: true as const }));
    guard.register({ id: "editor", hasUnsaved: () => false, settle });
    expect(guard.hasUnsaved()).toBe(false);
    await expect(guard.settle()).resolves.toEqual({ ok: true });
    expect(settle).not.toHaveBeenCalled();
  });

  it("串行结算；失败即停止并返回原因（现场保留）", async () => {
    const guard = new PageLeaveGuard();
    const order: string[] = [];
    guard.register({ id: "a", hasUnsaved: () => true, settle: async () => { order.push("a"); return { ok: true }; } });
    guard.register({ id: "b", hasUnsaved: () => true, settle: async () => { order.push("b"); return { ok: false, reason: "B 保存失败" }; } });
    guard.register({ id: "c", hasUnsaved: () => true, settle: async () => { order.push("c"); return { ok: true }; } });
    await expect(guard.settle()).resolves.toEqual({ ok: false, reason: "B 保存失败" });
    // 失败后不再结算后续参与者。
    expect(order).toEqual(["a", "b"]);
  });

  it("重复请求合并为同一次结算（避免并发保存两次）", async () => {
    const guard = new PageLeaveGuard();
    let resolves = 0;
    const settle = vi.fn(async () => { resolves += 1; await Promise.resolve(); return { ok: true as const }; });
    guard.register({ id: "editor", hasUnsaved: () => true, settle });
    const [first, second] = await Promise.all([guard.settle(), guard.settle()]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(resolves).toBe(1);
  });

  it("参与者查询抛错时不报告「可安全离开」", () => {
    const guard = new PageLeaveGuard();
    guard.register({ id: "broken", hasUnsaved: () => { throw new Error("boom"); }, settle: async () => ({ ok: true }) });
    expect(guard.hasUnsaved()).toBe(true);
  });

  it("注销后不再参与", async () => {
    const guard = new PageLeaveGuard();
    const settle = vi.fn(async () => ({ ok: true as const }));
    const dispose = guard.register({ id: "editor", hasUnsaved: () => true, settle });
    dispose();
    expect(guard.hasUnsaved()).toBe(false);
    await guard.settle();
    expect(settle).not.toHaveBeenCalled();
  });
});
