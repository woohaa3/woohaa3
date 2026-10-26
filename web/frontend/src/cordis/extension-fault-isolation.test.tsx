/**
 * 扩展故障隔离回归（change: 2026-10-21-harden-extension-fault-isolation，任务 1.1–1.4 / 2.6）。
 *
 * - 来源身份由宿主盖章：扩展伪造 owner 不影响归属；嵌套插件继承；
 * - 扩展贡献渲染抛错只替换该项，内置贡献与画布其它部分照常；
 * - 会话内熔断撤销该扩展全部贡献，required 不熔断；重新加载以新 epoch 恢复；
 * - reconciler 装配的 server-active 扩展同样盖章并可熔断，熔断后同 epoch 不自动重试。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import type { ApplicationExtensionStatus } from "@woohaa3/contracts";
import { SlotRegistry, createScopedSlots, slotContributionOrigin } from "./slots.js";
import { CanvasOverlayHost, CanvasToolbarHost } from "./host.js";
import { RuntimeProvider } from "./react.js";
import { startFrontendRuntime, type FrontendExtensionDefinition, type FrontendRuntime } from "./kernel.js";
import { createExtensionFaultService, type ExtensionFaultService } from "./extension-faults.js";
import { ApplicationExtensionFrontendEntryRegistry } from "./extension-entry/contract.js";
import { createApplicationExtensionEntryReconciler } from "./extension-entry/reconciler.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let runtime: FrontendRuntime | null = null;
const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  await runtime?.dispose();
  runtime = null;
  document.body.innerHTML = "";
});

function Boom(): never {
  throw new Error("boom");
}

async function start(plugins: FrontendExtensionDefinition[], faults: ExtensionFaultService = createExtensionFaultService({ logger: () => undefined })) {
  const slots = new SlotRegistry();
  runtime = await startFrontendRuntime({
    installPlatform: (ctx: Context) => {
      ctx.provide("slots" as never, slots as never);
      ctx.provide("extensionFaults" as never, faults as never);
    },
    plugins
  });
  return { slots, faults };
}

function extensionDefinition(id: string, apply: (ctx: Context) => void, required = false): FrontendExtensionDefinition {
  return { id, required, extension: true, plugin: { name: id, inject: ["slots"], apply } as unknown as Plugin };
}

async function mountToolbar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RuntimeProvider runtime={runtime!}>
        <CanvasOverlayHost revision={0} writable />
        <CanvasToolbarHost revision={0} writable />
      </RuntimeProvider>
    );
  });
  return container;
}

describe("来源身份（D1）", () => {
  it("扩展伪造 owner 不影响宿主盖章的归属，嵌套插件继承", async () => {
    const { slots } = await start([
      extensionDefinition("ext-a", (ctx) => {
        ctx.effect(() => ctx.slots.register("canvas.overlay", { id: "a1", owner: "ext-b", render: () => null }));
        ctx.plugin({
          name: "inner",
          inject: ["slots"],
          apply: (inner: Context) => {
            inner.effect(() => inner.slots.register("canvas.overlay", { id: "a2", owner: "builtin", render: () => null }));
          }
        } as unknown as Plugin);
      })
    ]);
    await flush();
    const owners = slots.owners();
    expect(owners.find((entry) => entry.id === "a1")?.origin).toMatchObject({ kind: "extension", extensionId: "ext-a" });
    expect(owners.find((entry) => entry.id === "a2")?.origin).toMatchObject({ kind: "extension", extensionId: "ext-a" });
  });

  it("宿主直接注册的贡献为 builtin；贡献对象上自带 origin 字段不能冒充扩展", () => {
    const slots = new SlotRegistry();
    slots.register("canvas.overlay", { id: "host", owner: "host", render: () => null, origin: { kind: "extension", extensionId: "x", epoch: 1 } } as never);
    expect(slotContributionOrigin(slots.list("canvas.overlay")[0]!)).toEqual({ kind: "builtin" });
  });

  it("代理只在注册时盖章，读取原样透传", () => {
    const slots = new SlotRegistry();
    const scoped = createScopedSlots(() => slots, { kind: "extension", extensionId: "e", epoch: 7 });
    const dispose = scoped.register("canvas.overlay", { id: "x", owner: "e", render: () => null });
    expect(scoped.list("canvas.overlay").map((entry) => entry.id)).toEqual(["x"]);
    expect(slotContributionOrigin(slots.list("canvas.overlay")[0]!)).toEqual({ kind: "extension", extensionId: "e", epoch: 7 });
    dispose();
    expect(slots.list("canvas.overlay")).toEqual([]);
  });
});

describe("逐项错误边界与熔断（D2/D3）", () => {
  it("扩展贡献抛错只替换该项，并上报诊断", async () => {
    const { faults } = await start([
      { id: "host-toolbar", required: true, plugin: ((ctx: Context) => {
        ctx.effect(() => ctx.slots.register("canvas.toolbar", { id: "zoom", owner: "host", render: () => <span data-testid="zoom">zoom</span> }));
      }) as unknown as Plugin },
      extensionDefinition("ext-bad", (ctx) => {
        ctx.effect(() => ctx.slots.register("canvas.toolbar", { id: "bad", owner: "ext-bad", render: Boom }));
        ctx.effect(() => ctx.slots.register("canvas.overlay", { id: "bad-overlay", owner: "ext-bad", render: Boom }));
      })
    ]);
    await flush();
    const container = await mountToolbar();
    expect(container.querySelector("[data-testid=zoom]")).not.toBeNull();
    const placeholder = container.querySelector("[data-diagnostic=extension-render-error]");
    expect(placeholder?.getAttribute("data-extension-id")).toBe("ext-bad");
    expect(placeholder?.getAttribute("data-slot")).toBe("canvas.toolbar");
    // overlay 类直接隐藏，不留占位。
    expect(container.querySelectorAll("[data-diagnostic=extension-render-error]")).toHaveLength(1);
    expect(faults.diagnostics().map((entry) => entry.slot).sort()).toEqual(["canvas.overlay", "canvas.toolbar"]);
  });

  it("可选扩展超过阈值后撤销全部贡献；重新加载以新 epoch 恢复", async () => {
    let now = 0;
    const faults = createExtensionFaultService({ now: () => now, threshold: 1, logger: () => undefined });
    let healthy = false;
    const { slots } = await start([
      extensionDefinition("ext-flaky", (ctx) => {
        ctx.effect(() => ctx.slots.register("canvas.toolbar", { id: "flaky", owner: "x", render: () => (healthy ? <span data-testid="flaky">ok</span> : Boom()) }));
        ctx.effect(() => ctx.slots.register("canvas.overlay", { id: "flaky-overlay", owner: "x", render: () => null }));
      })
    ], faults);
    await flush();
    const before = slotContributionOrigin(slots.list("canvas.toolbar")[0]!);
    const origin = before.kind === "extension" ? before : null;
    expect(origin).not.toBeNull();
    faults.report({ extensionId: "ext-flaky", epoch: origin!.epoch, slot: "canvas.toolbar", contributionId: "flaky", message: "x" });
    now += 10;
    faults.report({ extensionId: "ext-flaky", epoch: origin!.epoch, slot: "canvas.toolbar", contributionId: "flaky", message: "x" });
    await flush();
    expect(faults.isTripped("ext-flaky")).toBe(true);
    expect(slots.owners().filter((entry) => entry.origin.kind === "extension")).toEqual([]);
    // 熔断后再报错不重复计数/通知。
    const version = faults.version();
    faults.report({ extensionId: "ext-flaky", epoch: origin!.epoch, slot: "canvas.toolbar", contributionId: "flaky", message: "x" });
    expect(faults.isTripped("ext-flaky")).toBe(true);
    expect(faults.version()).toBe(version);

    healthy = true;
    expect(faults.stateOf("ext-flaky")?.reloadable).toBe(true);
    expect(faults.reload("ext-flaky")).toBe(true);
    await flush(10);
    expect(faults.isTripped("ext-flaky")).toBe(false);
    const after = slotContributionOrigin(slots.list("canvas.toolbar")[0]!);
    expect(after.kind === "extension" && after.epoch).toBeGreaterThan(origin!.epoch);
  });

  it("required 扩展反复抛错只记录，不撤销", async () => {
    const faults = createExtensionFaultService({ threshold: 0, logger: () => undefined });
    const { slots } = await start([
      extensionDefinition("ext-required", (ctx) => {
        ctx.effect(() => ctx.slots.register("canvas.toolbar", { id: "req", owner: "x", render: Boom }));
      }, true)
    ], faults);
    await flush();
    await mountToolbar();
    await flush();
    expect(faults.isTripped("ext-required")).toBe(false);
    expect(slots.list("canvas.toolbar").map((entry) => entry.id)).toEqual(["req"]);
  });
});

describe("reconciler 装配的站点扩展", () => {
  it("盖章来源；熔断释放 fiber 且同一 epoch 不自动重试；重新加载恢复", async () => {
    const ctx = new Context();
    const slots = new SlotRegistry();
    const faults = createExtensionFaultService({ threshold: 0, logger: () => undefined });
    ctx.provide("slots" as never, slots as never);
    ctx.provide("extensionFaults" as never, faults as never);
    await flush();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    let applies = 0;
    registry.register({
      metadata: { extensionId: "site-x", version: "0.1.0", label: "x", description: "x", activation: "server-active", configScope: "site", required: false, sdkAbi: 1 },
      async loadDescriptor() {
        return {
          extensionId: "site-x",
          plugin: () => ({
            name: "site-x",
            inject: ["slots"],
            apply: (inner: Context) => {
              applies += 1;
              inner.effect(() => inner.slots.register("canvas.overlay", { id: "site-x-overlay", owner: "site-x", render: () => null }));
            }
          }) as unknown as Plugin
        } as never;
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    const status: ApplicationExtensionStatus = { extensionId: "site-x", desiredEnabled: true, actualState: "active", configVersion: 1, extensionRevision: 1, activeWorkCount: 0, diagnostics: [] };
    reconciler.reconcile([status]);
    await flush(10);
    const origin = slotContributionOrigin(slots.list("canvas.overlay")[0]!);
    expect(origin).toMatchObject({ kind: "extension", extensionId: "site-x" });
    faults.report({ extensionId: "site-x", epoch: (origin as { epoch: number }).epoch, slot: "canvas.overlay", contributionId: "site-x-overlay", message: "x" });
    await flush(10);
    expect(slots.list("canvas.overlay")).toEqual([]);
    expect(reconciler.diagnostics()[0]).toMatchObject({ status: "failed" });
    // 相同权威通知不自动重试。
    reconciler.reconcile([status]);
    await flush(10);
    expect(applies).toBe(1);
    expect(faults.reload("site-x")).toBe(true);
    await flush(10);
    expect(applies).toBe(2);
    expect(slots.list("canvas.overlay")).toHaveLength(1);
    await reconciler.dispose();
  });
});
