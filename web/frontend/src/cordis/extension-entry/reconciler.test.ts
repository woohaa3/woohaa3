/**
 * 站点插件前端入口 reconciliation 测试（异步加载版）
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 4.3 / design D5；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 4.1/4.2；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 5.4/5.5/5.8 / design D7/D9：
 *  入口为异步 `loadDescriptor`；验证 epoch、pending、owned/closing、failedEpoch、
 *  加载中停用、快速启停复用、partial apply 回滚与 dispose 保护）。
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import type { ApplicationExtensionStatus, ExtensionFrontendMetadata } from "@woohaa3/contracts";
import {
  ApplicationExtensionFrontendEntryRegistry,
  type ApplicationExtensionFrontendAsyncEntry
} from "./contract.js";
import { createApplicationExtensionEntryReconciler } from "./reconciler.js";

function status(extensionId: string, actualState: ApplicationExtensionStatus["actualState"]): ApplicationExtensionStatus {
  return {
    extensionId,
    desiredEnabled: actualState === "active",
    actualState,
    configVersion: 1,
    extensionRevision: 1,
    activeWorkCount: 0,
    diagnostics: []
  };
}

function metadata(extensionId: string, overrides: Partial<ExtensionFrontendMetadata> = {}): ExtensionFrontendMetadata {
  return {
    extensionId,
    version: "0.1.0",
    label: extensionId,
    description: extensionId,
    activation: "server-active",
    configScope: "site",
    required: false,
    sdkAbi: 1,
    ...overrides
  };
}

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** 构造一个把 plugin apply 行为记入 log 的异步入口。 */
function makeEntry(
  extensionId: string,
  log: string[],
  overrides: Partial<ExtensionFrontendMetadata> = {}
): ApplicationExtensionFrontendAsyncEntry {
  return {
    metadata: metadata(extensionId, overrides),
    async loadDescriptor() {
      return {
        extensionId,
        plugin: () => (ctx) => {
          log.push(`enter:${extensionId}`);
          ctx.effect(() => () => {
            log.push(`dispose:${extensionId}`);
          });
        }
      };
    }
  };
}

describe("站点插件入口 reconciliation（任务 4.1/4.2/5.4）", () => {
  it("active 时加载并装配 fiber，停用时释放；重复相同通知不重复加载", async () => {
    const log: string[] = [];
    let loads = 0;
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register({
      metadata: metadata("sample-site-extension"),
      async loadDescriptor() {
        loads += 1;
        return {
          extensionId: "sample-site-extension",
          plugin: () => (innerCtx) => {
            log.push("enter:sample-site-extension");
            innerCtx.effect(() => () => log.push("dispose:sample-site-extension"));
          }
        };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });

    reconciler.reconcile([status("sample-site-extension", "active")]);
    await flush();
    expect(log).toEqual(["enter:sample-site-extension"]);
    expect(loads).toBe(1);

    // 重复相同 active：不推进 epoch，不重复 load/apply。
    reconciler.reconcile([status("sample-site-extension", "active")]);
    await flush();
    expect(log).toEqual(["enter:sample-site-extension"]);
    expect(loads).toBe(1);

    reconciler.reconcile([status("sample-site-extension", "disabled")]);
    await flush();
    expect(log).toEqual(["enter:sample-site-extension", "dispose:sample-site-extension"]);
    expect(reconciler.activeExtensionIds()).toEqual([]);

    // 再次启用进入一次（不累积）。
    reconciler.reconcile([status("sample-site-extension", "active")]);
    await flush();
    expect(log).toEqual([
      "enter:sample-site-extension",
      "dispose:sample-site-extension",
      "enter:sample-site-extension"
    ]);
    await reconciler.dispose();
    expect(reconciler.activeExtensionIds()).toEqual([]);
  });

  it("failed / draining / unconfigured 都不维持贡献；未知 identity 无副作用", async () => {
    const log: string[] = [];
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(makeEntry("sample-site-extension", log));
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    for (const state of ["failed", "draining", "unconfigured", "degraded", "configuring"] as const) {
      reconciler.reconcile([status("sample-site-extension", state)]);
      await flush();
      expect(reconciler.activeExtensionIds()).toEqual([]);
    }
    expect(log).toEqual([]);
    reconciler.reconcile([status("not-registered", "active")]);
    await flush();
    expect(reconciler.activeExtensionIds()).toEqual([]);
    await reconciler.dispose();
  });

  it("依赖等待：必需 Service 未提供时保持未激活并报告缺失 key；提供后激活", async () => {
    const log: string[] = [];
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register({
      metadata: metadata("needs-service"),
      async loadDescriptor() {
        const plugin = (innerCtx: Context) => {
          log.push("enter:needs-service");
          innerCtx.effect(() => () => log.push("dispose:needs-service"));
        };
        Object.defineProperty(plugin, "inject", { value: ["missingService"], configurable: true });
        return { extensionId: "needs-service", plugin: () => plugin };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });

    reconciler.reconcile([status("needs-service", "active")]);
    await flush();
    // 依赖未满足：不产生部分贡献，诊断显示 waiting + 缺失 service。
    expect(log).toEqual([]);
    const waiting = reconciler.diagnostics().find((entry) => entry.extensionId === "needs-service");
    expect(waiting?.status).toBe("waiting");
    expect(waiting?.missingServices).toEqual(["missingService"]);

    // 级联提供依赖 → 自动激活一次。
    ctx.provide("missingService" as never, {} as never);
    await flush();
    expect(log).toEqual(["enter:needs-service"]);
    await reconciler.dispose();
    expect(log).toContain("dispose:needs-service");
  });

  it("加载中停用：import 完成后不构造 plugin / 不创建 Fiber", async () => {
    const log: string[] = [];
    let resolveLoad!: () => void;
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register({
      metadata: metadata("slow-load"),
      async loadDescriptor() {
        await new Promise<void>((resolve) => {
          resolveLoad = resolve;
        });
        return {
          extensionId: "slow-load",
          plugin: () => (innerCtx) => {
            log.push("enter:slow-load");
            innerCtx.effect(() => () => log.push("dispose:slow-load"));
          }
        };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    reconciler.reconcile([status("slow-load", "active")]);
    await flush();
    // import 未完成时停用。
    reconciler.reconcile([status("slow-load", "disabled")]);
    resolveLoad();
    await flush();
    // 迟到结果不得安装。
    expect(log).toEqual([]);
    expect(reconciler.activeExtensionIds()).toEqual([]);
    await reconciler.dispose();
  });

  it("异步释放 + 快速停用并重新启用：旧 owner 清理完成前不建第二个 owner", async () => {
    const log: string[] = [];
    let activeCount = 0;
    let maxActive = 0;
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register({
      metadata: metadata("slow"),
      async loadDescriptor() {
        return {
          extensionId: "slow",
          plugin: () => (innerCtx: Context) => {
            activeCount += 1;
            maxActive = Math.max(maxActive, activeCount);
            log.push(`enter:${activeCount}`);
            innerCtx.effect(() => async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              activeCount -= 1;
              log.push(`dispose-done:${activeCount}`);
            });
          }
        };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });

    reconciler.reconcile([status("slow", "active")]);
    await flush();
    // 撤销后立即重新允许：旧 owner 尚未清理完。
    reconciler.reconcile([status("slow", "disabled")]);
    reconciler.reconcile([status("slow", "active")]);
    await flush();
    // 旧实例仍在释放中，未创建第二个 owner。
    expect(activeCount).toBe(1);

    await flush(60);
    // 最终只保留一个有效实例。
    expect(maxActive).toBe(1);
    expect(activeCount).toBe(1);
    expect(log).toEqual(["enter:1", "dispose-done:0", "enter:1"]);
    await reconciler.dispose();
    await flush();
    expect(activeCount).toBe(0);
  });

  it("apply 失败：主动 dispose 回滚部分贡献，报告 failed，不影响其它入口", async () => {
    const log: string[] = [];
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(makeEntry("ok", log));
    registry.register({
      metadata: metadata("broken"),
      async loadDescriptor() {
        return {
          extensionId: "broken",
          plugin: () => () => {
            throw new Error("apply failed");
          }
        };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    reconciler.reconcile([status("ok", "active"), status("broken", "active")]);
    await flush();
    // broken 失败被回滚，不保留 owner；ok 正常。
    expect(reconciler.activeExtensionIds()).toEqual(["ok"]);
    expect(log).toContain("enter:ok");
    const broken = reconciler.diagnostics().find((entry) => entry.extensionId === "broken");
    expect(broken?.status).toBe("failed");
    expect(broken?.error).toContain("apply failed");

    await reconciler.dispose();
    await reconciler.dispose(); // 幂等
    expect(reconciler.activeExtensionIds()).toEqual([]);
  });

  it("load 失败后重复 active 通知不自动重试；显式 retry 才重新加载", async () => {
    let loads = 0;
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register({
      metadata: metadata("flaky"),
      async loadDescriptor() {
        loads += 1;
        if (loads === 1) throw new Error("网络失败");
        return { extensionId: "flaky", plugin: () => () => undefined };
      }
    });
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    reconciler.reconcile([status("flaky", "active")]);
    await flush();
    expect(loads).toBe(1);
    expect(reconciler.diagnostics().find((entry) => entry.extensionId === "flaky")?.status).toBe("load-failed");

    // 相同 active 重复通知：不自动重试（failedEpoch 抑制）。
    reconciler.reconcile([status("flaky", "active")]);
    await flush();
    expect(loads).toBe(1);

    // 显式 retry：解除抑制并重新加载。
    reconciler.retry("flaky");
    await flush();
    expect(loads).toBe(2);
    expect(reconciler.activeExtensionIds()).toEqual(["flaky"]);
    await reconciler.dispose();
  });

  it("dispose 后不再接受 reconcile（scope 退出保护）", async () => {
    const log: string[] = [];
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(makeEntry("late", log));
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    await reconciler.dispose();
    reconciler.reconcile([status("late", "active")]);
    await flush();
    expect(log).toEqual([]);
    expect(reconciler.activeExtensionIds()).toEqual([]);
  });

  it("常驻（always）入口不由 reconciler 装配，避免与 kernel 清单双重 owner", async () => {
    const log: string[] = [];
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(makeEntry("resident", log, { activation: "always", required: true }));
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    reconciler.reconcile([status("resident", "active")]);
    await flush();
    expect(log).toEqual([]);
    expect(reconciler.activeExtensionIds()).toEqual([]);
    await reconciler.dispose();
  });

  it("browser-local 入口不由 server-active reconciler 装配（任务 2.3）", async () => {
    const log: string[] = [];
    const ctx = new Context();
    const registry = new ApplicationExtensionFrontendEntryRegistry();
    registry.register(makeEntry("local-only", log, { configScope: "browser-local", activation: "browser-local" }));
    const reconciler = createApplicationExtensionEntryReconciler({ registry, ctx });
    reconciler.reconcile([status("local-only", "active")]);
    await flush();
    expect(log).toEqual([]);
    expect(reconciler.activeExtensionIds()).toEqual([]);
    await reconciler.dispose();
  });
});
