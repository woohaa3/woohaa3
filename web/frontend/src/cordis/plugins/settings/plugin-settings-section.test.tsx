/**
 * 「插件配置」分区：插件行、行上的启停与状态、点行打开配置详情。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingPluginView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import { createBackendSettingsStore, type BackendSettingsRemote } from "./backend-settings-store.js";
import { PluginSettingsSection } from "./plugin-settings-section.js";
import type {
  ExtensionManagerFacade,
  ExtensionManagerView,
  ExtensionModelRow,
  ExtensionSiteRow
} from "../extension-manager/contract.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

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

const siteRow = (overrides: Partial<ExtensionSiteRow> = {}): ExtensionSiteRow => ({
  extensionId: "ark-provider",
  name: "Ark（火山方舟）",
  description: "火山方舟视频生成 Provider",
  desiredEnabled: false,
  actualState: "disabled",
  actualStateLabel: "已停用",
  diagnostics: [],
  busy: false,
  providerManaged: true,
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

function facadeWith(view: Partial<ExtensionManagerView>) {
  const full: ExtensionManagerView = {
    rows: [],
    siteRows: [],
    modelRows: [],
    siteManageable: true,
    siteError: null,
    pending: false,
    persistenceMessage: null,
    error: null,
    ...view
  };
  const setSiteEnabled = vi.fn();
  const setEnabled = vi.fn();
  const setModelEnabled = vi.fn();
  const facade: ExtensionManagerFacade = {
    getSnapshot: () => full,
    subscribe: () => () => undefined,
    setEnabled,
    refresh: () => undefined,
    setSiteEnabled,
    siteRows: () => full.siteRows,
    canManageSite: () => full.siteManageable,
    modelRows: () => full.modelRows,
    setModelEnabled,
    setModelsEnabled: () => undefined,
    setModelDefault: () => undefined,
    refreshModels: async () => undefined
  };
  return { facade, setSiteEnabled, setEnabled, setModelEnabled };
}

/** 最小受管控制器：分区只有受管扩展时要靠它才不会被当成「纯信息」折叠。 */
function stubManaged() {
  const state = { jobs: [], error: null, submitting: false, restart: { status: "idle" as const, message: null }, unquarantining: [] };
  const controller = {
    getState: () => state,
    subscribe: () => () => undefined,
    busy: () => false,
    cancel: async () => undefined,
    track: () => undefined,
    adoptSnapshot: () => undefined,
    installFile: async () => undefined,
    uninstall: async () => undefined,
    rollback: async () => undefined,
    restart: async () => undefined,
    dispose: () => undefined
  };
  return { controller, pendingReopen: { get: () => EMPTY_PENDING, subscribe: () => () => undefined } };
}

const EMPTY_PENDING: readonly string[] = [];
/** 必须是稳定引用：每次渲染新建会让 useSyncExternalStore 反复订阅。 */
const MANAGED_STUB = stubManaged();

async function renderSection(
  settings: SettingsEntryView[],
  plugins: SettingPluginView[],
  view: Partial<ExtensionManagerView> = {},
  onOpenPlugin?: (pluginId: string) => void,
  settingsPanels?: import("./plugin-panels.js").SettingsPanelSource,
  versions: Record<string, string> = {},
  installedOverrides: Record<string, Record<string, unknown>> = {},
  withManaged = false
) {
  const installedExtensions = plugins.filter((plugin) => plugin.layer === "extension").map((plugin) => ({
    id: plugin.id, label: plugin.label, description: plugin.description, directory: plugin.directory ?? `/plugins/${plugin.id}`,
    icon: plugin.icon, writable: false,
    ...(versions[plugin.id] ? { version: versions[plugin.id] } : {}),
    ...(installedOverrides[plugin.id] ?? {})
  }));
  const snapshot: SettingsSnapshot = { settings, plugins, installedExtensions, files: { config: "c", secrets: "s" } };
  const setExtensionInstalled = vi.fn(async () => ({ ok: true as const, snapshot }));
  const remote: BackendSettingsRemote = {
    fetchSnapshot: async () => ({ ok: true, snapshot }),
    write: async () => ({ ok: false, code: "unavailable", error: "x" })
  };
  const store = createBackendSettingsStore(remote);
  await store.load();
  const { facade, ...spies } = facadeWith(view);
  const onOpen = vi.fn(onOpenPlugin);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(
      <PluginSettingsSection
        store={store}
        manager={facade}
        onOpenPlugin={onOpen}
        {...(settingsPanels ? { settingsPanels } : {})}
        {...(withManaged ? { managed: MANAGED_STUB } : {})}
      />
    );
  });
  return { container, onOpen, setExtensionInstalled, ...spies };
}

const query = <T extends Element>(container: Element, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as T | null;

const PLUGINS = [
  plugin("log", { label: "日志", layer: "base", description: "结构化日志出口", icon: "logs" }),
  plugin("canvas", { label: "画布", layer: "core", description: "画布与 Yjs 同步", icon: "canvas" }),
  plugin("local-storage", { label: "本地存储", description: "本地对象存储", configPrefix: "storage.local", directory: "/opt/woohaa/extensions/local-storage", icon: "storage" }),
  plugin("ark-provider", {
    label: "Ark（火山方舟）",
    description: "火山方舟视频生成 Provider",
    configPrefix: "providers.ark",
    provider: true,
    siteManaged: true,
    icon: "provider"
  })
];

const SETTINGS = [
  entry("canvas.syncUpstream.url", { kind: "url", label: "远端同步地址" }),
  entry("storage.local.root", { label: "存储根目录", group: "本地存储", ownerExtensionId: "local-storage" }),
  entry("providers.ark.apiKey", { secret: true, label: "API Key", group: "Ark（火山方舟）", ownerExtensionId: "ark-provider" })
];

describe("插件目录管理", () => {
  it("只显示磁盘扩展，隐藏内置插件和旧浏览器条目", async () => {
    const { container } = await renderSection(SETTINGS, PLUGINS, { rows: [
      { id: "node-history", name: "节点历史", description: "", required: false, configurable: true, status: "active" }
    ] });
    expect(query(container, "settings-plugin-log")).toBeNull();
    expect(query(container, "settings-plugin-canvas")).toBeNull();
    expect(query(container, "settings-plugin-node-history")).toBeNull();
    expect(query(container, "plugins-settings-summary")?.textContent).toContain("2 个插件");
    expect(query(container, "settings-plugin-local-storage")?.querySelector(".plugin-directory code")?.textContent).toBe("/opt/woohaa/extensions/local-storage");
  });

  it("站点插件开关写服务端权威状态，不触碰目录改名或浏览器偏好", async () => {
    const { container, setExtensionInstalled, setSiteEnabled, setEnabled } = await renderSection(SETTINGS, PLUGINS, { siteRows: [siteRow()] });
    expect(query(container, "settings-plugin-ark-provider")?.textContent).toContain("已停用");
    await act(async () => query<HTMLButtonElement>(container, "settings-plugin-switch-ark-provider")!.click());
    expect(setSiteEnabled).toHaveBeenCalledWith("ark-provider", true);
    expect(setExtensionInstalled).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(query(container, "settings-plugins-pending")).toBeNull();
  });

  it("浏览器本地插件的开关写宿主配置并立即生效，不再提示「下次打开」", async () => {
    const { container, setEnabled, setSiteEnabled } = await renderSection(SETTINGS, PLUGINS, {
      rows: [{ id: "local-storage", name: "本地存储", description: "", required: false, configurable: true, status: "active" }]
    });
    await act(async () => query<HTMLButtonElement>(container, "settings-plugin-switch-local-storage")!.click());
    expect(setEnabled).toHaveBeenCalledWith("local-storage", false);
    expect(setSiteEnabled).not.toHaveBeenCalled();
    const text = query(container, "settings-plugin-local-storage")?.textContent ?? "";
    // 启停是运行中立即生效的：旧的「下次打开生效 / 重启后生效」文案必须消失。
    expect(text).not.toContain("下次打开");
    expect(text).not.toContain("重启后生效");
  });

  it("卡片展示扩展声明的版本，没有版本时不显示空标记", async () => {
    const { container } = await renderSection(SETTINGS, PLUGINS, {}, undefined, undefined, { "local-storage": "1.2.0" });
    expect(query(container, "settings-plugin-version-local-storage")?.textContent).toBe("v1.2.0");
    expect(query(container, "settings-plugin-version-ark-provider")).toBeNull();
  });

  it("打开扩展配置仍保留配置项和模型信息", async () => {
    const { container, onOpen } = await renderSection(SETTINGS, PLUGINS, { modelRows: [modelRow()] });
    expect(query(container, "settings-plugin-ark-provider")?.textContent).toContain("1/1 个模型");
    act(() => query<HTMLButtonElement>(container, "settings-plugin-open-ark-provider")!.click());
    expect(onOpen).toHaveBeenCalledWith("ark-provider");
  });

  it("没有磁盘扩展时显示空状态，不从旧站点记录生成卡片", async () => {
    const { container } = await renderSection([], [], { siteRows: [siteRow()] });
    expect(query(container, "plugins-settings-empty")).not.toBeNull();
    expect(query(container, "settings-plugin-ark-provider")).toBeNull();
  });

  it("未授权时不显示目录清单", async () => {
    const store = createBackendSettingsStore({
      fetchSnapshot: async () => ({ ok: false, code: "unauthorized", error: "需要管理员权限" }),
      write: async () => ({ ok: false, code: "unauthorized", error: "需要管理员权限" })
    });
    await store.load();
    const { facade } = facadeWith({ siteRows: [siteRow()] });
    const container = document.createElement("div"); const root = createRoot(container); roots.add(root);
    await act(async () => root.render(<PluginSettingsSection store={store} manager={facade} />));
    expect(query(container, "plugins-settings-unauthorized")).not.toBeNull();
    expect(query(container, "settings-plugin-ark-provider")).toBeNull();
  });

  it("受管扩展即使没有配置项也能点进详情（卸载/回滚在详情页）", async () => {
    const hello = plugin("hello-marketplace", { label: "市场示例插件", description: "演示插件" });
    const { container, onOpen } = await renderSection([], [hello], {}, undefined, undefined, {}, {
      "hello-marketplace": { managed: true, sourceId: "github-release", trust: "signed:afd67694dd46ddcd" }
    }, true);
    const open = query<HTMLButtonElement>(container, "settings-plugin-open-hello-marketplace")!;
    expect(open.disabled).toBe(false);
    expect(query(container, "settings-plugin-source-hello-marketplace")?.textContent).toBe("GitHub");
    act(() => open.click());
    expect(onOpen).toHaveBeenCalledWith("hello-marketplace");
  });

  it("扩展自带设置面板的插件也可打开配置弹窗，并标出扩展设置", async () => {
    const settingsPanels = {
      list: () => [{ id: "sdk-agent-panel", pluginId: "sdk-agent", render: () => <span data-testid="sdk-agent-panel" /> }],
      subscribe: () => () => undefined,
      version: () => 1
    };
    const sdk = plugin("sdk-agent", { label: "SDK Agent 来源", description: "配置 SDK 来源" });
    const { container, onOpen } = await renderSection([], [sdk], {}, undefined, settingsPanels);
    const card = query(container, "settings-plugin-sdk-agent")!;
    expect(card.textContent).toContain("扩展设置");
    const open = query<HTMLButtonElement>(container, "settings-plugin-open-sdk-agent")!;
    expect(open.disabled).toBe(false);
    act(() => open.click());
    expect(onOpen).toHaveBeenCalledWith("sdk-agent");
  });
});
