/**
 * 设置快照的分区投影（纯函数，无 React/DOM）。
 *
 * 宿主随 `GET /api/settings` 返回两样东西：每项配置的 `ownerExtensionId`（这段配置由哪个插件声明）
 * 与整棵插件树 `plugins`（base / core / extension 三层）。设置页据此只分两份：
 * - 没有归属插件的配置项 → 「核心服务」（宿主自己的、与插件无关的配置，按服务再分页签）；
 * - 每个插件一组 → 「插件配置」的卡片，配置项与「什么时候生效」的启停同处。
 *
 * 只在站点或浏览器登记的插件（站点应用插件、浏览器功能插件）不在这棵宿主插件树里，由设置页把
 * 插件管理 facade 的行当作额外种子传进来，插件清单才是完整的。
 */
import {
  PROVIDER_SETTING_PREFIX,
  providerIdFromConfigPrefix,
  type PluginIcon,
  type SettingPluginLayer,
  type SettingsEntryView,
  type SettingPluginView,
  type SettingsSnapshot
} from "@woohaa3/contracts";
import type {
  ExtensionManagerView,
  ExtensionManagerViewRow,
  ExtensionModelRow,
  ExtensionSiteRow
} from "../extension-manager/contract.js";

/** 插件在设置面上的归属层：宿主三层，加两种只登记在站点 / 浏览器侧的插件。 */
export type SettingsPluginLayerKind = SettingPluginLayer | "site" | "browser";

/** 插件卡片的一行数据；`entries` 是它自己声明的配置项（没有可配置项时为空）。 */
export type PluginSettingsGroup = {
  /** Provider 声明的模型输出类型，配置前也可展示。 */
  modelTypes?: SettingPluginView["modelTypes"];
  /** 本次启动扫描到的安装信息（目录、是否可写根）；不表达启用状态。 */
  installed?: import("@woohaa3/contracts").InstalledExtensionView;
  directory?: string;
  /** 扩展声明的版本；卡片与详情按 `v<version>` 展示，缺省时不显示。 */
  version?: string;
  id: string;
  label: string;
  description: string;
  layer: SettingsPluginLayerKind;
  /** 插件声明的图标名；未声明时卡片回退通用插件图标。 */
  icon?: PluginIcon;
  /** 站点插件：可由站点插件服务启停。 */
  siteManaged: boolean;
  /** Provider 类插件：配置段在 `providers.<providerId>` 下。 */
  provider: boolean;
  /** Provider id；生成模型据此归到对应 Provider 卡片。 */
  providerId: string | null;
  /** 插件声明的模型目录刷新入口；缺省表示该插件没有「可用模型」一节。 */
  modelRefresh?: { path: string; hint: string };
  entries: SettingsEntryView[];
};

/** 宿主配置项与插件清单：设置页两个分区的全部输入。 */
export type SettingsPartition = {
  /** 宿主自己的配置项（「核心服务」）。 */
  host: SettingsEntryView[];
  /** 插件清单，按宿主插件树的登记顺序。 */
  groups: PluginSettingsGroup[];
};

/** 额外插件的种子：插件管理 facade 里的站点行与浏览器功能行。 */
export type PluginGroupSeed = {
  directory?: string;
  id: string;
  label: string;
  description: string;
  layer: SettingsPluginLayerKind;
  icon?: PluginIcon;
  siteManaged?: boolean;
};

export function settingsPartition(
  snapshot: SettingsSnapshot | null,
  extras: readonly PluginGroupSeed[] = []
): SettingsPartition {
  const host: SettingsEntryView[] = [];
  const byOwner = new Map<string, SettingsEntryView[]>();
  for (const entry of snapshot?.settings ?? []) {
    if (!entry.ownerExtensionId) {
      host.push(entry);
      continue;
    }
    const list = byOwner.get(entry.ownerExtensionId) ?? [];
    list.push(entry);
    byOwner.set(entry.ownerExtensionId, list);
  }

  const groups: PluginSettingsGroup[] = [];
  const seen = new Set<string>();
  const push = (group: PluginSettingsGroup) => {
    if (seen.has(group.id)) return;
    seen.add(group.id);
    groups.push(group);
  };

  for (const plugin of snapshot?.plugins ?? []) push(groupOf(plugin, byOwner.get(plugin.id) ?? []));
  // 兜底：配置项带了归属插件、但宿主没在插件树里登记它（旧宿主或已移除的插件）。
  for (const [id, entries] of byOwner) {
    if (seen.has(id)) continue;
    push({
      id,
      label: entries[0]?.group ?? id,
      description: "",
      layer: "extension",
      siteManaged: false,
      provider: entries.some((entry) => entry.key.startsWith(PROVIDER_SETTING_PREFIX)),
      providerId: providerIdFromKey(entries),
      entries
    });
  }
  for (const seed of extras) {
    if (seen.has(seed.id)) continue;
    push({
      id: seed.id,
      label: seed.label,
      description: seed.description,
      layer: seed.layer,
      ...(seed.directory ? { directory: seed.directory } : {}),
      ...(seed.icon ? { icon: seed.icon } : {}),
      siteManaged: seed.siteManaged ?? false,
      provider: false,
      providerId: null,
      entries: byOwner.get(seed.id) ?? []
    });
  }
  return { host, groups };
}

/**
 * 声明了 Provider 配置段的插件 id 集合。
 *
 * 插件管理用它把 Provider 类插件从「站点插件」清单里摘出去：它们的启停跟配置一起显示在自己的
 * 卡片上，两处不再各有一个开关。
 */
export function providerExtensionIds(snapshot: SettingsSnapshot | null): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of settingsPartition(snapshot).groups) {
    if (group.provider) ids.add(group.id);
  }
  return ids;
}

/**
 * Provider 凭据视图的分组：按 `providers.<providerId>.` 键前缀分组，不要求插件树。
 *
 * 画布的凭据弹窗只有 `/api/settings`，拿不到插件树时也要能按配置段列出密钥项；有插件树时顺便
 * 带出插件名与启停范围。设置页的「插件配置」不用这里，它按插件树分组。
 */
export function providerConfigGroups(snapshot: SettingsSnapshot | null): PluginSettingsGroup[] {
  const groups = new Map<string, PluginSettingsGroup>();
  for (const entry of snapshot?.settings ?? []) {
    if (!entry.key.startsWith(PROVIDER_SETTING_PREFIX)) continue;
    const providerId = entry.key.slice(PROVIDER_SETTING_PREFIX.length).split(".")[0];
    if (!providerId) continue;
    const existing = groups.get(providerId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const plugin = snapshot?.plugins.find(
      (candidate) =>
        candidate.configPrefix === `${PROVIDER_SETTING_PREFIX}${providerId}` ||
        (entry.ownerExtensionId !== undefined && candidate.id === entry.ownerExtensionId)
    );
    groups.set(providerId, {
      id: plugin?.id ?? entry.ownerExtensionId ?? `${PROVIDER_SETTING_PREFIX}${providerId}`,
      label: plugin?.label ?? entry.group ?? providerId,
      description: plugin?.description ?? "",
      ...(plugin?.icon ? { icon: plugin.icon } : {}),
      ...(plugin?.modelTypes ? { modelTypes: plugin.modelTypes } : {}),
      layer: plugin?.layer ?? "extension",
      siteManaged: plugin?.siteManaged ?? false,
      provider: true,
      providerId,
      entries: [entry]
    });
  }
  return [...groups.values()];
}

/** 分层在设置面上的分组标题与卡片徽标。 */
export const PLUGIN_LAYER_LABELS: Record<SettingsPluginLayerKind, { section: string; badge: string }> = {
  base: { section: "内置插件", badge: "基础层" },
  core: { section: "内置插件", badge: "核心层" },
  extension: { section: "扩展插件", badge: "扩展" },
  site: { section: "站点插件", badge: "站点" },
  browser: { section: "此浏览器插件", badge: "此浏览器" }
};

/** 兜底分组 id：Provider 没有对应插件卡片时，模型单独列一组。 */
export const LEFTOVER_MODEL_GROUP_ID = "generation-models";

/** 「插件配置」渲染要的全部输入：分组、各自的启停行与模型。 */
export type PluginViewIndex = {
  /** 宿主自己的配置项（「核心服务」）。 */
  host: SettingsEntryView[];
  groups: PluginSettingsGroup[];
  siteRows: ReadonlyMap<string, ExtensionSiteRow>;
  browserRows: ReadonlyMap<string, ExtensionManagerViewRow>;
  /** 插件 id → 它提供的生成模型。 */
  models: ReadonlyMap<string, ExtensionModelRow[]>;
  /** 本次启动已安装的扩展 id（服务端扫描结果）。 */
  installedIds: ReadonlySet<string>;
};

/**
 * 把设置快照与插件管理快照合成一份插件索引。
 *
 * 卡片网格与配置弹窗都读这一份，避免两处各自拼装「哪个插件有开关、模型归谁」。
 */
export function indexPlugins(snapshot: SettingsSnapshot | null, view: ExtensionManagerView): PluginViewIndex {
  const siteRows = new Map(view.siteRows.map((row) => [row.extensionId, row]));
  const browserRows = new Map(view.rows.map((row) => [row.id, row]));
  const extras: PluginGroupSeed[] = [
    ...view.siteRows.map((row) => ({
      id: row.extensionId,
      ...(row.directory ? { directory: row.directory } : {}),
      label: row.name,
      description: row.description,
      layer: "site" as const,
      siteManaged: true,
      ...(row.icon ? { icon: row.icon } : {})
    })),
    ...view.rows.map((row) => ({
      id: row.id,
      ...(row.directory ? { directory: row.directory } : {}),
      label: row.name,
      description: row.description,
      layer: "browser" as const,
      ...(row.icon ? { icon: row.icon } : {})
    }))
  ];
  const partition = settingsPartition(snapshot, extras);
  // 卡片以本次启动扫描到的已安装扩展为准：宿主内置插件与旧浏览器偏好不产生插件卡片。
  // 启用状态不来自目录——站点插件看服务端 `desiredEnabled`/`actualState`，浏览器本地看本地偏好。
  const installedEntries = snapshot?.installedExtensions ?? [];
  const installedIds = new Set(installedEntries.map((entry) => entry.id));
  const groups: PluginSettingsGroup[] = installedEntries.map((installedEntry) => {
    const existing = partition.groups.find((group) => group.id === installedEntry.id);
    return {
      ...(existing ?? { id: installedEntry.id, entries: [], provider: false, providerId: null, siteManaged: false }),
      // 宿主插件登记的 label/description 是产品文案（「本地存储」）；安装扫描只认目录，
      // 对没有 site.name 的 host-only 扩展会退化成 extensionId。有产品文案时以它为准。
      label: existing?.label || installedEntry.label,
      description: existing?.description || installedEntry.description,
      layer: "extension", directory: installedEntry.directory, installed: installedEntry,
      ...(installedEntry.icon ? { icon: installedEntry.icon } : {}),
      ...(installedEntry.version ? { version: installedEntry.version } : {})
    };
  });
  // 宿主登记插件时只有名字与（可能没有的）图标；站点/浏览器行带来的说明与图标补上空缺，
  // 卡片与弹窗才有话可说、有图形可放。
  for (const group of groups) {
    const row = siteRows.get(group.id) ?? browserRows.get(group.id);
    if (!row) continue;
    if (!group.directory && row.directory) group.directory = row.directory;
    if (!group.description) group.description = row.description;
    if (!group.icon && row.icon) group.icon = row.icon;
  }
  const models = new Map<string, ExtensionModelRow[]>();
  for (const row of view.modelRows) {
    // 归属顺序：先按 Provider id（Provider 类插件照旧），再回落到「提供该模型的插件 id」。
    // 远端 Provider（providerId=remote-server）没有 providers.* 配置段，providerId 为 null，
    // 只靠 providerId 会让它的模型整片丢掉；旧宿主没有 extensionId，回落分支自然不生效。
    const group =
      groups.find((candidate) => candidate.providerId !== null && candidate.providerId === row.providerId) ??
      (row.extensionId !== undefined ? groups.find((candidate) => candidate.id === row.extensionId) : undefined);
    // Provider 已停用（不在已安装集合里是卸载，这里是不再有对应卡片）时模型不另立分组：
    // 服务端仍会用 `executable: false` 报告撤出，卡片消失即代表该 Provider 不再可用。
    if (!group) continue;
    const list = models.get(group.id) ?? [];
    list.push(row);
    models.set(group.id, list);
  }
  return { host: partition.host, groups, siteRows, browserRows, models, installedIds };
}

export function modelsOf(index: PluginViewIndex, group: PluginSettingsGroup): readonly ExtensionModelRow[] {
  return index.models.get(group.id) ?? [];
}

/** 这个插件有可打开的配置弹窗（有配置项或它提供的模型）。 */
export function isConfigurable(index: PluginViewIndex, group: PluginSettingsGroup): boolean {
  return group.entries.length > 0 || modelsOf(index, group).length > 0;
}

/**
 * 卡片上的启停开关归属：站点插件走服务端权威状态，browser-local 走浏览器本地偏好，
 * 两者都没有的（宿主内置 / 纯后端 hostPlugin 不在站点清单里）不显示开关。
 */
export function pluginStateKind(index: PluginViewIndex, group: PluginSettingsGroup): "site" | "browser" | null {
  if (index.siteRows.has(group.id)) return "site";
  if (index.browserRows.has(group.id)) return "browser";
  return null;
}

/** 卡片上有启停开关：站点插件或浏览器功能插件。 */
export function isManageable(index: PluginViewIndex, group: PluginSettingsGroup): boolean {
  return pluginStateKind(index, group) !== null;
}

/** 有可操作内容的插件（可配置或可启停）；整节都没有的话这一节可以按节收起。 */
export function isActionable(index: PluginViewIndex, group: PluginSettingsGroup): boolean {
  return isConfigurable(index, group) || isManageable(index, group);
}

/** 卡片上的配置规模文案。 */
export function configCountLabel(index: PluginViewIndex, group: PluginSettingsGroup, hasSettingsPanel = false): string {
  const rows = modelsOf(index, group);
  const enabled = rows.filter((row) => row.enabled && !row.tombstone).length;
  const modelLabel = rows.length > 0 ? `${enabled}/${rows.length} 个模型` : "";
  if (group.entries.length > 0) return modelLabel ? `${group.entries.length} 项配置 · ${modelLabel}` : `${group.entries.length} 项配置`;
  if (rows.length > 0) return modelLabel;
  return hasSettingsPanel ? "扩展设置" : "无可配置项";
}

/** 版本展示文案：统一加 v 前缀；声明里已带 v/V 时不重复写。 */
export function versionLabel(version: string): string {
  const trimmed = version.trim();
  return /^v\d/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

/** 插件没在运行时的状态说明；在运行或没有站点状态时返回 null。 */
export function inactiveStateOf(index: PluginViewIndex, group: PluginSettingsGroup): string | null {
  const row = index.siteRows.get(group.id);
  return row && !isSiteRowRunning(row.actualState) ? row.actualStateLabel : null;
}

/** 站点插件给出的安全诊断（不含秘密）。 */
export function diagnosticsOf(index: PluginViewIndex, group: PluginSettingsGroup): readonly string[] {
  return index.siteRows.get(group.id)?.diagnostics ?? [];
}

/** 站点插件是否已在运行（降级运行也算：插件已装载，配置改动照常生效）。 */
export function isSiteRowRunning(actualState: string): boolean {
  return actualState === "active" || actualState === "degraded";
}

export function isBrowserRowEnabled(row: ExtensionManagerViewRow): boolean {
  return row.status === "active" || row.status === "failed" || row.status === "pending-enable";
}

export function isBrowserRowPending(row: ExtensionManagerViewRow): boolean {
  return row.status === "pending-enable" || row.status === "pending-disable";
}

function groupOf(plugin: SettingPluginView, entries: SettingsEntryView[]): PluginSettingsGroup {
  return {
    id: plugin.id,
    label: plugin.label,
    description: plugin.description,
    layer: plugin.layer,
    ...(plugin.directory ? { directory: plugin.directory } : {}),
    ...(plugin.icon ? { icon: plugin.icon } : {}),
    ...(plugin.modelTypes ? { modelTypes: plugin.modelTypes } : {}),
    siteManaged: plugin.siteManaged,
    provider: plugin.provider,
    providerId: providerIdFromConfigPrefix(plugin.configPrefix),
    ...(plugin.modelRefresh ? { modelRefresh: plugin.modelRefresh } : {}),
    entries
  };
}

/** 兜底分组里从配置项键名解析 Provider id（拿不到配置段前缀时）。 */
function providerIdFromKey(entries: readonly SettingsEntryView[]): string | null {
  const key = entries.find((entry) => entry.key.startsWith(PROVIDER_SETTING_PREFIX))?.key;
  if (!key) return null;
  return key.slice(PROVIDER_SETTING_PREFIX.length).split(".")[0] || null;
}
