import { createNodeImplementationRegistry } from "../extension-api/node-implementations.js";
import { createMediaContentService } from "./services/media-content.js";

import { createPersistentSurfaces } from "./services/persistent-surfaces.js";
import { installTaskMonitorAction } from "../pages/task-monitor/entry.js";
import { hoverNodeStore } from "./services/hover-store.js";
/**
 * App / Canvas / Task History page scope 组装
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 2.1/2.3 / design D1）。
 *
 * 把启动拆为三层：
 * - App scope：Router、Theme、Dialog primitives、诊断；跨页面存活。
 * - Canvas page scope：Canvas Remote/Session/Runtime、selection、catalog、canvas plugins。
 * - Task History page scope：Task history reader + 受控 Media resolver；**不**创建
 *   Canvas Session、Canvas sync socket、Bevy/WASM、selection 或 canvas plugins。
 */
import { CompositeAssetRegistry } from "../extension-api/composite-assets.js";
import type { Context } from "@deepseek-ai/cordis";
import type { CanvasCommand } from "@woohaa3/contracts";
import { createCanvasRemote } from "./services/canvas-remote.js";
import { createTaskRemote } from "./services/task-remote.js";
import { createMediaRemote } from "./services/media-remote.js";
import { DialogService } from "./services/dialogs/service.js";
import { InputScopeService } from "./services/input-scopes.js";
import { PageLeaveGuard } from "./leave-guard.js";
import { SlotRegistry } from "./slots.js";
import { invalidateCatalogOnModelPolicyChange, TaskCatalogStore } from "./services/task-catalog.js";
import { ModelInteractionService } from "./services/model-interaction-service.js";
import { nodeSelectionStore } from "./services/selection-store.js";
import { parameterPreviewStore } from "./services/parameter-preview.js";
import { AppThemeService } from "./services/theme/service.js";
import { createCanvasCatalogRemote } from "./services/canvas-catalog-remote.js";
import { createApplicationRemote } from "./services/application-remote.js";
import { createApplicationExtensionStatusService, type ApplicationExtensionStatusService } from "./services/application-extension-status.js";
import { createGenerationModelsStatusService } from "./services/generation-models-status.js";
import { migrateLegacyProviderKeys } from "./services/legacy-provider-keys.js";
import { createSettingsRemote } from "./services/settings-remote.js";
import { createTaskNotificationService } from "./services/notifications/service.js";
import { createWebPresenter, createDesktopPresenter, type DesktopNotificationPort } from "./services/notifications/presenter.js";
import { scopedAccept } from "./services/notifications/scope.js";
import { createDesktopNotificationPort } from "./desktop/notifications.js";
import { notificationClickLocation } from "./services/notifications/click-landing.js";
import { currentAppBasePath } from "./services/app-base-path.js";
import { createAgentConversationRemote } from "./services/agent-conversation-remote.js";
import { createAgentConversationService, type AgentConversationServiceHandle } from "./services/agent-conversation-service.js";
import { preloadAgentDirectory } from "./services/agent-directory.js";
import { createCanvasGroupRuns } from "./services/canvas-group-runs.js";
import { createIdentitySubjectService } from "./services/identity-subject.js";
import { createCurrentUserService } from "./services/current-user.js";
import {
  ApplicationExtensionFrontendEntryRegistry,
  type ApplicationExtensionFrontendAsyncEntry
} from "./extension-entry/contract.js";
import { createPageExtensionReconciler, hostSubmissionGate, provideSlotsAndFaults } from "./canvas-extension-wiring.js";
import type { ExtensionRuntimeService } from "./extension-runtime/service.js";
import type { ExtensionLoadDiagnostic } from "@woohaa3/contracts";
import { CanvasCatalogStore } from "./services/canvas-catalog-store.js";
import { createCanvasPreparationRemote } from "./services/canvas-preparation-remote.js";
import { CanvasPreparationStore } from "./services/canvas-preparation-store.js";
import { createCanvasSelectionService } from "./services/canvas-selection.js";
import {
  createCanvasSession,
  createCanvasEditService,
  installCanvasEditTestHooks,
  woohaa3CanvasStore,
  DEFAULT_CANVAS_ID,
  installCanvasSessionTestHooks,
  type CanvasSession
} from "./services/canvas-session.js";
import { workingCanvasOf } from "./services/canvas-state/index.js";
import { createCanvasLocateService } from "./services/canvas-locate.js";
import { canvasSearchStore } from "./services/canvas-search-store.js";
import { nodeRenameStore } from "./plugins/canvas-menu/rename-store.js";
import type { SelectionService } from "./contracts.js";
import type { CanvasCatalogRemote, CanvasCatalogService, CanvasSelectionService, CanvasRecoveryService } from "./contract/canvas-catalog.js";
import type { CanvasNavigationService } from "./navigation/contracts.js";
import type { CanvasPreparationRemote, CanvasPreparationService } from "./contract/canvas-preparation.js";
import { AppRouterStore, type AppHistoryAdapter } from "./navigation/app-router-store.js";
import type { AppPageRegistry } from "./extension-entry/app-pages.js";

export type PlatformOptions = {
  canvasId?: string;
  canvasRemoteOptions?: Parameters<typeof createCanvasRemote>[0];
  taskRemoteOptions?: Parameters<typeof createTaskRemote>[0];
  applicationRemoteOptions?: Parameters<typeof createApplicationRemote>[0];
  mediaRemoteOptions?: Parameters<typeof createMediaRemote>[0];
  /** 画布目录 remote（测试注入）。 */
  canvasCatalogRemote?: CanvasCatalogRemote;
  /** 画布目录 service（App scope；测试注入）。 */
  canvasCatalog?: CanvasCatalogService;
  /** 首次打开准备 remote（测试注入）。（change: 2026-10-12-add-extension-online-canvas-migration） */
  canvasPreparationRemote?: CanvasPreparationRemote;
  /** 首次打开准备 service（App scope；测试注入）。 */
  canvasPreparation?: CanvasPreparationService;
  /** 最近画布选择 service（测试注入）。 */
  canvasSelection?: CanvasSelectionService;
  /** 主题初始 preset / 存储 / 具名 preset（change: unify-application-theme-tokens）。 */
  themeOptions?: ConstructorParameters<typeof AppThemeService>[0];
  /** 初始 pathname/search（App Router 解析用；缺省读 globalThis.location）。 */
  initialPathname?: string;
  initialSearch?: string;
  /** History 适配（测试注入）。 */
  history?: AppHistoryAdapter;
  /** 安装 E2E/test 钩子（仅开发与测试）。 */
  testHooks?: boolean;
  /**
   * Extension 运行时服务（App 级；Canvas page scope 用它加载 server-active 入口）。
   * change: 2026-10-12-build-and-load-extensions-independently，design D7/D9。
   */
  extensionRuntime?: ExtensionRuntimeService;
  /** server-active 入口（由发布目录派生；只登记 metadata，按服务端状态异步加载）。 */
  serverActiveEntries?: readonly ApplicationExtensionFrontendAsyncEntry[];
  /** 本次启动已记录的加载诊断（page startup 上报）。 */
  loadDiagnostics?: readonly ExtensionLoadDiagnostic[];
  /**
   * Extension page registry（App scope 提供；缺省空）。
   *
   * 由组合根从发布目录 `metadata.appPages` 派生，或测试直接注入 fixture；核心不硬编码
   * 具体业务 extension pageId（change: 2026-10-13-add-enterprise-access-and-production-deployment）。
   */
  appPages?: AppPageRegistry;
  logger?: (event: Record<string, unknown>) => void;
  /**
   * 桌面壳通知端口（change: 2026-10-17-move-settings-into-canvas-dialog，design D9）。
   *
   * 浏览器缺省为 Web presenter（只有标题渠道）；桌面壳注入受控原生能力后才有系统通知。
   */
  desktopNotifications?: DesktopNotificationPort;
};

/**
 * 应用实例标识（通知偏好/标签页 owner 的隔离键）。
 *
 * 桌面壳可注入稳定实例 ID；浏览器退化为 origin，配合 basePath 已能区分不同 worktree 挂载。
 */
function appInstanceId(basePath: string): string {
  const origin = (() => {
    try {
      return globalThis.location?.origin ?? "app";
    } catch {
      return "app";
    }
  })();
  return `${origin}${basePath}`;
}

/**
 * App scope：跨页面能力。Theme、Dialog primitives、Slots registry、App Router 与
 * 跨画布 Catalog Service。Task History 与 Canvas 页面都依赖这些；它们不创建任何远端连接。
 */
export function installAppServices(ctx: Context, options: PlatformOptions = {}): AppRouterStore {
  const dialogs = new DialogService();
  const slots = new SlotRegistry();
  const theme = new AppThemeService({ ...(options.themeOptions ?? {}) });
  ctx.provide("dialogs" as never, dialogs as never);
  provideSlotsAndFaults(ctx, slots);
  ctx.provide("theme" as never, theme as never);

  const detachThemeRoot = applyThemeRoot(theme);

  const router = new AppRouterStore({
    onNavigate: () => undefined,
    ...(options.initialPathname !== undefined ? { initialPathname: options.initialPathname } : {}),
    ...(options.initialSearch !== undefined ? { initialSearch: options.initialSearch } : {}),
    ...(options.history ? { history: options.history } : {}),
    ...(options.appPages ? { appPages: options.appPages } : {})
  });
  ctx.provide("appRouter" as never, router as never);
  const persistentSurfaces = createPersistentSurfaces();
  ctx.provide("persistentSurfaces" as never, persistentSurfaces as never);
  ctx.effect(() => () => persistentSurfaces.dispose(), "persistent-surfaces");

  // 当前可信身份主体（App scope；change: 2026-10-13-...，任务 2.6/5.8）：由 current-user 在解析
  // 当前 session 后写入，供本地用户态缓存做 subject 隔离。
  const identitySubject = createIdentitySubjectService();
  ctx.provide("identitySubject" as never, identitySubject as never);

  // 统一身份/访问读模型：只经通用 Application transport 读 `/api/application/session`。
  const currentUser = createCurrentUserService(createApplicationRemote(options.applicationRemoteOptions), identitySubject);
  ctx.provide("currentUser" as never, currentUser as never);
  ctx.provide("siteAccessCapability" as never, currentUser as never);
  let surfaceIdentity: string | null | undefined;
  const detachSurfaceIdentity = currentUser.subscribe(() => {
    // A transient permission refresh is not an identity switch.
    if (!currentUser.getSnapshot()) return;
    const next = identitySubject.namespace();
    if (surfaceIdentity !== undefined && surfaceIdentity !== next) persistentSurfaces.revokeIdentity();
    surfaceIdentity = next;
  });
  ctx.effect(() => detachSurfaceIdentity, "persistent-surface-identity");

  void currentUser.initialize().catch(() => undefined);

  // 多画布目录（App scope；change: 2026-09-29-add-multi-canvas-workspace，design D2）。
  const catalog: CanvasCatalogService =
    options.canvasCatalog ?? new CanvasCatalogStore({ remote: options.canvasCatalogRemote ?? createCanvasCatalogRemote() });
  const selection = options.canvasSelection ?? createCanvasSelectionService();
  ctx.provide("canvasCatalog" as never, catalog as never);
  ctx.provide("canvasSelection" as never, selection as never);

  // 首次打开准备（App scope；change: 2026-10-12-add-extension-online-canvas-migration，任务 5.4/5.5）。
  // 无来源/未认证时不产生请求（spec: 缺主体不自动读旧源）。
  const preparation: CanvasPreparationService =
    options.canvasPreparation ?? new CanvasPreparationStore({ remote: options.canvasPreparationRemote ?? createCanvasPreparationRemote() });
  ctx.provide("canvasPreparation" as never, preparation as never);

  // App 级任务结果通知（App scope；change: 2026-10-17-move-settings-into-canvas-dialog，design D8）。
  // 归 App scope 持有：关闭设置、释放 Canvas page、切到历史页都不停止它。
  // 数据来源是任务历史只读面（watermark + 增量订阅），按当前主体/数据空间过滤。
  // 桌面壳：只有探测到受控原生通知能力时才用桌面 presenter；否则仍是浏览器语义。
  const desktopNotifications = options.desktopNotifications ?? createDesktopNotificationPort() ?? undefined;
  const notificationReader = createTaskRemote(options.taskRemoteOptions).createHistory();
  const basePath = currentAppBasePath();
  const taskNotifications = createTaskNotificationService({
    reader: notificationReader,
    scope: () => ({
      instanceId: appInstanceId(basePath),
      basePath,
      dataScopeId: currentUser.getSnapshot()?.dataScopeId ?? ""
    }),
    accept: scopedAccept(() => currentUser.getSnapshot()),
    presenter: desktopNotifications
      ? createDesktopPresenter(desktopNotifications)
      : createWebPresenter()
  });
  ctx.provide("taskNotifications" as never, taskNotifications as never);
  void taskNotifications.start().catch(() => undefined);

  // 任务 8.4：桌面通知点击。原生层负责恢复/最小化与聚焦，这里只负责用既有 App Router
  // 定位任务历史（test 通知与合并通知分别见 notificationClickLocation）。
  const detachNotificationClicks = desktopNotifications?.subscribeClicks?.((click) => {
    const location = notificationClickLocation(click);
    if (location) router.navigate(location);
  });

  // E2E/排障钩子：观察与切换当前主题（生产无业务副作用）。
  if (options.testHooks ?? true) {
    const target = globalThis as unknown as {
      __appTheme?: () => unknown;
      __setAppTheme?: (preset: unknown) => { ok: boolean; error?: string };
      __selectAppTheme?: (presetId: string) => { ok: boolean; error?: string };
      __taskNotificationsSnapshot?: () => unknown;
      __currentUserSnapshot?: () => unknown;
    };
    target.__appTheme = () => theme.getSnapshot();
    target.__setAppTheme = (preset) => theme.setPreset(preset);
    // 按内置 preset id 切换（E2E 验证默认/暗色与本地恢复；不暴露额外生产 API）。
    target.__selectAppTheme = (presetId) => theme.select(presetId);
    // 通知服务与当前身份只读诊断（与 __appTheme 同类，生产无副作用）。
    target.__taskNotificationsSnapshot = () => taskNotifications.getSnapshot();
    target.__currentUserSnapshot = () => currentUser.getSnapshot();
  }

  ctx.fiber.effect(() => {
    return async () => {
      detachThemeRoot();
      detachNotificationClicks?.();
      taskNotifications.dispose();
      currentUser.dispose();
      catalog.dispose();
      preparation.dispose();
      theme.dispose();
    };
  }, "app resources");

  // 本机遥测采集客户端（App scope；change: 2026-10-20-add-local-client-telemetry，design D7）。
  // 归 App scope 持有而不是某个页面：埋点发生在画布编辑/同步里，切页面或关闭设置都不该让缓冲
  // 丢掉。它同步入队、失败只计数，缺失时上游埋点退化为 no-op，因此不影响任何启动路径。
  //
  // **动态 import 是为了首屏体积**：采集实现与契约的事件模块不该让每个用户都在启动时下载
  // （它们否则会进入入口静态闭包）。代价是加载完成前的极少量事件会丢——
  // 遥测是 best-effort，这个取舍写在 design D7。引用槽在 `telemetry-primitives.ts`，画布会话
  // 只依赖那个零依赖模块。
  void import("./services/telemetry-client.js")
    .then((module) => {
      module.installTelemetryClient(ctx);
    })
    .catch(() => undefined);

  return router;
}

/**
 * Extension page scope：安装通用 extension page 所需 remote（Application/Task/Media）与
 * 稳定不可用反馈；**不**创建 Canvas Session / sync socket / Bevy / selection / catalog。
 *
 * `unavailablePath` 用于未知/未注册路径：显式显示不可用，绝不回退 Canvas 或旧页面
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/8.1 / design D10）。
 */
export function installExtensionPageServices(ctx: Context, options: PlatformOptions & { unavailablePath?: string } = {}): void {
  const applicationRemote = createApplicationRemote(options.applicationRemoteOptions);
  const mediaRemote = createMediaRemote(options.mediaRemoteOptions);
  ctx.provide("applicationRemote" as never, applicationRemote as never);
  ctx.provide("mediaRemote" as never, mediaRemote as never);
  // 监控页面只读取 Application handler transport；Task 领域只读 reader 仅为兼容既有扩展页面
  // 注入（页面自身不得据此读取全局管理数据）。不提供 canvasRemote/session。
  const taskRemote = createTaskRemote(options.taskRemoteOptions);
  ctx.provide("taskRemote" as never, taskRemote as never);
  if (options.unavailablePath) {
    ctx.provide("extensionPageUnavailable" as never, { path: options.unavailablePath } as never);
  }
}

/**
 * Task History page scope：只安装 history reader 与受控 Media resolver；不创建 Canvas
 * Session / sync socket / Bevy / selection / catalog。
 */
/** 内置任务监控只安装应用传输和媒体解析，不创建画布资源。 */
export function installTaskMonitorServices(ctx: Context, options: PlatformOptions = {}): void {
  ctx.provide("applicationRemote" as never, createApplicationRemote(options.applicationRemoteOptions) as never);
  ctx.provide("mediaRemote" as never, createMediaRemote(options.mediaRemoteOptions) as never);
}

/**
 * Telemetry 复盘页 scope：只装应用传输（同源取数），不创建画布资源。
 *
 * 与任务监控同形，但**不装 mediaRemote**：复盘页不解析任何媒体地址，少一个能取媒体 URL 的
 * 面就少一处可以误用的输入（design D10）。
 */
export function installTelemetryPageServices(ctx: Context, options: PlatformOptions = {}): void {
  ctx.provide("applicationRemote" as never, createApplicationRemote(options.applicationRemoteOptions) as never);
}

export function installTaskHistoryServices(ctx: Context, options: PlatformOptions = {}): void {
  const taskRemote = createTaskRemote(options.taskRemoteOptions);
  const mediaRemote = createMediaRemote(options.mediaRemoteOptions);
  ctx.provide("taskRemote" as never, taskRemote as never);
  ctx.provide("mediaRemote" as never, mediaRemote as never);
}

export type CanvasPageServices = {
  canvasRemote: ReturnType<typeof createCanvasRemote>;
  session: CanvasSession;
  applicationExtensionStatus: ApplicationExtensionStatusService;
  /** 宿主 Agent 会话前端 service（生成面板提交 + 详情读模型）。 */
  agentConversations: AgentConversationServiceHandle;
};

/**
 * Canvas page scope：三大 remote（浏览器只读契约）、Input Scopes、catalog、selection、
 * parameter preview 与 Canvas Session。只由 Canvas 页面创建。
 */
export async function installCanvasPageServices(
  ctx: Context,
  options: PlatformOptions = {}
): Promise<CanvasPageServices> {
  const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;

  const canvasRemote = createCanvasRemote({ canvasId, ...options.canvasRemoteOptions });
  const taskRemote = createTaskRemote(options.taskRemoteOptions);
  const applicationRemote = createApplicationRemote(options.applicationRemoteOptions);
  const settingsRemote = createSettingsRemote();
  const mediaRemote = createMediaRemote(options.mediaRemoteOptions);
  ctx.provide("canvasRemote" as never, canvasRemote as never);
  ctx.provide("taskRemote" as never, taskRemote as never);
  ctx.provide("applicationRemote" as never, applicationRemote as never);
  ctx.provide("settingsRemote" as never, settingsRemote as never);
  ctx.provide("mediaRemote" as never, mediaRemote as never);

  // 当前 Canvas scope 身份与受控只读画布 facade（change: 2026-10-10-extract-optional-feature-extensions，
  // design D2/D4）：可选 extension 通过注入读取 canvasId 与 canonical/working 只读快照，
  // 不 import 宿主内部 canvas store，也不假定默认画布。
  ctx.provide("canvasScope" as never, { canvasId: () => canvasId } as never);
  /**
   * 页面离开守卫（编辑扩展工作区，design D6）。
   *
   * 切换画布、离开页面与可用的窗口关闭拦截先问它；返回画布/关闭 tab 不经过这里。
   */
  const pageLeave = new PageLeaveGuard();
  ctx.provide("pageLeave" as never, pageLeave as never);
  ctx.provide(
    "canvasState" as never,
    {
      getCanvas: () => woohaa3CanvasStore.getState().canvas,
      getWorkingCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()),
      subscribe: (listener: () => void) => woohaa3CanvasStore.subscribe(listener)
    } as never
  );

  ctx.provide("hoverState" as never, hoverNodeStore as never);
  const compositeAssets = new CompositeAssetRegistry();
  ctx.provide("compositeAssets" as never, compositeAssets as never);
  ctx.effect(() => () => compositeAssets.clear(), "composite-asset-registry");
  const nodeImplementations = createNodeImplementationRegistry(compositeAssets);
  ctx.provide("nodeImplementations" as never, nodeImplementations as never);
  ctx.effect(() => () => nodeImplementations.clear(), "node-implementation-registry");
  const inputScopes = new InputScopeService();
  const taskCatalog = new TaskCatalogStore(taskRemote);
  const selection: SelectionService = nodeSelectionStore;
  const modelInteractions = new ModelInteractionService();
  ctx.provide("inputScopes" as never, inputScopes as never);
  ctx.provide("taskCatalog" as never, taskCatalog as never);
  ctx.provide("selection" as never, selection as never);
  ctx.provide("parameterPreview" as never, parameterPreviewStore as never);
  ctx.provide("modelInteractions" as never, modelInteractions as never);

  // 站点插件状态 Service（服务端权威状态；change: 2026-10-05 迁入 Application Remote）。
  const applicationExtensionStatus = createApplicationExtensionStatusService({ remote: applicationRemote });
  ctx.provide("applicationExtensionStatus" as never, applicationExtensionStatus as never);
  applicationExtensionStatus.start();

  installTaskMonitorAction(ctx);

  // 生成模型状态 Service（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1）。
  const generationModelsStatus = createGenerationModelsStatusService({ remote: applicationRemote.generationModels });
  ctx.provide("generationModelsStatus" as never, generationModelsStatus as never);
  generationModelsStatus.start();

  // 生成模型策略（启停/默认）变化 → 目录失效重取：设置现在是画布内弹窗，关闭不再整页刷新，
  // 不重取时新启用的模型要手动刷新页面才出现在节点模型菜单里（与站点插件状态的失效路径一致）。
  const unsubscribeModelPolicy = invalidateCatalogOnModelPolicyChange(taskCatalog, generationModelsStatus);

  // 旧版存在浏览器里的 Provider API Key 迁入本机密钥文件（一次性）。
  void migrateLegacyProviderKeys(settingsRemote).then(() => taskCatalog.invalidate());

  // 宿主 Agent 会话 Service（生成面板提交首轮 + 详情读模型；change: 2026-10-12-add-agent-conversation-panel）。
  // 只经宿主通用 remote 访问 `/api/agent-conversations/*`；业务 adapter 由生成扩展注册。
  // 导航在插件启动后才提供，故惰性解析 `canvasNavigation`（install 阶段尚不可用）。
  const agentConversations = createAgentConversationService({
    remote: createAgentConversationRemote({ transport: applicationRemote.transport }),
    dataScopeId: () => ctx.currentUser.getSnapshot()?.dataScopeId ?? null,
    navigation: {
      getPanel: () => (ctx.get("canvasNavigation" as never) as CanvasNavigationService | undefined)?.getSnapshot().panel ?? null,
      openPanel: (route) => (ctx.get("canvasNavigation" as never) as CanvasNavigationService | undefined)?.openPanel(route),
      closePanel: (panelType) => (ctx.get("canvasNavigation" as never) as CanvasNavigationService | undefined)?.closePanel(panelType),
      panelAvailable: (route) => (ctx.get("canvasNavigation" as never) as CanvasNavigationService | undefined)?.panelAvailable(route) ?? false
    },
    // 生成目标身份：聚焦时就是聚焦节点（生成面板在聚焦工作区检查器里，没有 panel route），
    // 概览时是画布主选中节点。详情头部据此判断「返回生成面板」是否仍成立——
    // 用户换选节点或取消选中后，收起详情只剩关闭语义。
    currentTarget: () => {
      const mode = (ctx.get("canvasNavigation" as never) as CanvasNavigationService | undefined)?.getSnapshot().mode;
      if (mode?.type === "node-focus") return { nodeId: mode.nodeId, focus: true };
      const selected = nodeSelectionStore.getSnapshot().primaryNodeId;
      return selected ? { nodeId: selected, focus: false } : null;
    }
  });
  ctx.provide("agentConversationService" as never, agentConversations as never);

  // 说明：ChatGPT service 由 `oauthAgentExtension`（feature plugin）在自身 scope 拥有并注册
  // （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.3）；
  // 平台安装器 MUST NOT 创建该业务 service。

  // 站点插件前端入口 registry + reconciliation（只影响站点入口，不触碰核心/画布/browser-local）。
  const entryRegistry = new ApplicationExtensionFrontendEntryRegistry();
  for (const entry of options.serverActiveEntries ?? []) {
    entryRegistry.register(entry);
  }
  const reconciler = createPageExtensionReconciler(ctx, { registry: entryRegistry, status: applicationExtensionStatus, runtime: options.extensionRuntime, logger: options.logger });
  // 记录 page startup 上报的加载诊断（含 optional 失败）。
  for (const diagnostic of options.loadDiagnostics ?? []) {
    options.extensionRuntime?.report(diagnostic);
  }
  let lastStatusRevision = -1;
  const unsubscribeReconcile = applicationExtensionStatus.subscribe(() => {
    reconciler.reconcile(applicationExtensionStatus.getSnapshot().plugins);
    // 站点生成插件/模型策略变化 → 使 Task catalog 失效并重取（change: 2026-10-04-...，任务 3.2）。
    const revision = applicationExtensionStatus.getSnapshot().revision;
    if (revision > lastStatusRevision) {
      lastStatusRevision = revision;
      taskCatalog.invalidate();
    }
  });
  // 立即按当前 snapshot reconcile（首次为 loading，plugins 为空）。
  reconciler.reconcile(applicationExtensionStatus.getSnapshot().plugins);

  // modal 门禁：Dialog Service 是唯一来源（App scope 提供）。
  inputScopes.addScope("modal", () => ctx.dialogs.isModalActive());

  /**
   * 打开画布时先取一次内容权限（服务端判定，宿主已折进 `GET /api/canvases/:id`）。
   *
   * 这一步是"进画布就提示"的前提：拿到 `canWrite=false` 时会话整体只读，只读气泡与
   * 生成/编辑入口的置灰都由它驱动，而不是等第一次服务端写入被拒。
   *
   * 取不到（纯本地画布、没有接远端、远端暂时没答案）就是"未知"，按可写处理——不能把
   * 一次没答案当成只读，否则本地画布会突然不可编辑。
   */
  // catalog 是 App scope 提供的服务（画布目录读模型的唯一来源），页面 scope 只经 ctx 取。
  const canvasCatalog = ctx.get("canvasCatalog" as never) as CanvasCatalogService | undefined;
  const access = canvasCatalog
    ? await canvasCatalog
        .get(canvasId)
        .then((result) => (result.ok ? result.summary.access ?? null : null))
        .catch(() => null)
    : null;
  // 宿主重连门禁（fault-isolation D6）：App 级 hostConnectivity 存在时才设置，会话在重连期间拒绝提交。
  const submissionGate = hostSubmissionGate(ctx);
  const session = await createCanvasSession({ canvasId, remote: canvasRemote, lifecycle: compositeAssets.managedLifecycles, ...(access ? { access } : {}), ...submissionGate });
  ctx.provide("canvasSession" as never, session as never);
  ctx.effect(() => preloadAgentDirectory(agentConversations, ctx.currentUser, session), "agent-directory-preload");
  const groupRuns = createCanvasGroupRuns({ canvasId, transport: applicationRemote.transport, conversations: agentConversations, user: ctx.currentUser, writable: () => session.isWritable() });
  ctx.provide("canvasGroupRuns" as never, groupRuns as never);
  ctx.effect(() => () => groupRuns.dispose(), "canvas-group-runs");
  const mediaContent = createMediaContentService({
    canvas: () => woohaa3CanvasStore.getState().canvas,
    subscribe: listener => woohaa3CanvasStore.subscribe(listener),
    writable: () => session.isWritable(),
    async submit(commands, requestId) {
      const submitted = session.submitCommands(commands, requestId);
      if (!submitted.ok) throw Error(submitted.reason);
      const settled = await submitted.handle.settled;
      if (settled.state === "rejected") throw Error(settled.error ?? "媒体内容登记失败");
    },
  });
  ctx.provide("mediaContent" as never, mediaContent as never);
  ctx.effect(() => () => mediaContent.dispose(), "media-content-registry");
  if (options.testHooks ?? true) {
    installCanvasSessionTestHooks(session);
    const target = globalThis as unknown as { __canvasMediaContentSnapshot?: () => unknown };
    const snapshot = () => {
      const canvas = woohaa3CanvasStore.getState().canvas;
      return {
        canvasId: canvas?.id,
        nodes: (canvas?.document.nodes ?? []).filter(node => !!canvas?.nodeData[node.id]?.mediaContent).map(node => {
          const data = canvas!.nodeData[node.id];
          let source: unknown;
          try { source = mediaContent.describe(canvas!, data.mediaContent!, node.type as "image" | "video"); }
          catch (error) { source = { error: String(error) }; }
          return { id: node.id, type: node.type, outputAssetId: data.outputAssetId, source, state: mediaContent.state(node.id) };
        })
      };
    };
    target.__canvasMediaContentSnapshot = snapshot;
    ctx.effect(() => () => {
      if (target.__canvasMediaContentSnapshot === snapshot) delete target.__canvasMediaContentSnapshot;
    }, "media-content-diagnostics");
  }
  // 页面级编辑历史（撤销/重做）；随 page scope dispose 清空（change: 2026-10-09，任务 1.5）。
  const canvasEdit = createCanvasEditService({
    lifecycle: compositeAssets.managedLifecycles,
    session,
    getCanvas: () => woohaa3CanvasStore.getState().canvas
  });
  ctx.provide("canvasEdit" as never, canvasEdit as never);
  if (options.testHooks ?? true) {
    installCanvasEditTestHooks(canvasEdit);
  }
  /**
   * 通用扩展画布命令能力（change: 2026-10-10-add-game-furnace-extension，design D4）。
   *
   * 扩展（如 game-furnace 工作区）经此提交**通用语义画布命令**（`CanvasCommand[]`）；只暴露
   * `session` 根（canonical 权威）而非页面投影（working overlay，扩展不应写它）。经受保护
   * `session.submitCommands` 提交纯命令，扩展不得触碰 store/命令内部结构。宿主不出现任何
   * 业务插件分支。
   */
  ctx.provide(
    "canvasCommands" as never,
    {
      submit(commands: readonly CanvasCommand[], commandId: string) {
        if (!session.isWritable()) return { ok: false as const, reason: "只读会话" };
        return session.submitCommands(commands as never, commandId);
      },
      isWritable() {
        return session.isWritable();
      }
    } as never
  );
  // 统一定位服务：搜索/任务/当前选区共用世界几何与有效尺寸（任务 4.1）。
  // 注意：canvasRuntime 由插件在启动时提供，install 阶段的 ctx 未注入它，必须用 `ctx.get`
  // 惰性读取（`ctx.canvasRuntime` 会抛 "without inject"）。
  const canvasLocate = createCanvasLocateService({
    getCanvas: () => woohaa3CanvasStore.getState().canvas,
    getController: () => (ctx.get("canvasRuntime" as never) as { controller: () => never } | undefined)?.controller() ?? null,
    // 定位作品：保持当前缩放并平滑居中（尊重减少动态效果偏好）。
    panViewportTo: (viewport) => {
      const controller = (ctx.get("canvasRuntime" as never) as { controller: () => { panViewportTo?: (v: typeof viewport) => void } | null } | undefined)?.controller();
      controller?.panViewportTo?.(viewport);
    }
  });
  ctx.provide("canvasLocate" as never, canvasLocate as never);
  if (options.testHooks ?? true) {
    // E2E：查找面板与重命名输入的确定性驱动（任务 7.1）。
    const target = globalThis as unknown as {
      __canvasLocate?: typeof canvasLocate.locateNodes;
      __canvasSearch?: { open: () => void; setQuery: (value: string) => void; snapshot: () => unknown };
      __canvasRename?: { open: (nodeId: string, initial: string) => void; close: () => void };
      __canvasPanTo?: (viewport: { x: number; y: number; zoom: number }, durationMs?: number) => void;
    };
    target.__canvasLocate = (ids, settings) => canvasLocate.locateNodes(ids, settings);
    target.__canvasSearch = {
      open: () => canvasSearchStore.open(),
      setQuery: (value) => canvasSearchStore.setQuery(value),
      snapshot: () => canvasSearchStore.getSnapshot()
    };
    target.__canvasRename = {
      open: (nodeId, initial) => nodeRenameStore.open(nodeId, initial),
      close: () => nodeRenameStore.close()
    };
    target.__canvasPanTo = (viewport, durationMs) => {
      const controller = (ctx.get("canvasRuntime" as never) as { controller: () => { panViewportTo?: (v: typeof viewport, o?: { durationMs?: number }) => void } | null } | undefined)?.controller();
      controller?.panViewportTo?.(viewport, durationMs === undefined ? {} : { durationMs });
    };
  }

  ctx.fiber.effect(() => {
    return async () => {
      unsubscribeReconcile();
      unsubscribeModelPolicy();
      await reconciler.dispose();
      entryRegistry.dispose();
      applicationExtensionStatus.dispose();
      generationModelsStatus.dispose();
      modelInteractions.dispose();
      session.shutdown();
      taskCatalog.dispose();
    };
  }, "canvas page resources");

  return { canvasRemote, session, applicationExtensionStatus, agentConversations };
}

/**
 * Canvas recovery page scope：显式不存在的 canvasId 或目录解析失败。**不**创建 Canvas
 * Session/socket/Bevy/plugins，只提供稳定恢复信息。
 */
export function installCanvasRecoveryServices(
  ctx: Context,
  recovery: CanvasRecoveryService
): void {
  ctx.provide("canvasRecovery" as never, recovery as never);
}

/**
 * 画布壳（空壳 / 准备中 / 恢复页）的设置端口
 * （change: 2026-10-17-move-settings-into-canvas-dialog，design D1）。
 *
 * 无法打开画布或渲染失败时仍要能读设置：只装 `/api/settings` 与插件/模型状态刷新所需的
 * remote，**不**创建作品、Canvas Session、sync socket、Bevy/WASM 或画布插件。
 */
export function installCanvasShellSettingsServices(ctx: Context, options: PlatformOptions = {}): void {
  const applicationRemote = createApplicationRemote(options.applicationRemoteOptions);
  ctx.provide("applicationRemote" as never, applicationRemote as never);
  ctx.provide("settingsRemote" as never, createSettingsRemote() as never);
  const applicationExtensionStatus = createApplicationExtensionStatusService({ remote: applicationRemote });
  ctx.provide("applicationExtensionStatus" as never, applicationExtensionStatus as never);
  const generationModelsStatus = createGenerationModelsStatusService({ remote: applicationRemote.generationModels });
  ctx.provide("generationModelsStatus" as never, generationModelsStatus as never);
}

/**
 * Canvas preparation page scope：显式旧 ID 迁移中。**不**创建 Canvas Session/socket/Bevy/
 * plugins，只提供准备态视图（进度/媒体计数/重试/退出）与所属画布 ID。
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.4/5.8）。
 */
export function installCanvasPreparationServices(
  ctx: Context,
  view: { canvasId: string; jobId: string | null }
): void {
  ctx.provide("canvasPreparationView" as never, view as never);
}

/**
 * 把当前主题挂到 document 根（`document.documentElement`），让 Cordis UI、portals、
 * dialog host 与 showcase 共享同一 `--app-*` variable 集合（design D3）。
 * 返回撤销函数；provider dispose 时调用，不遗留 document 状态。
 */
function applyThemeRoot(theme: AppThemeService): () => void {
  const root = globalThis.document?.documentElement ?? null;
  if (!root) return () => undefined;
  return theme.applyTo(root);
}
