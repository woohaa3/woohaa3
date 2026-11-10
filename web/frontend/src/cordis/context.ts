/**
 * Cordis Context/Events 类型增强（change: adopt-frontend-cordis-plugin-runtime；
 *   change: formalize-frontend-event-bus：事件声明迁至集中式 Frontend Event Catalog）。
 *
 * 把三大 remote adapter 与平台 Service 注册到 `ctx`/`ctx.inject` 的类型面。**事件**不再在
 * 这里声明：`./events/catalog.js` 是唯一的类型化目录（import 即完成 `Events` 增强）。
 * **运行时**由各 Service 的 `ctx.provide()` 提供。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  CanvasRemoteService,
  CanvasRuntimeService,
  CanvasSession,
  DialogsService,
  MediaRemoteService,
  SelectionService,
  ParameterPreviewService,
  SlotsService,
  InputScopesService,
  TaskRemoteService,
  TaskCatalogService,
  CanvasMenuService,
  ImportService,
  ThemeService,
  ApplicationRemoteService
} from "./contracts.js";
import type { CanvasNavigationService, AppRouterService } from "./navigation/index.js";
import type { CanvasCatalogService, CanvasSelectionService, CanvasRecoveryService } from "./contract/canvas-catalog.js";
import type { ModelInteractionRegistry } from "./contract/model-interaction.js";
import type { ExtensionManagerFacade } from "./plugins/extension-manager/contract.js";
// 事件目录：import 即把 `Events` 增强到 Context 类型面（唯一事件声明处）。
import "./events/catalog.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** App scope 的身份与权限快照，独立管理页面共用。 */
    currentUser: import("./services/current-user.js").CurrentUserService;
    canvasRemote: CanvasRemoteService;
    taskRemote: TaskRemoteService;
    /** Application Remote：站点插件状态/管理 + Application 健康（change: 2026-10-05）。 */
    applicationRemote: ApplicationRemoteService;
    mediaRemote: MediaRemoteService;
    canvasSession: CanvasSession;
    /**
     * 页面级画布编辑历史（撤销/重做、参数条目、冲突跳过）
     * （change: 2026-10-09-improve-canvas-workflow，任务 1.5）。
     */
    canvasEdit: import("./services/canvas-state/index.js").CanvasEditService;
    /**
     * 页面离开守卫（编辑扩展工作区，design D6）。
     *
     * 多文档工作区注册自己的未结算文档与串行结算；切换画布 / 离开页面先问它。
     */
    pageLeave: import("./leave-guard.js").PageLeaveGuard;
    /**
     * 通用扩展画布命令提交能力（change: 2026-10-10-add-game-furnace-extension，design D4）。
     *
     * 扩展经此提交**通用语义画布命令**；只读会话拒绝。编辑扩展“添加到画布”用它提交
     * 工程资产 + 输出资产 + 带工程的图片节点这一原子批次。
     */
    canvasCommands: import("./contract/platform.js").CanvasCommandsService;
    /** 统一定位服务（搜索/任务/当前选区共用；change: 2026-10-09，任务 4.1）。 */
    canvasLocate: import("./services/canvas-locate.js").CanvasLocateService;
    /**
     * 当前 Canvas scope 身份（change: 2026-10-10-extract-optional-feature-extensions，design D2）。
     * 只在 Canvas page scope 提供；extension 用它确定目标画布，不假定默认画布。
     */
    canvasScope: import("./contract/platform.js").CanvasScopeService;
    /**
     * 受控只读画布 facade（change: 2026-10-10-extract-optional-feature-extensions，design D4）。
     * 只读 canonical/working 快照与订阅；MUST NOT import 宿主内部 canvas store。
     */
    hoverState: import("../extension-api/model-workspace.js").HoverStateService;
    nodeImplementations: import("../extension-api/node-implementations.js").NodeImplementationRegistry;
    mediaContent: import("../extension-api/media-content.js").MediaContentService;
    canvasState: import("./contract/platform.js").CanvasStoreFacade;
    dialogs: DialogsService;
    slots: SlotsService;
    /**
     * 结构化日志出口（change: unify-host-client-logging）。
     *
     * 前端实现只写 console：不落盘、不上报、不缓冲。宿主侧同名服务由
     * `web/backend/src/host/base/log.ts` 提供；两者共用 contracts 的信封与脱敏表。
     */
    log: import("./plugins/log/plugin.js").FrontendLogService;
    /** 扩展渲染故障与会话内熔断（App scope；change: 2026-10-21-harden-extension-fault-isolation）。 */
    extensionFaults: import("./extension-faults.js").ExtensionFaultService;
    inputScopes: InputScopesService;
    canvasRuntime: CanvasRuntimeService;
    /**
     * Canvas presentation navigation（change: unify-canvas-presentation-navigation）。
     * 只在 Canvas page scope 提供。
     */
    canvasNavigation: CanvasNavigationService;
    /** 应用级顶层页面 Router（App scope 提供）。 */
    appRouter: AppRouterService;
    persistentSurfaces: import("./services/persistent-surfaces.js").PersistentSurfaces;
    selection: SelectionService;
    parameterPreview: ParameterPreviewService;
    taskCatalog: TaskCatalogService;
    /**
     * 多画布目录读模型（App scope；change: 2026-09-29-add-multi-canvas-workspace）。
     * 跨 Canvas page transition 存活；不创建任何画布运行资源。
     */
    canvasCatalog: CanvasCatalogService;
    /** 最近画布选择（App scope；用于缺省 canvasId 解析）。 */
    canvasSelection: CanvasSelectionService;
    /**
     * 首次打开准备读模型（App scope；change: 2026-10-12-add-extension-online-canvas-migration）。
     * 跨 Canvas page transition 存活；不创建任何画布运行资源。
     */
    canvasPreparation: import("./contract/canvas-preparation.js").CanvasPreparationService;
    /** 显式不支持画布的恢复页（recovery page scope 提供）。 */
    canvasRecovery: CanvasRecoveryService;
    /**
     * 旧 ID 迁移准备态视图（preparation page scope 提供）
     * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.4/5.8）。
     */
    canvasPreparationView: { canvasId: string; jobId: string | null };
    canvasMenu: CanvasMenuService;
    importService: ImportService;
    /** 页面级唯一主题 owner（change: unify-application-theme-tokens）。 */
    theme: ThemeService;
    /** feature-owned 片段目录 capability（由 prompt-snippets extension 提供）。 */
    snippetCatalog: import("./contract/platform.js").SnippetCatalogService;
    /**
     * 图片/模型聚焦编辑的异步退出协调器
     * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
     */
    focusExit: import("./navigation/exit-coordinator.js").FocusExitCoordinator;
    /** Canvas page scope 的模型交互注册表。 */
    modelInteractions: ModelInteractionRegistry;
    /**
     * 插件管理 capability（Canvas page scope 提供；change: add-frontend-plugin-manager；
     * change: 2026-10-16-consolidate-canvas-settings-entries：管理界面在设置页「插件配置」）。
     * 只暴露投影后的快照，不暴露底层 browser-local 原始配置。
     */
    extensionManager: ExtensionManagerFacade;
    /**
     * 站点应用插件状态读模型（Canvas page scope 提供）
     * （change: 2026-10-04-add-backend-plugin-extensions）。
     */
    applicationExtensionStatus: import("./services/application-extension-status.js").ApplicationExtensionStatusService;
    /**
     * 生成模型状态读模型（Canvas page scope 提供）
     * （change: 2026-10-04-add-runninghub-and-extensionize-litellm）。
     */
    generationModelsStatus: import("./services/generation-models-status.js").GenerationModelsStatusService;
    /**
     * 宿主统一配置 remote（Canvas page scope / 画布壳 scope 提供）
     * （change: 2026-10-17-move-settings-into-canvas-dialog）。
     *
     * `/api/settings` 的唯一读取出口；设置页、助手生成服务与画布引导都复用同一实例，
     * 不各自新建 fetch 或轮询。
     */
    settingsRemote: import("./services/settings-remote.js").SettingsRemote;
    /**
     * 宿主 Agent 会话 service（Canvas page scope 提供）
     * （change: 2026-10-12-add-agent-conversation-panel）。生成面板提交首轮与详情读模型共用；
     * 业务生成扩展只消费它，不自行持久化会话。
     */
    agentConversationService: import("./contract/agent-conversation.js").AgentConversationService;
    /**
     * 画布内设置的打开能力（Canvas page scope 提供；change: 2026-10-17-move-settings-into-canvas-dialog）。
     *
     * 左下角入口、旧 `/settings` 兼容意图与其它指路操作都经它打开同一 singleton 弹窗；
     * 不涉及 App Router/页面导航。渲染失败/空壳的恢复页 scope 也提供同一能力。
     */
    settingsOpen: import("./plugins/settings/entry.js").SettingsOpenService;
    /**
     * 统一生成运行状态（Canvas page scope 提供）
     * （change: 2026-10-12-unify-generation-history-strip，design D1/D2）。
     */
    runState: import("./plugins/service-keys.js").RunStateService;
    /**
     * App 级任务结果通知服务
     * （change: 2026-10-17-move-settings-into-canvas-dialog，design D8/D10）。
     *
     * 唯一实例，归 App scope：关闭设置、释放 Canvas page、切到历史页都不停止它；
     * 设置「通知」分区只订阅 snapshot 并调用具名操作。
     */
    taskNotifications: import("./services/notifications/service.js").NotificationServiceHandle;
  }
}

export type { Context };
