/**
 * 设置工作区（画布内弹窗内容）：三个分区、按项保存、插件详情内部导航与草稿/保存门禁。
 *
 * change: 2026-10-17-move-settings-into-canvas-dialog：
 * - 不再有整页/返回画布按钮；关闭与内部导航都是显式回调，由 Dialog Host guard 决定能否执行；
 * - 插件详情替换右栏（不再弹第二张大弹窗），返回列表保留同一实例。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApplicationExtensionStatus, SettingPluginView, SettingsEntryView, SettingsSnapshot } from "@woohaa3/contracts";
import { AppThemeService } from "../../../services/theme/service.js";
import { createExtensionManagerFacade } from "../../extension-manager/facade.js";
import { SettingsWorkspace } from "./settings-workspace.js";
import { createBackendSettingsStore, type BackendSettingsRemote } from "../backend-settings-store.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.clear();
  document.body.innerHTML = "";
});

// 组件测试的宿主项夹具：键名只用于覆盖 url / secret / 环境变量锁定这些行形态，
// 不代表宿主仍提供这些配置（静态同步已移除）。
const urlEntry = (overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
  key: "canvas.syncUpstream.url",
  kind: "url",
  label: "远端同步地址",
  description: "远端 Yjs 中继的 ws(s) 基址",
  protocols: ["ws:", "wss:"],
  reload: "hot",
  secret: false,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ...overrides
});
const tokenEntry = (overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
  key: "canvas.syncUpstream.token",
  kind: "string",
  label: "远端同步令牌",
  description: "远端中继的会话令牌",
  reload: "hot",
  secret: true,
  source: null,
  lockedBy: null,
  value: null,
  configured: false,
  pendingRestart: false,
  ...overrides
});
/** 任意宿主配置项的最小形状（服务页签按 key 的前缀归组）。 */
const hostEntry = (key: string, overrides: Partial<SettingsEntryView> = {}): SettingsEntryView => ({
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

const sitePluginStatus = (extensionId: string): ApplicationExtensionStatus => ({
  extensionId,
  desiredEnabled: true,
  actualState: "active",
  configVersion: 1,
  extensionRevision: 1,
  activeWorkCount: 0,
  diagnostics: []
});

const snapshotOf = (
  settings: SettingsEntryView[],
  plugins: SettingPluginView[] = [],
  extensionPoints?: SettingsSnapshot["extensionPoints"]
): SettingsSnapshot => ({
  settings,
  plugins,
  ...(extensionPoints ? { extensionPoints } : {}),
  installedExtensions: plugins
    .filter((entry) => entry.layer === "extension")
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      directory: `/plugins/${entry.id}`,
      writable: false
    })),
  files: { config: "/tmp/woohaa.config.yml", secrets: "/tmp/woohaa.secrets.yml" }
});

/** 最小的站点插件状态服务：卡片是否有启停开关由服务端行决定。 */
function siteStatus(plugins: ApplicationExtensionStatus[]) {
  const snapshot = { revision: 1, catalog: [], plugins, error: null, loading: false };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    refreshChanges: async () => undefined,
    writeConfig: async () => ({ ok: true as const, revision: 1, status: plugins[0]! }),
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined
  };
}

async function renderWorkspace(
  remote: BackendSettingsRemote,
  options: {
    onRequestNavigate?: (input: unknown) => Promise<boolean> | boolean;
    /** 站点插件行：扩展卡片是否有启停开关由它决定（服务端权威状态）。 */
    sitePlugins?: ApplicationExtensionStatus[];
    /** 初始直开某个插件详情（`settingsOpen.open({ pluginId })`）。 */
    initialPluginId?: string;
    /** 打开本机遥测复盘页；缺省不显示入口。 */
    onOpenTelemetry?: () => void;
  } = {}
) {
  const backend = createBackendSettingsStore(remote);
  const extensions = createExtensionManagerFacade({
    catalog: [],
    ids: [],
    assembled: {},
    refresh: () => undefined,
    site: {
      canManageSite: () => backend.canManage(),
      ...(options.sitePlugins ? { statusService: siteStatus(options.sitePlugins) as never } : {})
    }
  });
  const onRequestClose = vi.fn();
  const onRequestNavigate = vi.fn(options.onRequestNavigate ?? (() => true));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  await act(async () => {
    root.render(
      <SettingsWorkspace
        backend={backend}
        theme={new AppThemeService({ storage: null })}
        extensions={extensions.facade}
        onRequestClose={onRequestClose}
        onRequestNavigate={onRequestNavigate}
        {...(options.initialPluginId ? { initialPluginId: options.initialPluginId } : {})}
        {...(options.onOpenTelemetry ? { onOpenTelemetry: options.onOpenTelemetry } : {})}
      />
    );
  });
  return { container, backend, extensions, onRequestClose, onRequestNavigate };
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const query = <T extends Element>(container: Element, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as T | null;

describe("设置工作区", () => {
  it("弹窗内保留固定标题、左栏三个分区与单一关闭入口（无返回画布按钮）", async () => {
    const { container, onRequestClose } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) }),
      write: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) })
    });
    expect(query(container, "settings-nav-backend")).not.toBeNull();
    expect(query(container, "settings-nav-plugins")).not.toBeNull();
    expect(query(container, "settings-nav-appearance")).not.toBeNull();
    expect(query(container, "settings-back")).toBeNull();
    // 关闭按钮在固定 Header（共享 Dialog primitives 的 close 图标按钮）。
    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!;
    expect(close).not.toBeNull();
    act(() => close.click());
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it("读取核心服务配置并按项保存；敏感项保存后清空输入", async () => {
    const write = vi.fn(async (values: Record<string, unknown>) => ({
      ok: true as const,
      snapshot: snapshotOf([
        urlEntry("canvas.syncUpstream.url" in values ? { value: values["canvas.syncUpstream.url"] as string, source: "file", configured: true } : {}),
        tokenEntry("canvas.syncUpstream.token" in values ? { source: "secrets", configured: true } : {})
      ])
    }));
    const { container } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([urlEntry(), tokenEntry()]) }),
      write
    });
    expect(container.textContent).toContain("远端同步地址");
    expect(container.textContent).toContain("/tmp/woohaa.config.yml");

    const url = query<HTMLInputElement>(container, "setting-input-canvas.syncUpstream.url")!;
    const saveUrl = query<HTMLButtonElement>(container, "setting-save-canvas.syncUpstream.url")!;
    expect(saveUrl.disabled).toBe(true);
    typeInto(url, "ws://relay.local");
    expect(saveUrl.disabled).toBe(false);
    await act(async () => saveUrl.click());
    expect(write).toHaveBeenLastCalledWith({ "canvas.syncUpstream.url": "ws://relay.local" });
    expect(query(container, "setting-source-canvas.syncUpstream.url")?.textContent).toBe("配置文件");
    expect(query(container, "setting-clear-canvas.syncUpstream.url")).not.toBeNull();

    const token = query<HTMLInputElement>(container, "setting-input-canvas.syncUpstream.token")!;
    expect(token.type).toBe("password");
    expect(token.placeholder).toBe("未配置");
    typeInto(token, "alice");
    await act(async () => query<HTMLButtonElement>(container, "setting-save-canvas.syncUpstream.token")!.click());
    expect(write).toHaveBeenLastCalledWith({ "canvas.syncUpstream.token": "alice" });
    const tokenAfter = query<HTMLInputElement>(container, "setting-input-canvas.syncUpstream.token")!;
    expect(tokenAfter.value).toBe("");
    expect(tokenAfter.placeholder).toBe("已配置，输入以覆盖");
  });

  it("保存失败显示该项的问题；环境变量锁定的项只读", async () => {
    const { container } = await renderWorkspace({
      fetchSnapshot: async () => ({
        ok: true,
        snapshot: snapshotOf([urlEntry(), tokenEntry({ source: "env", lockedBy: "WOOHAA3_CANVAS_SYNC_UPSTREAM_TOKEN", configured: true })])
      }),
      write: async () => ({
        ok: false,
        code: "config-invalid",
        error: "canvas.syncUpstream.url：协议必须是 ws: / wss:",
        issues: [{ key: "canvas.syncUpstream.url", layer: "file", message: "协议必须是 ws: / wss:" }]
      })
    });
    expect(query(container, "setting-locked-canvas.syncUpstream.token")?.textContent).toContain("WOOHAA3_CANVAS_SYNC_UPSTREAM_TOKEN");
    expect(query<HTMLInputElement>(container, "setting-input-canvas.syncUpstream.token")!.disabled).toBe(true);
    expect(query(container, "setting-clear-canvas.syncUpstream.token")).toBeNull();

    typeInto(query<HTMLInputElement>(container, "setting-input-canvas.syncUpstream.url")!, "http://relay");
    await act(async () => query<HTMLButtonElement>(container, "setting-save-canvas.syncUpstream.url")!.click());
    expect(container.querySelector('[data-setting-key="canvas.syncUpstream.url"] [role="alert"]')?.textContent).toBe("协议必须是 ws: / wss:");
  });

  it("插件声明的配置项不在「核心服务」里；点卡片在右栏进入详情并保留同一实例", async () => {
    const arkKey = tokenEntry({ key: "providers.ark.apiKey", label: "API Key", group: "Ark（火山方舟）", ownerExtensionId: "ark-provider" });
    const arkUrl = urlEntry({ key: "providers.ark.videoCreateUrl", label: "视频任务创建地址", group: "Ark（火山方舟）", protocols: ["https:"], ownerExtensionId: "ark-provider" });
    const localRoot = tokenEntry({ key: "storage.local.root", label: "存储根目录", group: "本地存储", ownerExtensionId: "local-storage" });
    const arkPlugin = plugin("ark-provider", {
      label: "Ark（火山方舟）",
      description: "火山方舟视频生成 Provider",
      configPrefix: "providers.ark",
      provider: true,
      siteManaged: true
    });
    const snapshot = snapshotOf([arkKey, arkUrl, localRoot, urlEntry()], [
      plugin("local-storage", { label: "本地存储", configPrefix: "storage.local" }),
      arkPlugin
    ]);
    const { container, onRequestNavigate } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot }),
      write: async () => ({ ok: true, snapshot })
    });

    // 核心服务只留宿主项；插件的配置项不在页面上，也不在卡片里内联。
    expect(container.querySelector('[data-setting-key="canvas.syncUpstream.url"]')).not.toBeNull();
    expect(container.querySelector('[data-setting-key^="providers."]')).toBeNull();
    expect(container.querySelector('[data-setting-key="storage.local.root"]')).toBeNull();

    act(() => query<HTMLButtonElement>(container, "settings-nav-plugins")!.click());
    const ark = query(container, "settings-plugin-ark-provider")!;
    expect(ark.getAttribute("data-provider-id")).toBe("ark");
    expect(ark.textContent).toContain("Ark（火山方舟）");
    expect(ark.textContent).toContain("2 项配置");
    expect(ark.querySelector('[data-setting-key="providers.ark.apiKey"]')).toBeNull();

    await act(async () => query<HTMLButtonElement>(container, "settings-plugin-open-ark-provider")!.click());
    // 内部导航：右栏换成详情，同一实例（没有第二张弹窗/第二个 nav）。
    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "plugin", section: "plugins", pluginId: "ark-provider" });
    expect(container.querySelectorAll('[data-testid="settings-nav-backend"]')).toHaveLength(1);
    expect(query(container, "plugin-config-back")).not.toBeNull();
    expect(container.querySelector('[data-setting-key="providers.ark.apiKey"]')).not.toBeNull();

    // 返回列表：回到插件配置分区。
    await act(async () => query<HTMLButtonElement>(container, "plugin-config-back")!.click());
    expect(query(container, "settings-plugin-local-storage")).not.toBeNull();
    expect(container.querySelector('[data-setting-key="providers.ark.apiKey"]')).toBeNull();
  });

  it("内部导航被门禁拒绝时留在当前视图（dirty 确认由 Host guard 决定）", async () => {
    const snapshot = snapshotOf([], [plugin("ark-provider", { label: "Ark", configPrefix: "providers.ark", provider: true })]);
    const { container } = await renderWorkspace(
      { fetchSnapshot: async () => ({ ok: true, snapshot }), write: async () => ({ ok: true, snapshot }) },
      {
        onRequestNavigate: (input) => (input as { kind: string }).kind !== "plugin",
        sitePlugins: [sitePluginStatus("ark-provider")]
      }
    );
    act(() => query<HTMLButtonElement>(container, "settings-nav-plugins")!.click());
    // 没有任何可操作内容的节默认收起；先展开「扩展插件」。
    act(() => query<HTMLButtonElement>(container, "plugins-section-toggle-扩展插件")!.click());
    await act(async () => query<HTMLButtonElement>(container, "settings-plugin-open-ark-provider")!.click());
    // 门禁拒绝：仍在插件列表，不进入详情。
    expect(query(container, "settings-plugin-open-ark-provider")).not.toBeNull();
    expect(query(container, "plugin-config-back")).toBeNull();
  });

  it("未授权时提示需要管理员；核心服务与插件配置都不可写", async () => {
    const { container, extensions } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: false, code: "unauthorized", error: "需要管理员权限" }),
      write: async () => ({ ok: false, code: "unauthorized", error: "需要管理员权限" })
    });
    expect(query(container, "backend-settings-unauthorized")).not.toBeNull();
    act(() => query<HTMLButtonElement>(container, "settings-nav-plugins")!.click());
    expect(query(container, "plugins-settings-unauthorized")).not.toBeNull();
    expect(extensions.facade.getSnapshot().siteManageable).toBe(false);
  });

  it("分区切换、去插件配置与外观都在同一右栏内", async () => {
    const { container, backend, extensions } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) }),
      write: async () => ({ ok: false, code: "unavailable", error: "x" })
    });
    expect(backend.canManage()).toBe(true);
    extensions.notify();
    expect(extensions.facade.getSnapshot().siteManageable).toBe(true);

    act(() => query<HTMLButtonElement>(container, "settings-goto-plugins")!.click());
    expect(container.querySelector('[data-section="plugins"]')).not.toBeNull();
    expect(query(container, "plugins-settings-empty")).not.toBeNull();

    act(() => query<HTMLButtonElement>(container, "settings-nav-appearance")!.click());
    const themeControl = query<HTMLElement>(container, "settings-theme")!;
    expect(themeControl).not.toBeNull();
    expect(themeControl.textContent).toContain("浅色");
    expect(themeControl.textContent).toContain("暗色");
    expect(container.textContent).not.toContain("目前只内置了一套主题");

    act(() => query<HTMLButtonElement>(container, "settings-nav-backend")!.click());
    expect(container.querySelector('[data-section="backend"]')).not.toBeNull();
  });

  it("四个分区之一叫「核心服务」，页签只显示有配置的服务", async () => {
    const { container } = await renderWorkspace({
      fetchSnapshot: async () => ({
        ok: true,
        snapshot: snapshotOf([
          urlEntry(),
          hostEntry("storage.primary", { label: "主存储后端" }),
          hostEntry("telemetry.local.enabled", { kind: "boolean", label: "本机遥测记录" })
        ])
      }),
      write: async () => ({ ok: true, snapshot: snapshotOf([]) })
    });
    expect(query(container, "settings-nav-backend")!.textContent).toBe("核心服务");
    expect(container.querySelector(".settings-workbench__panel h2")?.textContent).toBe("核心服务");
    expect(query(container, "host-service-tabs")).not.toBeNull();
    expect(query(container, "host-service-tab-canvas")).not.toBeNull();
    expect(query(container, "host-service-tab-storage")).not.toBeNull();
    expect(query(container, "host-service-tab-telemetry")).not.toBeNull();
    // 没有宿主级配置的服务不出现页签，也不出现空态占位或迁移清单。
    expect(query(container, "host-service-tab-task")).toBeNull();
    expect(query(container, "host-service-tab-media")).toBeNull();
    expect(container.textContent).not.toContain("暂无可配置项");
    expect(container.textContent).not.toContain("计划迁入");
  });

  it("切换服务页签只显示该服务的配置，并经过统一的导航门禁", async () => {
    const { container, onRequestNavigate } = await renderWorkspace({
      fetchSnapshot: async () => ({
        ok: true,
        snapshot: snapshotOf([urlEntry(), hostEntry("storage.primary", { label: "主存储后端" })])
      }),
      write: async () => ({ ok: true, snapshot: snapshotOf([]) })
    });
    expect(container.querySelector('[data-setting-key="canvas.syncUpstream.url"]')).not.toBeNull();
    expect(container.querySelector('[data-setting-key="storage.primary"]')).toBeNull();

    act(() => query<HTMLButtonElement>(container, "host-service-tab-storage")!.click());
    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "service", section: "backend", serviceId: "storage" });
    expect(container.querySelector('[data-setting-key="storage.primary"]')).not.toBeNull();
    expect(container.querySelector('[data-setting-key="canvas.syncUpstream.url"]')).toBeNull();
    expect(query<HTMLButtonElement>(container, "host-service-tab-storage")!.getAttribute("aria-selected")).toBe("true");
  });

  it("门禁拒绝时停在原页签，不切换内容", async () => {
    const { container } = await renderWorkspace(
      {
        fetchSnapshot: async () => ({
          ok: true,
          snapshot: snapshotOf([urlEntry(), hostEntry("storage.primary", { label: "主存储后端" })])
        }),
        write: async () => ({ ok: true, snapshot: snapshotOf([]) })
      },
      { onRequestNavigate: (input) => (input as { kind: string }).kind !== "service" }
    );
    act(() => query<HTMLButtonElement>(container, "host-service-tab-storage")!.click());
    expect(container.querySelector('[data-setting-key="canvas.syncUpstream.url"]')).not.toBeNull();
    expect(container.querySelector('[data-setting-key="storage.primary"]')).toBeNull();
    expect(query<HTMLButtonElement>(container, "host-service-tab-canvas")!.getAttribute("aria-selected")).toBe("true");
  });

  it("有 Provider 插件时生成服务出现页签，并能直达 Provider 配置", async () => {
    const ark = plugin("ark-provider", {
      label: "Ark（火山方舟）",
      configPrefix: "providers.ark",
      provider: true,
      siteManaged: true
    });
    const { container, onRequestNavigate } = await renderWorkspace({
      fetchSnapshot: async () => ({
        ok: true,
        snapshot: snapshotOf([hostEntry("storage.primary", { label: "主存储后端" })], [ark])
      }),
      write: async () => ({ ok: true, snapshot: snapshotOf([]) })
    });
    // Generation 本身没有 YAML 配置，但 Provider 插件影响它，页签要出现。
    expect(query(container, "host-service-tab-generation")).not.toBeNull();
    act(() => query<HTMLButtonElement>(container, "host-service-tab-generation")!.click());
    expect(query(container, "generation-providers")).not.toBeNull();
    expect(query(container, "generation-provider-open-ark-provider")).not.toBeNull();
    await act(async () => query<HTMLButtonElement>(container, "generation-provider-open-ark-provider")!.click());
    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "plugin", section: "plugins", pluginId: "ark-provider" });
  });

  it("只有一个服务有配置时不渲染页签条", async () => {
    const { container } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) }),
      write: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) })
    });
    expect(query(container, "host-service-tabs")).toBeNull();
    expect(container.querySelector('[data-setting-key="canvas.syncUpstream.url"]')).not.toBeNull();
  });

  it("没有任何宿主配置时显示空态，而不是空页签", async () => {
    const pluginKey = hostEntry("providers.ark.apiKey", { label: "API Key", ownerExtensionId: "ark-provider" });
    const { container } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([pluginKey]) }),
      write: async () => ({ ok: true, snapshot: snapshotOf([pluginKey]) })
    });
    expect(query(container, "backend-settings-empty")).not.toBeNull();
    expect(query(container, "host-service-tabs")).toBeNull();
  });

  it("存储扩展点把输入变成可选后端，并给出直达提供者插件配置的入口", async () => {
    const cosPlugin = plugin("cos-storage", { label: "COS / S3 对象存储", configPrefix: "storage.cos" });
    const snapshot = snapshotOf(
      [
        hostEntry("storage.primary", { label: "主存储后端", value: "cos", source: "file" }),
        hostEntry("storage.expose", { label: "对外存储后端", value: "" })
      ],
      [cosPlugin],
      { storage: [{ id: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage" }] }
    );
    const { container, onRequestNavigate } = await renderWorkspace({
      fetchSnapshot: async () => ({ ok: true, snapshot }),
      write: async () => ({ ok: true, snapshot })
    });

    // 不再是可以手写任意 id 的自由文本；当前值以提供者显示名呈现。
    expect(query(container, "setting-input-storage.primary")).toBeNull();
    const select = query<HTMLSelectElement>(container, "setting-select-storage.primary")!;
    expect(select.value).toBe("cos");
    expect([...select.options].map((option) => option.textContent)).toContain("COS / S3 对象存储");
    expect([...select.options].map((option) => option.value)).toEqual(["cos"]);

    // 关联插件带真实状态，点击直接进入该插件详情（同一设置实例）。
    const related = query(container, "setting-related-storage.primary");
    expect(related?.textContent).toContain("COS / S3 对象存储");
    expect(related?.textContent).toContain("随宿主运行");
    await act(async () => query<HTMLButtonElement>(container, "setting-related-open-storage.primary")!.click());
    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "plugin", section: "plugins", pluginId: "cos-storage" });
  });

  it("复盘入口跟着遥测配置落在遥测页签", async () => {
    const onOpenTelemetry = vi.fn();
    const { container } = await renderWorkspace(
      {
        fetchSnapshot: async () => ({
          ok: true,
          snapshot: snapshotOf([urlEntry(), hostEntry("telemetry.local.enabled", { kind: "boolean", label: "本机遥测记录" })])
        }),
        write: async () => ({ ok: true, snapshot: snapshotOf([]) })
      },
      { onOpenTelemetry }
    );
    expect(query(container, "open-telemetry-review")).toBeNull();
    act(() => query<HTMLButtonElement>(container, "host-service-tab-telemetry")!.click());
    expect(query(container, "open-telemetry-review")).not.toBeNull();
  });
});

describe("初始直开插件详情", () => {
  it("给了 initialPluginId 时直接停在插件详情，而不是先让用户去列表里找", async () => {
    const plugin: SettingPluginView = {
      id: "remote-server",
      label: "服务端接入",
      description: "接入远端 woohaa-server",
      layer: "extension",
      configPrefix: "remote-server",
      settingCount: 0,
      provider: false,
      siteManaged: true
    };
    const { container } = await renderWorkspace(
      {
        fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()], [plugin]) }),
        write: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()], [plugin]) })
      },
      { initialPluginId: "remote-server" }
    );
    // 详情视图的稳定标记是 `plugin-config-<pluginId>`；分区视图没有它。
    expect(query(container, "plugin-config-remote-server")).not.toBeNull();
  });

  it("插件不存在时仍显示插件列表，不报错也不卡在半截视图", async () => {
    const { container } = await renderWorkspace(
      {
        fetchSnapshot: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) }),
        write: async () => ({ ok: true, snapshot: snapshotOf([urlEntry()]) })
      },
      { initialPluginId: "not-installed" }
    );
    // 落到「插件不存在」的稳定提示，而不是空详情或崩溃。
    expect(query(container, "plugin-config-missing")).not.toBeNull();
  });
});
