/**
 * 生成页签的 Provider 汇总：有 Provider 插件才算「有内容」，模型数量来自插件管理快照。
 */
import { describe, expect, it } from "vitest";
import type { SettingPluginView, SettingsSnapshot } from "@woohaa3/contracts";
import type { ExtensionManagerView, ExtensionModelRow, ExtensionSiteRow } from "../extension-manager/contract.js";
import type { InstalledExtensionView } from "@woohaa3/contracts";
import { generationProviders } from "./generation-providers.js";

const plugin = (id: string, overrides: Partial<SettingPluginView> = {}): SettingPluginView => ({
  id,
  label: id,
  description: "",
  layer: "extension",
  settingCount: 0,
  siteManaged: false,
  provider: true,
  ...overrides
});

const snapshot = (plugins: SettingPluginView[], installedExtensions?: InstalledExtensionView[]): SettingsSnapshot => ({
  settings: [],
  plugins,
  ...(installedExtensions ? { installedExtensions } : {}),
  files: { config: "/tmp/a.yml", secrets: "/tmp/b.yml" }
});

const model = (overrides: Partial<ExtensionModelRow> = {}): ExtensionModelRow => ({
  modelKey: "m",
  providerId: "ark",
  modelType: "image",
  title: "M",
  enabled: true,
  isDefault: false,
  executable: true,
  tombstone: false,
  ...overrides
});

const siteRow = (extensionId: string, overrides: Partial<ExtensionSiteRow> = {}): ExtensionSiteRow => ({
  extensionId,
  name: extensionId,
  description: "",
  desiredEnabled: true,
  actualState: "active",
  actualStateLabel: "已启用",
  diagnostics: [],
  busy: false,
  providerManaged: true,
  ...overrides
});

const view = (input: { modelRows?: ExtensionModelRow[]; siteRows?: ExtensionSiteRow[] }): ExtensionManagerView => ({
  rows: [],
  siteRows: input.siteRows ?? [],
  modelRows: input.modelRows ?? [],
  siteManageable: true,
  siteError: null,
  pending: false,
  persistenceMessage: null,
  error: null
});

describe("generationProviders", () => {
  it("只汇总 Provider 插件，带 Provider id、状态与模型数量", () => {
    const providers = generationProviders(
      snapshot([
        plugin("ark-provider", { label: "Ark（火山方舟）", configPrefix: "providers.ark" }),
        plugin("log", { label: "日志", provider: false, configPrefix: "" }),
        plugin("litellm-provider", { label: "LiteLLM", configPrefix: "providers.litellm" })
      ]),
      view({ modelRows: [model(), model({ modelKey: "m2" }), model({ modelKey: "m3", enabled: false }), model({ modelKey: "gone", tombstone: true })] })
    );
    expect(providers.map((entry) => [entry.pluginId, entry.providerId])).toEqual([
      ["ark-provider", "ark"],
      ["litellm-provider", "litellm"]
    ]);
    expect(providers[0]).toMatchObject({ label: "Ark（火山方舟）", status: "随宿主运行", modelCount: 3, enabledCount: 2 });
  });

  it("站点插件的状态用插件管理快照的实际状态文案", () => {
    const [entry] = generationProviders(
      snapshot([plugin("ark-provider", { configPrefix: "providers.ark", siteManaged: true })]),
      view({ siteRows: [siteRow("ark-provider", { name: "Ark（火山方舟）", actualStateLabel: "已停用" })] })
    );
    expect(entry).toMatchObject({ status: "已停用", modelCount: 0 });
  });

  it("没有 Provider 插件时返回空数组（页签不出现）", () => {
    expect(generationProviders(snapshot([plugin("log", { provider: false })]), view({}))).toEqual([]);
    expect(generationProviders(null, null)).toEqual([]);
  });

  // 「服务端接入」是站点扩展：没有 providers.* 配置段，但同样向 ctx.generation 注册 Provider。
  // 它必须出现在同一张 Provider 表里，模型启停与其它 Provider 一样按本机策略计数。
  it("没有 providers.* 配置段的站点 Provider 也进列表（服务端接入）", () => {
    const installed: InstalledExtensionView = {
      id: "remote-server",
      label: "服务端接入",
      description: "",
      directory: "/plugins/remote-server",
      writable: false
    };
    const providers = generationProviders(
      snapshot([plugin("log", { provider: false })], [installed]),
      view({
        siteRows: [siteRow("remote-server", { name: "服务端接入", actualStateLabel: "运行中", providerManaged: false })],
        modelRows: [
          model({ modelKey: "remote-server:auto", providerId: "remote-server", extensionId: "remote-server", enabled: false }),
          model({ modelKey: "remote-server:glm-5", providerId: "remote-server", extensionId: "remote-server", enabled: true })
        ]
      })
    );
    expect(providers).toEqual([
      {
        pluginId: "remote-server",
        label: "服务端接入",
        providerId: "remote-server",
        status: "运行中",
        modelCount: 2,
        enabledCount: 1
      }
    ]);
  });
});
