/**
 * 「生成」页签的 Provider 汇总（纯函数，无 React/DOM）。
 *
 * Generation 是核心服务，但它的配置不落宿主 YAML：Provider（宿主插件或站点扩展）向
 * `ctx.generation` 注册模型目录与配置。页签仍应出现——因为它**被插件影响**着；内容就是
 * 「谁在给它供模型」以及每个 Provider 的状态，而不是一个空配置页。
 *
 * 模型数量来自插件管理快照（站点级策略的只读投影）；没有模型条目时显示 0，不猜。
 */
import type { SettingsSnapshot } from "@woohaa3/contracts";
import { providerIdFromConfigPrefix } from "@woohaa3/contracts";
import type { ExtensionManagerView } from "../extension-manager/contract.js";

export type GenerationProviderView = {
  pluginId: string;
  label: string;
  providerId: string;
  /** 有 `providers.<id>` 配置段时显示对应键；站点扩展没有该段（例如「服务端接入」）。 */
  configKey?: string;
  /** 面向用户的状态：随宿主运行 / 站点实际状态 / 未启用。 */
  status: string;
  modelCount: number;
  enabledCount: number;
};

/**
 * 汇总向生成服务注册能力的 Provider；没有 Provider 时返回空数组（页签不出现）。
 *
 * 两类来源：
 * - 宿主插件树里声明了 `providers.<id>` 配置段的 Provider 插件（既有行为）；
 * - 没有该配置段的站点扩展（例如「服务端接入」）：它同样向 `ctx.generation` 注册 Provider，
 *   模型快照里带 `extensionId`。按 extensionId 归组即可把它列进同一张表，模型启停仍是普通
 *   本机策略，与其它 Provider 完全一致。
 */
export function generationProviders(
  snapshot: SettingsSnapshot | null,
  view: ExtensionManagerView | null
): GenerationProviderView[] {
  if (!snapshot) return [];
  const allRows = view?.modelRows ?? [];
  const providers: GenerationProviderView[] = [];
  const covered = new Set<string>();

  for (const plugin of snapshot.plugins ?? []) {
    if (!plugin.provider) continue;
    covered.add(plugin.id);
    const providerId = providerIdFromConfigPrefix(plugin.configPrefix) ?? plugin.id;
    const rows = allRows.filter((row) => row.providerId === providerId && !row.tombstone);
    const site = view?.siteRows.find((row) => row.extensionId === plugin.id);
    const status = site ? site.actualStateLabel : plugin.siteManaged ? "未启用" : "随宿主运行";
    providers.push({
      pluginId: plugin.id,
      label: plugin.label,
      providerId,
      configKey: plugin.configPrefix ?? `providers.${providerId}`,
      status,
      modelCount: rows.length,
      enabledCount: rows.filter((row) => row.enabled).length
    });
  }

  const installed = new Map((snapshot.installedExtensions ?? []).map((entry) => [entry.id, entry]));
  const rowsByExtension = new Map<string, typeof allRows>();
  for (const row of allRows) {
    if (!row.extensionId || covered.has(row.extensionId)) continue;
    const list = rowsByExtension.get(row.extensionId) ?? [];
    list.push(row);
    rowsByExtension.set(row.extensionId, list);
  }
  for (const [extensionId, extensionRows] of rowsByExtension) {
    const rows = extensionRows.filter((row) => !row.tombstone);
    if (rows.length === 0) continue;
    const site = view?.siteRows.find((row) => row.extensionId === extensionId);
    const extension = installed.get(extensionId);
    providers.push({
      pluginId: extensionId,
      label: site?.name ?? extension?.label ?? extensionId,
      providerId: rows[0]!.providerId,
      status: site ? site.actualStateLabel : "随宿主运行",
      modelCount: rows.length,
      enabledCount: rows.filter((row) => row.enabled).length
    });
  }
  return providers;
}
