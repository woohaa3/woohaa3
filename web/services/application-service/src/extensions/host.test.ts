/**
 * Task 后端插件宿主测试（change: 2026-10-04-add-backend-plugin-extensions，任务 2.1）。
 *
 * 验证：依赖解析、typed registration、handler 分派、重复注册稳定拒绝、activation 反序回滚
 * 与 optional 失败隔离。
 */
import { describe, expect, it } from "vitest";
import type { StorageBackend } from "@woohaa3/contracts";
import { ExtensionHostError, createApplicationExtensionHost } from "./host.js";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";

describe("Task 后端插件宿主（任务 2.1）", () => {
  it("public routes follow successful activation, reject conflicting owners, and disappear on disposal", async () => {
    const host = createApplicationExtensionHost();
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "external-agent",
      publicRoutes: [{ extensionId: "external-agent", publicPath: "/api/external-agent", route: "agent", methods: ["POST"] }],
      activate() { expect(host.declaredPublicRoutes?.()).toEqual([]); }
    };
    const result = await host.activate(definition);
    expect(result.ok).toBe(true);
    expect(host.declaredPublicRoutes?.()).toEqual(definition.publicRoutes);
    expect((await host.activate({ ...definition, extensionId: "conflict", publicRoutes: [{ ...definition.publicRoutes![0]!, extensionId: "conflict" }] })).ok).toBe(false);
    expect((await host.activate({ extensionId: "broken", publicRoutes: [{ ...definition.publicRoutes![0]!, extensionId: "broken", publicPath: "/api/broken" }], activate() { throw new Error("failed"); } })).ok).toBe(false);
    expect(host.declaredPublicRoutes?.()).toEqual(definition.publicRoutes);
    if (result.ok) await result.handle.dispose();
    expect(host.declaredPublicRoutes?.()).toEqual([]);
    await host.dispose();
  });

  it("依赖满足时激活并注册 capability / handler / resource", async () => {
    const host = createApplicationExtensionHost();
    const events: string[] = [];
    // 宿主核心先提供 task-runtime capability（插件声明依赖）。
    await host.activate({
      extensionId: "task-core",
      activate: (h) => {
        h.registerCapability({ id: "task-runtime", version: 1, value: { kind: "runtime" } });
      }
    });
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "sample-site-extension",
      requiredDependencies: ["task-runtime"],
      activate: (h) => {
        h.registerCapability({ id: "sample-cap", version: 1, value: { kind: "sample" } });
        h.registerHandler({
          route: "actions/run",
          auth: "authenticated",
          handle: ({ body }) => ({ status: 200, body: { echo: body } })
        });
        h.registerResource({
          id: "ticker",
          start: () => { events.push("start:ticker"); },
          stop: () => { events.push("stop:ticker"); }
        });
        return { dispose: () => { events.push("dispose"); } };
      }
    };
    const result = await host.activate(definition);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(host.hasCapability("sample-cap", 1)).toBe(true);
    expect(host.resolveCapability("sample-cap", 1)).toEqual({ kind: "sample" });
    expect(events).toEqual(["start:ticker"]);

    const dispatched = await host.dispatch("actions/run", { body: { x: 1 }, context: { authLevel: "authenticated" } });
    expect(dispatched).toEqual({ status: 200, body: { echo: { x: 1 } } });
    expect(host.snapshot()).toEqual([
      { extensionId: "task-core", capabilities: ["task-runtime"], handlers: [], httpHandlers: [], resources: [] },
      { extensionId: "sample-site-extension", capabilities: ["sample-cap"], handlers: [{ route: "actions/run", auth: "authenticated" }], httpHandlers: [], resources: ["ticker"] }
    ]);

    await result.handle.dispose();
    // 反序释放：先 stop 已启动的资源，再执行 activation disposer。
    expect(events).toEqual(["start:ticker", "stop:ticker", "dispose"]);
    expect(host.hasCapability("sample-cap", 1)).toBe(false);
    expect(host.snapshot().map((entry) => entry.extensionId)).toEqual(["task-core"]);
  });

  it("必需依赖缺失时不产生部分可用贡献并暴露诊断", async () => {
    const host = createApplicationExtensionHost();
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "dep-plugin",
      requiredDependencies: ["missing-cap"],
      activate: (h) => {
        h.registerCapability({ id: "should-not-exist", version: 1, value: true });
      }
    };
    const result = await host.activate(definition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingDependencies).toEqual(["missing-cap"]);
    expect(host.hasCapability("should-not-exist", 1)).toBe(false);
    expect(host.snapshot()).toEqual([]);
  });

  it("同一扩展重复 handler 稳定拒绝且该 activation 回滚；不同扩展可同名 route", async () => {
    const host = createApplicationExtensionHost();
    await host.activate({
      extensionId: "owner-a",
      activate: (h) => {
        h.registerCapability({ id: "shared", version: 1, value: "a" });
        h.registerHandler({ route: "a/handle", auth: "public", handle: () => ({ body: null }) });
      }
    });
    const conflicting: ApplicationBackendExtensionDefinition = {
      extensionId: "owner-b",
      activate: (h) => {
        h.registerCapability({ id: "own-cap", version: 1, value: "b" });
        h.registerHandler({ route: "a/handle", auth: "public", handle: () => ({ body: null }) });
        // 同一扩展内重复 route（不同扩展允许同名）→ 稳定拒绝并回滚。
        h.registerHandler({ route: "a/handle", auth: "public", handle: () => ({ body: null }) });
      }
    };
    const result = await host.activate(conflicting);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("duplicate-handler");
    // owner-b 的自有 capability 必须一并回滚，owner-a 的注册保持有效。
    expect(host.hasCapability("own-cap", 1)).toBe(false);
    expect(host.resolveCapability("shared", 1)).toBe("a");
    expect(host.snapshot().map((entry) => entry.extensionId)).toEqual(["owner-a"]);
    // 不同扩展声明同名 route 不冲突：各自按 owner 分派。
    const other = await host.activate({
      extensionId: "owner-c",
      activate: (h) => { h.registerHandler({ route: "a/handle", auth: "public", handle: () => ({ body: "c" }) }); }
    });
    expect(other.ok).toBe(true);
    expect((await host.dispatch("a/handle", { body: null, context: { authLevel: "public" }, extensionId: "owner-c" })).body).toBe("c");
  });

  it("公开映射的 HTTP/raw 路由自带扩展名前缀时只记诊断、不阻断激活", async () => {
    const events: Array<Record<string, unknown>> = [];
    const host = createApplicationExtensionHost({ logger: (event) => events.push(event) });
    const result = await host.activate({
      extensionId: "local-agent",
      activate: (h) => {
        // 这两类的查找键来自 publicPath 之后的相对子路径，自带前缀必然查不到（2026-10 回归）。
        h.registerHttpHandler?.({ route: "local-agent/http", method: "GET", auth: "public", purpose: "read", handle: async () => undefined });
        h.registerRawHttpHandler?.({ route: "local-agent/connections", method: "GET", auth: "public", purpose: "read", handle: async () => undefined });
      }
    });
    expect(result.ok).toBe(true);
    // 诊断可查，但扩展照常激活：硬门槛在 CI，运行期不为一条不可达路由否掉整个扩展。
    expect(events.filter((event) => event.event === "extension-route-namespace-mismatch").map((event) => event.route)).toEqual([
      "local-agent/http",
      "local-agent/connections"
    ]);
    expect(host.snapshot()).toHaveLength(1);
  });

  it("JSON handler 的 route 自带扩展名前缀不告警：公开 URL 原样携带该 route", async () => {
    const events: Array<Record<string, unknown>> = [];
    const host = createApplicationExtensionHost({ logger: (event) => events.push(event) });
    const result = await host.activate({
      extensionId: "game-furnace",
      activate: (h) => {
        h.registerHandler({ route: "game-furnace/project-save", auth: "public", handle: () => ({ body: null }) });
      }
    });
    expect(result.ok).toBe(true);
    expect(events.some((event) => event.event === "extension-route-namespace-mismatch")).toBe(false);
    // 分派用同一个 route 查表：前缀写不写都能命中自己，所以这类不属于缺陷。
    expect((await host.dispatch("game-furnace/project-save", { body: null, context: { authLevel: "public" } })).body).toBeNull();
  });

  it("activation 中途抛错回滚已产生的注册（资源未 start 则不遗留）", async () => {
    const host = createApplicationExtensionHost();
    const events: string[] = [];
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "failing",
      activate: (h) => {
        h.registerCapability({ id: "failing-cap", version: 1, value: 1 });
        h.registerResource({ id: "r1", start: () => { events.push("start:r1"); }, stop: () => { events.push("stop:r1"); } });
        throw new Error("boom");
      }
    };
    const result = await host.activate(definition);
    expect(result.ok).toBe(false);
    // 资源 start 在 activation 成功之后才执行；中途抛错时未启动，也无遗留注册。
    expect(events).toEqual([]);
    expect(host.hasCapability("failing-cap", 1)).toBe(false);
    expect(host.snapshot()).toEqual([]);
  });

  it("资源 start 失败时反序回滚已启动资源与全部注册", async () => {
    const host = createApplicationExtensionHost();
    const events: string[] = [];
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "start-fails",
      activate: (h) => {
        h.registerCapability({ id: "start-cap", version: 1, value: 1 });
        h.registerResource({ id: "r1", start: () => { events.push("start:r1"); }, stop: () => { events.push("stop:r1"); } });
        h.registerResource({
          id: "r2",
          start: () => {
            events.push("start:r2");
            throw new Error("start failed");
          },
          stop: () => { events.push("stop:r2"); }
        });
      }
    };
    const result = await host.activate(definition);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("activation-failed");
    // r2 start 失败：已 start 的 r1 反序 stop；r2 自身的 stop 不调用（未成功启动）。
    expect(events).toEqual(["start:r1", "start:r2", "stop:r1"]);
    expect(host.hasCapability("start-cap", 1)).toBe(false);
    expect(host.snapshot()).toEqual([]);
  });

  it("一个 optional 插件失败不影响其它插件与宿主核心", async () => {
    const host = createApplicationExtensionHost();
    const results = await host.activateManifest([
      { extensionId: "ok", activate: (h) => { h.registerCapability({ id: "ok-cap", version: 1, value: true }); } },
      { extensionId: "broken", requiredDependencies: ["absent"], activate: () => ({}) }
    ]);
    expect(results.map((entry) => entry.result.ok)).toEqual([true, false]);
    expect(host.hasCapability("ok-cap", 1)).toBe(true);
    // 宿主自身仍可继续激活新插件。
    expect((await host.activate({ extensionId: "later", activate: (h) => { h.registerCapability({ id: "later-cap", version: 1, value: 1 }); } })).ok).toBe(true);
  });

  it("未知路由分派抛 handler-not-found", async () => {
    const host = createApplicationExtensionHost();
    await expect(host.dispatch("nope", { body: null, context: { authLevel: "authenticated" } })).rejects.toBeInstanceOf(ExtensionHostError);
  });

  /**
   * 站点插件注册的存储后端必须随 owner 释放。
   *
   * 为什么这条重要：存储后端带着会话与连接，不是一条静态配置。停用扩展后如果 `ctx.storage`
   * 里还留着它，主存储会路由进一个「扩展已经不在」的实现——字节读写失败，但没有任何一条日志
   * 说得清是谁注册的。所以释放必须落在 owner 的反序回滚里，且对重复注销幂等。
   */
  it("站点插件注册的存储后端在停用/卸载时被注销（幂等）", async () => {
    const backends = new Map<string, StorageBackend>();
    const host = createApplicationExtensionHost({
      registerStorageFor: () => (backend: StorageBackend) => {
        if (backends.has(backend.backendId)) throw new Error(`存储后端已注册：${backend.backendId}`);
        backends.set(backend.backendId, backend);
      },
      releaseStorageFor: () => (backendId: string) => {
        // core 的 unregister 语义：不存在也算成功（幂等），这里照抄。
        backends.delete(backendId);
      }
    });

    const backend: StorageBackend = {
      backendId: "server",
      label: "服务端托管存储",
      head: async () => null,
      get: async () => ({ bytes: new Uint8Array() }),
      put: async () => undefined
    };
    const registered: string[] = [];
    const result = await host.activate({
      extensionId: "remote-server",
      activate: (h) => {
        expect(h.registerStorage).toBeTypeOf("function");
        h.registerStorage!(backend);
        registered.push(backend.backendId);
      }
    });
    expect(result.ok).toBe(true);
    expect([...backends.keys()]).toEqual(["server"]);

    if (!result.ok) return;
    await result.handle.dispose();
    expect(backends.size).toBe(0);
    // 幂等：再 dispose 一次不报错，也不会把别的 owner 的后端带走。
    await result.handle.dispose();
    expect(backends.size).toBe(0);
  });

  it("插件显式注销存储后端后，回滚不会重复注销同一个 id", async () => {
    const released: string[] = [];
    const host = createApplicationExtensionHost({
      registerStorageFor: () => () => undefined,
      releaseStorageFor: () => (backendId: string) => {
        released.push(backendId);
      }
    });
    const result = await host.activate({
      extensionId: "remote-server",
      activate: (h) => {
        h.registerStorage!({
          backendId: "server",
          head: async () => null,
          get: async () => ({ bytes: new Uint8Array() }),
          put: async () => undefined
        });
        h.unregisterStorage!("server");
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.handle.dispose();
    // 显式注销只记一次；owner 里已摘掉，回滚不再重复调。
    expect(released).toEqual(["server"]);
  });

  it("宿主没提供存储扩展点时插件拿不到 registerStorage（不伪造注册表）", async () => {
    const host = createApplicationExtensionHost();
    let sawRegisterStorage = true;
    const result = await host.activate({
      extensionId: "no-storage-seam",
      activate: (h) => {
        sawRegisterStorage = h.registerStorage !== undefined;
      }
    });
    expect(result.ok).toBe(true);
    expect(sawRegisterStorage).toBe(false);
  });
});

it("media format registrations are released on unload and activation rollback", async () => {
  const registrations = new Set<string>();
  const host = createApplicationExtensionHost({ registerMediaFormatFor: owner => format => {
    const key = `${owner}:${format.contentType}`;
    registrations.add(key);
    return () => { registrations.delete(key); };
  } });
  const format = { contentType: "application/vnd.fixture", maxBytes: 100, validate: async () => {} };
  const active = await host.activate({ extensionId: "format-good", activate(h) { h.registerMediaFormat!(format); } });
  expect(active.ok).toBe(true);
  expect(registrations.size).toBe(1);
  if (active.ok) await active.handle.dispose();
  expect(registrations.size).toBe(0);
  const failed = await host.activate({ extensionId: "format-bad", activate(h) { h.registerMediaFormat!(format); throw new Error("activation failed"); } });
  expect(failed.ok).toBe(false);
  expect(registrations.size).toBe(0);
});

it("pluginContextFor 暴露 mediaFormats，并在 release 时注销", () => {
  const registrations = new Set<string>();
  const host = createApplicationExtensionHost({ registerMediaFormatFor: owner => format => {
    const key = `${owner}:${format.contentType}`;
    registrations.add(key);
    return () => { registrations.delete(key); };
  } });
  const format = { contentType: "application/vnd.host-plugin", maxBytes: 100, validate: async () => {} };
  const surface = host.pluginContextFor("host-plugin");
  expect(surface.mediaFormats).toBeDefined();
  surface.mediaFormats!.register(format);
  expect([...registrations]).toEqual(["host-plugin:application/vnd.host-plugin"]);
  surface.release();
  expect(registrations.size).toBe(0);
});

describe("dispose reasons (task 4.1)", () => {
  it("passes detach/cancel reasons to resources and treats host shutdown as detach", async () => {
    const host = createApplicationExtensionHost();
    const reasons: string[] = [];
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "executor-holder",
      activate: (h) => {
        h.registerResource({ id: "executors", start: () => undefined, stop: (reason) => { reasons.push(reason ?? "none"); } });
      }
    };
    const activated = await host.activate(definition);
    expect(activated.ok).toBe(true);
    await host.disposeVersion("executor-holder", 0, "upgrade");
    expect(reasons).toEqual(["upgrade"]);

    await host.activate(definition);
    await host.dispose();
    expect(reasons).toEqual(["upgrade", "shutdown"]);
  });
});
