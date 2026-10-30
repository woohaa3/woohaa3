/**
 * Page scope 运行时
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 2.1/2.2/2.5 / design D1；
 *   change: 2026-09-29-add-multi-canvas-workspace，任务 3.1–3.5 / design D1、D3；
 *   change: 2026-10-12-build-and-load-extensions-independently，任务 5.1–5.3 / design D6/D8：
 *   Canvas 启动先读发布目录纯 metadata 与一次本地选择，再**只**加载 always/本地已选入口；
 *   server-active 只登记不提前请求；每个异步边界检查 page generation 与退出信号）。
 *
 * App scope 启动后，为当前 location 创建至多一个页面 scope；切换先释放 outgoing 再挂载
 * incoming。Canvas page 的 scope identity **包含 `canvasId`**：同一 Canvas 页面内 ID 变化
 * 同样执行完整 scope transition。
 *
 * 快速连续切换由 transition generation 隔离：过期的异步启动结果在发布前立即 dispose，
 * 绝不覆盖较新的 location。缺省 canvasId 由纯解析器确定性解析为可打开画布。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import type { ApplicationExtensionFrontendAsyncEntry, ExtensionLoadDiagnostic } from "@woohaa3/contracts";
import { startFrontendRuntime, startFrontendScope, type FrontendExtensionDefinition, type FrontendRuntime } from "./kernel.js";
import {
  installAppServices,
  installTaskMonitorServices,
  installCanvasPageServices,
  installCanvasPreparationServices,
  installCanvasRecoveryServices,
  installCanvasShellSettingsServices,
  installTaskHistoryServices,
  installTelemetryPageServices
} from "./install-services.js";
import { createCanvasShellSettingsPlugin } from "./page-scope-canvas.js";
import {
  createCanvasExtensionManifest,
  createTaskHistoryExtensionManifest,
  createTelemetryExtensionManifest,
  canvasExtensionCatalogMetadata,
  resolveConfigurableOptionalIds
} from "./manifest.js";
import { isAssembledAtStartup } from "./services/extension-preferences/selector.js";
import { ExtensionPreferenceStore } from "./services/extension-preferences/store.js";
import {
  defaultLegacyStorage,
  migrateLegacyPreferences,
  persistFrontendExtension,
  readFrontendExtensionPreferences,
  watchFrontendExtensionPreferences
} from "./services/extension-preferences/config-source.js";
import { beginStartupSpan } from "./services/telemetry-primitives.js";
import type { PreferenceStorage } from "./services/extension-preferences/codec.js";
import { AppRouterStore, type AppHistoryAdapter } from "./navigation/app-router-store.js";
import { resolveCanvasLocation } from "./canvas-location.js";
import { attachOpenedNodeTarget } from "./navigation/node-target.js";
import type { AppPageLocation, AppPageScopeStatus } from "./navigation/app-router.js";
import type { CanvasCatalogRemote, CanvasCatalogService, CanvasSelectionService } from "./contract/canvas-catalog.js";
import type { CanvasPreparationRemote, CanvasPreparationService } from "./contract/canvas-preparation.js";
import type { CanvasExtensionMetadata } from "./plugins/extension-manager/contract.js";
import { createExtensionRuntimeService, type ExtensionRuntimeService } from "./extension-runtime/service.js";
import { extensionDefaultPreferences, resolveExtensionStartupSelection } from "./extension-runtime/selection.js";
import { installAppHostConnectivity, type AppConnectivityOptions, type AppConnectivityRuntime } from "./app-host-connectivity.js";
import { browserHistory, subscribePreparationReady } from "./page-scope-helpers.js";
import { createSettingsRemote, type SettingsRemote } from "./services/settings-remote.js";

/** App 运行时快照：页面、location 与兼容设置意图的诊断必须原子发布。 */
export type AppRuntimeSnapshot = {
  page: FrontendRuntime | null;
  location: AppPageLocation | null;
  /** 旧 `/settings` 兼容打开失败的安全文案；无错误为 null。 */
  settingsError: string | null;
};

export type AppRuntime = AppConnectivityRuntime & {
  /** App scope runtime（Theme/Dialog/Slots/Router/Catalog）。 */
  app: FrontendRuntime;
  router: AppRouterStore;
  /** 当前页面 scope runtime；切换期间为 null。 */
  currentPage(): FrontendRuntime | null;
  /**
   * 旧 `/settings` 兼容打开失败的安全诊断；无错误为 null
   * （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）。
   */
  settingsIntentError(): string | null;
  /**
   * 显式重试一次兼容打开（**不**自动重试）：仅在当前 Canvas 壳仍有效时重新消费一次意图。
   * 成功即清空错误；失败保留新的安全文案。
   */
  retrySettingsIntent(): Promise<void>;
  /**
   * 与 `currentPage()` 同时发布的 location（原子快照）。React Host 必须在同一次
   * `useSyncExternalStore` 中读取二者，避免用新 location 渲染旧 scope。未变更时返回同一引用。
   */
  getSnapshot(): AppRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  /** 处理一次 location 变化（popstate/navigate）。 */
  applyLocation(location: AppPageLocation): Promise<void>;
  dispose(): Promise<void>;
};

export type StartAppOptions = AppConnectivityOptions & {
  /** 初始 pathname（测试注入）。 */
  initialPathname?: string;
  initialSearch?: string;
  /** 画布目录 remote（测试注入）。 */
  canvasCatalogRemote?: CanvasCatalogRemote;
  /** 画布目录 service（测试注入）。 */
  canvasCatalog?: CanvasCatalogService;
  /** 首次打开准备 remote（测试注入）。 */
  canvasPreparationRemote?: CanvasPreparationRemote;
  /** 首次打开准备 service（测试注入）。 */
  canvasPreparation?: CanvasPreparationService;
  /** 最近画布选择 service（测试注入）。 */
  canvasSelection?: CanvasSelectionService;
  /** History 适配（测试注入；缺省用 globalThis.history）。 */
  history?: AppHistoryAdapter;
  /**
   * 旧版浏览器偏好的读取介质：**只用于一次性迁移**到宿主配置文件。
   * 传 null 表示跳过迁移；缺省读 globalThis.localStorage。
   */
  extensionPreferenceStorage?: PreferenceStorage | null;
  /**
   * 宿主设置 API 客户端（测试注入；缺省按同源路径创建）。
   * 插件启停的读取与写入都走它，配置落在宿主配置文件里。
   */
  settingsRemote?: SettingsRemote;
  /** 测试注入的刷新适配（传递到 Plugin Manager；缺省页面 reload）。 */
  extensionManagerReload?: () => void;
  /**
   * Extension 运行时服务（测试注入；缺省按发布 HTML link 加载 `@woohaa3/contracts` catalog）。
   * change: 2026-10-12-build-and-load-extensions-independently，design D6/D7。
   */
  extensionRuntime?: ExtensionRuntimeService;
  /**
   * 启动取消信号：HMR/teardown/beforeunload 在 `startApp` 返回前 abort 尚未完成的启动。
   * abort 后清理 App scope 与已创建 Fiber，旧 startup rejection 不覆盖新 root。
   */
  signal?: AbortSignal;
};

/** Canvas page 的解析结果：ready（含 canvasId）、preparing（旧 ID 迁移中）或 unresolved（恢复页）。 */
type ResolvedPage =
  | { kind: "ready"; canvasId: string }
  | { kind: "preparing"; canvasId: string; jobId: string | null }
  | { kind: "unresolved"; code: string; error: string };

/** 业务 extension 的展示元数据投影（纯数据；不含实现）。 */
function extensionCatalogMetadata(metadata: readonly import("@woohaa3/contracts").ExtensionFrontendMetadata[]): CanvasExtensionMetadata[] {
  return metadata.map((entry) => ({
    id: entry.extensionId,
    name: entry.label,
    description: entry.description,
    ...(entry.directory ? { directory: entry.directory } : {}),
    required: entry.required,
    configurable: entry.configScope === "browser-local" && !entry.required,
    ...(entry.defaultEnabled !== undefined ? { defaultEnabled: entry.defaultEnabled } : {}),
    ...(entry.icon ? { icon: entry.icon } : {})
  }));
}

/**
 * 启动 App scope 与当前页面 scope。
 *
 * App scope 只拥有跨页面能力；Canvas 页面才创建 remote/session/runtime/plugins。
 */
export async function startApp(options: StartAppOptions = {}): Promise<AppRuntime> {
  // 启动阶段埋点（change: 2026-10-25-enhance-telemetry-performance-collection，task 3.4）。
  // 计时器是零依赖原语：构建模式缺失时整体 no-op，不改变启动路径。
  const finishAppScope = beginStartupSpan("app-scope");
  const history = options.history ?? browserHistory();
  const runtimeService = options.extensionRuntime ?? createExtensionRuntimeService();
  const app = await startFrontendRuntime({
    installPlatform: (ctx) => {
      installAppServices(ctx, {
        ...(options.initialPathname !== undefined ? { initialPathname: options.initialPathname } : {}),
        ...(options.initialSearch !== undefined ? { initialSearch: options.initialSearch } : {}),
        ...(options.canvasCatalogRemote ? { canvasCatalogRemote: options.canvasCatalogRemote } : {}),
        ...(options.canvasCatalog ? { canvasCatalog: options.canvasCatalog } : {}),
        ...(options.canvasPreparationRemote ? { canvasPreparationRemote: options.canvasPreparationRemote } : {}),
        ...(options.canvasPreparation ? { canvasPreparation: options.canvasPreparation } : {}),
        ...(options.canvasSelection ? { canvasSelection: options.canvasSelection } : {}),
        ...(history ? { history } : {})
      });
    },
    plugins: []
  });

  finishAppScope();
  const router = app.ctx.appRouter as AppRouterStore;
  const connectivity = installAppHostConnectivity({ appCtx: app.ctx, runtime: runtimeService, ...(options.hostProbe ? { probe: options.hostProbe } : {}) });
  const catalog = app.ctx.canvasCatalog;
  const selection = app.ctx.canvasSelection;
  const preparation = app.ctx.canvasPreparation;
  const listeners = new Set<() => void>();
  // page + 其对应 location 必须作为**原子快照**发布：React 一次 render 可能读到
  // `currentPage()` 与 `router.getLocation()` 两个独立来源，若二者不同步，就会用新的
  // canvasId 去渲染旧 scope（旧 scope 没有对应 service → 运行时 TypeError）。
  let page: FrontendRuntime | null = null;
  let pageLocation: AppPageLocation | null = null;
  let settingsError: string | null = null;
  let snapshot: AppRuntimeSnapshot = {
    page: null,
    location: null,
    settingsError: null
  };
  let transitionGeneration = 0;
  const inFlight = new Set<Promise<FrontendRuntime>>();
  /** 兼容 `/settings` 打开失败时的安全诊断（不自动重试，交给用户显式操作）。 */
  const settingsIntentError = () => settingsError;
  /** 迁移准备态 watcher：切换到新 location 时释放（不残留订阅）。 */
  let preparationWatcher: (() => void) | null = null;
  /**
   * 打开的 Canvas 页面携带的 `nodeId` 目标（任务监控/任务历史跳转）；
   * 页面级一次性消费，换画布/离开画布时释放，不写入 presentation 或规范数据。
   */
  let nodeTargetDispose: (() => void) | null = null;
  const startedAt = options.signal?.aborted ?? false;
  if (startedAt) {
    await app.dispose();
    runtimeService.dispose();
    throw new DOMException("启动已取消", "AbortError");
  }

  const publish = () => {
    snapshot = { page, location: pageLocation, settingsError };
    for (const listener of listeners) listener();
  };
  /** 兼容意图诊断：只在变化时发布，避免重复通知（也不构成自动重试）。 */
  const setSettingsError = (message: string | null) => {
    if (settingsError === message) return;
    settingsError = message;
    publish();
  };
  const isAborted = () => options.signal?.aborted === true;

  /**
   * Canvas page scope：只从启动期发布目录加载扩展；browser-local optional 按浏览器本地偏好装配，
   * server-active 入口先登记，再跟随后端实际就绪状态装载。
   */
  const startCanvasPageScope = async (canvasId: string): Promise<FrontendRuntime> => {
    // 1. 获取并固定发布目录（App 级缓存；缺失视为无扩展能力，不禁用核心）。
    const release = await runtimeService.ensureCatalog();
    const metadata = release?.entries.map((entry) => entry.metadata) ?? [];
    const runtimeCatalogIds = release?.browserLocalIds() ?? [];
    const configurableIds = resolveConfigurableOptionalIds(runtimeCatalogIds);
    const catalogMetadata = canvasExtensionCatalogMetadata(extensionCatalogMetadata(metadata));

    // 2. 目标状态来自宿主配置文件（`extensions.frontend.<id>.enabled`）：与 provider 参数同层同格式，
    //    前端只投影、不自持 localStorage。启动前先读一次权威配置；读取失败按全部启用继续启动
    //    （缺配置不该拦住画布，面板会显示持久化不可用）。
    // 配置来源：宿主设置 API（独立 remote 实例，不依赖 scope 内服务装配顺序）。
    const settingsRemote = options.settingsRemote ?? createSettingsRemote();
    const initialPreferences = await readFrontendExtensionPreferences(settingsRemote);
    const defaults = extensionDefaultPreferences(metadata);
    const preferenceStore = new ExtensionPreferenceStore({
      ids: configurableIds,
      defaults,
      ...(initialPreferences.ok ? { desired: initialPreferences.preferences } : {}),
      persist: persistFrontendExtension(settingsRemote)
    });
    // 读取失败不阻断启动：这时按各插件开箱默认装配，面板据此显示持久化不可用。
    if (options.extensionPreferenceStorage !== null) {
      void migrateLegacyPreferences({
        remote: settingsRemote,
        storage: options.extensionPreferenceStorage ?? defaultLegacyStorage(),
        ids: configurableIds,
        current: preferenceStore.getSnapshot().preferences
      }).then((outcome) => {
        if (outcome.migrated.length > 0) {
          // 迁移写回宿主机配置文件后，以宿主快照为准重新投影。
          void readFrontendExtensionPreferences(settingsRemote).then((result) => {
            if (result.ok) preferenceStore.applyDesired(result.preferences);
          });
        }
        return undefined;
      });
    }
    const desired = preferenceStore.getSnapshot().preferences;
    const selectionResult = resolveExtensionStartupSelection({ metadata, desired });
    // 内置 optional（node-history）沿用既有 selector 语义。
    const builtinAssembled: Record<string, boolean> = {};
    for (const entry of catalogMetadata) {
      if (!entry.configurable) continue;
      builtinAssembled[entry.id] = desired[entry.id] ?? entry.defaultEnabled ?? true;
    }

    // 3. 只加载 always + 已启用 browser-local optional；required 失败即 page 失败，optional 失败隔离。
    const loadedDefinitions: FrontendExtensionDefinition[] = [];
    const loadDiagnostics: ExtensionLoadDiagnostic[] = [];
    const loadResults = await Promise.all(
      selectionResult.load.map(async (entry) => {
        try {
          const descriptor = await runtimeService.loadDescriptor(entry.extensionId);
          return { entry, descriptor, error: null as Error | null };
        } catch (error) {
          return { entry, descriptor: null, error: error instanceof Error ? error : new Error(String(error)) };
        }
      })
    );
    for (const result of loadResults) {
      if (result.descriptor) {
        loadedDefinitions.push({
          id: result.entry.extensionId,
          required: result.entry.required,
          configurable: result.entry.configScope === "browser-local",
          name: result.entry.label,
          description: result.entry.description,
          plugin: result.descriptor.plugin() as Plugin,
          extension: true,
          // 重装时先刷新本条目再求值，取到的是宿主当前产物（change: 2026-10-27-add-extension-dev-reload）。
          resolvePlugin: async () => {
            await runtimeService.refreshEntry(result.entry.extensionId);
            return (await runtimeService.loadDescriptor(result.entry.extensionId)).plugin() as Plugin;
          }
        });
      } else if (result.entry.required) {
        // required 资源加载失败：进入稳定 page error，不挂载半可用画布。
        throw new Error(`required extension "${result.entry.extensionId}" 资源加载失败：${result.error?.message ?? "未知错误"}`);
      } else {
        loadDiagnostics.push({
          extensionId: result.entry.extensionId,
          status: "load-failed",
          artifactId: null,
          releaseId: release?.releaseId ?? null,
          errorCode: "network",
          // 真实原因优先：设置面「启动失败」要靠它说明为什么，而不是再让人猜。
          message: result.error?.message ?? "功能加载失败，请重试"
        });
      }
    }

    // 4. server-active 只登记 metadata（由 reconciler 按服务端状态驱动加载）。
    const serverActiveEntries: ApplicationExtensionFrontendAsyncEntry[] = selectionResult.registered.map((entry) => ({
      metadata: entry,
      async loadDescriptor() {
        return runtimeService.loadDescriptor(entry.extensionId);
      }
    }));

    // 可选入口加载失败必须在管理面板显示「启动失败」，不能沿用目标启用显示为「已启用」。
    const failedOptionalIds = new Set(loadDiagnostics.map((diagnostic) => diagnostic.extensionId));
    const optionalFailures: Record<string, string> = {};
    for (const diagnostic of loadDiagnostics) optionalFailures[diagnostic.extensionId] = diagnostic.message ?? "加载失败";

    // 启动时**实际装配**的集合：目标状态 + 加载成功与否。这是 runtime 就绪前的回退值。
    // 启动时**实际**装配的集合：目标启用、且（发布目录扩展）实现加载成功。
    // `selectionResult.assembled` 是「目标」（被禁用时同样是 false），不能直接当实际状态用；
    // 宿主内置 optional（如 node-history）不在 `loadedDefinitions` 里，用 `builtinAssembled`。
    const loadedIdSet = new Set(loadedDefinitions.map((definition) => definition.id));
    const assembledAtStartup: Record<string, boolean> = { ...builtinAssembled };
    for (const id of configurableIds) {
      if (builtinAssembled[id] !== undefined) continue;
      assembledAtStartup[id] = (selectionResult.assembled[id] ?? false) && loadedIdSet.has(id);
    }

    // 面板要读**当前**装配状态：热插拔后 runtime.plugins 才知道真相，用启动快照会一直显示
    // 「待启用/待停用」（进而提示「重启后生效」，而那条语义已经不存在了）。
    let liveRuntime: FrontendRuntime | null = null;
    const assembledNow = (): Readonly<Record<string, boolean>> => {
      // runtime 就绪后以它为准（热插拔的真相）；之前用启动时的实际装配结果。
      if (!liveRuntime?.plugins) return assembledAtStartup;
      const result: Record<string, boolean> = {};
      for (const id of configurableIds) result[id] = liveRuntime.plugins.has(id);
      return result;
    };

    const manifest = createCanvasExtensionManifest({
      canvasId,
      catalogMetadata,
      configurableOptionalIds: configurableIds,
      extensions: loadedDefinitions,
      extensionManager: {
        assembled: assembledNow,
        failed: failedOptionalIds,
        failures: optionalFailures,
        catalog: catalogMetadata,
        ids: configurableIds,
        preferenceStore,
        ...(options.extensionManagerReload ? { reload: options.extensionManagerReload } : {})
      }
    });
    const assembled = assembledAtStartup;
    const plugins = manifest.filter((definition) => isAssembledAtStartup(definition, assembled));
    const disabled = Object.entries(assembled)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => ({ id, reason: "未启用该可选插件" }));

    const runtime = await startFrontendScope(app.ctx, {
      install: async (ctx) => {
        await installCanvasPageServices(ctx, {
          canvasId,
          extensionRuntime: runtimeService,
          serverActiveEntries,
          loadDiagnostics
        });
      },
      plugins,
      disabled,
      isolate: [
        "canvasRemote",
        "taskRemote",
        "applicationRemote",
        "mediaRemote",
        "canvasSession",
        "canvasScope",
        "canvasState",
        "inputScopes",
        "taskCatalog",
        "selection",
        "parameterPreview",
        "modelInteractions",
        "canvasNavigation",
        "agentConversationService",
        "canvasGroupRuns",
        "mediaContent",
        "settingsOpen", "extensionReload"
      ]
    });
    // 面板从此刻起读实时装配状态（见上面的 assembledNow）。
    liveRuntime = runtime;
    // 配置热生效：宿主配置文件里 `extensions.<id>.enabled` 变了，就装回或卸下对应 fiber，
    // 不重建页面 scope（旧行为是「下次启动生效」）。
    // 可换表覆盖**全部** configurable optional：包含宿主内置（如 node-history）与发布目录扩展。
    // 清单里被过滤掉的定义也保留，才能在配置改回启用时热装回来。
    const swappableById = new Map<string, FrontendExtensionDefinition>();
    for (const definition of manifest) {
      if (definition.required) continue;
      if (!configurableIds.includes(definition.id)) continue;
      swappableById.set(definition.id, { ...definition });
    }
    // 启动时被禁用、从未加载过实现的发布目录扩展：按 metadata 补一个占位定义，
    // 首次启用时再取 artifact。
    for (const entry of catalogMetadata) {
      if (!entry.configurable || entry.required) continue;
      if (swappableById.has(entry.id)) continue;
      swappableById.set(entry.id, {
        id: entry.id,
        required: false,
        configurable: true,
        name: entry.name,
        description: entry.description,
        // 占位：真正启用时用 descriptor.plugin() 替换。
        plugin: (() => undefined) as unknown as Plugin,
        extension: true
      });
    }
    const loadedIds = new Set(loadedDefinitions.map((definition) => definition.id));
    const applyPreferences = async (): Promise<void> => {
      const snapshot = preferenceStore.getSnapshot().preferences;
      for (const [id, definition] of swappableById) {
        const shouldRun = snapshot[id] ?? true;
        const running = runtime.plugins?.has(id) ?? false;
        if (shouldRun && !running) {
          // 启动时被禁用、从未加载过实现：现在才取 artifact。
          // 只有**发布目录**扩展需要现取 artifact；宿主内置插件（如 node-history）
          // 的定义自带 plugin 工厂，不在 loadedDefinitions 里也不该去 loadDescriptor。
          if (!loadedIds.has(id) && definition.extension) {
            try {
              const descriptor = await runtimeService.loadDescriptor(id);
              definition.plugin = descriptor.plugin() as Plugin;
              loadedIds.add(id);
            } catch {
              // 加载失败保持未装配；下一次配置变化或重开页面会再试。
              continue;
            }
          }
          runtime.plugins?.enable(definition);
        } else if (!shouldRun && running) {
          await runtime.plugins?.disable(id);
        }
      }
    };
    // 两个触发源：面板写入（store 自身变化，立即生效）与配置文件被外部编辑（轮询宿主快照）。
    // 面板快照由 facade 自己订阅 store 重建，所以这里不必额外通知。
    const unsubscribeStore = preferenceStore.subscribe(() => void applyPreferences());
    const unsubscribeConfig = watchFrontendExtensionPreferences(settingsRemote, (preferences) => {
      preferenceStore.applyDesired(preferences);
    });
    const disposeRuntime = runtime.dispose;
    return {
      ...runtime,
      async dispose() {
        unsubscribeStore();
        unsubscribeConfig();
        await disposeRuntime();
        preferenceStore.dispose();
      }
    };
  };

  /**
   * 画布页 scope 的启动阶段（只有真正进入画布才算；复盘/历史页不产生这条事实，
   * 否则"画布启动耗时"会被不相干的页面启动样本污染）。
   */
  const startCanvasPage = async (canvasId: string): Promise<FrontendRuntime> => {
    const finishCanvasScope = beginStartupSpan("canvas-scope");
    try {
      return await startCanvasPageScope(canvasId);
    } finally {
      finishCanvasScope();
    }
  };

  const startPage = (location: AppPageLocation, resolved: ResolvedPage): Promise<FrontendRuntime> => {
    if (location.page === "task-monitor") {
      return startFrontendScope(app.ctx, {
        install: (ctx) => installTaskMonitorServices(ctx),
        plugins: [],
        isolate: ["applicationRemote", "mediaRemote"]
      });
    }
    if (location.page === "telemetry") {
      // 本机遥测复盘页：只装应用传输（同源取数），不创建任何画布资源。
      // change: 2026-10-20-add-local-client-telemetry，design D9。
      return startFrontendScope(app.ctx, {
        install: (ctx) => installTelemetryPageServices(ctx),
        plugins: createTelemetryExtensionManifest(),
        isolate: ["applicationRemote"]
      });
    }
    if (location.page === "task-history") {
      // Task History 冷启动不请求任何 Canvas extension JS/CSS 或 SDK 分组。
      return startFrontendScope(app.ctx, {
        install: (ctx) => {
          installTaskHistoryServices(ctx, {});
        },
        plugins: createTaskHistoryExtensionManifest(),
        isolate: ["taskRemote", "mediaRemote"]
      });
    }
    if (resolved.kind === "unresolved") {
      // 恢复页仍装配设置能力：渲染失败/找不到画布时保留配置恢复入口
      // （change: 2026-10-17-move-settings-into-canvas-dialog，design D1）。
      return startFrontendScope(app.ctx, {
        install: (ctx) => {
          installCanvasRecoveryServices(ctx, {
            canvasId: location.canvasId ?? null,
            code: resolved.code,
            error: resolved.error
          });
          installCanvasShellSettingsServices(ctx, {});
        },
        plugins: [createCanvasShellSettingsPlugin()],
        isolate: [
          "applicationRemote", "settingsRemote",
          "applicationExtensionStatus",
          "generationModelsStatus",
          "settingsOpen"
        ]
      });
    }
    if (resolved.kind === "preparing") {
      // 旧 ID 迁移中：准备态页面（不创建 Session/socket/Bevy）；ready 后由 watcher 重解析。
      return startFrontendScope(app.ctx, {
        install: (ctx) => {
          installCanvasPreparationServices(ctx, { canvasId: resolved.canvasId, jobId: resolved.jobId });
          // 准备中的壳也保留设置入口（不等待准备完成、不创建画布资源）。
          installCanvasShellSettingsServices(ctx, {});
        },
        plugins: [createCanvasShellSettingsPlugin()],
        isolate: [
          "applicationRemote", "settingsRemote",
          "applicationExtensionStatus",
          "generationModelsStatus",
          "settingsOpen"
        ]
      });
    }
    return startCanvasPage(resolved.canvasId);
  };

  /**
   * 消费一次性的「打开画布内设置」兼容意图
   * （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）。
   *
   * 只在对应 transition generation 与目标壳仍有效时执行；用户已离开、换画布或 App dispose 后
   * 迟到结果一律丢弃。设置能力缺失时只记录诊断，不重试、不跳转。
   */
  const consumeSettingsIntent = (runtime: FrontendRuntime, location: AppPageLocation, generation: number) => {
    if (generation !== transitionGeneration || page !== runtime || isAborted()) return;
    const capability = runtime.ctx.get("settingsOpen" as never) as
      | { open: (input?: { canvasId?: string | null }) => Promise<{ ok: boolean; code?: string; reason?: string }> }
      | undefined;
    if (!capability) {
      setSettingsError("设置能力不可用");
      return;
    }
    setSettingsError(null);
    void capability
      .open({ canvasId: location.canvasId ?? null })
      .then((result) => {
        if (generation !== transitionGeneration || page !== runtime) return;
        if (!result.ok) setSettingsError(result.reason ?? "无法打开设置");
      })
      .catch((error: unknown) => {
        if (generation !== transitionGeneration || page !== runtime) return;
        setSettingsError(error instanceof Error ? error.message : "无法打开设置");
      });
  };

  const applyLocation = async (location: AppPageLocation) => {
    if (isAborted()) return;
    // 已有画布接收旧 `/settings` 请求时复用当前 scope：只消费一次意图，不释放/重建同一画布
    // （change: 2026-10-17-move-settings-into-canvas-dialog，spec: 已有画布接收旧路径请求）。
    if (
      location.page === "canvas" &&
      location.openSettings &&
      page &&
      pageLocation?.page === "canvas" &&
      (location.canvasId === undefined || location.canvasId === pageLocation.canvasId)
    ) {
      const reuseTarget = { ...pageLocation, canvasId: pageLocation.canvasId ?? location.canvasId ?? "" };
      const normalizedReuse: AppPageLocation = { page: "canvas", ...(reuseTarget.canvasId ? { canvasId: reuseTarget.canvasId } : {}) };
      router.replace(normalizedReuse);
      router.reportScope({ id: router.currentScopeId(), page: "canvas", phase: "ready", error: null });
      consumeSettingsIntent(page, normalizedReuse, transitionGeneration);
      return;
    }
    // 同一 Task History 顶层页面内的查询/游标/选中变化复用当前 scope：只更新类型化
    // location 并通知页面控制器，不释放/重建 reader 与订阅（spec: 同页修改筛选或选中项）。
    if (page && pageLocation?.page === location.page && (location.page === "task-history" || location.page === "task-monitor")) {
      router.commit(location);
      router.reportScope({ id: router.currentScopeId(), page: location.page, phase: "ready", error: null });
      return;
    }
    const generation = ++transitionGeneration;
    // 先释放 outgoing scope（不后台保留 socket/WASM/listener/plugin contribution）。
    // 同时释放上一个迁移准备 watcher（切换 location 后迟到 ready 不再导航）。
    preparationWatcher?.();
    preparationWatcher = null;
    // 上一个画布跳转的节点定位随旧 scope 一起失效（换画布/离开画布/Back 都不再重试）。
    nodeTargetDispose?.();
    nodeTargetDispose = null;
    const outgoing = page;
    page = null;
    pageLocation = null;
    connectivity.watchPage(null);
    publish();
    if (outgoing) await outgoing.dispose();
    if (generation !== transitionGeneration) return;

    let resolved: ResolvedPage = { kind: "ready", canvasId: "" };
    let normalized = location;
    if (location.page === "canvas") {
      const outcome = await resolveCanvasLocation({
        location,
        catalog,
        selection,
        preparation
      });
      if (generation !== transitionGeneration) return;
      if (outcome.kind === "resolved") {
        resolved = { kind: "ready", canvasId: outcome.canvasId };
        // 缺省解析/自动创建写回 URL 但不污染 back stack；用户显式 ID 保持原样。
        if (!location.canvasId || outcome.created) {
          normalized = { ...location, canvasId: outcome.canvasId };
        }
        selection.setRecentCanvasId(outcome.canvasId);
      } else if (outcome.kind === "preparing") {
        // 旧 ID 迁移中：不创建默认画布；展示准备态，ready 后由 watcher 重解析。
        resolved = { kind: "preparing", canvasId: outcome.canvasId, jobId: outcome.jobId };
        selection.setRecentCanvasId(outcome.canvasId);
      } else {
        resolved = {
          kind: "unresolved",
          code: outcome.kind === "not-found" ? "CANVAS_NOT_FOUND" : "CATALOG_UNAVAILABLE",
          error: outcome.error
        };
      }
    }
    if (generation !== transitionGeneration) return;

    // 一次性设置意图：需要消费，但不进入已提交的 location/URL
    // （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）。
    const settingsIntent = normalized.openSettings === true;
    if (settingsIntent) {
      const { openSettings: _openSettings, ...withoutIntent } = normalized;
      normalized = withoutIntent;
    }

    // 提交 location（含 canvasId）→ 更新 scope identity；缺省 ID 用 replaceState 规范化。
    if (normalized !== location) router.replace(normalized);
    else router.commit(normalized);
    const startingStatus: AppPageScopeStatus = {
      id: router.currentScopeId(),
      page: location.page,
      phase: "starting",
      error: null
    };
    router.reportScope(startingStatus);

    const promise = startPage(normalized, resolved);
    inFlight.add(promise);
    try {
      const incoming = await promise;
      // 资源准备过期或退出：立即 dispose，不发布旧结果。
      if (generation !== transitionGeneration || isAborted()) {
        await incoming.dispose();
        return;
      }
      page = incoming;
      pageLocation = normalized;
      connectivity.watchPage(incoming);
      // page 与其 location 原子发布：React 只会看到「无 page」或「page 与 location 一致」。
      publish();
      router.reportScope({ id: router.currentScopeId(), page: location.page, phase: "ready", error: null });

      // 一次性节点目标（任务监控/任务历史的「在画布中打开」）：`?nodeId=` 只表示打开后
      // 定位并选中该节点，不进入 URL 之外的 presentation。画布数据/渲染宿主可能尚未就绪，
      // 由定位器自行等待一次成功后结束；换画布或离开画布时释放。
      if (normalized.page === "canvas" && normalized.nodeId && resolved.kind === "ready") {
        nodeTargetDispose = attachOpenedNodeTarget(incoming.ctx, normalized.nodeId);
      }

      // 旧 `/settings` 兼容意图：壳与设置能力就绪后**消费一次**
      // （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）。
      // 不等待 GPU/场景 ready；地址已 replace 为规范 Canvas URL，刷新不会再次打开。
      if (settingsIntent) {
        consumeSettingsIntent(incoming, normalized, generation);
      }

      // 旧 ID 迁移中：订阅准备态；ready 后重解析同一 location（移动到新 scope）。
      if (resolved.kind === "preparing" && location.canvasId) {
        const target = location;
        preparationWatcher = subscribePreparationReady(preparation, location.canvasId, () => {
          if (generation !== transitionGeneration) return;
          void applyLocation(target);
        });
      }
    } catch (error) {
      if (generation !== transitionGeneration) return;
      router.reportScope({
        id: router.currentScopeId(),
        page: location.page,
        phase: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      inFlight.delete(promise);
    }
  };

  try {
    await applyLocation(router.getLocation());
  } catch (error) {
    await app.dispose();
    runtimeService.dispose();
    throw error;
  }
  // 用户主动导航（切换器/历史页）与 popstate 共用同一 scope transition 入口。
  router.setNavigateHandler((to) => {
    void applyLocation(to);
  });

  const onPop = () => {
    const location = router.resolve(
      globalThis.location?.pathname ?? "/",
      globalThis.location?.search ?? ""
    );
    void applyLocation(location);
  };
  globalThis.addEventListener?.("popstate", onPop);

  connectivity.bindPageReopen({ location: () => pageLocation ?? router.getLocation(), apply: applyLocation });
  return {
    app,
    router,
    currentPage: () => page,
    settingsIntentError,
    async retrySettingsIntent() {
      if (isAborted() || !page || !pageLocation) return;
      if (pageLocation.page !== "canvas") return;
      consumeSettingsIntent(page, pageLocation, transitionGeneration);
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyLocation,
    ...connectivity.runtimeFields(),
    async dispose() {
      transitionGeneration += 1;
      connectivity.dispose();
      preparationWatcher?.();
      preparationWatcher = null;
      globalThis.removeEventListener?.("popstate", onPop);
      router.setNavigateHandler(null);
      nodeTargetDispose?.();
      nodeTargetDispose = null;
      const outgoing = page;
      page = null;
      pageLocation = null;
      publish();
      if (outgoing) await outgoing.dispose();
      await Promise.allSettled([...inFlight]);
      inFlight.clear();
      await app.dispose();
      runtimeService.dispose();
    }
  };
}
