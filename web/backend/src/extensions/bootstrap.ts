/**
 * 启动期槽位实现装配
 * （change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 3.1 / design D3）。
 *
 * 槽位实现（storage / identity / access）的唯一发现路径是**启动期扩展宿主**扫描扩展目录：
 * `web/backend/src/extensions/host-boot.ts` 的 `loadExtensionHostFromEnv` 加载
 * `scripts/lib/extension-host.mjs`，宿主按各扩展 `extension.json` 的 `bootstrap` 声明解析出
 * 槽位声明工厂。这里把宿主结果包成组合根可用的「槽位来源」。
 *
 * 分支与 master 的差异：分支的 provider 装配在 `host/base/access.ts`（Cordis 插件）里，
 * 因此这里只产出声明，不在此调用 `bootstrapProviders`。测试仍可显式传
 * `BackendServiceOptions.bootstrapExtensions` 覆盖（此时不加载宿主）。
 */
import type { BootstrapExtension } from "@woohaa3/contracts";
import type { LoadedExtensionHost } from "./manifest.js";
import type { RuntimeStorageProvider } from "./slot-contract.js";

/**
 * 槽位实现来源：启动期扫描结果，或测试注入的声明集合。
 *
 * `createDeclarations` 调用的是各扩展目录里的**声明工厂**（只返回 `{ extensionId, providers }`），
 * 真正建立连接的 `provider.create` 由 `bootstrapProviders` 在校验之后按依赖顺序执行。
 */
export type SlotImplementationSource = {
  extensionIds: readonly string[];
  createDeclarations: (
    optionsByExtensionId: Record<string, unknown>
  ) => Promise<readonly BootstrapExtension<RuntimeStorageProvider>[]>;
};

/**
 * 由启动期宿主结果构造槽位来源；宿主缺失或无槽位入口时返回 `null`（测试注入路径）。
 */
export function slotImplementationSource(
  host: LoadedExtensionHost | undefined,
  env?: Record<string, string | undefined>
): SlotImplementationSource | null {
  const createSlotDeclarations = host?.createSlotDeclarations;
  if (!createSlotDeclarations) return null;
  return {
    extensionIds: (host?.slotEntries ?? []).map((entry) => entry.extensionId),
    // 运行期 env 用后端实际生效的那一份：测试与部署入口经常注入自定义 env，槽位实现必须读同一份。
    createDeclarations: (optionsByExtensionId) => createSlotDeclarations.call(host, optionsByExtensionId, env)
  };
}
