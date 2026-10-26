/**
 * 首次安装运行期装配（change: 2026-10-21-isolate-extension-host-process，任务 8.4）：
 * 用替身的隔离服务 / 站点门禁 / 控制面 / 扩展层验证装配顺序、失败撤销与卸载顺序。
 */
import { describe, expect, it } from "vitest";
import type { HostContext } from "../../context.js";
import { createRuntimeAttach } from "./runtime-attach.js";
import type { ExtensionPackageToolkit } from "./types.js";

type Calls = string[];

function fakeCtx(options: { metadata?: boolean; addOutcome?: Record<string, unknown>; layerStarted?: Promise<void>; enabled?: boolean } = {}) {
  const calls: Calls = [];
  const services: Record<string, unknown> = {
    extensionHostIsolation: {
      enabled: () => options.enabled ?? true,
      add: (descriptor: { extensionId: string }) => {
        calls.push(`isolation.add:${descriptor.extensionId}`);
        return { plugin: { name: descriptor.extensionId }, order: 1 };
      },
      remove: async (id: string) => void calls.push(`isolation.remove:${id}`)
    },
    extensionLayer: {
      add: (plugin: { name: string }) => {
        calls.push(`layer.add:${plugin.name}`);
        return { name: plugin.name, started: options.layerStarted ?? Promise.resolve(), dispose: async () => undefined };
      },
      remove: async (name: string) => void calls.push(`layer.remove:${name}`)
    },
    application: {
      siteGate: {
        add: (id: string) => (calls.push(`gate.add:${id}`), { extensionId: id }),
        remove: (id: string) => void calls.push(`gate.remove:${id}`)
      },
      service: {
        plugins: () => ({
          addExtension: async (input: { metadata: { extensionId: string } }) => {
            calls.push(`plane.add:${input.metadata.extensionId}`);
            return options.addOutcome ?? { ok: true, revision: 2, status: { actualState: "active" } };
          },
          removeExtension: async (id: string) => (calls.push(`plane.remove:${id}`), { ok: true, revision: 3 })
        })
      }
    }
  };
  const ctx = { get: (name: string) => services[name] } as unknown as HostContext;
  const toolkit = {
    describeIsolatedExtension: ({ extensionId }: { extensionId: string }) => ({
      descriptor: { isolated: true, extensionId },
      metadata: options.metadata === false ? null : { extensionId, name: extensionId }
    })
  } as unknown as ExtensionPackageToolkit;
  const logs: Array<Record<string, unknown>> = [];
  return { ctx, toolkit, calls, logs, log: (event: Record<string, unknown>) => logs.push(event) };
}

describe("首次安装运行期装配", () => {
  it("有站点元数据：隔离服务 add → 门禁 add → 扩展层追加 → 控制面 addExtension；返回实际状态", async () => {
    const h = fakeCtx();
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    expect(runtime.supported()).toBe(true);
    await expect(runtime.attach("demo", "/m/demo/1.0.0", "1.0.0")).resolves.toEqual({ state: "active" });
    expect(h.calls).toEqual(["isolation.add:demo", "gate.add:demo", "layer.add:demo", "plane.add:demo"]);
  });

  it("没有站点元数据：不登记门禁与控制面，等装载器直接启动", async () => {
    const h = fakeCtx({ metadata: false });
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    await expect(runtime.attach("demo", "/d", "1.0.0")).resolves.toEqual({ state: "active" });
    expect(h.calls).toEqual(["isolation.add:demo", "layer.add:demo"]);
  });

  it("激活失败（控制面状态 failed）：按相反顺序撤销并抛出诊断码", async () => {
    const h = fakeCtx({ addOutcome: { ok: true, revision: 2, status: { actualState: "failed", diagnostics: [{ code: "activation-timeout", message: "就绪超时" }] } } });
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    await expect(runtime.attach("demo", "/d", "1.0.0")).rejects.toMatchObject({ code: "activation-timeout" });
    expect(h.calls).toEqual([
      "isolation.add:demo", "gate.add:demo", "layer.add:demo", "plane.add:demo",
      "plane.remove:demo", "layer.remove:demo", "gate.remove:demo", "isolation.remove:demo"
    ]);
  });

  it("控制面拒绝登记（extension-exists）：撤销门禁、扩展层与子进程", async () => {
    const h = fakeCtx({ addOutcome: { ok: false, code: "extension-exists", message: "已登记" } });
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    await expect(runtime.attach("demo", "/d", "1.0.0")).rejects.toMatchObject({ code: "extension-exists" });
    expect(h.calls.slice(4)).toEqual(["layer.remove:demo", "gate.remove:demo", "isolation.remove:demo"]);
  });

  it("非站点插件启动失败也撤销", async () => {
    const h = fakeCtx({ metadata: false, layerStarted: Promise.reject(Object.assign(new Error("boom"), { code: "activation-timeout" })) });
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    await expect(runtime.attach("demo", "/d", "1.0.0")).rejects.toMatchObject({ code: "activation-timeout" });
    expect(h.calls).toEqual(["isolation.add:demo", "layer.add:demo", "layer.remove:demo", "isolation.remove:demo"]);
  });

  it("卸载运行期装配的扩展：控制面移除 → 门禁移除 → 扩展层卸载 → 停子进程", async () => {
    const h = fakeCtx();
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    await runtime.attach("demo", "/d", "1.0.0");
    h.calls.length = 0;
    await runtime.detach("demo");
    expect(h.calls).toEqual(["plane.remove:demo", "gate.remove:demo", "layer.remove:demo", "isolation.remove:demo"]);
  });

  it("卸载启动期装配的扩展：只停子进程（占位保留到下次启动）", async () => {
    const h = fakeCtx();
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    await runtime.detach("boot-time");
    expect(h.calls).toEqual(["isolation.remove:boot-time"]);
  });

  it("隔离服务未启用：supported=false，attach 抛 extension-host-unsupported", async () => {
    const h = fakeCtx({ enabled: false });
    const runtime = createRuntimeAttach(h.ctx, h.toolkit, h.log)!;
    expect(runtime.supported()).toBe(false);
    await expect(runtime.attach("demo", "/d", "1.0.0")).rejects.toMatchObject({ code: "extension-host-unsupported" });
    expect(h.calls).toEqual([]);
  });

  it("包工具缺 describeIsolatedExtension：不提供运行期装配", () => {
    const h = fakeCtx();
    expect(createRuntimeAttach(h.ctx, {} as ExtensionPackageToolkit, h.log)).toBeNull();
  });
});
