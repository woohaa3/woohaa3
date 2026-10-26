/**
 * 受管扩展热登记（change: 2026-10-21-add-extension-marketplace-point，任务 6.3 / design D8）。
 *
 * 站点状态快照携带宿主当前发布目录指针（`extensionRelease`）。指针变化时：
 * 1. 交给 App 级 `ExtensionRuntimeService.adoptRelease`：读取并校验新目录，只把**新增**条目追加进
 *    已固定的运行时目录（不 repin、不换已加载的 artifact）；
 * 2. 新增的 `server-active` 条目登记进本页 entry registry，再按最新服务端状态 reconcile——
 *    与启动期登记的入口走同一套资格（actual active 才装配）；
 * 3. 新增的 `browser-local` 条目不在当前页面装配（保持「本次启动」语义），下次打开画布时按偏好装配；
 * 4. 发出 `extension.release.changed` 事实事件：升级/卸载的条目不热换，由设置面提示重开画布。
 *
 * 同一 releaseId 只处理一次；读取失败记日志并在下一次指针通知时重试，不影响已装配的扩展。
 */
import type { ApplicationExtensionReleasePointer, ApplicationExtensionStatus } from "@woohaa3/contracts";
import type { ExtensionRuntimeService } from "../extension-runtime/service.js";
import type { ApplicationExtensionFrontendEntryRegistry } from "./contract.js";

export type ReleaseChangedPayload = {
  releaseId: string;
  /** 新发布目录逻辑地址（重开画布前 repin 用）。 */
  href: string;
  added: string[];
  upgraded: string[];
  removed: string[];
  /** 当前页面仍在用旧版本、重开画布后才生效的扩展。 */
  pendingReopen: string[];
};

export type ExtensionReleaseAdoptionOptions = {
  runtime: Pick<ExtensionRuntimeService, "adoptRelease" | "entry" | "loadDescriptor" | "staleExtensionIds">;
  registry: ApplicationExtensionFrontendEntryRegistry;
  /** 新增 server-active 入口登记后，按最新服务端状态 reconcile。 */
  reconcile: () => void;
  emit: (payload: ReleaseChangedPayload) => void;
  logger?: (event: Record<string, unknown>) => void;
};

export type ExtensionReleaseAdoption = {
  /** 收到最新指针（可重复调用；同一 releaseId 只处理一次，串行）。 */
  observe(pointer: ApplicationExtensionReleasePointer | null | undefined): Promise<void>;
  dispose(): void;
};

export function createExtensionReleaseAdoption(options: ExtensionReleaseAdoptionOptions): ExtensionReleaseAdoption {
  const log = options.logger ?? (() => undefined);
  let handled: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  const unregister: Array<() => void> = [];

  const adopt = async (pointer: ApplicationExtensionReleasePointer) => {
    if (disposed || pointer.releaseId === handled) return;
    let delta;
    try {
      delta = await options.runtime.adoptRelease(pointer);
    } catch (error) {
      log({ event: "extension-release-adopt-failed", releaseId: pointer.releaseId, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (disposed) return;
    handled = pointer.releaseId;
    if (!delta) return;
    for (const extensionId of delta.added) {
      const entry = options.runtime.entry(extensionId);
      if (!entry || entry.metadata.activation !== "server-active" || options.registry.has(extensionId)) continue;
      unregister.push(
        options.registry.register({
          metadata: entry.metadata,
          loadDescriptor: () => options.runtime.loadDescriptor(extensionId)
        })
      );
    }
    options.reconcile();
    options.emit({
      releaseId: pointer.releaseId,
      href: pointer.href,
      added: delta.added,
      upgraded: delta.upgraded,
      removed: delta.removed,
      pendingReopen: [...options.runtime.staleExtensionIds()]
    });
  };

  return {
    observe(pointer) {
      if (!pointer || disposed) return chain;
      chain = chain.then(() => adopt(pointer));
      return chain;
    },
    dispose() {
      disposed = true;
      for (const off of unregister.splice(0)) off();
    }
  };
}

/** 便于测试：从状态列表判断新增入口是否会被装配（actual active）。 */
export function isActive(plugins: readonly ApplicationExtensionStatus[], extensionId: string): boolean {
  return plugins.some((plugin) => plugin.extensionId === extensionId && plugin.actualState === "active");
}
