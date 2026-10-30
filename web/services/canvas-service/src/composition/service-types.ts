import type { FilmSetNodeOutcome, ReadFilmSetOutcome, ImportFilmSetContentOutcome } from "@woohaa3/contracts";
/**
 * Canvas Service composition：公共装配类型
 * （change: split-web-runtime-services，任务 5.1–5.6；
 *  change: 2026-10-12-add-extension-online-canvas-migration —— 抽出自 `composition.ts`
 *  以保持组合根文件聚焦生命周期编排）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasRepository } from "../storage/core/index.js";
import type { YjsDocumentRepository, ProjectionReceiptStore, CanvasWriterLock } from "../sync/index.js";
import type { SyncUpgradeHandler } from "../sync/upgrade.js";
import type { CanvasStorageComposition, CanvasStorageConfig } from "../storage/composition.js";
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import type {
  ResourceAccessPolicy,
  ResourceDirectory,
  ResourceLifecyclePolicy,
  StorageProfile
} from "@woohaa3/contracts";
import type { CanvasRunService } from "../task/run-service.js";
import type { TaskResultConsumer } from "../task/result-consumer.js";
import type { CanvasTaskClient } from "../clients/task-client.js";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { SnippetComposition } from "../storage/snippet-composition.js";
import type { SnippetRepository } from "../storage/core/snippet-contracts.js";
import type { NodeHistoryComposition } from "../storage/node-history-composition.js";
import type { NodeHistoryRepository } from "../storage/core/node-history-contracts.js";
import type { RendererClient } from "../model-renderer/index.js";
import type { ModelMcpService, CreateFilmSetNodeOutcome } from "../model-mcp/index.js";
import type { AgentCanvasInternalService } from "../agent-authoring/index.js";
import type { MutateFilmSetItemOutcome } from "../model-mcp/internal-api.js";
import type {
  McpCreateFilmSetNodeRequest,
  McpImportModelSnapshotRequest,
  McpImportFilmSetContentRequest,
  McpCommitAnimationRequest,
  McpConfirmAdaptationRequest,
  McpMutateFilmSetItemRequest
} from "@woohaa3/contracts";
import type { CanvasSourcePort } from "../import/contracts.js";
import type { CanvasImportService } from "../import/service.js";
import type { SqliteCanvasImportStore } from "../storage/sqlite/canvas-import.js";
import type { CanvasAccessPort, CanvasRequestAuthenticator } from "../access/resolve-access.js";

export type CanvasServiceOptions = {
  assistantTextRuns?: import("@woohaa3/contracts").AssistantTextRunGateway;
  /**
   * Skill 尝试校验（change: 2026-10-28-add-agent-skill-media-regeneration）。
   *
   * 懒读取 Application Service 的当前 attempt；缺失时保持旧 run 语义（不启用 continuation）。
   */
  skillAttempts?: () => import("../agent-authoring/run-adapter.js").SkillAttemptGuard | undefined;
  /**
   * 任务终态投影后的 Skill 结算回调。必须只记录历史，不得覆盖节点当前结果；
   * 实现方可异步收敛，失败由查询复核兜底。
   */
  onRunSettled?: (record: import("../sync/task-projector.js").PptaskExecutionRecord) => void;
  /**
   * 复合内容聚合端口（预览/历史帧 + 转片场等能力）：由内容扩展实现、backend 宿主装配时注入。
   * 注入后 canvas-service 不再 import 任何扩展实现；缺失的组在宿主侧明确不可用。
   */
  contentRuntime?: import("@woohaa3/contracts").CanvasContentRuntime;
  /**
   * 原生录制 submit/cancel/status（change: 2026-10-17-add-native-offscreen-film-set-recording）。
   *
   * 未注入时录制路由返回 503 `recording-unavailable`，前端据此显示具体原因。
   */
  recording?: import("@woohaa3/contracts").CanvasRecordingPort;
  /**
   * 当前主题的镜头预览清屏色（`#rrggbb`）；镜头背景为 `theme` 且 agent 经 MCP 导出时使用
   * （change: 2026-10-19-extend-film-set-for-motion-graphics，D6）。
   */
  themeBackdrop?: () => string;
  /**
   * 资源/身份运行时开关（change: 2026-10-13-add-enterprise-access-and-production-deployment）。
   *
   * `{ enabled: true }` 表示由注入的 `authenticate`/`access` 接管入口授权，禁用历史
   * 「loopback 即信任」边界；缺省（undefined）保持独立单元/本机部署的历史行为。
   */
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  env?: Record<string, string | undefined>;
  repository?: CanvasRepository;
  yjsRepository?: YjsDocumentRepository;
  /**
   * 存储实现解析出的画布存储配置（bootstrap `storage` 槽位注入）。提供时不再从 `env` 重新解析
   * （部署侧凭据可以只放在扩展目录的配置文件里）。
   */
  storageConfig?: CanvasStorageConfig;
  taskClient?: CanvasTaskClient;
  mediaClient?: CanvasMediaClient;
  resolveCatalog?: () => Promise<CanvasTaskCatalog>;
  enableCanvasStorage?: boolean;
  enableYjsSync?: boolean;
  syncAllowedOrigins?: readonly string[];
  projectionReceipts?: ProjectionReceiptStore;
  /** 部署级 writer lock（单实例约束）；省略时按 backend 构造 durable 锁。 */
  writerLock?: CanvasWriterLock;
  /** 实例 id（writer lock 持有者标识）；默认 hostname+pid。 */
  instanceId?: string;
  reconcileIntervalMs?: number;
  /** 是否挂载模型 MCP HTTP 面（/mcp/model-canvas 与 /api/model-mcp/*）；默认挂载。 */
  enableModelMcp?: boolean;
  /** 是否挂载提示词片段目录面（/api/prompt-snippets）；默认挂载。 */
  enablePromptSnippets?: boolean;
  /** 测试注入：片段目录仓库。 */
  snippetRepository?: SnippetRepository;
  /** 测试注入：节点历史仓库（change: add-canvas-node-generation-history）。 */
  nodeHistoryRepository?: NodeHistoryRepository;
  /** bootstrap `storage` 槽位注入的编辑完成回执仓库（与画布存储同一 backend）。 */
  editCompletionRepository?: import("../storage/core/edit-completion-contracts.js").EditCompletionRepository;
  /** 是否挂载节点历史面（/api/canvas-node-history）；默认挂载。 */
  enableNodeHistory?: boolean;
  /** 原生 model renderer client（测试注入或自定义生命周期）；省略时按 env 配置创建。 */
  modelRenderer?: RendererClient | null;
  /**
   * 资源授权端口（change: 2026-10-13-...，任务 4.4/6.1/6.2）。缺省由 `resourceAccessPolicy`
   * 适配；两者都缺省时 fail closed（未注入 `resourceAccessPolicy` 且未注入端口即全部拒绝）。
   */
  access?: CanvasAccessPort;
  /** 资源生命周期策略（reserve→finalize→tombstone）；缺省不提供生命周期端口。 */
  resourceLifecyclePolicy?: () => ResourceLifecyclePolicy | null;
  /** 资源访问策略（画布 ACL）。宿主注入 provenance：每次都重新查询策略，便于在线更新。 */
  resourceAccessPolicy?: () => ResourceAccessPolicy | null;
  /**
   * 资源发现目录（我的目录，与 Access 目录 handler 同一规则）。
   * 用于 Agent `list_canvases`（任务 4.4/6.5）；未提供时目录为空（fail closed）。
   */
  resourceDirectory?: () => ResourceDirectory | null;
  /** Canvas 入口认证接缝：HTTP/WS 解析可信 principal；缺省 fail closed。 */
  authenticate?: CanvasRequestAuthenticator;
  logger?: (event: Record<string, unknown>) => void;
  now?: () => string;
  /**
   * 动态上游凭据来源（可选；由宿主按 `canvas-upstream:<id>` capability 注入）。
   *
   * 这是唯一的远端同步路径：扩展登录远端后，画布同步真的改走那个会话，而不是只有界面
   * 显示「已连接」。没有它时所有画布保持纯本地。
   */
  upstreamCredential?: import("../sync/upstream/relay-upstream.js").SyncUpstreamCredentialSource | null;
  /**
   * 某张画布**刚刚建立/刷新了上游链路**时回调（宿主用它把已有媒体补传到远端存储）。
   *
   * 只承诺「这张画布属于远端」这个事实已经成立；补传是否要做、做到什么程度由宿主决定。
   * 回调是 fire-and-forget，失败不得影响同步本身。
   */
  onCanvasUpstreamLinked?: (canvasId: string) => void | Promise<void>;
  /**
   * 「画布归属远端存储」的持久记录，由宿主注入（可选；省略时只在进程内记）。
   *
   * 为什么必须在画布服务之外持久化：归属是**字节写进谁**的事实，进程重启不改变，而
   * 宿主存储层按它决定读哪个后端。只放在内存里时，重启后到房间 attach 之前这段窗口
   * 会让远端对象被当作本地对象查找——已成功生成的远端结果会被固化成「核验失败」。
   *
   * 记录只有宿主知道该落在哪（.woohaa3/ 还是桌面数据目录），画布服务只负责在
   * 「解析到远端配置」时报告，在「目录里已经存在」时补记（登录/启动后 `catalogSources`
   * 列出的画布都属于远端），在「画布被删除」时收回。
   */
  upstreamOwnership?: import("../sync/upstream/relay-upstream.js").SyncCanvasOwnershipStore;
  /**
   * 画布媒体（资产字节）的远端同步端口，由宿主注入。
   *
   * 文档同步与字节同步是两件事：Yjs 链路 `synced` 只代表文档到位，媒体可能还在补传。
   * 目录徽标据此把「文档已同步、资产仍在传」表达成 `syncing`，而不是提前说「已同步」。
   */
  mediaAssetSync?: CanvasMediaAssetSyncPort;
  /**
   * 远端**目录**来源（可选；同样由宿主按 `canvas-upstream:<id>` capability 注入）。
   *
   * 与 `upstreamCredential` 是同一份接入的两个面：一个管"内容怎么同步"，一个管
   * "目录里有哪些画布"。两个来源（本机、远端）都接上时，目录取并集——本地新建的
   * 与远端已有的出现在同一份列表里，同一个 id 只出现一次。
   *
   * 传函数时**每次列举**重新求值：宿主先装载 canvas、后激活扩展/登录，构造那一刻
   * 没有 provider；存结果会让目录永远停在纯本地（既看不到远端已有的画布）。
   */
  catalogSources?:
    | readonly import("../storage/core/index.js").CanvasCatalogRemoteSource[]
    | (() => readonly import("../storage/core/index.js").CanvasCatalogRemoteSource[]);
  /**
   * 远端删除端口（可选；宿主按同一组 `canvas-upstream` capability 注入）。
   *
   * 删除一张属于远端的画布时先问它；实现自己判定归属，不属于远端返回 `skipped`。
   * 省略时删除只作用于本机（纯本地部署）。
   */
  deleteRemote?: (canvasId: string) => Promise<import("@woohaa3/contracts").CanvasUpstreamDeleteResult>;
  /**
   * 在线迁移：来源端口（由 Backend 受控来源调用桥注入）。
   * 省略时不挂载 prepare/status/来源目录面（无来源即无迁移入口）。
   */
  canvasSources?: CanvasSourcePort;
  /** 在线迁移：导入存储（测试注入）；省略时按 SQLite backend 构造。 */
  canvasImportStore?: SqliteCanvasImportStore;
  /**
   * 在线迁移：可信主体解析（宿主认证适配器，由 Backend 注入）。
   * 缺省为拒绝（不信任客户端自报 staffId/ownerId）。
   * change: 2026-10-13-...：统一认证器异步，返回 Promise（企业 identity provider 是异步解析）。
   */
  canvasSubjectResolver?: (req: IncomingMessage) => Promise<string | null>;
  /**
   * 单节点快捷「转为片场」的生成端口（Section 2 的公开 adapter；测试可注入）。
   * 省略时图片/视频转换返回 `model-not-configured`，3D 直接复制仍可用
   * （change: 2026-10-13-add-node-to-film-set-shortcut）。
   */
  filmSetConversionGenerator?: import("@woohaa3/contracts").FilmSetConversionGenerator;
  filmSetConversionExecution?: import("@woohaa3/contracts").ContentConversionExecutionPort;
  /**
   * 转换模型提供方 capability 集合（宿主按扩展激活结果注入）。
   * 提供时服务端在调用上游之前解析实际模型并强制能力门禁（design D6）；
   * 省略时按注入的 `filmSetConversionGenerator` 自身边界处理（测试/无宿主路径）。
   */
  filmSetConversionProviders?: readonly import("@woohaa3/contracts").FilmSetConversionProvider[]
    | (() => readonly import("@woohaa3/contracts").FilmSetConversionProvider[]);
  /**
   * 「转为片场」的 owner 解析（宿主按扩展提供方的 `resolveOwner` 注入）。
   * 提供时转换路由在 HTTP 边界解析 owner（生产 `principal:`、本地开发受控会话 `local:`，
   * 可能附带 `Set-Cookie`）并冻结进记录；省略时生成端按自身边界处理。
   */
  filmSetConversionOwnerResolver?: (input: {
    subject?: string;
    cookie?: string;
  }) => import("@woohaa3/contracts").FilmSetConversionOwner | null;
  /** 媒体读取/抽帧端口（宿主注入 Media 能力）；提供方生成器据此读取真实内容。 */
  filmSetConversionMediaReader?: import("@woohaa3/contracts").FilmSetConversionMediaReader;
  /**
   * 稳定媒体字节来源（宿主 Media 能力的 `read`）；由 canvas 侧组合成
   * `FilmSetConversionMediaReader`（含 film-set 的有界 CPU 抽帧）。
   * 与 `filmSetConversionMediaReader` 二选一，后者优先。
   *
   * `canvasId` 可选：远端画布的素材只在服务端托管存储里（键 `<canvasId>/media/<key>`），
   * 转片场调用时用记录里的 `record.canvasId` 透传；省略表示与画布无关（保持旧行为）。
   */
  filmSetConversionMediaRead?: (storageKey: string, canvasId?: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
};

/** 画布媒体字节的远端同步状态（宿主维护）。 */
export type CanvasMediaAssetSyncState = {
  state: "syncing" | "synced" | "failed";
  /** 本轮需要对齐的对象总数。 */
  total: number;
  /** 本轮真正补传的对象数。 */
  copied: number;
  /** 主存储里也找不到的对象数（不影响「已同步」判断，如实计数）。 */
  missing: number;
  /** 补传失败的对象数。 */
  failed: number;
  updatedAt: number;
};

/** 宿主注入的媒体补传端口：`run` 幂等启动，`stateOf` 供目录/路由现查。 */
export type CanvasMediaAssetSyncPort = {
  run(canvasId: string, options?: { force?: boolean }): void;
  stateOf(canvasId: string): CanvasMediaAssetSyncState | undefined;
};

export type CanvasService = {
  /** 本地场景包独立事务/收据；不复用在线来源权限。 */
  scenePackages: import("../storage/sqlite/scene-package.js").SqliteScenePackageStore | null;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  sync: SyncUpgradeHandler | null;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
  /**
   * 重新解析远端同步上游（动态来源优先、静态配置回落），并按结果重建已加载 room 的中继连接。
   *
   * 扩展登录/登出远端后由宿主调用（`ApplicationExtensionCanvasFacade.refreshSyncUpstream`），
   * 以及启动完成时调用一次，覆盖「会话在扩展激活后才可用 / 运行中切换接入」两种情况。
   * 未启用同步面时是空操作。
   */
  refreshUpstream: () => Promise<void>;
  /**
   * 这张画布当前的上游同步状态；没有上游链路（纯本地画布）时返回 undefined。
   *
   * 宿主存储层据此把「属于远端的画布」的媒体读写路由到服务端托管存储。
   */
  syncStateOf: (canvasId: string) => import("@woohaa3/contracts").CanvasSyncState | undefined;
  /**
   * 这张画布**属于远端**吗（持久归属，与此刻是否连上无关）。
   *
   * 与 `syncStateOf` 的分工：「连到哪一步」用它，「字节该存哪里 / 去哪读」用这个。
   * 远端生成的结果由服务端写进托管存储，客户端读取必须走同一个后端；若用链路状态
   * 判断，断线或房间未加载时会回落本地主存储，把一个明明存在的对象报成「找不到」。
   *
   * 答案来自宿主注入的 `upstreamOwnership` 持久记录（见 CanvasServiceOptions），因此
   * 宿主重启、画布还没打开、房间被空闲回收时都仍然准确。
   */
  remoteCanvasIds: () => readonly string[];
  /** 这张画布的存储形态（字节落点 + 地址覆盖）；未覆盖时 undefined。 */
  canvasStorageProfile: (canvasId: string) => StorageProfile | undefined;
  /** 写一张画布级地址覆盖（空串表示明确不对外）。 */
  rememberCanvasExposure: (canvasId: string, exposure: string) => void;
  /**
   * 显式启动一次画布媒体补传（「同步远端」动作在文档链路建立后调用）。
   *
   * 已同步过也允许重跑（`force`）：用户点按钮时应当真的对账一次，而不是依赖上次的结论。
   */
  syncCanvasMedia: (canvasId: string) => void;
  /**
   * 启动期结算遗留 provisioning 预留（任务 11.2 / D1）。未注入生命周期提供者或画布存储不可用时
   * 返回 null（表示未执行）。
   */
  reconcileProvisioningReservations: (input?: { reservedBefore?: string }) => Promise<{ finalized: string[]; cleaned: string[]; failed: string[] } | null>;
  runService: CanvasRunService | null;
  consumer: TaskResultConsumer | null;
  /** 单节点快捷「转为片场」（change: 2026-10-13-add-node-to-film-set-shortcut）。 */
  filmSetConversionService: import("@woohaa3/contracts").FilmSetConversionServicePort | null;
  composition: CanvasStorageComposition | null;
  snippets: SnippetComposition | null;
  nodeHistory: NodeHistoryComposition | null;  writerLock: CanvasWriterLock | null;
  /** 在线迁移：导入编排服务（无来源端口时为 null）。 */
  importService: CanvasImportService | null;
  mcpServices: () => {
    modelMcp: ModelMcpService | null;
    agent: AgentCanvasInternalService | null;
    createFilmSetNode: ((input: McpCreateFilmSetNodeRequest & { canvasId: string }) => Promise<CreateFilmSetNodeOutcome>) | null;
    importModelSnapshot: ((input: McpImportModelSnapshotRequest & { canvasId: string }) => Promise<CreateFilmSetNodeOutcome>) | null;
    importFilmSetContent: ((input: McpImportFilmSetContentRequest & { canvasId: string }) => Promise<ImportFilmSetContentOutcome>) | null;
    commitAnimation: ((input: McpCommitAnimationRequest & { canvasId: string; nodeId: string; requestId: string }) => Promise<FilmSetNodeOutcome>) | null;
    confirmAdaptation: ((input: McpConfirmAdaptationRequest & { canvasId: string; nodeId: string; requestId: string }) => Promise<FilmSetNodeOutcome>) | null;
    readAnimation: ((input: { canvasId: string; nodeId: string }) => Promise<ReadFilmSetOutcome>) | null;
    mutateFilmSetItem: ((input: McpMutateFilmSetItemRequest & { canvasId: string }) => Promise<MutateFilmSetItemOutcome>) | null;
    addFilmSetMedia?: ((input: import("@woohaa3/contracts").McpAddFilmSetMediaRequest & { canvasId: string }) => Promise<import("@woohaa3/contracts").McpAddFilmSetMediaOutcome>) | null;
    exportFilmSetClip?: ((input: import("@woohaa3/contracts").McpExportFilmSetClipRequest & { canvasId: string }) => Promise<import("@woohaa3/contracts").McpExportFilmSetClipOutcome>) | null;
    getFilmSetExport?: ((input: import("@woohaa3/contracts").McpGetFilmSetExportRequest & { canvasId: string }) => Promise<import("@woohaa3/contracts").McpGetFilmSetExportOutcome>) | null;
  };
};
