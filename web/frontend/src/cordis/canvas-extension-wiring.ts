/**
 * 扩展相关的 scope 装配（从 install-services.ts 抽出，纯重构）。
 *
 * - `provideSlotsAndFaults`：App scope 的 slot registry 与扩展渲染故障/会话内熔断服务
 *   （change: 2026-10-21-harden-extension-fault-isolation，design D3）；
 * - `createPageExtensionReconciler`：站点插件前端入口 reconciler，并挂上受管扩展热登记——发布指针
 *   变化时只为新增条目登记入口并按服务端状态装配；升级/卸载不热换，经事件交给设置面提示
 *   （change: 2026-10-21-add-extension-marketplace-point，6.3）。返回的 reconciler.dispose 同时释放热登记；
 * - `hostSubmissionGate`：宿主重连期间拒绝提交（App 级 hostConnectivity，fault-isolation D6）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createExtensionFaultService } from "./extension-faults.js";
import { createApplicationExtensionEntryReconciler, type ApplicationExtensionEntryReconciler } from "./extension-entry/reconciler.js";
import { createExtensionReleaseAdoption } from "./extension-entry/release-adoption.js";
import type { ApplicationExtensionFrontendEntryRegistry } from "./extension-entry/contract.js";
import type { ExtensionRuntimeService } from "./extension-runtime/service.js";
import type { ApplicationExtensionStatusService } from "./services/application-extension-status.js";
import type { SlotRegistry } from "./slots.js";

export function provideSlotsAndFaults(ctx: Context, slots: SlotRegistry): void {
  ctx.provide("slots" as never, slots as never);
  ctx.provide("extensionFaults" as never, createExtensionFaultService() as never);
}

export function createPageExtensionReconciler(
  ctx: Context,
  input: {
    registry: ApplicationExtensionFrontendEntryRegistry;
    status: ApplicationExtensionStatusService;
    runtime?: ExtensionRuntimeService | undefined;
    logger?: ((event: Record<string, unknown>) => void) | undefined;
  }
): ApplicationExtensionEntryReconciler {
  const reconciler = createApplicationExtensionEntryReconciler({ registry: input.registry, ctx, logger: input.logger });
  if (!input.runtime) return reconciler;
  const adoption = createExtensionReleaseAdoption({
    runtime: input.runtime,
    registry: input.registry,
    reconcile: () => reconciler.reconcile(input.status.getSnapshot().plugins),
    emit: (payload) => ctx.emit("extension.release.changed", payload),
    ...(input.logger ? { logger: input.logger } : {})
  });
  // 先于调用方的状态订阅登记：每次状态变化先观察发布指针，再由调用方 reconcile。
  const unsubscribe = input.status.subscribe(() => {
    void adoption.observe(input.status.getSnapshot().extensionRelease);
  });
  return {
    ...reconciler,
    dispose: async () => {
      unsubscribe();
      adoption.dispose();
      await reconciler.dispose();
    }
  };
}

/** 画布会话的提交门禁选项（App 级 hostConnectivity 存在时才设置）。 */
export function hostSubmissionGate(ctx: Context): { blocksSubmissions?: () => boolean } {
  const hostConnectivity = ctx.get("hostConnectivity" as never) as { blocksSubmissions(): boolean } | undefined;
  return hostConnectivity ? { blocksSubmissions: () => hostConnectivity.blocksSubmissions() } : {};
}
