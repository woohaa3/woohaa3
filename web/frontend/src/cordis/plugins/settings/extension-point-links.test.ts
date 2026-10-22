/**
 * 扩展点选择项：提供者合并、可选值、关联插件解析（含注册表缺失时的前缀兜底与站点插件状态）。
 */
import { describe, expect, it } from "vitest";
import type {
  SettingExtensionPointProvider,
  SettingPluginView,
  SettingsSnapshot
} from "@woohaa3/contracts";
import type { ExtensionSiteRow } from "../extension-manager/contract.js";
import {
  isStorageSettingKey,
  relatedProviderPlugin,
  storageBackendIdOf,
  storageProviders,
  storageSettingOptions
} from "./extension-point-links.js";

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

const snapshot = (input: {
  plugins?: SettingPluginView[];
  storage?: SettingExtensionPointProvider[];
  installed?: SettingsSnapshot["installedExtensions"];
}): SettingsSnapshot => ({
  settings: [],
  plugins: input.plugins ?? [],
  ...(input.storage ? { extensionPoints: { storage: input.storage } } : {}),
  ...(input.installed ? { installedExtensions: input.installed } : {}),
  files: { config: "/tmp/a.yml", secrets: "/tmp/b.yml" }
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
  providerManaged: false,
  ...overrides
});

describe("storageBackendIdOf", () => {
  it("从配置前缀推出后端 id，非存储段返回 null", () => {
    expect(storageBackendIdOf(plugin("cos-storage", { configPrefix: "storage.cos" }))).toBe("cos");
    expect(storageBackendIdOf(plugin("local-storage", { configPrefix: "storage.local" }))).toBe("local");
    expect(storageBackendIdOf(plugin("ark", { configPrefix: "providers.ark" }))).toBeNull();
    expect(storageBackendIdOf(plugin("plain"))).toBeNull();
  });
});

describe("storageProviders", () => {
  it("合并已注册后端与插件声明的后端，按注册表顺序去重", () => {
    const providers = storageProviders(snapshot({
      storage: [{ id: "local", label: "本地存储", ownerExtensionId: "local-storage" }],
      plugins: [
        plugin("local-storage", { label: "本地存储", configPrefix: "storage.local" }),
        plugin("cos-storage", { label: "COS / S3 对象存储", configPrefix: "storage.cos" })
      ]
    }));
    expect(providers).toEqual([
      { id: "local", label: "本地存储", ownerExtensionId: "local-storage", registered: true },
      { id: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage", registered: false }
    ]);
  });
});

describe("storageSettingOptions", () => {
  const providers = [
    { id: "local", label: "本地存储", ownerExtensionId: "local-storage", registered: true },
    { id: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage", registered: true }
  ];

  it("主存储只列已注册/已声明的后端", () => {
    expect(storageSettingOptions("storage.primary", providers, "local").map((option) => option.value)).toEqual(["local", "cos"]);
  });

  it("主存储尚未选择时给占位项，避免原生 select 的 value 匹配不到 option", () => {
    expect(storageSettingOptions("storage.primary", providers, "")[0]).toEqual({ value: "", label: "请选择后端" });
  });

  it("对外后端带空选项，保留未注册的当前值并标注", () => {
    const options = storageSettingOptions("storage.expose", providers, "legacy");
    expect(options[0]).toEqual({ value: "", label: "未选择（只用主存储的签名能力）" });
    expect(options.at(-1)).toEqual({ value: "legacy", label: "legacy（未注册）" });
  });
});

describe("relatedProviderPlugin", () => {
  const providers = [{ id: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage", registered: true }];

  it("用注册表 owner 解析到宿主插件", () => {
    const result = relatedProviderPlugin({
      backendId: "cos",
      providers,
      snapshot: snapshot({ plugins: [plugin("cos-storage", { label: "COS / S3 对象存储" })] })
    });
    expect(result).toMatchObject({ pluginId: "cos-storage", label: "COS / S3 对象存储", status: "随宿主运行", openable: true });
  });

  it("注册表缺失时按 storage.<id> 配置前缀兜底（后端还没配置完也能跳）", () => {
    const result = relatedProviderPlugin({
      backendId: "cos",
      providers: [],
      snapshot: snapshot({ plugins: [plugin("cos-storage", { label: "COS / S3 对象存储", configPrefix: "storage.cos" })] })
    });
    expect(result?.pluginId).toBe("cos-storage");
  });

  it("站点插件用插件管理快照的状态文案", () => {
    const result = relatedProviderPlugin({
      backendId: "server",
      providers: [{ id: "server", label: "服务端托管存储", ownerExtensionId: "remote-server", registered: true }],
      snapshot: snapshot({ plugins: [] }),
      siteRows: [siteRow("remote-server", { name: "服务端接入", actualStateLabel: "已启用" })]
    });
    expect(result).toMatchObject({ pluginId: "remote-server", label: "服务端接入", status: "已启用", openable: true });
  });

  it("只安装未运行与完全未知的情况分开处理", () => {
    const installed = relatedProviderPlugin({
      backendId: "cos",
      providers,
      snapshot: snapshot({ installed: [{ id: "cos-storage", label: "COS", description: "", directory: "/x", writable: false }] })
    });
    expect(installed?.status).toBe("已安装，未运行");
    expect(installed?.openable).toBe(true);
    expect(relatedProviderPlugin({ backendId: "ghost", providers: [], snapshot: snapshot({}) })).toBeNull();
  });

  it("插件声明了后端但还没注册时，标记出来而不是假装可用", () => {
    const result = relatedProviderPlugin({
      backendId: "cos",
      providers: [{ id: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage", registered: false }],
      snapshot: snapshot({ plugins: [plugin("cos-storage", { label: "COS / S3 对象存储", configPrefix: "storage.cos" })] })
    });
    expect(result?.unregistered).toBe(true);
    expect(result?.openable).toBe(true);
  });

  it("空值不产生关联行", () => {
    expect(relatedProviderPlugin({ backendId: "", providers, snapshot: snapshot({}) })).toBeNull();
  });
});

describe("isStorageSettingKey", () => {
  it("只认两个存储扩展点键", () => {
    expect(isStorageSettingKey("storage.primary")).toBe(true);
    expect(isStorageSettingKey("storage.expose")).toBe(true);
    expect(isStorageSettingKey("storage.local.root")).toBe(false);
  });
});
