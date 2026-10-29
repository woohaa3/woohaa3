/**
 * 插件列表的共享推导：行状态、筛选与分层归组。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import type { SettingPluginView, SettingsSnapshot } from "@woohaa3/contracts";
import type { ExtensionManagerView, ExtensionSiteRow } from "../extension-manager/contract.js";
import { indexPlugins } from "./plugin-groups.js";
import {
  filterPluginGroups,
  isStoppedStatus,
  pluginBrowserTotals,
  pluginRowStatus,
  pluginSourceOptions,
  sectionizePluginGroups
} from "./plugin-browser.js";

const plugin = (id: string, overrides: Partial<SettingPluginView> = {}): SettingPluginView => ({
  id,
  label: id,
  description: "",
  layer: "extension",
  settingCount: 0,
  siteManaged: false,
  provider: false,
  ...overrides
});

const siteRow = (extensionId: string, overrides: Partial<ExtensionSiteRow> = {}): ExtensionSiteRow => ({
  extensionId,
  name: extensionId,
  description: "",
  desiredEnabled: true,
  actualState: "active",
  actualStateLabel: "运行中",
  diagnostics: [],
  busy: false,
  providerManaged: true,
  ...overrides
});

const view = (overrides: Partial<ExtensionManagerView> = {}): ExtensionManagerView => ({
  rows: [],
  siteRows: [],
  modelRows: [],
  siteManageable: true,
  siteError: null,
  pending: false,
  persistenceMessage: null,
  error: null,
  ...overrides
});

const snapshot = (plugins: SettingPluginView[], installed: SettingsSnapshot["installedExtensions"] = []): SettingsSnapshot => ({
  settings: [],
  plugins,
  installedExtensions: installed,
  files: { config: "c", secrets: "s" }
});

const installedOf = (plugins: SettingPluginView[], overrides: Record<string, object> = {}) =>
  plugins.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    directory: `/plugins/${item.id}`,
    writable: false,
    ...(overrides[item.id] ?? {})
  }));

const input = (overrides: Partial<{ query: string; filter: "all" | "running" | "disabled" | "configurable"; sourceFilter: string; panelIds: Set<string> }> = {}) => ({
  query: "",
  filter: "all" as const,
  sourceFilter: "all",
  panelIds: new Set<string>(),
  ...overrides
});

describe("pluginRowStatus", () => {
  it("站点插件看服务端状态，未安装看安装结果", () => {
    const plugins = [plugin("site-a"), plugin("gone")];
    const index = indexPlugins(
      snapshot(plugins, installedOf(plugins)),
      view({ siteRows: [siteRow("site-a")] })
    );
    expect(pluginRowStatus(index, index.groups[0]!)).toEqual({ label: "运行中", tone: "success" });
    expect(pluginRowStatus(index, index.groups[1]!)).toEqual({ label: "运行中", tone: "success" });
    expect(isStoppedStatus("已停用", "muted")).toBe(true);
    expect(isStoppedStatus("运行中", "success")).toBe(false);
  });
});

describe("filterPluginGroups", () => {
  const plugins = [
    plugin("ark-provider", { label: "Ark", description: "火山方舟" }),
    plugin("film-set", { label: "片场", description: "素材与镜头" }),
    plugin("cos-storage", { label: "COS", description: "对象存储" })
  ];

  it("关键词同时匹配名称、说明与 id", () => {
    const index = indexPlugins(snapshot(plugins, installedOf(plugins)), view());
    const byName = filterPluginGroups(index, index.groups, input({ query: "片场" }));
    expect(byName.map((group) => group.id)).toEqual(["film-set"]);
    const byId = filterPluginGroups(index, index.groups, input({ query: "ark" }));
    expect(byId.map((group) => group.id)).toEqual(["ark-provider"]);
    const byDescription = filterPluginGroups(index, index.groups, input({ query: "对象存储" }));
    expect(byDescription.map((group) => group.id)).toEqual(["cos-storage"]);
  });

  it("状态筛选与来源筛选互斥，不会筛出永远为空的列表", () => {
    const index = indexPlugins(snapshot(plugins, installedOf(plugins)), view());
    const running = filterPluginGroups(index, index.groups, input({ filter: "running", sourceFilter: "builtin" }));
    expect(running).toHaveLength(3);
  });

  it("「可配置」包含只有扩展面板的插件", () => {
    const index = indexPlugins(snapshot(plugins, installedOf(plugins)), view());
    const configurable = filterPluginGroups(
      index,
      index.groups,
      input({ filter: "configurable", panelIds: new Set(["film-set"]) })
    );
    expect(configurable.map((group) => group.id)).toEqual(["film-set"]);
  });
});

describe("分组与统计", () => {
  it("按分层归组：base 与 core 合为「内置插件」", () => {
    const plugins = [
      plugin("log", { layer: "base" }),
      plugin("canvas", { layer: "core" }),
      plugin("film-set")
    ];
    const index = indexPlugins(snapshot(plugins, installedOf(plugins)), view());
    // 已安装扩展的行统一按「扩展插件」列出；base/core 只出现在旧宿主的登记项里。
    expect(sectionizePluginGroups(index.groups).map((section) => section.title)).toEqual(["扩展插件"]);

    const synthetic = index.groups.map((group, position) => ({
      ...group,
      layer: (["base", "core", "extension"] as const)[position]!
    }));
    expect(sectionizePluginGroups(synthetic).map((section) => [section.title, section.groups.length])).toEqual([
      ["内置插件", 2],
      ["扩展插件", 1]
    ]);
  });

  it("单来源不出现来源筛选；统计不受当前筛选影响", () => {
    const plugins = [plugin("film-set")];
    const index = indexPlugins(snapshot(plugins, installedOf(plugins)), view());
    expect(pluginSourceOptions(index.groups)).toEqual([]);
    expect(pluginBrowserTotals(index, new Set())).toEqual({ all: 1, running: 1, disabled: 0, configurable: 0 });
  });
});
