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
import { resolveExtensionStartupSelection } from "./extension-runtime/selection.js";

/** App 运行时快照：页面、location 与兼容设置意图的诊断必须原子发布。 */
export type AppRuntimeSnapshot = {
  page: FrontendRuntime | null;
  location: AppPageLocation | null;
  /** 旧 `/settings` 兼容打开失败的安全文案；无错误为 null。 */
  settingsError: string | null;
};

export type AppRuntime = {
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

export type StartAppOptions = {
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
   * 插件偏好存储（测试注入；缺省 globalThis.localStorage）。
   * change: add-frontend-plugin-manager，design D2/D3。
   */
  extensionPreferenceStorage?: PreferenceStorage | null;
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

    // 2. 读一次浏览器本地选择（design D2/D8）：browser-local optional 由用户偏好决定本次是否装配；
    //    站点插件（server-active）只登记，由 reconciler 跟随服务端实际状态。
    const preferenceStore = new ExtensionPreferenceStore({
      ids: configurableIds,
      ...(options.extensionPreferenceStorage !== undefined ? { storage: options.extensionPreferenceStorage } : {})
    });
    const desired = preferenceStore.getSnapshot().preferences;
    const selectionResult = resolveExtensionStartupSelection({ metadata, desired });
    // 内置 optional（node-history）沿用既有 selector 语义。
    const builtinAssembled: Record<string, boolean> = {};
    for (const entry of catalogMetadata) {
      if (!entry.configurable) continue;
      builtinAssembled[entry.id] = desired[entry.id] ?? true;
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
          plugin: result.descriptor.plugin() as Plugin
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
          message: "功能加载失败，请重试"
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

    const manifest = createCanvasExtensionManifest({
      canvasId,
      catalogMetadata,
      configurableOptionalIds: configurableIds,
      extensions: loadedDefinitions,
      extensionManager: {
        assembled: { ...builtinAssembled, ...selectionResult.assembled },
        failed: failedOptionalIds,
        catalog: catalogMetadata,
        ids: configurableIds,
        preferenceStore,
        ...(options.extensionManagerReload ? { reload: options.extensionManagerReload } : {})
      }
    });
    const assembled = { ...builtinAssembled, ...selectionResult.assembled };
    const plugins = manifest.filter((definition) => isAssembledAtStartup(definition, assembled));
    const disabled = Object.entries(assembled)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => ({ id, reason: "用户已禁用该可选插件" }));

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
        "settingsOpen"
      ]
    });
    const disposeRuntime = runtime.dispose;
    return {
      ...runtime,
      async dispose() {
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
          "applicationRemote",
          "settingsRemote",
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
          "applicationRemote",
          "settingsRemote",
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
    async dispose() {
      transitionGeneration += 1;
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

/**
 * 订阅某 canvasId 的准备态：仅当状态转为 `ready` 时回调一次（用于把 preparing scope 迁移到
 * 真正的 Canvas scope）。返回取消订阅函数。
 */
function subscribePreparationReady(
  preparation: CanvasPreparationService,
  canvasId: string,
  onReady: () => void
): () => void {
  let fired = false;
  const listener = () => {
    if (fired) return;
    const state = preparation.getState();
    if (state.canvasId !== null && state.canvasId !== canvasId) return;
    if (state.status === "ready") {
      fired = true;
      onReady();
    }
  };
  const unsubscribe = preparation.subscribe(listener);
  // 订阅后立即检查一次（可能订阅前已 ready）。
  listener();
  return unsubscribe;
}

/** 浏览器 history 适配；无 `history` 时返回 undefined（SSR/测试）。 */
function browserHistory(): AppHistoryAdapter | undefined {
  const history = globalThis.history;
  if (!history) return undefined;
  return {
    pushState: (data, title, url) => history.pushState(data, title, url),
    replaceState: (data, title, url) => history.replaceState(data, title, url)
  };
}
