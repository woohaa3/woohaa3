/**
 * 扩展点选择项：把「用哪个提供者」和「提供者插件的深配置」连起来（纯函数，无 React/DOM）。
 *
 * 提供者集合来自两处：
 * 1. 宿主注册表当前已注册的后端（`/api/settings` 的 `extensionPoints.storage`，带 owner）；
 * 2. 插件声明的 `storage.<id>` 配置段——后端依赖配置才能注册，首次配置（例如 COS 还没填桶）
 *    时注册表是空的，但插件已经在场，选项和跳转仍应可见。
 *
 * 关联插件优先用注册表给的 owner，其次按配置前缀兜底；两者都拿不到时返回 null，由界面显示
 * 「没有插件提供这个后端」，不猜测。
 */
import type {
  SettingExtensionPointProvider,
  SettingPluginView,
  SettingsSnapshot
} from "@woohaa3/contracts";
import type { ExtensionSiteRow } from "../extension-manager/contract.js";

export type StorageSettingKey = "storage.primary" | "exposer.primary" | "storage.expose";

const STORAGE_SETTING_KEYS: readonly string[] = ["storage.primary", "exposer.primary", "storage.expose"];

export function isStorageSettingKey(key: string): key is StorageSettingKey {
  return STORAGE_SETTING_KEYS.includes(key);
}

export type ProviderOption = { value: string; label: string };

/** 提供者 + 是否已真正注册：插件声明了配置段不等于后端已经可用（缺配置时不会注册）。 */
export type StorageProviderOption = SettingExtensionPointProvider & { registered: boolean };

/** 插件声明的存储后端 id（`storage.local` → `local`）；不是存储配置段时返回 null。 */
export function storageBackendIdOf(plugin: SettingPluginView): string | null {
  const prefix = plugin.configPrefix;
  if (!prefix || !prefix.startsWith("storage.")) return null;
  const id = prefix.slice("storage.".length).split(".")[0];
  return id && id !== "storage" ? id : null;
}

/** 合并已注册后端与「插件声明但尚未注册」的后端；按 id 去重，注册表顺序优先。 */
export function storageProviders(snapshot: SettingsSnapshot | null): StorageProviderOption[] {
  const providers: StorageProviderOption[] = (snapshot?.extensionPoints?.storage ?? []).map((provider) => ({
    ...provider,
    registered: true
  }));
  const seen = new Set(providers.map((provider) => provider.id));
  for (const plugin of snapshot?.plugins ?? []) {
    const id = storageBackendIdOf(plugin);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    providers.push({ id, label: plugin.label, ownerExtensionId: plugin.id, registered: false });
  }
  return providers;
}

/**
 * 对外地址提供者：来自快照的 `extensionPoints.exposer`，加上「可能提供地址的存储插件」。
 *
 * 后者是给未注册场景兜底：提供地址的插件往往同时提供存储后端，配置没填完时注册表里还没有它，
 * 但设置页仍应能跳去补配置。
 */
export function exposerProviders(snapshot: SettingsSnapshot | null): StorageProviderOption[] {
  // 只列**真正注册过**的提供者：地址能力不能靠猜。曾经把存储后端当兜底补进来，结果下拉里
  // 出现了 `local`——它没有 presign，选中等于主动配置一个签不出地址的值。
  return (snapshot?.extensionPoints?.exposer ?? []).map((provider) => ({ ...provider, registered: true }));
}

/** 某个设置键该用哪一组提供者：`storage.primary` 用后端，`exposer.primary` 用地址提供者。 */
export function providersForSettingKey(
  key: StorageSettingKey,
  storage: readonly StorageProviderOption[],
  exposer: readonly StorageProviderOption[]
): readonly StorageProviderOption[] {
  // `storage.expose` 与 `exposer.primary` 语义相同（都是「谁来出地址」），共用一份列表；
  // `storage.primary` 才是「谁存字节」，用后端列表。
  return key === "storage.primary" ? storage : exposer;
}

/**
 * 选项列表。
 *
 * - `exposer.primary` / `storage.expose` 允许空值（不指定提供者，也就没有对外地址；没有默认提供者）；
 * - 当前值不在提供者里时保留它并标注「未注册」：不静默吞掉已有配置，也不假装它可用。
 */
export function storageSettingOptions(
  key: StorageSettingKey,
  providers: readonly StorageProviderOption[],
  currentValue: string
): ProviderOption[] {
  const options: ProviderOption[] = providers.map((provider) => ({
    value: provider.id,
    label: provider.registered ? provider.label : provider.label + "（未注册）"
  }));
  if (key === "storage.expose" || key === "exposer.primary") {
    options.unshift({ value: "", label: "未选择（不指定提供者）" });
  } else if (!currentValue) {
    // 主存储尚未选择时给一个占位项：原生 select 的 value 必须能匹配到 option。
    options.unshift({ value: "", label: "请选择后端" });
  }
  // 地址提供者的旧值（拆分前存的是存储后端 id，例如 `local`）永远出不了地址：
  // 运行时按未设置处理，这里也就不再把它当成一个可选项显示出来。
  if (key !== "exposer.primary" && currentValue && !options.some((option) => option.value === currentValue)) {
    options.push({ value: currentValue, label: currentValue + "（未注册）" });
  }
  return options;
}

export type RelatedProviderPlugin = {
  pluginId: string;
  label: string;
  /** 面向用户的状态：随宿主运行 / 已启用 / 已停用 / 已安装未运行 / 未安装。 */
  status: string;
  /** 已经有可打开的插件详情；未安装且未登记时为 false（此时只给「去插件配置」兜底）。 */
  openable: boolean;
  /** 后端还没有真正注册（常见于插件配置未填完）：可以跳去补配置，但现在不能选。 */
  unregistered: boolean;
};

/** 解析某个后端 id 的提供者插件；解析不到时返回 null（界面据此提示，不跳到错误插件）。 */
export function relatedProviderPlugin(input: {
  backendId: string;
  providers: readonly StorageProviderOption[];
  snapshot: SettingsSnapshot | null;
  siteRows?: readonly ExtensionSiteRow[];
}): RelatedProviderPlugin | null {
  const { backendId, providers, snapshot, siteRows } = input;
  if (!backendId) return null;
  const provider = providers.find((item) => item.id === backendId);
  const owner =
    provider?.ownerExtensionId ??
    snapshot?.plugins.find((plugin) => storageBackendIdOf(plugin) === backendId)?.id ??
    null;
  if (!owner) return null;

  const plugin = snapshot?.plugins.find((item) => item.id === owner);
  const siteRow = siteRows?.find((row) => row.extensionId === owner);
  const installed = snapshot?.installedExtensions?.find((extension) => extension.id === owner);
  const label = plugin?.label ?? siteRow?.name ?? installed?.label ?? owner;
  const status = siteRow
    ? siteRow.actualStateLabel
    : plugin
      ? (plugin.siteManaged ? "未启用" : "随宿主运行")
      : installed
        ? "已安装，未运行"
        : "未安装";
  return {
    pluginId: owner,
    label,
    status,
    openable: Boolean(plugin || siteRow || installed),
    unregistered: provider ? !provider.registered : true
  };
}
