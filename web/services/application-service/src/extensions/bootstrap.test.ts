import { describe, expect, it, vi } from "vitest";
import type { BootstrapExtension, FoundationSlot, StorageProvider } from "@woohaa3/contracts";
import { bootstrapProviders } from "./bootstrap.js";

function fixture(slot: FoundationSlot, requires: readonly FoundationSlot[] = [], events: string[] = []): BootstrapExtension {
  return { extensionId: slot, providers: [{ slot, requires, async create(ctx) {
    for (const dependency of requires) ctx.get(dependency);
    events.push(`open:${slot}`);
    return { value: { providerId: slot }, dispose: () => { events.push(`close:${slot}`); } };
  } } as BootstrapExtension["providers"][number]] };
}

describe("foundation bootstrap", () => {
  it("乱序声明按依赖初始化，反向释放且 close 幂等", async () => {
    const events: string[] = [];
    const runtime = await bootstrapProviders([fixture("access", ["storage", "identity"], events), fixture("identity", ["storage"], events), fixture("storage", [], events)]);
    expect(runtime.owners).toEqual({ storage: "storage", identity: "identity", access: "access" });
    await runtime.close(); await runtime.close();
    expect(events).toEqual(["open:storage", "open:identity", "open:access", "close:access", "close:identity", "close:storage"]);
  });
  it("只有存储时不创建或登记身份与权限 provider", async () => {
    const events: string[] = [];
    const runtime = await bootstrapProviders([fixture("storage", [], events)]);
    expect(runtime.accessControl).toBe(false);
    expect(Object.keys(runtime.providers)).toEqual(["storage"]);
    expect(runtime.owners).toEqual({ storage: "storage" });
    await runtime.close();
    expect(events).toEqual(["open:storage", "close:storage"]);
  });
  it.each(["identity", "access"] as const)("只有 %s 时不创建任何资源", async slot => {
    const events: string[] = [];
    await expect(bootstrapProviders([fixture("storage", [], events), fixture(slot, [], events)])).rejects.toThrow("缺少必需 provider");
    expect(events).toEqual([]);
  });
  it.each(["missing", "duplicate", "cycle", "unknown-dependency"])("%s 在任何工厂运行前失败", async kind => {
    const events: string[] = [];
    const entries = [fixture("storage", [], events), fixture("identity", ["storage"], events), fixture("access", ["identity"], events)];
    if (kind === "missing") entries.pop();
    if (kind === "duplicate") entries.push({ ...fixture("identity"), extensionId: "other" });
    if (kind === "cycle") entries[0] = fixture("storage", ["access"], events);
    if (kind === "unknown-dependency") entries[0] = fixture("storage", ["other" as FoundationSlot], events);
    await expect(bootstrapProviders(entries)).rejects.toThrow();
    expect(events).toEqual([]);
  });
  it("工厂越过声明依赖时拒绝，并释放已经打开的资源", async () => {
    const events: string[] = [];
    const bad: BootstrapExtension = { extensionId: "bad", providers: [{ slot: "identity", requires: [], async create(ctx) { ctx.get("storage"); throw new Error("unreachable"); } }] };
    await expect(bootstrapProviders([fixture("storage", [], events), bad, fixture("access")])).rejects.toThrow("未声明依赖");
    expect(events).toEqual(["open:storage", "close:storage"]);
  });
  it("失败 provider 的 dispose 和之前资源均执行，即使某个 dispose 抛错", async () => {
    const close = vi.fn(() => { throw new Error("cleanup"); });
    const events: string[] = [];
    const bad: BootstrapExtension<StorageProvider> = { extensionId: "bad", providers: [{ slot: "identity", requires: [], async create() { return { value: { providerId: "bad", ready: () => false, authenticate: vi.fn() }, dispose: close }; } }] };
    await expect(bootstrapProviders([fixture("storage", [], events), bad, fixture("access")])).rejects.toThrow("启动失败");
    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual(["open:storage", "close:storage"]);
  });
});

it("普通 extension dispose 保留 bootstrap 注册，重复注册仍拒绝", async () => {
  const { createProviderRegistry } = await import("./provider-registry.js");
  const registry = createProviderRegistry();
  const identity = { providerId: "foundation", authenticate: vi.fn() };
  registry.register({ slot: "identity", extensionId: "identity-extension", providerId: identity.providerId, value: identity, bootstrap: true });
  registry.releaseExtension("identity-extension");
  expect(registry.identityProvider()).toBe(identity);
  expect(() => registry.register({ slot: "identity", extensionId: "other", providerId: "other", value: identity })).toThrow("槽位已被占用");
});
