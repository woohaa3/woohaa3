/**
 * 页面级 Plugin Runtime kernel 测试
 * （change: adopt-frontend-cordis-plugin-runtime，design D1/D2/D10）。
 *
 * 覆盖：启动顺序、required 失败回滚、optional 失败隔离、teardown 后零活动 fiber、
 * 依赖等待、独立 Context 不共享进程级残留。
 */
import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { Context as CordisContext } from "@deepseek-ai/cordis";
import { startFrontendRuntime, startFrontendScope, type FrontendExtensionDefinition } from "./kernel.js";
import { definePlugin } from "./plugin.js";

type FakeService = { calls: number };

function installFakePlatform(ctx: CordisContext) {
  ctx.provide("fakeA" as never, { calls: 0 } as never);
  ctx.provide("fakeB" as never, { calls: 0 } as never);
}

describe("startFrontendRuntime", () => {
  it("按声明启动 plugin 并进入 ready", async () => {
    const applied: string[] = [];
    const plugins: FrontendExtensionDefinition[] = [
      {
        id: "p1",
        required: true,
        plugin: definePlugin(
          () => {
            applied.push("p1");
          },
          { name: "p1", inject: ["fakeA"] }
        )
      },
      {
        id: "p2",
        required: true,
        plugin: definePlugin(
          () => {
            applied.push("p2");
          },
          { name: "p2", inject: ["fakeB"] }
        )
      }
    ];
    const runtime = await startFrontendRuntime({ installPlatform: installFakePlatform, plugins });
    expect(applied).toEqual(["p1", "p2"]);
    expect(runtime.status().phase).toBe("ready");
    expect(runtime.status().plugins.map((plugin) => plugin.status)).toEqual(["active", "active", "active"]);
    await runtime.dispose();
  });

  it("required plugin 失败时回滚并抛错，零活动 fiber", async () => {
    const disposeSpy = vi.fn();
    const plugins: FrontendExtensionDefinition[] = [
      {
        id: "ok",
        required: true,
        plugin: definePlugin(
          (ctx: CordisContext) => {
            ctx.effect(() => () => disposeSpy(), "ok-effect");
          },
          { name: "ok", inject: ["fakeA"] }
        )
      },
      {
        id: "boom",
        required: true,
        plugin: definePlugin(
          () => {
            throw new Error("boom");
          },
          { name: "boom", inject: ["fakeB"] }
        )
      }
    ];
    await expect(startFrontendRuntime({ installPlatform: installFakePlatform, plugins })).rejects.toThrow(
      /required plugin "boom"/
    );
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("optional plugin 失败不阻塞 core，并暴露诊断", async () => {
    const plugins: FrontendExtensionDefinition[] = [
      { id: "core", required: true, plugin: definePlugin(() => undefined, { name: "core", inject: ["fakeA"] }) },
      {
        id: "optional",
        required: false,
        plugin: definePlugin(
          () => {
            throw new Error("optional-boom");
          },
          { name: "optional", inject: ["fakeB"] }
        )
      }
    ];
    const runtime = await startFrontendRuntime({ installPlatform: installFakePlatform, plugins });
    expect(runtime.status().phase).toBe("ready");
    expect(runtime.status().plugins.find((plugin) => plugin.id === "optional")?.status).toBe("failed");
    expect(runtime.status().plugins.find((plugin) => plugin.id === "core")?.status).toBe("active");
    await runtime.dispose();
  });

  it("依赖未 ready 时 plugin 保持 pending，不产生副作用", async () => {
    const applied = vi.fn();
    const plugins: FrontendExtensionDefinition[] = [
      {
        id: "late",
        required: false,
        plugin: definePlugin(() => {
          applied();
        }, { name: "late", inject: ["neverProvided"] })
      }
    ];
    const runtime = await startFrontendRuntime({ installPlatform: installFakePlatform, plugins });
    expect(applied).not.toHaveBeenCalled();
    const diagnostic = runtime.status().plugins.find((plugin) => plugin.id === "late");
    expect(diagnostic?.status).toBe("pending");
    expect(diagnostic?.missingServices).toContain("neverProvided");
    await runtime.dispose();
  });

  it("dispose 后重复 dispose 幂等，且 registry 归零", async () => {
    const plugins: FrontendExtensionDefinition[] = [
      { id: "p", required: true, plugin: definePlugin(() => undefined, { name: "p", inject: ["fakeA"] }) }
    ];
    const runtime = await startFrontendRuntime({ installPlatform: installFakePlatform, plugins });
    await runtime.dispose();
    await runtime.dispose();
    expect(runtime.ctx.registry.size).toBe(0);
  });

  it("独立 Context 之间不共享 fake service", async () => {
    const services: FakeService[] = [];
    const make = () =>
      startFrontendRuntime({
        installPlatform: (ctx) => {
          installFakePlatform(ctx);
          services.push((ctx as unknown as { fakeA: FakeService }).fakeA);
        },
        plugins: [
          {
            id: "reader",
            required: true,
            plugin: definePlugin(() => undefined, { name: "reader", inject: ["fakeA"] })
          }
        ]
      });
    const first = await make();
    expect(services[services.length - 1].calls).toBe(0);
    services[services.length - 1].calls = 5;
    await first.dispose();
    const second = await make();
    expect(services[services.length - 1].calls).toBe(0);
    await second.dispose();
  });
});

describe("startFrontendScope disabled diagnostics（change: add-frontend-plugin-manager）", () => {
  it("未选择的 optional 报告 disabled（区别于 failed），required 仍 active", async () => {
    const runtime = await startFrontendScope(new Context(), {
      install: () => undefined,
      plugins: [
        {
          id: "core",
          required: true,
          plugin: definePlugin(() => undefined, { name: "core", inject: [] })
        }
      ],
      disabled: [{ id: "node-history", reason: "用户已禁用该可选插件" }]
    });
    const status = runtime.status();
    expect(status.phase).toBe("ready");
    const disabled = status.plugins.find((plugin) => plugin.id === "node-history");
    expect(disabled?.status).toBe("disabled");
    expect(disabled?.required).toBe(false);
    expect(disabled?.reason).toContain("禁用");
    expect(status.plugins.find((plugin) => plugin.id === "core")?.status).toBe("active");
    await runtime.dispose();
  });

  it("disabled 与启动失败可区分（不把禁用计为失败）", async () => {
    const runtime = await startFrontendScope(new Context(), {
      install: () => undefined,
      plugins: [
        {
          id: "optional-boom",
          required: false,
          plugin: definePlugin(() => {
            throw new Error("boom");
          }, { name: "optional-boom", inject: [] })
        }
      ],
      disabled: [{ id: "node-history", reason: "用户已禁用该可选插件" }]
    });
    const status = runtime.status();
    expect(status.plugins.find((plugin) => plugin.id === "optional-boom")?.status).toBe("failed");
    expect(status.plugins.find((plugin) => plugin.id === "node-history")?.status).toBe("disabled");
    await runtime.dispose();
  });
});


describe("实例级重装（change: 2026-10-27-add-extension-dev-reload）", () => {
  it("required 扩展重装：替换代码、保留 scope 服务、可重复触发", async () => {
    const applied: string[] = [];
    const disposed: string[] = [];
    const versions = ["v1", "v2", "v3"];
    let index = 1;
    const makePlugin = (version: string) =>
      definePlugin(
        (ctx: CordisContext) => {
          applied.push(version);
          ctx.effect(() => () => disposed.push(version));
        },
        { name: `p-${version}`, inject: ["fakeA"] }
      );

    const runtime = await startFrontendScope(new Context(), {
      install: installFakePlatform,
      plugins: [
        {
          id: "hot",
          required: true,
          plugin: makePlugin(versions[0]!),
          resolvePlugin: async () => makePlugin(versions[index++]!)
        }
      ]
    });

    expect(applied).toEqual(["v1"]);
    const platformService = runtime.ctx.get("fakeA" as never);

    await runtime.reloadExtension!("hot");
    expect(applied).toEqual(["v1", "v2"]);
    expect(disposed).toEqual(["v1"]);
    // scope 服务实例不变：没有重建 scope。
    expect(runtime.ctx.get("fakeA" as never)).toBe(platformService);
    expect(runtime.status().plugins.find((plugin) => plugin.id === "hot")?.status).toBe("active");

    await runtime.reloadExtension!("hot");
    expect(applied).toEqual(["v1", "v2", "v3"]);
    await runtime.dispose();
  });

  it("scope 自己的 fiber 提供 extensionReload，并在 dispose 后移除", async () => {
    const first = await startFrontendScope(new Context(), { install: installFakePlatform, plugins: [] });
    const second = await startFrontendScope(new Context(), { install: installFakePlatform, plugins: [] });
    // 两个 scope 的入口按 scope 隔离，并存不冲突（快速切换时可能同时启动）。
    expect(first.ctx.get("extensionReload" as never)).toBe(first.reloadExtension);
    expect(second.ctx.get("extensionReload" as never)).toBe(second.reloadExtension);

    await first.dispose();
    expect(first.ctx.get("extensionReload" as never)).toBeUndefined();
    expect(second.ctx.get("extensionReload" as never)).toBe(second.reloadExtension);
    await second.dispose();
    expect(second.ctx.get("extensionReload" as never)).toBeUndefined();
  });

  it("未装配的 id 返回 not-mounted，且不因此装配", async () => {
    const applied: string[] = [];
    const runtime = await startFrontendScope(new Context(), {
      install: installFakePlatform,
      plugins: [
        {
          id: "optional-hot",
          required: false,
          plugin: definePlugin(
            (ctx: CordisContext) => {
              applied.push("mounted");
              ctx.effect(() => () => undefined);
            },
            { name: "optional-hot", inject: ["fakeA"] }
          )
        }
      ]
    });

    expect(await runtime.reloadExtension!("missing")).toBe("not-mounted");
    expect(applied).toEqual(["mounted"]);
    expect(runtime.plugins!.ids()).toEqual(["optional-hot"]);
    await runtime.dispose();
  });

  it("重装失败保留上一次成功的装配", async () => {
    let fail = false;
    const runtime = await startFrontendScope(new Context(), {
      install: installFakePlatform,
      plugins: [
        {
          id: "flaky",
          required: true,
          plugin: definePlugin(() => undefined, { name: "flaky-v1", inject: ["fakeA"] }),
          resolvePlugin: async () => {
            if (fail) throw new Error("产物解析失败");
            return definePlugin(() => undefined, { name: "flaky-v2", inject: ["fakeA"] });
          }
        }
      ]
    });

    fail = true;
    await expect(runtime.reloadExtension!("flaky")).rejects.toThrow("产物解析失败");
    // 旧实例仍在运行，扩展仍是 active。
    expect(runtime.status().plugins.find((plugin) => plugin.id === "flaky")?.status).toBe("active");

    fail = false;
    expect(await runtime.reloadExtension!("flaky")).toBe("reloaded");
    await runtime.dispose();
  });

  it("重装与启停无关：停用后不再重装，启用后按其自身代码装配", async () => {
    const runtime = await startFrontendScope(new Context(), {
      install: installFakePlatform,
      plugins: [
        {
          id: "optional-swap",
          required: false,
          plugin: definePlugin(() => undefined, { name: "optional-swap", inject: ["fakeA"] }),
          resolvePlugin: async () => definePlugin(() => undefined, { name: "optional-swap-v2", inject: ["fakeA"] })
        }
      ]
    });

    await runtime.plugins!.disable("optional-swap");
    expect(await runtime.reloadExtension!("optional-swap")).toBe("not-mounted");
    await runtime.plugins!.enable({
      id: "optional-swap",
      required: false,
      plugin: definePlugin(() => undefined, { name: "optional-swap", inject: ["fakeA"] })
    });
    expect(await runtime.reloadExtension!("optional-swap")).toBe("reloaded");
    await runtime.dispose();
  });
});
