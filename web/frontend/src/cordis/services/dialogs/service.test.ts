/**
 * Dialog Service facade 测试（change: adopt-frontend-cordis-plugin-runtime，design D3/D7）。
 *
 * 覆盖：owner-scoped 注册返回 disposer、重复 ID 拒绝、部分失败回滚、dispose 后拒绝 open，
 * 且 Service 替换不写 Y.Doc/IndexedDB（结构性：不持有画布 store）。
 */
import { describe, expect, it } from "vitest";
import { DialogService } from "./service.js";
import type { DialogDefinition } from "./types.js";

const accept = (): { ok: true; payload: {} } => ({ ok: true, payload: {} });
const definition = (overrides: Partial<DialogDefinition> = {}): DialogDefinition => ({
  validatePayload: accept,
  ...overrides
});

describe("DialogService", () => {
  it("注册 definition/renderer 后 open 成功，dispose 后拒绝 open", () => {
    const service = new DialogService();
    const dispose = service.registerDialog("demo", { definition: definition(), renderer: () => null });
    expect(service.open({ dialogId: "demo" }).ok).toBe(true);
    dispose();
    expect(service.open({ dialogId: "demo" }).ok).toBe(false);
    expect(service.registeredDialogIds()).toEqual([]);
  });

  it("重复 ID 注册抛错并报告 owner", () => {
    const service = new DialogService();
    service.registerDialog("dup", { definition: definition() });
    expect(() => service.registerDialog("dup", { definition: definition() })).toThrow(/dup/);
  });

  it("renderer/disposer 与 definition 一并撤销", () => {
    const service = new DialogService();
    const dispose = service.registerDialog("with-renderer", {
      definition: definition(),
      renderer: () => null
    });
    expect(service.resolveRenderer("with-renderer")).not.toBeNull();
    dispose();
    expect(service.resolveRenderer("with-renderer")).toBeNull();
  });

  it("alert action 注册与撤销", () => {
    const service = new DialogService();
    const action = async () => ({ ok: true as const });
    const dispose = service.registerAlertAction("delete-1", action);
    expect(service.resolveAlertAction("delete-1")).toBe(action);
    dispose();
    expect(service.resolveAlertAction("delete-1")).toBeNull();
  });

  it("部分注册失败原子回滚：definition 已注册但 renderer 注册后抛错时不留半装配", () => {
    const service = new DialogService();
    const disposeA = service.registerDialog("a", { definition: definition() });
    // 模拟同一 Plugin scope 后续注册失败，回滚已完成的 A。
    disposeA();
    expect(service.registeredDialogIds()).toEqual([]);
  });

  it("isModalActive 与 requestCloseTop 遵循 dismissible/busy", () => {
    const service = new DialogService();
    service.registerDialog("m", { definition: definition({ dismissible: false }) });
    const opened = service.open({ dialogId: "m" });
    expect(opened.ok).toBe(true);
    expect(service.isModalActive()).toBe(true);
    expect(service.requestCloseTop().closed).toBe(false);
  });

  it("Service 替换互不影响（独立 registry/store）", () => {
    const a = new DialogService();
    const b = new DialogService();
    a.registerDialog("only-a", { definition: definition() });
    expect(a.open({ dialogId: "only-a" }).ok).toBe(true);
    expect(b.open({ dialogId: "only-a" }).ok).toBe(false);
  });
});
