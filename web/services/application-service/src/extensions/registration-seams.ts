/**
 * 站点插件的运行期注册面接缝：生成 Provider / 存储后端 / 遥测出口 / 市场来源。
 *
 * 四者同形——core 持有唯一注册表，宿主只为每个 activation 记 owner 与 id，停用 / 回滚时按反序注销；
 * 某个扩展点缺省时插件拿不到对应的 `host.registerX`，必须记日志跳过（不伪造注册表）。
 *
 * - `registrationHooksFor(core)`：把 core 的注册表适配成 `ApplicationExtensionHostOptions` 的
 *   `register*For` / `release*For` 钩子（composition 用）；
 * - `attachRegistrationSeams(...)`：在一次 activation 上安装 `host.register* / unregister*` 并记 owner（host 用）。
 *
 * 从 composition.ts / extensions/host.ts 抽出（纯重构，行为不变）。
 */
import type {
  ApplicationBackendHost,
  GenerationProvider,
  MarketplaceSource,
  StorageBackend,
  TelemetryExport
} from "@woohaa3/contracts";
import type { ApplicationExtensionHostOptions, OwnerState } from "./host-types.js";

export type RegistrationCores = {
  generation?: { register: (provider: GenerationProvider) => void; unregister: (providerId: string) => void };
  storage?: { register: (backend: StorageBackend) => void; unregister: (backendId: string) => void };
  telemetry?: { register: (provider: TelemetryExport) => void; unregister: (exportId: string) => void };
  marketplace?: { register: (extensionId: string, source: MarketplaceSource) => void; unregister: (sourceId: string) => void };
};

type Hooks = Pick<
  ApplicationExtensionHostOptions,
  | "registerGenerationFor"
  | "releaseGenerationFor"
  | "registerStorageFor"
  | "releaseStorageFor"
  | "registerTelemetryExportFor"
  | "releaseTelemetryExportFor"
  | "registerMarketplaceSourceFor"
  | "releaseMarketplaceSourceFor"
>;

/** core 注册表 → 宿主钩子。四者都直接进 core，中间不做转发层（否则会出现两份「有哪些 X」的真相）。 */
export function registrationHooksFor(core: RegistrationCores): Hooks {
  const { generation, storage, telemetry, marketplace } = core;
  return {
    ...(generation
      ? {
          registerGenerationFor: (extensionId: string) => (provider: GenerationProvider) => {
            if (provider.extensionId !== extensionId) {
              throw new Error(`生成 Provider extensionId 不一致：${provider.extensionId} != ${extensionId}`);
            }
            generation.register(provider);
          },
          releaseGenerationFor: () => (providerId: string) => generation.unregister(providerId)
        }
      : {}),
    // 存储后端：站点插件注册的就是 `storage.primary` / `storage.expose` 能选中的那个后端。
    ...(storage
      ? {
          registerStorageFor: () => (backend: StorageBackend) => storage.register(backend),
          releaseStorageFor: () => (backendId: string) => storage.unregister(backendId)
        }
      : {}),
    // 遥测出口：core 不挑选目的地，注册即参与投递（总开关是 `telemetry.export.enabled`）。
    ...(telemetry
      ? {
          registerTelemetryExportFor: () => (provider: TelemetryExport) => telemetry.register(provider),
          releaseTelemetryExportFor: () => (exportId: string) => telemetry.unregister(exportId)
        }
      : {}),
    // 市场来源：进 core 的 `ctx.marketplace`，来源断言用扩展 id 对应的扫描来源。
    ...(marketplace
      ? {
          registerMarketplaceSourceFor: (extensionId: string) => (source: MarketplaceSource) => marketplace.register(extensionId, source),
          releaseMarketplaceSourceFor: () => (sourceId: string) => marketplace.unregister(sourceId)
        }
      : {})
  };
}

/** 显式注销：只摘本 activation 记过的 id，再交给 core（core 侧幂等）。 */
function unregisterOwned(ids: string[], release: (id: string) => void) {
  return (id: string) => {
    const index = ids.lastIndexOf(id);
    if (index >= 0) ids.splice(index, 1);
    release(id);
  };
}

/** 在一次 activation 的 host 上安装注册面，并把 release 钩子挂到 owner（rollback 反序注销用）。 */
export function attachRegistrationSeams(
  host: ApplicationBackendHost,
  owner: OwnerState,
  options: ApplicationExtensionHostOptions,
  extensionId: string
): void {
  const registerGeneration = options.registerGenerationFor?.(extensionId);
  if (registerGeneration) {
    host.registerGeneration = (provider) => {
      registerGeneration(provider);
      owner.generationProviderIds.push(provider.providerId);
    };
  }
  const releaseGeneration = options.releaseGenerationFor?.(extensionId);
  if (releaseGeneration) {
    owner.releaseGeneration = releaseGeneration;
    host.unregisterGeneration = releaseGeneration;
  }

  const registerStorage = options.registerStorageFor?.(extensionId);
  if (registerStorage) {
    host.registerStorage = (backend) => {
      registerStorage(backend);
      owner.storageBackendIds.push(backend.backendId);
    };
  }
  const releaseStorage = options.releaseStorageFor?.(extensionId);
  if (releaseStorage) {
    owner.releaseStorage = releaseStorage;
    host.unregisterStorage = unregisterOwned(owner.storageBackendIds, releaseStorage);
  }

  // 遥测出口自带部署地址 / 会话与在途批次：谁注册谁收回，停用后不留指向已释放资源的出口。
  const registerTelemetryExport = options.registerTelemetryExportFor?.(extensionId);
  if (registerTelemetryExport) {
    host.registerTelemetryExport = (provider) => {
      registerTelemetryExport(provider);
      owner.telemetryExportIds.push(provider.exportId);
    };
  }
  const releaseTelemetryExport = options.releaseTelemetryExportFor?.(extensionId);
  if (releaseTelemetryExport) {
    owner.releaseTelemetryExport = releaseTelemetryExport;
    host.unregisterTelemetryExport = unregisterOwned(owner.telemetryExportIds, releaseTelemetryExport);
  }

  // 市场来源（D6）：非内置根的拒绝由宿主钩子抛出，拒绝时不记 owner（没注册就不需要收回）。
  const registerMarketplaceSource = options.registerMarketplaceSourceFor?.(extensionId);
  if (registerMarketplaceSource) {
    host.registerMarketplaceSource = (source) => {
      registerMarketplaceSource(source);
      owner.marketplaceSourceIds.push(source.sourceId);
    };
  }
  const releaseMarketplaceSource = options.releaseMarketplaceSourceFor?.(extensionId);
  if (releaseMarketplaceSource) {
    owner.releaseMarketplaceSource = releaseMarketplaceSource;
    host.unregisterMarketplaceSource = unregisterOwned(owner.marketplaceSourceIds, releaseMarketplaceSource);
  }
}
