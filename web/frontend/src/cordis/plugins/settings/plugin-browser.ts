/**
 * 「插件配置」列表的共享推导：行状态、筛选、分层归组与统计。
 *
 * 设置一级页（完整列表）与二级左栏（紧凑导航）读同一份推导，避免两处各自判断「哪个插件在跑」，
 * 也避免一级页筛选后左栏与右栏对不上。这里只有纯函数：不订阅 store、不渲染。
 *
 * 交互设计：画布设置-扩展层级导航（2026-10-28）——左栏永远是右栏内容的父级，
 * 二级左栏就是一级页的同一份列表的紧凑形态。
 */
import {
  PLUGIN_LAYER_LABELS,
  isConfigurable,
  isSiteRowRunning,
  type PluginSettingsGroup,
  type PluginViewIndex
} from "./plugin-groups.js";
import { extensionSource } from "./extension-source.js";

export type PluginRowTone = "success" | "warning" | "muted";

/** 行右侧的状态：站点/浏览器用权威状态，宿主内置按安装结果。 */
export function pluginRowStatus(index: PluginViewIndex, group: PluginSettingsGroup): {
  label: string;
  tone: PluginRowTone;
} {
  const site = index.siteRows.get(group.id);
  if (site) {
    if (site.busy) return { label: "正在应用…", tone: "warning" };
    return {
      label: site.actualStateLabel,
      tone: isSiteRowRunning(site.actualState) ? (site.actualState === "degraded" ? "warning" : "success") : "muted"
    };
  }
  const browser = index.browserRows.get(group.id);
  if (browser) {
    if (browser.status === "failed") return { label: "异常", tone: "warning" };
    return browser.status === "disabled"
      ? { label: "已停用", tone: "muted" }
      : { label: "运行中", tone: "success" };
  }
  return index.installedIds.has(group.id) ? { label: "运行中", tone: "success" } : { label: "未安装", tone: "muted" };
}

/** 这个状态算「停着」：筛选「已停用」与开关的初始值都用它。 */
export function isStoppedStatus(label: string, tone: PluginRowTone): boolean {
  return tone === "muted" || label.includes("停用") || label.includes("未启用") || label.includes("未安装");
}

export type PluginBrowserFilter = "all" | "running" | "disabled" | "configurable";

export const PLUGIN_BROWSER_FILTERS: ReadonlyArray<{ id: PluginBrowserFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "running", label: "运行中" },
  { id: "disabled", label: "已停用" },
  { id: "configurable", label: "可配置" }
];

export type PluginBrowserFilterInput = {
  /** 已归一化的关键词（小写、去掉首尾空白）；空串表示不过滤。 */
  query: string;
  filter: PluginBrowserFilter;
  /** `all` 或来源 id（见 extension-source.ts）。 */
  sourceFilter: string;
  /** 有自带设置面板的插件 id。 */
  panelIds: ReadonlySet<string>;
};

/** 关键词是否命中插件（名称、说明与 id）。 */
export function pluginMatchesQuery(group: PluginSettingsGroup, query: string): boolean {
  if (!query) return true;
  return `${group.label} ${group.description} ${group.id}`.toLowerCase().includes(query);
}

/**
 * 按当前筛选条件过滤插件分组（保持插件树顺序）。
 *
 * 注意既有语义：选了任一状态筛选时不再叠加来源筛选（两个筛选条互斥，避免「筛出来永远是空」）。
 */
export function filterPluginGroups(
  index: PluginViewIndex,
  groups: readonly PluginSettingsGroup[],
  input: PluginBrowserFilterInput
): PluginSettingsGroup[] {
  return groups.filter((group) => {
    if (!pluginMatchesQuery(group, input.query)) return false;
    const status = pluginRowStatus(index, group);
    if (input.filter === "running") return !isStoppedStatus(status.label, status.tone);
    if (input.filter === "disabled") return isStoppedStatus(status.label, status.tone);
    if (input.filter === "configurable") return isConfigurable(index, group) || input.panelIds.has(group.id);
    if (input.sourceFilter !== "all" && extensionSource(group.installed).id !== input.sourceFilter) return false;
    return true;
  });
}

/** 各筛选下的插件数（取自完整列表，不受当前筛选影响）。 */
export function pluginBrowserTotals(
  index: PluginViewIndex,
  panelIds: ReadonlySet<string>
): Record<PluginBrowserFilter, number> {
  const stopped = (group: PluginSettingsGroup) => {
    const status = pluginRowStatus(index, group);
    return isStoppedStatus(status.label, status.tone);
  };
  return {
    all: index.groups.length,
    running: index.groups.filter((group) => !stopped(group)).length,
    disabled: index.groups.filter(stopped).length,
    configurable: index.groups.filter((group) => isConfigurable(index, group) || panelIds.has(group.id)).length
  };
}

export type PluginBrowserSection = { title: string; groups: PluginSettingsGroup[] };

/** 按分层标题归组，保持插件树顺序；base 与 core 合成「内置插件」一节。 */
export function sectionizePluginGroups(groups: readonly PluginSettingsGroup[]): PluginBrowserSection[] {
  const order: string[] = [];
  const byTitle = new Map<string, PluginSettingsGroup[]>();
  for (const group of groups) {
    const title = PLUGIN_LAYER_LABELS[group.layer].section;
    if (!byTitle.has(title)) {
      byTitle.set(title, []);
      order.push(title);
    }
    byTitle.get(title)!.push(group);
  }
  return order.map((title) => ({ title, groups: byTitle.get(title)! }));
}

/** 只在真的有多个来源时返回来源筛选项：单来源场景多一行是噪声。 */
export function pluginSourceOptions(
  groups: readonly PluginSettingsGroup[]
): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const group of groups) {
    const source = extensionSource(group.installed);
    if (!seen.has(source.id)) seen.set(source.id, source.label);
  }
  return seen.size > 1 ? [...seen].map(([id, label]) => ({ id, label })) : [];
}
