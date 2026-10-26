/**
 * 控制面的运行期登记（change: 2026-10-21-isolate-extension-host-process；首次安装的受管后端扩展）。
 *
 * 启动期清单（`options.metadata` / `options.definitions`）固定不变；运行期 add 的扩展叠加在其上：
 * - `addExtension`：登记元数据与可信定义、从审计恢复隔离记录，然后**只对它**协调一次
 *   （无配置且 defaultEnabled → 首次版本化提交并激活；已有配置 → 按 desiredEnabled；安全模式 / 隔离 → 不激活）。
 *   同 id 已登记（含启动期清单）→ `extension-exists`。
 * - `removeExtension`：只允许移除运行期 add 的扩展；有在途工作 → `extension-busy`（先停用，等 draining 结束）；
 *   否则释放全部版本实例、移除登记、推进 revision。已保存的站点配置与审计保留（重装后沿用）。
 *
 * 幂等与重试：add 失败（协调期间激活失败）不回滚登记，状态如实为 failed，可按配置变化重试；remove 成功后再调
 * 返回 `extension-not-found`。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";
import type { SqliteSiteExtensionConfigStore } from "./config-store.js";
import type { SiteExtensionMetadataSource, SiteExtensionRuntimeOutcome } from "./control-plane-types.js";
import type { ApplicationExtensionHost } from "./host.js";
import type { QuarantineRegistry } from "./quarantine.js";

export type RuntimeCatalog = {
  source: SiteExtensionMetadataSource;
  add(metadata: ApplicationExtensionMetadata): void;
  remove(extensionId: string): void;
  isRuntime(extensionId: string): boolean;
};

/** 启动期元数据之上叠加运行期条目；list 保持「启动期在前、运行期按登记顺序」。 */
export function createRuntimeCatalog(base: SiteExtensionMetadataSource): RuntimeCatalog {
  const runtime = new Map<string, ApplicationExtensionMetadata>();
  return {
    source: {
      list: () => [...base.list(), ...runtime.values()],
      get: (extensionId) => base.get(extensionId) ?? runtime.get(extensionId)
    },
    add: (metadata) => void runtime.set(metadata.extensionId, metadata),
    remove: (extensionId) => void runtime.delete(extensionId),
    isRuntime: (extensionId) => runtime.has(extensionId) && !base.get(extensionId)
  };
}

type RuntimeDeps = {
  catalog: RuntimeCatalog;
  definitionById: Map<string, ApplicationBackendExtensionDefinition>;
  host: ApplicationExtensionHost;
  store: SqliteSiteExtensionConfigStore;
  quarantine: QuarantineRegistry;
  publicVersion: Map<string, number>;
  activeWorkCount: (extensionId: string) => number;
  disposeLease: (extensionId: string) => void;
  reconcileOne: (metadata: ApplicationExtensionMetadata) => Promise<void>;
  statusFor: SiteExtensionRuntimeOutcomeStatus;
  log: (event: Record<string, unknown>) => void;
};

type SiteExtensionRuntimeOutcomeStatus = (extensionId: string) => import("@woohaa3/contracts").ApplicationExtensionStatus | undefined;

export function createRuntimeRegistration(deps: RuntimeDeps) {
  const addExtension = async (input: {
    metadata: ApplicationExtensionMetadata;
    definition: ApplicationBackendExtensionDefinition;
  }): Promise<SiteExtensionRuntimeOutcome> => {
    const { metadata, definition } = input;
    if (definition.extensionId !== metadata.extensionId) {
      return { ok: false, code: "extension-invalid", message: "定义与元数据的 extensionId 不一致" };
    }
    if (deps.catalog.source.get(metadata.extensionId) || deps.definitionById.has(metadata.extensionId)) {
      return { ok: false, code: "extension-exists", message: `插件 ${metadata.extensionId} 已登记` };
    }
    deps.catalog.add(metadata);
    deps.definitionById.set(metadata.extensionId, definition);
    deps.quarantine.restore(metadata.extensionId);
    deps.log({ event: "site-extension-runtime-added", extensionId: metadata.extensionId });
    await deps.reconcileOne(metadata);
    const status = deps.statusFor(metadata.extensionId);
    return { ok: true, revision: deps.store.revision(), ...(status ? { status } : {}) };
  };

  const removeExtension = async (extensionId: string): Promise<SiteExtensionRuntimeOutcome> => {
    if (!deps.catalog.source.get(extensionId)) {
      return { ok: false, code: "extension-not-found", message: `插件 ${extensionId} 未登记` };
    }
    if (!deps.catalog.isRuntime(extensionId)) {
      return { ok: false, code: "extension-not-removable", message: `插件 ${extensionId} 属于启动期清单，不能在运行中移除` };
    }
    const activeWorkCount = deps.activeWorkCount(extensionId);
    if (activeWorkCount > 0) {
      return { ok: false, code: "extension-busy", message: `插件 ${extensionId} 仍有 ${activeWorkCount} 项在途工作；请先停用并等待收尾`, activeWorkCount };
    }
    for (const version of [...deps.host.activeVersions(extensionId)]) {
      await deps.host.disposeVersion(extensionId, version);
    }
    deps.publicVersion.delete(extensionId);
    deps.disposeLease(extensionId);
    deps.quarantine.delete(extensionId);
    deps.definitionById.delete(extensionId);
    deps.catalog.remove(extensionId);
    // 推进 revision 并写 status log：前端增量据此刷新（snapshot 里不再有它）。
    deps.store.setActual(extensionId, "disabled", [{ code: "extension-removed", message: "扩展已卸载" }], new Date().toISOString());
    deps.log({ event: "site-extension-runtime-removed", extensionId });
    return { ok: true, revision: deps.store.revision() };
  };

  return { addExtension, removeExtension };
}
