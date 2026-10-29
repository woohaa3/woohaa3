/**
 * 插件子页推导：按插件实际有什么决定「概览 / 配置 / 模型 / 管理」。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import type { SettingPluginView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import type { ExtensionManagerView, ExtensionModelRow } from "../extension-manager/contract.js";
import { indexPlugins } from "./plugin-groups.js";
import { pluginPages, pluginSubPages, resolvePluginPage } from "./plugin-pages.js";

const entry = (key: string, ownerExtensionId: string): SettingsEntryView => ({
  key,
  kind: "string",
  label: key,
  description: "",
  reload: "hot",
  secret: false,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ownerExtensionId
});

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

const model = (providerId: string): ExtensionModelRow => ({
  modelKey: `${providerId}/m`,
  providerId,
  modelType: "image",
  title: "M",
  enabled: true,
  isDefault: false,
  executable: true,
  tombstone: false
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

const snapshot = (settings: SettingsEntryView[], plugins: SettingPluginView[]): SettingsSnapshot => ({
  settings,
  plugins,
  installedExtensions: plugins.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    directory: `/plugins/${item.id}`,
    writable: false
  })),
  files: { config: "c", secrets: "s" }
});

const pagesOf = (settings: SettingsEntryView[], plugins: SettingPluginView[], panelIds: string[] = [], extensionView = view()) => {
  const index = indexPlugins(snapshot(settings, plugins), extensionView);
  return pluginPages(index, index.groups[0]!, new Set(panelIds));
};

describe("pluginPages", () => {
  it("没有配置与模型的插件只有概览：不造单选项导航", () => {
    const pages = pagesOf([], [plugin("film-set")]);
    expect(pages.map((page) => page.id)).toEqual(["overview"]);
    expect(pluginSubPages(pages)).toEqual([]);
  });

  it("有配置项时出现「配置」并带上真实数量", () => {
    const pages = pagesOf([entry("a.x", "p"), entry("a.y", "p")], [plugin("p", { configPrefix: "a" })]);
    expect(pages.map((page) => [page.id, page.count])).toEqual([
      ["overview", undefined],
      ["config", 2]
    ]);
  });

  it("只有扩展自带面板、没有声明式配置项时也有「配置」，但不带数量", () => {
    const pages = pagesOf([], [plugin("sdk-agent")], ["sdk-agent"]);
    const config = pages.find((page) => page.id === "config");
    expect(config).toBeDefined();
    expect(config?.count).toBeUndefined();
  });

  it("有模型时出现「模型」；只有刷新入口也算有模型页", () => {
    const withModels = pagesOf(
      [],
      [plugin("ark-provider", { configPrefix: "providers.ark", provider: true })],
      [],
      view({ modelRows: [model("ark")] })
    );
    expect(withModels.find((page) => page.id === "models")?.count).toBe(1);
    const refreshOnly = pagesOf([], [
      plugin("litellm-provider", {
        provider: true,
        modelRefresh: { path: "/api/providers/litellm/refresh", hint: "从网关发现" }
      })
    ]);
    expect(refreshOnly.map((page) => page.id)).toContain("models");
    expect(refreshOnly.find((page) => page.id === "models")?.count).toBeUndefined();
  });

  it("受管扩展才有「管理」页", () => {
    const managed = pagesOf([], [plugin("demo")], [], view());
    expect(managed.map((page) => page.id)).toEqual(["overview"]);
    const index = indexPlugins(
      {
        settings: [],
        plugins: [plugin("demo")],
        installedExtensions: [
          { id: "demo", label: "Demo", description: "", directory: "/ext/demo/1.0.0", writable: false, managed: true, version: "1.0.0" }
        ],
        files: { config: "c", secrets: "s" }
      },
      view()
    );
    expect(pluginPages(index, index.groups[0]!, new Set()).map((page) => page.id)).toEqual(["overview", "manage"]);
  });

  it("目标子页不可用时回落到概览，不停在半截视图", () => {
    const pages = pagesOf([], [plugin("film-set")]);
    expect(resolvePluginPage(pages, "models").id).toBe("overview");
    expect(resolvePluginPage(pages, "config").id).toBe("overview");
  });
});
