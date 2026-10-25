/**
 * `@woohaa3/frontend/extension-api` 公共入口
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 2.2 / design D2/D6；
 *  change: 2026-10-10-extract-optional-feature-extensions，任务 1.2/1.3：补齐可选扩展所需的
 *  公共 Context/Service 契约、画布只读 facade、locate/catalog 与公共 UI/Dialog primitives）。
 *
 * extension 作者从此入口获得：入口描述/plugin 定义辅助、Context/Service 纯类型与公共 UI。
 * 运行时依赖闭包限于 `shared/ui`、Dialog primitives 与 `task-execution/execution-panel`；不包含
 * 扫描器、装配根、Canvas manifest 或具体业务插件，避免循环装配。
 */
/**
 * 宿主的 Cordis `Context` 类型增强必须随 SDK 一起进入扩展的 tsc program：扩展在自己的项目里
 * 编译 SDK 源码（`@woohaa3/frontend/extension-api` → src），若只依赖各自入口的 import 图，
 * `ctx.slots` / `ctx.canvasNavigation` 这类宿主注入的 service 不会出现在 `Context` 上。
 * type-only 副作用导入（空绑定）足以让 augmentation 生效，不产生运行时依赖。
 */
import type {} from "../cordis/context.js";
export { defineExtensionFrontend, defineExtensionPlugin } from "./entry.js";
export { AssistantConnectionPicker, type AssistantConnectionSelection } from "../cordis/plugins/task-execution/assistant-connection-picker.js";
export { resolveAgentDetailAction } from "../cordis/plugins/task-execution/execution-panel/agent-detail-action.js";
export { AuthoringGenerateSurface } from "../cordis/plugins/task-execution/authoring-generate-layout.js";
export type { CanvasGroupRun, CanvasGroupRunsService, CanvasGroupRunsSnapshot } from "./context-api.js";
/**
 * 通用公开 URL 解析能力（change: 2026-10-15-support-configurable-app-base-path，design D6）：
 * extension 前端把应用逻辑路径解析为当前挂载下的公开 URL，而不是各自拼部署前缀。
 */
export { appPublicUrl as resolvePublicUrl, stripAppLocationPathname as toLogicalAppPath } from "../cordis/services/app-base-path.js";
/**
 * 当前浏览器构建的标识（遥测 / diagnostics 上报的 `frontendVersion`）。
 *
 * 为什么经公共入口转出而不是让扩展自己读全局：扩展是**独立构建**的，拿不到宿主 bundle 的
 * 构建期常量；这个值由宿主 SDK 分组作为不可变运行时能力交给扩展（见 `sdk-core.ts`）。
 * 未注入时返回空串，调用方据此不报版本。
 */
export { appBuildVersion } from "../cordis/services/build-info.js";
export type {
  ExtensionFrontendActivation,
  ExtensionFrontendConfigScope,
  ExtensionFrontendDescriptor,
  ExtensionFrontendModule
} from "./entry.js";
/**
 * 通用 app/page 扩展贡献（change: 2026-10-13-...）：页面由扩展拥有，宿主只负责可信注册、
 * page scope 生命周期与 typed query 解码。`ExtensionAppPageQuery` 是页面查询的规范化载体。
 */
export type {
  ExtensionAppPageEntry,
  ExtensionAppPageMetadata,
  ExtensionAppPageQuery,
  ExtensionAppPageRuntime
} from "@woohaa3/contracts";

export type {
  AgentConversationActiveTurn,
  AgentConversationRemote,
  AgentConversationResult,
  AgentConversationService,
  AgentConversationServiceHandle,
  AgentConversationSnapshotView,
  AgentConversationSubmitInput,
  AgentConversationSubmitResult,
  AgentConversationView,
  AppRouterService,
  ApplicationRemoteService,
  ApplicationRemoteTransport,
  ApplicationTransportErrorCode,
  ApplicationTransportJsonResult,
  ApplicationTransportStreamCallbacks,
  ApplicationTransportStreamEvent,
  AuthoringGenerationComponent,
  AuthoringGenerationProps,
  CanvasCancelResult,
  CanvasCommand,
  CanvasCommandsResult,
  CanvasCommandsService,
  CanvasLocateService,
  CanvasRemoteService,
  CanvasRunRequest,
  CanvasRunResult,
  CanvasRuntimeService,
  CanvasRuntimeStatus,
  CanvasCatalogItemActionProps,
  CanvasScopeService,
  CanvasSession,
  CanvasSessionPhase,
  CanvasSessionStatus,
  CanvasSlotProps,
  CanvasStoreFacade,
  CanvasSyncStatus,
  CatalogState,
  CanvasNavigationService,
  Context,
  ContextMenuContext,
  DialogDefinition,
  DialogHostApi,
  DialogHostSnapshot,
  DialogInstance,
  DialogRegistration,
  DialogRenderer,
  DialogRendererProps,
  DialogsService,
  InputScopesService,
  LocateNodesResult,
  MediaRemoteService,
  ModelExecutionDraft,
  ModelExecutionDraftPatch,
  ModelExecutionStatus,
  ModelInteractionDefinition,
  ModelInteractionDescriptor,
  ModelInteractionRegistry,
  ModelInteractionSummary,
  ModelPanelComponent,
  ModelPanelProps,
  ModelPanelRenderers,
  ModelReferenceItem,
  ModelSubmitDraft,
  ModelSubmitOutcome,
  NodeHistoryResult,
  OpenDialogRequest,
  OpenDialogResult,
  PanelPresentationIntent,
  ParameterPreviewService,
  Plugin,
  PromptSnippetSearchResult,
  PromptSnippetSource,
  SelectionService,
  SnippetResult,
  SnippetTagWithCount,
  SlotContribution,
  SlotContributionMap,
  SlotName,
  SlotsService,
  StoredAsset,
  TaskActivityFeedItem,
  TaskActivityRow,
  TaskActivityRowKind,
  TaskActivityRowTone,
  TaskActivityStoreService,
  TaskActivityStoreSnapshot,
  TaskCatalogService,
  TaskRemoteService,
  ThemeService
} from "./context-api.js";

export * from "./ui.js";
export * from "./capability-keys.js";
export * from "./host-platform.js";
export * from "./mention-editor.js";
export * from "./panel-projection.js";
export * from "./events.js";
export * from "./composite-assets.js";

export { ModelEditorSession } from "./model-workspace-session.js";
export * from "./model-workspace.js";
export * from "./upload-asset.js";
export type { InteractionController, InteractionControllerOptions } from "../cordis/plugins/canvas-shell/interaction-types.js";
export type { CanvasEditService } from "../cordis/services/canvas-state/store/canvas-edit-service.js";
export type { RunStateService } from "../cordis/plugins/service-keys.js";

export { AgentAssistantSettingsLink, openAgentAssistant } from "./agent-assistant.js";
export * from "./assistant-execution.js";

export * from "./node-implementations.js";
export { scriptModelPreparation, orbitModelPreview, modelWorkspaceFocus, nodeActionContributions, rectangularNodeResize, modelResourceDemand } from "@woohaa3/contracts";
export type { MediaContentService, MediaContentProvider, MediaContentState, MediaContentSource, MediaContentContext, MediaContentKind } from "./media-content.js";

export { FocusExitCoordinator } from "../cordis/navigation/exit-coordinator.js";
