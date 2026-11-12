/**
 * 插件配置弹窗：插件信息、启停、配置项与它提供的生成模型；插件不存在时给提示。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingPluginView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import { createBackendSettingsStore, type BackendSettingsRemote } from "../backend-settings-store.js";
import { PluginConfigContent } from "./plugin-config-content.js";
import type {
  ExtensionManagerFacade,
  ExtensionManagerView,
  ExtensionModelRow,
  ExtensionSiteRow
} from "../../extension-manager/contract.js";

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

const arkPlugin = (): SettingPluginView => ({
  id: "ark-provider",
  label: "Ark（火山方舟）",
  description: "火山方舟视频生成 Provider",
  layer: "extension",
  configPrefix: "providers.ark",
  settingCount: 2,
  siteManaged: true,
  provider: true
});

const sdkAgentPlugin = (): SettingPluginView => ({
  id: "sdk-agent",
  label: "SDK Agent 来源",
  description: "SDK",
  layer: "extension",
  settingCount: 0,
  siteManaged: false,
  provider: false
});

const arkEntries = (): SettingsEntryView[] => [
  entry("providers.ark.apiKey", { secret: true, label: "API Key", ownerExtensionId: "ark-provider" }),
  entry("providers.ark.videoCreateUrl", {
    kind: "url",
    label: "视频任务创建地址",
    ownerExtensionId: "ark-provider",
    protocols: ["https:"]
  })
];

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
  const setModelEnabled = vi.fn();
  const setModelsEnabled = vi.fn();
  const facade: ExtensionManagerFacade = {
    getSnapshot: () => full,
    subscribe: () => () => undefined,
    setEnabled: () => undefined,
    refresh: () => undefined,
    setSiteEnabled,
    siteRows: () => full.siteRows,
    canManageSite: () => full.siteManageable,
    modelRows: () => full.modelRows,
    setModelEnabled,
    setModelsEnabled,
    setModelDefault: () => undefined,
    refreshModels: async () => undefined
  };
  return { facade, setSiteEnabled, setModelEnabled, setModelsEnabled };
}

async function renderDialog(options: {
  pluginId: string;
  /** 三级页：概览（默认）/ 配置 / 模型 / 管理。 */
  page?: "overview" | "config" | "models" | "manage";
  settings?: SettingsEntryView[];
  plugins?: SettingPluginView[];
  view?: Partial<ExtensionManagerView>;
  write?: BackendSettingsRemote["write"];
  settingsPanels?: import("../plugin-panels.js").SettingsPanelSource;
  installedVersions?: Record<string, string>;
  onSelectPage?: (page: "overview" | "config" | "models" | "manage") => void;
}) {
  const snapshot: SettingsSnapshot = {
    settings: options.settings ?? [],
    plugins: options.plugins ?? [],
    installedExtensions: (options.plugins ?? []).filter((plugin) => plugin.layer === "extension").map((plugin) => ({
      id: plugin.id, label: plugin.label, description: plugin.description, directory: `/plugins/${plugin.id}`, writable: false,
      ...(options.installedVersions?.[plugin.id] ? { version: options.installedVersions[plugin.id] } : {})
    })),
    files: { config: "c", secrets: "s" }
  };
  const store = createBackendSettingsStore({
    fetchSnapshot: async () => ({ ok: true, snapshot }),
    setExtensionInstalled: async () => ({ ok: true, snapshot }),
    write: options.write ?? (async () => ({ ok: false, code: "unavailable", error: "x" }))
  });
  await store.load();
  const { facade, ...spies } = facadeWith(options.view ?? {});
  const onBack = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(
      <PluginConfigContent
        pluginId={options.pluginId}
        {...(options.page ? { page: options.page } : {})}
        store={store}
        manager={facade}
        {...(options.settingsPanels ? { settingsPanels: options.settingsPanels } : {})}
        {...(options.onSelectPage ? { onSelectPage: options.onSelectPage } : {})}
        onBack={onBack}
      />
    );
  });
  return { container, onBack, ...spies };
}

const query = <T extends Element>(container: Element, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as T | null;

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("插件配置弹窗", () => {
  it("浏览器插件失败时概览可展开原因，开关旁不误报运行中", async () => {
    const { container } = await renderDialog({
      pluginId: "sdk-agent",
      plugins: [sdkAgentPlugin()],
      view: { rows: [{ id: "sdk-agent", name: "SDK Agent 来源", description: "SDK", required: false, configurable: true, status: "failed", failureReason: "模块加载失败：HTTP 404" }] }
    });
    const details = query<HTMLDetailsElement>(container, "plugin-failure-sdk-agent")!;
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("模块加载失败：HTTP 404");
    expect(container.querySelector(".plugin-state__label")?.textContent).toBe("激活失败");
  });

  it("详情头展示扩展声明的版本，没有版本时不渲染空标记", async () => {
    const plugin: SettingPluginView = {
      id: "fal-provider", label: "fal.ai", description: "", layer: "extension",
      settingCount: 0, siteManaged: true, provider: true
    };
    const versioned = await renderDialog({
      pluginId: "fal-provider",
      plugins: [plugin],
      installedVersions: { "fal-provider": "1.0.0" }
    });
    expect(query(versioned.container, "plugin-config-version-fal-provider")?.textContent).toBe("v1.0.0");
    const unversioned = await renderDialog({ pluginId: "fal-provider", plugins: [plugin] });
    expect(query(unversioned.container, "plugin-config-version-fal-provider")).toBeNull();
  });

  it("LiteLLM 提供刷新发现，不要求手写模型名单", async () => {
    const { container } = await renderDialog({
      pluginId: "litellm-provider",
      page: "models",
      settings: [entry("providers.litellm.apiKey", { secret: true, label: "API Key", ownerExtensionId: "litellm-provider" })],
      plugins: [{
        id: "litellm-provider",
        label: "LiteLLM",
        description: "网关",
        layer: "extension",
        configPrefix: "providers.litellm",
        settingCount: 1,
        siteManaged: true,
        provider: true,
        // 刷新入口由插件声明驱动（宿主不再硬编码 Provider 的刷新路径与说明）。
        modelRefresh: {
          path: "/api/providers/litellm/refresh",
          hint: "模型从 LiteLLM 网关发现，不用在这里手写名单。保存 API Key 和网关地址后会发现一次，也可以再刷新。"
        }
      }]
    });
    expect(query(container, "litellm-refresh-models")?.textContent).toContain("刷新可用模型");
    expect(container.textContent).toContain("不用在这里手写名单");
  });

  it("非站点插件启动失败时，模型页直接给出原因而不是「还没有模型」", async () => {
    const plugin: SettingPluginView = {
      id: "litellm-provider",
      label: "LiteLLM",
      description: "网关",
      layer: "extension",
      configPrefix: "providers.litellm",
      settingCount: 1,
      // Provider 不进站点控制面：没有 actualState，失败原因只能靠 activationFailure 上屏。
      siteManaged: false,
      provider: true,
      modelRefresh: { path: "/api/providers/litellm/refresh", hint: "从网关发现" },
      activationFailure: "ctx.generation.registerConversion is not a function"
    };
    const { container } = await renderDialog({ pluginId: "litellm-provider", page: "models", plugins: [plugin] });
    expect(container.textContent).toContain("ctx.generation.registerConversion is not a function");
    // 概览页的状态标记同样要跟着变：否则卡片写着「运行中」，模型页却说插件没启动。
    const overview = await renderDialog({ pluginId: "litellm-provider", page: "overview", plugins: [plugin] });
    expect(overview.container.querySelector(".plugin-overview__status")?.textContent).toBe("启动失败");
  });

  it("全部启用和全部关闭一次写这张卡片上的模型，关闭前先确认", async () => {
    const { container, setModelsEnabled } = await renderDialog({
      pluginId: "litellm-provider",
      page: "models",
      plugins: [{
        id: "litellm-provider",
        label: "LiteLLM",
        description: "网关",
        layer: "extension",
        configPrefix: "providers.litellm",
        settingCount: 1,
        siteManaged: true,
        provider: true
      }],
      view: {
        modelRows: [
          modelRow({ modelKey: "litellm:a", providerId: "litellm", title: "A", enabled: true }),
          modelRow({ modelKey: "litellm:b", providerId: "litellm", title: "B", enabled: false, isDefault: false }),
          modelRow({ modelKey: "litellm:gone", providerId: "litellm", title: "Gone", tombstone: true }),
          modelRow({ modelKey: "ark:v", providerId: "ark", title: "Ark" })
        ]
      }
    });
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-disable-all-litellm-provider")!.click());
    expect(query(container, "plugin-config-models-confirm-litellm-provider")).not.toBeNull();
    expect(setModelsEnabled).not.toHaveBeenCalled();
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-confirm-disable-litellm-provider")!.click());
    expect(setModelsEnabled).toHaveBeenCalledWith(["litellm:a", "litellm:b"], false);
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-enable-all-litellm-provider")!.click());
    expect(setModelsEnabled).toHaveBeenCalledWith(["litellm:a", "litellm:b"], true);
  });

  it("有关键词时批量动作只写命中的模型", async () => {
    const models = Array.from({ length: 10 }, (_, index) =>
      modelRow({
        modelKey: `ark/m${index}`,
        providerId: "ark",
        title: `Seedance ${index}`,
        modelType: index % 2 === 0 ? "image" : "video",
        enabled: index < 5,
        isDefault: index === 0
      })
    );
    const { container, setModelsEnabled } = await renderDialog({
      pluginId: "ark-provider",
      page: "models",
      plugins: [arkPlugin()],
      view: { modelRows: models }
    });
    const filter = query<HTMLInputElement>(container, "plugin-config-model-filter-ark-provider")!;
    typeInto(filter, "Seedance 1");
    expect(query(container, "plugin-config-models-ark-provider")!.children).toHaveLength(1);
    expect(query<HTMLButtonElement>(container, "plugin-config-models-disable-all-ark-provider")!.textContent).toContain("关闭 1 个");
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-disable-all-ark-provider")!.click());
    expect(query(container, "plugin-config-models-confirm-ark-provider")?.textContent).toContain("关闭匹配的 1 个模型");
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-confirm-disable-ark-provider")!.click());
    expect(setModelsEnabled).toHaveBeenCalledWith(["ark/m1"], false);
  });

  it("全部关闭后可撤销到操作前的状态", async () => {
    const { container, setModelsEnabled } = await renderDialog({
      pluginId: "ark-provider",
      page: "models",
      plugins: [arkPlugin()],
      view: {
        modelRows: [
          modelRow({ modelKey: "ark/a", title: "A", enabled: true }),
          modelRow({ modelKey: "ark/b", title: "B", enabled: false, isDefault: false })
        ]
      }
    });
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-disable-all-ark-provider")!.click());
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-confirm-disable-ark-provider")!.click());
    expect(setModelsEnabled).toHaveBeenNthCalledWith(1, ["ark/a", "ark/b"], false);
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-undo-ark-provider")!.click());
    expect(setModelsEnabled).toHaveBeenNthCalledWith(2, ["ark/a"], true);
    expect(setModelsEnabled).toHaveBeenNthCalledWith(3, ["ark/b"], false);
    expect(query(container, "plugin-config-models-toast-ark-provider")).toBeNull();
  });

  it("仅看已启用过滤列表，空结果有清除出口", async () => {
    const models = Array.from({ length: 10 }, (_, index) =>
      modelRow({
        modelKey: `ark/m${index}`,
        providerId: "ark",
        title: `Seedance ${index}`,
        modelType: index % 2 === 0 ? "image" : "video",
        enabled: index < 5,
        isDefault: index === 0
      })
    );
    const { container } = await renderDialog({
      pluginId: "ark-provider",
      page: "models",
      plugins: [arkPlugin()],
      view: { modelRows: models }
    });
    expect(query(container, "plugin-config-models-ark-provider")!.children).toHaveLength(10);
    const onlyEnabled = query<HTMLButtonElement>(container, "plugin-config-models-only-enabled-ark-provider")!;
    act(() => onlyEnabled.click());
    expect(onlyEnabled.getAttribute("aria-pressed")).toBe("true");
    expect(query(container, "plugin-config-models-ark-provider")!.children).toHaveLength(5);
    const filter = query<HTMLInputElement>(container, "plugin-config-model-filter-ark-provider")!;
    typeInto(filter, "zzz");
    expect(query(container, "plugin-config-models-empty-ark-provider")).not.toBeNull();
    expect(container.textContent).toContain("没有匹配的模型");
    act(() => query<HTMLButtonElement>(container, "plugin-config-models-clear-filters-ark-provider")!.click());
    expect(query(container, "plugin-config-models-ark-provider")!.children).toHaveLength(10);
  });

  it("概览展示身份与启停；配置项在「配置」页，未运行时提示要等启用", async () => {
    const overview = await renderDialog({
      pluginId: "ark-provider",
      settings: arkEntries(),
      plugins: [arkPlugin()],
      view: { siteRows: [siteRow()] }
    });
    expect(overview.container.textContent).toContain("Ark（火山方舟）");
    expect(overview.container.textContent).toContain("火山方舟视频生成 Provider");
    expect(overview.container.textContent).toContain("Provider");
    // 概览只放身份与启停：配置项不在这里，避免一进详情就掉进长表单。
    expect(query(overview.container, "plugin-config-entries-ark-provider")).toBeNull();
    expect(query(overview.container, "plugin-config-inactive-ark-provider")?.textContent).toContain("当前未运行");
    const control = query<HTMLButtonElement>(overview.container, "plugin-config-switch-ark-provider")!;
    expect(control.getAttribute("aria-checked")).toBe("false");

    const config = await renderDialog({
      pluginId: "ark-provider",
      page: "config",
      settings: arkEntries(),
      plugins: [arkPlugin()],
      view: { siteRows: [siteRow()] }
    });
    expect(query(config.container, "plugin-config-entries-ark-provider")).not.toBeNull();
    const apiKey = query<HTMLInputElement>(config.container, "setting-input-providers.ark.apiKey")!;
    expect(apiKey.type).toBe("password");
    // 停用态不许再说「即时生效」。
    expect(config.container.querySelector('[data-setting-key="providers.ark.videoCreateUrl"]')?.textContent).toContain("启用后生效");
  });

  it("有扩展自带设置面板时，运行中直接渲染面板", async () => {
    const settingsPanels = {
      list: () => [
        { id: "sdk-agent-panel", pluginId: "sdk-agent", render: () => <span data-testid="sdk-agent-panel">SDK 设置</span> }
      ],
      subscribe: () => () => undefined,
      version: () => 1
    };
    const { container } = await renderDialog({
      pluginId: "sdk-agent",
      page: "config",
      plugins: [sdkAgentPlugin()],
      view: {
        siteRows: [
          siteRow({
            extensionId: "sdk-agent",
            name: "SDK Agent 来源",
            description: "SDK",
            desiredEnabled: true,
            actualState: "active",
            actualStateLabel: "运行中",
            providerManaged: false
          })
        ]
      },
      settingsPanels
    });
    expect(query(container, "plugin-config-panels-sdk-agent")).not.toBeNull();
    expect(query(container, "sdk-agent-panel")?.textContent).toBe("SDK 设置");
    expect(query(container, "plugin-config-panel-inactive-sdk-agent")).toBeNull();
  });

  it("扩展设置面板在插件未运行时只提示先启用，不渲染会调后端面板", async () => {
    const settingsPanels = {
      list: () => [
        { id: "sdk-agent-panel", pluginId: "sdk-agent", render: () => <span data-testid="sdk-agent-panel" /> }
      ],
      subscribe: () => () => undefined,
      version: () => 1
    };
    const { container } = await renderDialog({
      pluginId: "sdk-agent",
      page: "config",
      plugins: [sdkAgentPlugin()],
      view: {
        siteRows: [
          siteRow({
            extensionId: "sdk-agent",
            name: "SDK Agent 来源",
            description: "SDK",
            actualState: "disabled",
            actualStateLabel: "已停用",
            providerManaged: false
          })
        ]
      },
      settingsPanels
    });
    expect(query(container, "sdk-agent-panel")).toBeNull();
    expect(query(container, "plugin-config-panel-inactive-sdk-agent")?.textContent).toContain("先用上方开关启用它");
  });

  it("弹窗里的启停与卡片是同一份权威状态", async () => {
    const { container, setSiteEnabled } = await renderDialog({
      pluginId: "ark-provider",
      settings: arkEntries(),
      plugins: [arkPlugin()],
      view: { siteRows: [siteRow({ desiredEnabled: true, actualState: "active", actualStateLabel: "运行中" })] }
    });
    expect(query(container, "plugin-config-inactive-ark-provider")).toBeNull();
    const control = query<HTMLButtonElement>(container, "plugin-config-switch-ark-provider")!;
    expect(control.getAttribute("aria-checked")).toBe("true");
    act(() => control.click());
    expect(setSiteEnabled).toHaveBeenCalledWith("ark-provider", false);
  });

  it("配置项按项保存，敏感项保存后清空", async () => {
    const write = vi.fn(async (values: Record<string, unknown>) => ({
      ok: true as const,
      snapshot: {
        settings: arkEntries().map((item) =>
          item.key === "providers.ark.apiKey" && "providers.ark.apiKey" in values
            ? { ...item, source: "secrets" as const, configured: true }
            : item
        ),
        plugins: [arkPlugin()],
        installedExtensions: [{ id: "ark-provider", label: "Ark", description: "", directory: "/plugins/ark-provider", writable: false }],
        files: { config: "c", secrets: "s" }
      }
    }));
    const { container } = await renderDialog({
      pluginId: "ark-provider",
      page: "config",
      settings: arkEntries(),
      plugins: [arkPlugin()],
      view: { siteRows: [siteRow({ desiredEnabled: true, actualState: "active", actualStateLabel: "运行中" })] },
      write
    });
    const input = query<HTMLInputElement>(container, "setting-input-providers.ark.apiKey")!;
    typeInto(input, "ark-secret");
    await act(async () => query<HTMLButtonElement>(container, "setting-save-providers.ark.apiKey")!.click());
    expect(write).toHaveBeenCalledWith({ "providers.ark.apiKey": "ark-secret" });
    expect(query<HTMLInputElement>(container, "setting-input-providers.ark.apiKey")!.value).toBe("");
  });

  it("列出该 Provider 提供的模型并可站点级启停", async () => {
    const { container, setModelEnabled } = await renderDialog({
      pluginId: "ark-provider",
      page: "models",
      settings: arkEntries(),
      plugins: [arkPlugin()],
      view: {
        siteRows: [siteRow({ desiredEnabled: true, actualState: "active", actualStateLabel: "运行中" })],
        modelRows: [
          modelRow(),
          modelRow({ modelKey: "ark/seedance-2.5", title: "Seedance 2.5", enabled: false, isDefault: false }),
          modelRow({ modelKey: "ark/legacy", title: "旧模型", executable: false })
        ]
      }
    });
    const models = query(container, "plugin-config-models-ark-provider")!;
    expect(models.textContent).toContain("Seedance 2.0");
    expect(models.textContent).toContain("默认");
    // 不可执行模型显式标注（原 Plugin Manager 面板用例迁入设置页弹窗）。
    expect(models.textContent).toContain("不可执行");
    const control = models.querySelector<HTMLButtonElement>('[data-testid="plugin-config-model-switch-ark/seedance-2.5"]')!;
    expect(control.getAttribute("aria-checked")).toBe("false");
    act(() => control.click());
    expect(setModelEnabled).toHaveBeenCalledWith("ark/seedance-2.5", true);
  });

  it("「服务端接入」的模型归到该插件卡片，并与其它 Provider 一样可启停", async () => {
    const remotePlugin: SettingPluginView = {
      id: "remote-server",
      label: "服务端接入",
      description: "接入远端 woohaa-server",
      layer: "extension",
      settingCount: 0,
      siteManaged: true,
      provider: false
    };
    const remoteModels = Array.from({ length: 78 }, (_, index) =>
      modelRow({
        modelKey: `remote-server:m${index}`,
        providerId: "remote-server",
        extensionId: "remote-server",
        title: `远端模型 ${index}`,
        modelType: "language",
        enabled: index === 0,
        isDefault: false
      })
    );
    const { container, setModelEnabled } = await renderDialog({
      pluginId: "remote-server",
      page: "models",
      plugins: [remotePlugin],
      view: { siteRows: [siteRow({ extensionId: "remote-server", name: "服务端接入", providerManaged: false, actualState: "active", actualStateLabel: "运行中", desiredEnabled: true })], modelRows: remoteModels }
    });
    expect(container.textContent).toContain("生成的模型");
    // 与 Provider 详情同一套：比例、批量与开关都在。
    const summary = query(container, "plugin-config-model-summary-remote-server")!.textContent ?? "";
    expect(summary).toContain("已启用");
    expect(summary).toContain("1");
    expect(query(container, "plugin-config-models-enable-all-remote-server")).not.toBeNull();
    expect(query(container, "plugin-config-models-disable-all-remote-server")).not.toBeNull();
    // 未启用的远端模型也能在详情里勾选（这就是「启用了才生效」的入口）。
    const control = container.querySelector<HTMLButtonElement>('[data-testid="plugin-config-model-switch-remote-server:m1"]')!;
    expect(control.getAttribute("aria-checked")).toBe("false");
    act(() => control.click());
    expect(setModelEnabled).toHaveBeenCalledWith("remote-server:m1", true);
  });

  it("Ark 的接入点按模型列在配置页：勾选后才出现输入框", async () => {
    const write = vi.fn(async () => ({ ok: true as const, snapshot: { settings: [], plugins: [arkPlugin()], installedExtensions: [{ id: "ark-provider", label: "Ark", description: "", directory: "/plugins/ark-provider", writable: false }], files: { config: "c", secrets: "s" } } }));
    const seedance = entry("providers.ark.ep.video.doubao-seedance-2-5-260628", {
      label: "Seedance 2.5",
      description: "doubao-seedance-2-5-260628",
      ownerExtensionId: "ark-provider"
    });
    const seedream = entry("providers.ark.ep.image.doubao-seedream-5-0-pro-260628", {
      label: "Seedream 5.0 Pro",
      description: "doubao-seedream-5-0-pro-260628",
      ownerExtensionId: "ark-provider",
      value: "ep-20260101000000-image",
      configured: true,
      source: "file"
    });
    const { container } = await renderDialog({
      pluginId: "ark-provider",
      page: "config",
      settings: [...arkEntries(), seedance, seedream],
      plugins: [arkPlugin()],
      view: { siteRows: [siteRow({ desiredEnabled: true, actualState: "active", actualStateLabel: "运行中" })] },
      write
    });
    expect(query(container, "setting-input-providers.ark.ep.video.doubao-seedance-2-5-260628")).toBeNull();
    expect(query(container, "ark-endpoint-input-doubao-seedance-2-5-260628")).toBeNull();
    expect(query<HTMLInputElement>(container, "ark-endpoint-input-doubao-seedream-5-0-pro-260628")!.value).toBe("ep-20260101000000-image");
    act(() => query<HTMLButtonElement>(container, "ark-endpoint-toggle-doubao-seedance-2-5-260628")!.click());
    const input = query<HTMLInputElement>(container, "ark-endpoint-input-doubao-seedance-2-5-260628")!;
    typeInto(input, "ep-20260101000000-video");
    await act(async () => query<HTMLButtonElement>(container, "ark-endpoint-save-doubao-seedance-2-5-260628")!.click());
    expect(write).toHaveBeenCalledWith({ "providers.ark.ep.video.doubao-seedance-2-5-260628": "ep-20260101000000-video" });
  });

  it("插件不在清单里时给提示而不是空白", async () => {
    const { container } = await renderDialog({ pluginId: "gone-provider" });
    expect(query(container, "plugin-config-missing")?.textContent).toContain("gone-provider");
    expect(container.querySelector('[data-testid^="plugin-config-entries-"]')).toBeNull();
  });
});
