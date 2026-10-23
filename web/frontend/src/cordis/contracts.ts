/**
 * Frontend 页面级插件运行时契约（change: adopt-frontend-cordis-plugin-runtime）。
 *
 * 这里只放**纯类型**：三大 remote adapter、平台 Service、typed slot、诊断和
 * Canvas Session 的公共形状。类型定义按职责放在同目录 `contract/` 子模块
 * （change: 2026-09-28-split-frontend-god-plugins，task 1.5），本模块只做聚合，
 * 保持既有 `cordis/contracts.js` 导入路径不变。
 */
export type {
  CanvasSessionPhase,
  CanvasSessionStatus,
  CanvasSession
} from "./contract/session.js";

export type {
  CanvasRunRequest,
  CanvasRunResult,
  CanvasCancelResult,
  ModelScriptReport,
  CanvasRemoteService,
  SnippetResult,
  NodeHistoryResult,
  EditCompleteResult,
  SnippetTagWithCount,
  TaskCatalogReader,
  TaskRemoteService,
  UploadedMedia,
  UploadMediaResult,
  MediaRemoteService,
  ApplicationRemoteService,
  ApplicationTransportErrorCode,
  ApplicationTransportJsonResult,
  ApplicationTransportStreamEvent,
  ApplicationTransportStreamCallbacks,
  ApplicationRemoteTransport
} from "./contract/remote.js";

export type {
  DialogRegistration,
  DialogHostSnapshot,
  DialogCloseGuard,
  DialogCloseResult,
  DialogsService,
  RouteProps,
  CanvasSlotProps,
  CanvasCatalogItemActionProps,
  CatalogItemActionContribution,
  CanvasCreateOptionContribution,
  ContextMenuContext,
  PromptSnippetSearchResult,
  PromptSnippetSource,
  SlotContributionMap,
  SlotName,
  SlotContribution,
  SlotsService,
  InputScope,
  InputScopesService,
  SelectionService,
  ParameterPreviewEntry,
  ParameterPreviewService,
  CatalogState,
  TaskCatalogService,
  CanvasMenuService,
  ThemeService,
  StoredAsset,
  OpenDialogRequest,
  OpenDialogResult,
  DialogRendererProps,
  DialogDefinition,
  DialogInstance,
  DialogHostApi,
  DialogRenderer,
  CanvasSyncStatus
} from "./contract/platform.js";

export type {
  CanvasRuntimeStatus,
  CanvasMenuState,
  CanvasRuntimeService
} from "./contract/canvas-runtime.js";

export type {
  CanvasCatalogState,
  CanvasCatalogService,
  CanvasCatalogRemote,
  CanvasCatalogListResult,
  CanvasCatalogSummaryResult,
  CanvasCatalogCreateResult,
  CanvasSelectionService,
  CanvasRecoveryService,
  CanvasSummary,
  CanvasDetailSummary
} from "./contract/canvas-catalog.js";

export type {
  ModelExecutionStatus,
  ModelExecutionDraft,
  ModelExecutionDraftPatch,
  ModelReferenceItem,
  ModelSubmitDraft,
  ModelSubmitOutcome,
  PanelPresentationIntent,
  ModelPanelProps,
  ModelPanelComponent,
  ModelPanelRenderers,
  ModelInteractionDefinition,
  ModelInteractionSummary,
  ModelInteractionDescriptor,
  ModelInteractionRegistry,
  ExecutionPanelPresentation
} from "./contract/model-interaction.js";

export type {
  AuthoringGenerateMode,
  AuthoringGenerationProps,
  AuthoringGenerationComponent
} from "./contract/authoring.js";

export type {
  ImportAnchor,
  ImportSource,
  ImportItemStage,
  ImportItem,
  ImportBatchResult,
  ImportBatchInput,
  ImportState,
  ImportService
} from "./contract/import.js";

export type {
  ExtensionStatus,
  ExtensionDiagnostic,
  RuntimeStatus,
  RuntimeDiagnostics,
  CanvasStoreLike
} from "./contract/diagnostics.js";
