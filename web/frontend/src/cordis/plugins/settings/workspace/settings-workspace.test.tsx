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

/** 受管任务控制器的稳定空状态（每次新建对象会让 useSyncExternalStore 无限重渲染）。 */
const MANAGED_STUB_STATE = { jobs: [], error: null, submitting: false, restart: { status: "idle", message: null }, unquarantining: [], riskPrompt: null };
/** 同理：待重开列表也必须是稳定引用。 */
const NO_PENDING_REOPEN: readonly string[] = [];

/** 最小的市场控制器：安装页只订阅它，测试不驱动真实网络。 */
const MARKETPLACE_STUB_STATE = {
  sources: [],
  sourceId: null,
  query: "",
  searching: false,
  refreshing: false,
  fetchedAt: null,
  items: [],
  unavailableReason: "本地模式下没有市场来源",
  selected: null,
  installing: false,
  installingId: null,
  trusting: null,
  error: null,
  notice: null
};
const MARKETPLACE_STUB = {
  getState: () => MARKETPLACE_STUB_STATE,
  subscribe: () => () => undefined,
  load: async () => undefined,
  refresh: async () => undefined,
  setSource: async () => undefined,
  search: async () => undefined,
  select: async () => undefined,
  chooseVersion: () => undefined,
  close: () => undefined,
  install: async () => undefined,
  installListed: async () => undefined,
  trustKey: async () => undefined
};

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
    /** 挂载受管安装能力（悬浮 + 需要它）；`marketplace` 决定 + 默认进市场还是文件。 */
    install?: { marketplace?: boolean; selectedLabel?: string };
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
  const closeDetail = vi.fn();
  // 详情状态必须是稳定引用：getSnapshot 每次新建对象会让 useSyncExternalStore 无限重渲染。
  const selectedMarketState = options.install?.selectedLabel
    ? {
        ...MARKETPLACE_STUB_STATE,
        selected: {
          extensionId: "photocraft",
          loading: false,
          version: "0.1.1",
          detail: {
            sourceId: "woohaa-server",
            extension: {
              extensionId: "photocraft",
              label: options.install.selectedLabel,
              versions: [{ version: "0.1.1", packageDigest: "sha256:a", size: 2048, keyId: "k1" }]
            },
            trustedKeyIds: [],
            signingKeys: []
          }
        }
      }
    : null;
  const managedStub = options.install
    ? ({
        controller: {
          // 稳定快照：每次返回新对象会让 useSyncExternalStore 无限重渲染。
          getState: () => MANAGED_STUB_STATE,
          subscribe: () => () => undefined,
          busy: () => false,
          installFile: async () => undefined,
          cancel: async () => undefined
        },
        pendingReopen: { get: () => NO_PENDING_REOPEN, subscribe: () => () => undefined },
        ...(options.install.marketplace
          ? {
              marketplace: options.install.selectedLabel
                ? {
                    ...MARKETPLACE_STUB,
                    getState: () => selectedMarketState!,
                    close: closeDetail
                  }
                : MARKETPLACE_STUB
            }
          : {})
      } as never)
    : undefined;
  await act(async () => {
    root.render(
      <SettingsWorkspace
        backend={backend}
        theme={new AppThemeService({ storage: null })}
        extensions={extensions.facade}
        onRequestClose={onRequestClose}
        onRequestNavigate={onRequestNavigate}
        // 本文件测的是上游工作区行为（核心服务页签、分区切换…），显式打开全部分区。
        // 四喜发行形态只显示其中两个，那是 `settings-sections-sixi.ts` 的事，另有单独断言。
        sections={["backend", "plugins", "appearance", "runtimes", "notifications", "about"]}
        // 本文件测工作区自身行为，插件列表也显式打开完整清单（样例数据里有 local-storage）。
        hiddenPluginIds={[]}
        // 安装入口在四喜发行版默认关闭；这些用例专测安装流，显式打开。
        allowExtensionInstall
        initialSection="backend"
        {...(managedStub ? { managed: managedStub } : {})}
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
    // 内部导航：同一实例（没有第二张弹窗），左栏换成插件列表（父级），右栏是概览。
    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "plugin", section: "plugins", pluginId: "ark-provider" });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(query(container, "settings-nav-backend")).toBeNull();
    expect(query(container, "plugin-rail-list")).not.toBeNull();
    expect(query(container, "plugin-config-ark-provider")).not.toBeNull();
    expect(query(container, "settings-breadcrumbs")?.textContent).toContain("插件配置");
    // 概览不直接摊开长表单：配置项在下一级的「配置」页。
    expect(container.querySelector('[data-setting-key="providers.ark.apiKey"]')).toBeNull();
    expect(query(container, "plugin-entry-config")).not.toBeNull();

    // 进入「配置」：左栏换成子页导航，右栏换成配置项，仍是一张弹窗。
    await act(async () => query<HTMLButtonElement>(container, "plugin-entry-config")!.click());
    expect(onRequestNavigate).toHaveBeenCalledWith({
      kind: "plugin-page",
      section: "plugins",
      pluginId: "ark-provider",
      page: "config"
    });
    expect(query(container, "plugin-page-nav-ark-provider")).not.toBeNull();
    expect(container.querySelector('[data-setting-key="providers.ark.apiKey"]')).not.toBeNull();

    // 返回插件列表：同一实例，左栏还是那份列表。
    await act(async () => query<HTMLButtonElement>(container, "plugin-page-back")!.click());
    expect(query(container, "plugin-rail-local-storage")).not.toBeNull();
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
    expect(query(container, "plugin-rail-list")).toBeNull();
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
describe("扩展层级导航", () => {
  const arkKey = () =>
    tokenEntry({
      key: "providers.ark.apiKey",
      label: "API Key",
      group: "Ark（火山方舟）",
      ownerExtensionId: "ark-provider"
    });
  const layered = () =>
    snapshotOf([arkKey()], [
      plugin("ark-provider", { label: "Ark（火山方舟）", configPrefix: "providers.ark", provider: true, siteManaged: true }),
      plugin("film-set", { label: "片场" })
    ]);
  const open = async (initial: { initialPluginId?: string } = {}) =>
    renderWorkspace({ fetchSnapshot: async () => ({ ok: true, snapshot: layered() }), write: async () => ({ ok: true, snapshot: layered() }) }, initial);

  it("进入插件后左栏换成插件列表，面包屑可跨级回到一级页", async () => {
    const { container } = await open();
    act(() => query<HTMLButtonElement>(container, "settings-nav-plugins")!.click());
    await act(async () => query<HTMLButtonElement>(container, "settings-plugin-open-ark-provider")!.click());

    // L2：分区导航让位给父级（插件列表），右栏是概览。
    expect(query(container, "settings-nav-plugins")).toBeNull();
    expect(query(container, "plugin-rail-list")).not.toBeNull();
    expect(query(container, "settings-breadcrumbs")?.textContent).toBe("设置插件配置Ark（火山方舟）");
    expect(query(container, "plugin-entry-config")).not.toBeNull();

    // 面包屑「插件配置」直接回到一级页。
    await act(async () => query<HTMLButtonElement>(container, "settings-crumb-1")!.click());
    expect(query(container, "settings-nav-plugins")).not.toBeNull();
    expect(query(container, "plugin-rail-list")).toBeNull();
  });

  it("子页之间只是同级切换：从「配置」回「概览」仍留在子页导航里", async () => {
    const { container, onRequestNavigate } = await open({ initialPluginId: "ark-provider" });
    expect(query(container, "plugin-rail-list")).not.toBeNull();

    await act(async () => query<HTMLButtonElement>(container, "plugin-entry-config")!.click());
    expect(query(container, "plugin-page-nav-ark-provider")).not.toBeNull();
    expect(query(container, "plugin-config-ark-provider")!.getAttribute("data-page")).toBe("config");
    expect(onRequestNavigate).toHaveBeenCalledWith({
      kind: "plugin-page",
      section: "plugins",
      pluginId: "ark-provider",
      page: "config"
    });

    // 概览也属于子页导航：左栏不退回插件列表。
    await act(async () => query<HTMLButtonElement>(container, "plugin-page-overview")!.click());
    expect(query(container, "plugin-page-nav-ark-provider")).not.toBeNull();
    expect(query(container, "plugin-rail-list")).toBeNull();
    expect(query(container, "plugin-config-ark-provider")!.getAttribute("data-page")).toBe("overview");

    // 返回上一级才回到插件列表。
    await act(async () => query<HTMLButtonElement>(container, "plugin-page-back")!.click());
    expect(query(container, "plugin-rail-list")).not.toBeNull();
  });

  it("左栏搜索过滤插件，并可直接切到另一个插件", async () => {
    const { container } = await open({ initialPluginId: "ark-provider" });
    const search = query<HTMLInputElement>(container, "plugin-rail-search")!;
    typeInto(search, "片场");
    expect(query(container, "plugin-rail-film-set")).not.toBeNull();
    expect(query(container, "plugin-rail-ark-provider")).toBeNull();

    await act(async () => query<HTMLButtonElement>(container, "plugin-rail-film-set")!.click());
    expect(query(container, "settings-breadcrumbs")?.textContent).toContain("片场");
    expect(query(container, "plugin-config-ark-provider")).toBeNull();
  });

  it("没有配置项的插件也能打开概览，并说明只需要启停", async () => {
    const { container } = await open({ initialPluginId: "film-set" });
    expect(query(container, "plugin-config-film-set")).not.toBeNull();
    expect(query(container, "plugin-entry-config")).toBeNull();
    expect(query(container, "plugin-config-film-set")?.textContent).toContain("只需要启停");
  });
});
describe("添加扩展页", () => {
  const withInstall = () => {
    const snapshot = {
      ...snapshotOf([arkKey()], [plugin("ark-provider", { label: "Ark（火山方舟）", configPrefix: "providers.ark", provider: true, siteManaged: true })]),
      extensionInstallations: { revision: 1, jobs: [], restartSupported: true }
    };
    return { fetchSnapshot: async () => ({ ok: true as const, snapshot }), write: async () => ({ ok: true as const, snapshot }) };
  };
  const arkKey = () => tokenEntry({ key: "providers.ark.apiKey", label: "API Key", group: "Ark（火山方舟）", ownerExtensionId: "ark-provider" });

  it("悬浮 + 进入「添加扩展」：左栏仍是插件列表，面包屑标出当前页", async () => {
    const { container, onRequestNavigate } = await renderWorkspace(withInstall(), { install: { marketplace: true } });
    act(() => query<HTMLButtonElement>(container, "settings-nav-plugins")!.click());
    await act(async () => query<HTMLButtonElement>(container, "plugin-install-open")!.click());

    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "install", section: "plugins", mode: "market" });
    expect(query(container, "plugin-install-page")).not.toBeNull();
    // 同一层级：左栏是插件列表（父级），不是分区导航。
    expect(query(container, "plugin-rail-list")).not.toBeNull();
    expect(query(container, "settings-nav-plugins")).toBeNull();
    expect(query(container, "settings-breadcrumbs")?.textContent).toBe("设置插件配置添加扩展");

    // 来源切换走同一门禁，仍停在安装页。
    await act(async () => {
      const fileTab = [...container.querySelectorAll('[data-testid="plugin-install-mode"] button')].find((button) =>
        button.textContent?.includes("从文件安装")
      ) as HTMLButtonElement | undefined;
      fileTab?.click();
    });
    expect(onRequestNavigate).toHaveBeenCalledWith({ kind: "install", section: "plugins", mode: "file" });
    expect(query(container, "plugin-install-page")!.getAttribute("data-mode")).toBe("file");

    // 返回：左栏的返回项回到插件列表。
    await act(async () => query<HTMLButtonElement>(container, "plugin-rail-back")!.click());
    expect(query(container, "plugin-settings")).not.toBeNull();
    expect(query(container, "plugin-install-page")).toBeNull();
  });
});
describe("添加扩展的详情层级", () => {
  const installSnapshot = () => {
    const snapshot = {
      ...snapshotOf([], [plugin("ark-provider", { label: "Ark（火山方舟）", configPrefix: "providers.ark", provider: true })]),
      extensionInstallations: { revision: 1, jobs: [], restartSupported: true }
    };
    return { fetchSnapshot: async () => ({ ok: true as const, snapshot }), write: async () => ({ ok: true as const, snapshot }) };
  };

  it("打开市场详情时面包屑多一段扩展名，「添加扩展」变成可点回列表", async () => {
    const { container } = await renderWorkspace(installSnapshot(), {
      install: { marketplace: true, selectedLabel: "PhotoCraft 图片编辑" }
    });
    act(() => query<HTMLButtonElement>(container, "settings-nav-plugins")!.click());
    await act(async () => query<HTMLButtonElement>(container, "plugin-install-open")!.click());

    // 详情是这一页的内容：面包屑带上扩展名，列表页头不再出现。
    expect(query(container, "settings-breadcrumbs")?.textContent).toBe("设置插件配置添加扩展PhotoCraft 图片编辑");
    expect(query(container, "plugin-install-page")!.getAttribute("data-view")).toBe("detail");
    expect(query(container, "plugin-install-mode")).toBeNull();
    expect(query(container, "settings-crumb-2")).not.toBeNull();
  });
});
