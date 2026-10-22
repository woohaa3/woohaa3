/**
 * 设置专项扩展装配（change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2/5.4）。
 *
 * - 已激活扩展：直接复用贡献，不加载、不新建 fiber；
 * - 未激活扩展：只调用 descriptor 的可选 settings-only 工厂，并以独立 fiber 挂到当前 scope；
 * - 重复打开按 id 去重（不增长）；关闭设置释放 fiber；
 * - 旧 artifact 缺设置入口 / 加载失败：返回原因，不回退执行完整 plugin；
 * - dispose 后的迟到结果不挂载。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFrontendScope, type FrontendRuntime } from "../../kernel.js";
import { createCanvasSettingsAssembly } from "./extension-settings-assembly.js";
import type { ExtensionRuntimeService } from "../../extension-runtime/service.js";
import type { ExtensionBrowserDescriptor } from "@woohaa3/contracts";

let runtime: FrontendRuntime | null = null;
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

/** 只提供 `loadDescriptor` 的最小 extension runtime 替身。 */
function fakeRuntime(descriptors: Record<string, Partial<ExtensionBrowserDescriptor> | Error>) {
  const loads: string[] = [];
  const service = {
    ensureCatalog: async () => null,
    current: () => null,
    metadata: () => [],
    entry: () => undefined,
    async loadDescriptor(extensionId: string) {
      loads.push(extensionId);
      const value = descriptors[extensionId];
      if (!value) throw new Error(`发布目录不含扩展：${extensionId}`);
      if (value instanceof Error) throw value;
      return {
        extensionId,
        configScope: "site",
        activation: "server-active",
        plugin: () => () => undefined,
        ...value
      } as ExtensionBrowserDescriptor;
    },
    diagnostics: () => [],
    report: () => undefined,
    retry: () => undefined,
    dispose: () => undefined
  } as unknown as ExtensionRuntimeService;
  return { service, loads };
}

const startScope = async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { SlotRegistry } = await import("../../slots.js");
  runtime = await startFrontendScope(new Context(), {
    // 最小 App 能力：设置装配只依赖 slots（Dialog/remote 由真实 scope 提供）。
    install: (ctx) => {
      ctx.provide("slots" as never, new SlotRegistry() as never);
    },
    plugins: []
  });
  return runtime.ctx;
};

describe("设置专项扩展装配", () => {
  it("未激活扩展只装配 settings-only 贡献，重复打开不增长", async () => {
    const ctx = await startScope();
    let pluginBuilds = 0;
    const { definePlugin } = await import("../../plugin.js");
    const { service, loads } = fakeRuntime({
      "sdk-agent": {
        settingsPlugin: () => {
          pluginBuilds += 1;
          // 与真实扩展一致：贡献注册在 ctx.effect 里，fiber dispose 时撤销。
          return definePlugin(
            (inner) => {
              const remove = inner.slots.register("settings.plugin-config", {
                id: "sdk-agent-settings-panel",
                owner: "sdk-agent",
                pluginId: "sdk-agent",
                render: () => null
              });
              inner.effect(() => () => remove(), "sdk-agent-settings-panel");
            },
            { name: "sdk-agent-settings", inject: ["slots"] }
          );
        }
      }
    });
    const assembly = createCanvasSettingsAssembly({ runtime: service, staticallyAssembled: new Set() });
    assembly.attach(ctx as never);
    expect(assembly.assembly.activeIds().has("sdk-agent")).toBe(false);

    expect(await assembly.assembly.load("sdk-agent")).toEqual({ ok: true });
    expect(await assembly.assembly.load("sdk-agent")).toEqual({ ok: true });
    // 只构建一次、只请求一次；贡献只注册一份。
    expect(pluginBuilds).toBe(1);
    expect(loads).toEqual(["sdk-agent"]);
    expect(ctx.slots.list("settings.plugin-config")).toHaveLength(1);
    expect(assembly.mountedIds()).toEqual(["sdk-agent"]);

    // 关闭设置：释放设置专用 fiber，不留下贡献。
    assembly.assembly.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.slots.list("settings.plugin-config")).toHaveLength(0);
    expect(assembly.mountedIds()).toEqual([]);
  });

  it("已激活扩展直接复用贡献，不加载 descriptor", async () => {
    const ctx = await startScope();
    const { service, loads } = fakeRuntime({});
    const assembly = createCanvasSettingsAssembly({ runtime: service, staticallyAssembled: new Set(["sdk-agent"]) });
    assembly.attach(ctx as never);
    expect(assembly.assembly.activeIds().has("sdk-agent")).toBe(true);
    expect(await assembly.assembly.load("sdk-agent")).toEqual({ ok: true });
    expect(loads).toEqual([]);
  });

  it("旧 artifact 没有设置入口：给出原因且不回退执行完整 plugin", async () => {
    const ctx = await startScope();
    let fullPluginBuilds = 0;
    const { service } = fakeRuntime({
      "local-agent": {
        plugin: () => () => {
          fullPluginBuilds += 1;
          throw new Error("不该执行完整插件");
        }
      }
    });
    const assembly = createCanvasSettingsAssembly({ runtime: service, staticallyAssembled: new Set() });
    assembly.attach(ctx as never);
    await expect(assembly.assembly.load("local-agent")).resolves.toEqual({
      ok: false,
      reason: "该扩展版本未提供设置专用入口"
    });
    expect(fullPluginBuilds).toBe(0);
    expect(ctx.slots.list("settings.plugin-config")).toHaveLength(0);
  });

  it("加载失败只返回安全原因；dispose 后的迟到结果不挂载", async () => {
    const ctx = await startScope();
    const { service } = fakeRuntime({ "sdk-agent": new Error("network down") });
    const assembly = createCanvasSettingsAssembly({ runtime: service, staticallyAssembled: new Set() });
    assembly.attach(ctx as never);
    await expect(assembly.assembly.load("sdk-agent")).resolves.toEqual({
      ok: false,
      reason: "设置面板加载失败"
    });

    // 迟到：dispose 后不再加载。
    assembly.assembly.dispose();
    await expect(assembly.assembly.load("sdk-agent")).resolves.toEqual({ ok: false, reason: "设置已关闭" });
    expect(ctx.slots.list("settings.plugin-config")).toHaveLength(0);
  });

  it("没有发布目录时不装配，也不抛错", async () => {
    const ctx = await startScope();
    const assembly = createCanvasSettingsAssembly({ runtime: undefined, staticallyAssembled: new Set() });
    assembly.attach(ctx as never);
    await expect(assembly.assembly.load("sdk-agent")).resolves.toEqual({
      ok: false,
      reason: "当前实例没有扩展发布目录"
    });
  });

  it("设置专用工厂本身抛错不影响宿主，只报告加载失败", async () => {
    const ctx = await startScope();
    const { service } = fakeRuntime({
      "sdk-agent": {
        settingsPlugin: () => {
          throw new Error("boom");
        }
      }
    });
    const assembly = createCanvasSettingsAssembly({ runtime: service, staticallyAssembled: new Set() });
    assembly.attach(ctx as never);
    await expect(assembly.assembly.load("sdk-agent")).resolves.toEqual({
      ok: false,
      reason: "设置面板加载失败"
    });
    expect(vi.isMockFunction(assembly.assembly.load)).toBe(false);
  });
});
