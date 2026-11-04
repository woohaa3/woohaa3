/**
 * Extension 前端公共 Context/Service 契约
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 2.2 / design D2/D6；
 *  change: 2026-10-10-extract-optional-feature-extensions，任务 1.2/1.3：补齐可选扩展所需的
 *  画布只读 facade、scope identity、locate、catalog、平台 Service 与 feature capability 契约）。
 *
 * 只做 **type-only** 转出：Cordis 运行时实例由宿主注入，平台 Service 形状取自主机已有契约
 * 类型；feature capability 的**契约**对消费者公开，具体 service 实现与 Context 增强属于对应
 * extension。本模块 MUST NOT 在运行时依赖扫描器、Canvas manifest、bootstrap 或具体业务插件。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { BackgroundActivityJob, CanvasTaskActivity } from "@woohaa3/contracts";

export type { Context, Plugin };
export type { CanvasNavigationService } from "../cordis/navigation/contracts.js";
export type { AppRouterService } from "../cordis/navigation/app-router.js";

export type {
  ApplicationRemoteService,
  ApplicationRemoteTransport,
  ApplicationTransportErrorCode,
  ApplicationTransportJsonResult,
  ApplicationTransportStreamCallbacks,
  ApplicationTransportStreamEvent,
  CanvasRemoteService,
  MediaRemoteService,
  TaskRemoteService,
  SnippetResult,
  SnippetTagWithCount,
  CanvasRunRequest,
  CanvasRunResult,
  CanvasCancelResult,
  NodeHistoryResult
} from "../cordis/contract/remote.js";
export type { CanvasCommand } from "@woohaa3/contracts";
export type { CanvasEditService } from "../cordis/services/canvas-state/store/canvas-edit-service.js";
export type { RunStateService } from "../cordis/plugins/service-keys.js";
export type {
  SlotContribution,
  SlotContributionMap,
  SlotName,
  SlotsService,
  DialogsService,
  DialogRegistration,
  DialogHostSnapshot,
  CanvasSlotProps,
  CanvasCatalogItemActionProps,
  CanvasScopeService,
  CanvasStoreFacade,
  CanvasCommandsService,
  CanvasCommandsResult,
  ContextMenuContext,
  PromptSnippetSearchResult,
  PromptSnippetSource,
  TaskCatalogService,
  CatalogState,
  SelectionService,
  InputScopesService,
  ParameterPreviewService,
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
} from "../cordis/contract/platform.js";
export type { AuthoringGenerationComponent, AuthoringGenerationProps } from "../cordis/contract/authoring.js";
export type { CanvasRuntimeService, CanvasRuntimeStatus } from "../cordis/contract/canvas-runtime.js";
export type { CanvasSession, CanvasSessionStatus, CanvasSessionPhase } from "../cordis/contract/session.js";
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
  ModelInteractionRegistry
} from "../cordis/contract/model-interaction.js";
export type { CanvasLocateService, LocateNodesResult } from "../cordis/services/canvas-locate.js";
export type {
  AgentConversationActiveTurn,
  AgentConversationResult,
  AgentConversationService,
  AgentConversationSnapshotView,
  AgentConversationSubmitInput,
  AgentConversationSubmitResult,
  AgentConversationView
} from "../cordis/contract/agent-conversation.js";
/** 宿主会话前端 remote 出口（extension 只读消费，不自建 fetch）。 */
export type { AgentConversationRemote } from "../cordis/services/agent-conversation-remote.js";
/** 宿主会话前端 service 句柄（含详情打开/收起读模型）。 */
export type { AgentConversationServiceHandle } from "../cordis/services/agent-conversation-service.js";

/** 活动浮层记录（含本地 optimistic/local-failure 标记；非 canonical 事实）。 */
export type TaskActivityFeedItem = CanvasTaskActivity & {
  optimistic: boolean;
  localFailure: boolean;
};

/** 活动记录来源种类；只决定数据来源与可用动作，不决定寿命或清理规则。 */
export type TaskActivityRowKind = "task" | "job" | "group" | "skill";

/** 活动记录语义色（状态灯与状态文案）。 */
export type TaskActivityRowTone = "active" | "success" | "danger" | "muted";

/**
 * 只读行视图：与面板实际渲染的记录一致，覆盖全部来源。
 *
 * 不含来源内部载荷（提示词、参数、凭据、签名 URL 或媒体字节），也不含动作函数——
 * 该能力仍是只读的，没有写入口。
 */
export type TaskActivityRow = {
  /** 稳定身份：`task:<runId>` | `job:<id>` | `group:<requestId>` | `skill:<skillRunId>:<stepId>`。 */
  key: string;
  kind: TaskActivityRowKind;
  title: string;
  secondary?: string;
  detail?: string;
  status: string;
  state: string;
  tone: TaskActivityRowTone;
  progress?: number;
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

export type TaskActivityStoreSnapshot = {
  /** 统一记录列表：全部来源按开始时间从新到旧交错（change: 2026-10-22，design D5）。 */
  rows: readonly TaskActivityRow[];
  /**
   * @deprecated 过渡字段，由 `rows` 派生；改用 `rows`。
   * 生成任务记录（含本地 optimistic/local-failure 标记）。
   */
  items: TaskActivityFeedItem[];
  /**
   * @deprecated 过渡字段，由 `rows` 派生；改用 `rows`。
   * 扩展后台活动（非 durable 任务），例如镜头参考录制。
   */
  jobs: BackgroundActivityJob[];
  unread: number;
  cursor: number;
  hasActive: boolean;
};

/**
 * feature-owned 只读活动 store capability（由 task-activity extension 提供）。
 *
 * change: 2026-10-10-extract-optional-feature-extensions，design D4/D6。
 */
export type TaskActivityStoreService = {
  getSnapshot(): TaskActivityStoreSnapshot;
  subscribe(listener: () => void): () => void;
};
