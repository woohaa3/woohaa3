/**
 * 后端插件受控后台资源与 handler 输入/认证边界测试
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 2.3 / design D2）。
 *
 * 验证：停用后无遗留 listener/route；插件不能弱化宿主认证；激活前依赖校验失败不发布部分能力。
 */
import { describe, expect, it } from "vitest";
import { ExtensionHostError, createApplicationExtensionHost } from "./host.js";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";

describe("后台资源与认证边界（任务 2.3）", () => {
  it("停用后后台 listener 与 handler route 均无遗留", async () => {
    const host = createApplicationExtensionHost();
    const listeners = new Set<string>();
    const result = await host.activate({
      extensionId: "bg-plugin",
      activate: (h) => {
        h.registerHandler({ route: "bg/ping", auth: "public", handle: () => ({ body: "pong" }) });
        h.registerResource({
          id: "bg-loop",
          start: () => { listeners.add("bg-loop"); },
          stop: () => { listeners.delete("bg-loop"); }
        });
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listeners.has("bg-loop")).toBe(true);
    expect((await host.dispatch("bg/ping", { body: null, context: { authLevel: "public" } })).body).toBe("pong");

    await result.handle.dispose();
    expect(listeners.has("bg-loop")).toBe(false);
    await expect(host.dispatch("bg/ping", { body: null, context: { authLevel: "authenticated" } })).rejects.toBeInstanceOf(ExtensionHostError);
  });

  it("插件不能弱化宿主认证：authenticated handler 拒绝 public 调用", async () => {
    const host = createApplicationExtensionHost();
    await host.activate({
      extensionId: "secure-plugin",
      activate: (h) => {
        h.registerHandler({
          route: "secure/op",
          auth: "authenticated",
          handle: () => ({ body: "secret" })
        });
      }
    });
    // public 调用在进入插件逻辑前被拒绝。
    const before = host.snapshot();
    await expect(
      host.dispatch("secure/op", { body: null, context: { authLevel: "public" } })
    ).rejects.toMatchObject({ code: "unauthorized" });
    // authenticated 放行。
    expect((await host.dispatch("secure/op", { body: null, context: { authLevel: "authenticated" } })).body).toBe("secret");
    expect(host.snapshot()).toEqual(before);
  });

  it("handler 注册摘要携带 requiredActions（诊断可见）", async () => {
    const host = createApplicationExtensionHost();
    await host.activate({
      extensionId: "action-plugin",
      activate: (h) => {
        h.registerHandler({ route: "secure/act", auth: "authenticated", requiredActions: ["tasks.inspect"], handle: () => ({ body: "ok" }) });
      }
    });
    expect(host.snapshot()[0]?.handlers).toEqual([{ route: "secure/act", auth: "authenticated", requiredActions: ["tasks.inspect"] }]);
  });

  it("插件不能注册公网绝对路由或替换根 server 语义", async () => {
    const host = createApplicationExtensionHost();
    const result = await host.activate({
      extensionId: "bad-route",
      activate: (h) => {
        h.registerHandler({ route: "/api/public", auth: "public", handle: () => ({ body: null }) });
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("duplicate-handler");
  });

  it("重复 resource id 使 activation 回滚", async () => {
    const host = createApplicationExtensionHost();
    const result = await host.activate({
      extensionId: "dup-res",
      activate: (h) => {
        h.registerResource({ id: "r", stop: () => undefined });
        h.registerResource({ id: "r", stop: () => undefined });
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("duplicate-resource");
    expect(host.snapshot()).toEqual([]);
  });
});

describe("dependency isolation（任务 2.1/2.3）", () => {
  it("可选依赖缺失不阻塞 activation", async () => {
    const host = createApplicationExtensionHost();
    // 先提供必需依赖 core。
    await host.activate({ extensionId: "core-owner", activate: (h) => { h.registerCapability({ id: "core", value: "core" }); } });
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "optional-dep",
      optionalDependencies: ["not-there"],
      requiredDependencies: ["core"],
      activate: (h) => {
        h.registerCapability({ id: "optional-dep-cap", value: "v" });
      }
    };
    const result = await host.activate(definition);
    expect(result.ok).toBe(true);
    expect(host.hasCapability("optional-dep-cap")).toBe(true);
  });
});
