/**
 * 设置快照的分区投影：宿主项进「核心服务」、插件项进「插件配置」，插件树即使没有配置项也要列出来。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import type { SettingPluginView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import type {
  ExtensionManagerView,
  ExtensionManagerViewRow,
  ExtensionModelRow,
  ExtensionSiteRow
} from "../extension-manager/contract.js";
import {
  configCountLabel,
  indexPlugins,
  inactiveStateOf,
  isActionable,
  isManageable,
  modelsOf,
  pluginStateKind,
  providerConfigGroups,
  providerExtensionIds,
  settingsPartition,
  versionLabel
} from "./plugin-groups.js";

const entry = (key: string, overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
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
  ...overrides
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

const snapshot = (settings: SettingsEntryView[], plugins: SettingPluginView[]): SettingsSnapshot => ({
  settings,
  plugins,
  files: { config: "/tmp/c.yml", secrets: "/tmp/s.yml" }
});

describe("settingsPartition", () => {
  it("没有归属插件的项留在核心服务，插件声明的项按插件分组", () => {
    const partition = settingsPartition(
      snapshot(
        [
          entry("canvas.syncUpstream.url"),
          entry("storage.primary"),
          entry("storage.local.root", { ownerExtensionId: "local-storage", group: "本地存储" }),
          entry("storage.cos.secretId", { ownerExtensionId: "cos-storage", group: "COS / S3 对象存储", secret: true })
        ],
        [
          plugin("local-storage", { label: "本地存储", configPrefix: "storage.local" }),
          plugin("cos-storage", { label: "COS / S3 对象存储", configPrefix: "storage.cos" })
        ]
      )
    );
    expect(partition.host.map((item) => item.key)).toEqual(["canvas.syncUpstream.url", "storage.primary"]);
    expect(partition.groups.map((group) => [group.id, group.entries.length])).toEqual([
      ["local-storage", 1],
      ["cos-storage", 1]
    ]);
  });

  it("插件树里的插件即使没有可配置项也出现在清单里，并按宿主登记顺序", () => {
    const partition = settingsPartition(
      snapshot([], [
        plugin("log", { label: "日志", layer: "base" }),
        plugin("canvas", { label: "画布", layer: "core" }),
        plugin("ark-provider", { label: "Ark（火山方舟）", configPrefix: "providers.ark", provider: true, siteManaged: true })
      ])
    );
    expect(partition.groups.map((group) => group.id)).toEqual(["log", "canvas", "ark-provider"]);
    expect(partition.groups.map((group) => group.layer)).toEqual(["base", "core", "extension"]);
    expect(partition.groups[2]).toMatchObject({ provider: true, providerId: "ark", siteManaged: true, entries: [] });
  });

  it("配置项带了归属插件、插件树却没登记它时按扩展插件补一组（旧宿主）", () => {
    const partition = settingsPartition(
      snapshot([entry("providers.litellm.apiKey", { ownerExtensionId: "litellm-provider", group: "LiteLLM", secret: true })], [])
    );
    expect(partition.groups).toHaveLength(1);
    expect(partition.groups[0]).toMatchObject({
      id: "litellm-provider",
      label: "LiteLLM",
      layer: "extension",
      provider: true,
      providerId: "litellm"
    });
  });

  it("站点与浏览器插件作为额外种子并入，同 id 不重复", () => {
    const partition = settingsPartition(snapshot([], [plugin("ark-provider", { configPrefix: "providers.ark", provider: true })]), [
      { id: "ark-provider", label: "重复的 Ark", description: "", layer: "site", siteManaged: true },
      { id: "game-furnace", label: "游戏炼丹炉", description: "生成游戏", layer: "site", siteManaged: true },
      { id: "prompt-snippets", label: "提示词片段", description: "", layer: "browser" }
    ]);
    expect(partition.groups.map((group) => group.id)).toEqual(["ark-provider", "game-furnace", "prompt-snippets"]);
    expect(partition.groups[0]!.label).toBe("ark-provider");
    expect(partition.groups[1]).toMatchObject({ layer: "site", siteManaged: true, description: "生成游戏" });
    expect(partition.groups[2]).toMatchObject({ layer: "browser", entries: [] });
  });

  it("没有快照时只剩额外种子，不抛错", () => {
    const partition = settingsPartition(null);
    expect(partition).toEqual({ host: [], groups: [] });
    expect(settingsPartition(null, [{ id: "x", label: "X", description: "", layer: "browser" }]).groups).toHaveLength(1);
  });
});

describe("providerExtensionIds", () => {
  it("只把声明了 providers.<id> 段的插件算作 Provider 插件", () => {
    const ids = providerExtensionIds(
      snapshot([], [
        plugin("ark-provider", { configPrefix: "providers.ark", provider: true }),
        plugin("local-storage", { configPrefix: "storage.local" })
      ])
    );
    expect([...ids]).toEqual(["ark-provider"]);
    expect([...providerExtensionIds(null)]).toEqual([]);
  });
});

describe("providerConfigGroups", () => {
  it("按键前缀分组，不要求插件树（画布凭据弹窗）", () => {
    const groups = providerConfigGroups(
      snapshot(
        [
          entry("providers.litellm.apiKey", { secret: true, group: "LiteLLM" }),
          entry("providers.litellm.baseUrl", { kind: "url", group: "LiteLLM" }),
          entry("canvas.syncUpstream.token", { secret: true })
        ],
        []
      )
    );
    expect(groups.map((group) => group.providerId)).toEqual(["litellm"]);
    expect(groups[0]!.entries.map((item) => item.key)).toEqual(["providers.litellm.apiKey", "providers.litellm.baseUrl"]);
    expect(groups[0]!.label).toBe("LiteLLM");
  });

  it("有插件树时带出插件名与启停范围", () => {
    const groups = providerConfigGroups(
      snapshot(
        [entry("providers.ark.apiKey", { secret: true, ownerExtensionId: "ark-provider", group: "Ark（火山方舟）" })],
        [plugin("ark-provider", { label: "Ark（火山方舟）", configPrefix: "providers.ark", provider: true, siteManaged: true })]
      )
    );
    expect(groups[0]).toMatchObject({ id: "ark-provider", label: "Ark（火山方舟）", siteManaged: true });
  });
});

const viewOf = (overrides: Partial<ExtensionManagerView> = {}): ExtensionManagerView => ({
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

const siteRow = (overrides: Partial<ExtensionSiteRow> = {}): ExtensionSiteRow => ({
  extensionId: "game-furnace",
  name: "游戏炼丹炉",
  description: "生成游戏",
  desiredEnabled: true,
  actualState: "active",
  actualStateLabel: "运行中",
  diagnostics: [],
  busy: false,
  providerManaged: false,
  ...overrides
});

const browserRow = (overrides: Partial<ExtensionManagerViewRow> = {}): ExtensionManagerViewRow => ({
  id: "prompt-snippets",
  name: "提示词片段",
  description: "片段库",
  required: false,
  configurable: true,
  status: "active",
  ...overrides
});

const modelRow = (overrides: Partial<ExtensionModelRow> = {}): ExtensionModelRow => ({
  modelKey: "ark/seedance-2.0",
  providerId: "ark",
  modelType: "video",
  title: "Seedance 2.0",
  enabled: true,
  isDefault: true,
  executable: true,
  tombstone: false,
  ...overrides
});

describe("indexPlugins 已安装扩展清单", () => {
  const installed = (id: string) => ({ id, label: id, description: "", directory: `/plugins/${id}`, writable: false });
  it("只投影已安装扩展，隐藏内置项与旧浏览器偏好", () => {
    const index = indexPlugins({ ...snapshot([], [plugin("log", { layer: "base" }), plugin("ark-provider", { configPrefix: "providers.ark", provider: true })]),
      installedExtensions: [installed("ark-provider"), installed("prompt-snippets")] },
      viewOf({ siteRows: [siteRow()], rows: [browserRow()], modelRows: [modelRow()] }));
    expect(index.groups.map(group => group.id)).toEqual(["ark-provider", "prompt-snippets"]);
    expect(index.groups[0].installed?.directory).toBe("/plugins/ark-provider");
    expect(modelsOf(index, index.groups[0])).toHaveLength(1);
    expect(isActionable(index, index.groups[1])).toBe(true);
  });
  it("站点健康状态和模型仍归到对应扩展，图标从元数据补齐", () => {
    const index = indexPlugins({ ...snapshot([], [plugin("game-furnace")]), installedExtensions: [installed("game-furnace")] },
      viewOf({ siteRows: [siteRow({ actualState: "disabled", actualStateLabel: "已停用", icon: "game" })] }));
    expect(inactiveStateOf(index, index.groups[0])).toBe("已停用");
    expect(index.groups[0].icon).toBe("game");
    expect(pluginStateKind(index, index.groups[0])).toBe("site");
  });
  it("宿主插件登记的产品名优先于安装扫描的 extensionId", () => {
    const index = indexPlugins(
      { ...snapshot([], [plugin("local-storage", { label: "本地存储", configPrefix: "storage.local" })]), installedExtensions: [installed("local-storage")] },
      viewOf({})
    );
    expect(index.groups[0]!.label).toBe("本地存储");
  });

  it("已安装但不在站点或浏览器清单里的扩展没有启停开关", () => {
    const index = indexPlugins({ ...snapshot([], []), installedExtensions: [installed("film-set")] }, viewOf({}));
    expect(pluginStateKind(index, index.groups[0])).toBeNull();
    expect(isManageable(index, index.groups[0])).toBe(false);
  });

  it("安装扫描带出的版本透传到卡片分组，没有版本时不带字段", () => {
    const index = indexPlugins(
      { ...snapshot([], []), installedExtensions: [{ ...installed("fal-provider"), version: "1.0.0" }, installed("film-set")] },
      viewOf({})
    );
    expect(index.groups[0]!.version).toBe("1.0.0");
    expect(index.groups[1]!.version).toBeUndefined();
  });
});

// 「服务端接入」没有 providers.* 配置段：卡片上 providerId 为 null，只按 providerId 归组会让它的
// 整份目录丢掉。宿主在模型行里带 extensionId 作为回落归属；模型本身仍是普通策略行（可启停）。
describe("没有 providers.* 配置段的 Provider（服务端接入）", () => {
  const installed = (id: string) => ({ id, label: id, description: "", directory: `/plugins/${id}`, writable: false });
  const remoteModels = (count: number): ExtensionModelRow[] =>
    Array.from({ length: count }, (_, index) =>
      modelRow({
        modelKey: `remote-server:m${index}`,
        providerId: "remote-server",
        extensionId: "remote-server",
        title: `远端模型 ${index}`,
        modelType: "language",
        enabled: false,
        isDefault: false,
        executable: true
      })
    );

  it("按 extensionId 归到「服务端接入」卡片，providerId 匹配不到的模型不再丢", () => {
    const index = indexPlugins(
      {
        ...snapshot([], [plugin("ark-provider", { configPrefix: "providers.ark", provider: true })]),
        installedExtensions: [installed("ark-provider"), installed("remote-server")]
      },
      viewOf({ modelRows: [...remoteModels(2), modelRow()] })
    );
    expect(index.groups.map((group) => group.id)).toEqual(["ark-provider", "remote-server"]);
    expect(modelsOf(index, index.groups[0]!).map((row) => row.modelKey)).toEqual(["ark/seedance-2.0"]);
    expect(modelsOf(index, index.groups[1]!).map((row) => row.modelKey)).toEqual([
      "remote-server:m0",
      "remote-server:m1"
    ]);
    expect(isActionable(index, index.groups[1]!)).toBe(true);
  });

  it("卡片计数与其它 Provider 一致：已启用数 / 总数", () => {
    const index = indexPlugins(
      { ...snapshot([], []), installedExtensions: [installed("remote-server")] },
      viewOf({ modelRows: remoteModels(78) })
    );
    expect(configCountLabel(index, index.groups[0]!)).toBe("0/78 个模型");
  });

  it("providerId 匹配优先于 extensionId 回落", () => {
    const index = indexPlugins(
      { ...snapshot([], [plugin("ark-provider", { configPrefix: "providers.ark", provider: true })]), installedExtensions: [installed("ark-provider"), installed("remote-server")] },
      viewOf({ modelRows: [modelRow({ extensionId: "remote-server" })] })
    );
    expect(modelsOf(index, index.groups[0]!).map((row) => row.modelKey)).toEqual(["ark/seedance-2.0"]);
    expect(modelsOf(index, index.groups[1]!)).toEqual([]);
    expect(configCountLabel(index, index.groups[0]!)).toBe("1/1 个模型");
  });
});

describe("versionLabel", () => {
  it("统一 v 前缀，声明里自带 v/V 时不重复", () => {
    expect(versionLabel("1.0.0")).toBe("v1.0.0");
    expect(versionLabel("v2.0.0")).toBe("v2.0.0");
    expect(versionLabel(" V3.1.0 ")).toBe("V3.1.0");
  });
});
