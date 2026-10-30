/**
 * `ctx.services`：宿主注入的领域服务 facade（tasks / media / canvas / …）。
 *
 * 这些是**服务契约**：形状在这里定义，Application 宿主实现并通过受认证、版本化的协议提供；
 * 插件拿不到原始服务令牌、数据库或任意目标 URL。可选成员表示最小装配里可能不存在，插件按
 * 存在与否决定能力，不要假定一定注入。
 */
import type { ApplicationAuthoringServices, ApplicationPersonalGenerationFacade } from "../../assistant/authoring.js";
import type { AgentConnectionBinding, AgentReasoningEffort } from "../../assistant/conversation.js";
import type { ServerCanvas } from "../../../canvas/domain/types.js";
import type { TaskInspectionFacade } from "../../host/app-page.js";
import type { ApplicationExtensionSecretStore } from "../../host/secrets.js";
import type { ApplicationServiceConnectionFacade } from "../../host/service-connection.js";
import type { ExtensionDocumentStore } from "../../host/store.js";
import type { MediaMetadata } from "../../../media/protocol.js";
import type { TaskErrorSummary, TaskResultSummary } from "../../../task/history.js";

export type ApplicationExtensionTaskResult = {
  workerTaskKey: string;
  state: string;
  result?: TaskResultSummary;
  /** 已由 Task 历史白名单裁剪的失败摘要，供扩展给出可操作的错误。 */
  error?: TaskErrorSummary;
};

export type ApplicationExtensionMediaResourcesFacade = {
  /**
   * 读取稳定资源字节。
   *
   * `canvasId` 可选，但**能确定所属画布时必须传**：远端画布的媒体字节只存在服务端托管存储
   * （键布局 `<canvasId>/media/<key>`），本地主存储里没有；省略作用域会按 `media/<key>` 去
   * 读主存储，把一张存在的远端素材报成 404。省略表示「与画布无关」（扩展素材、独立页），
   * 保持历史行为。
   */
  read(storageKey:string,canvasId?:string,extensionId?:string):Promise<{bytes:Uint8Array;contentType:string}>;
  /**
   * 写入内容寻址的稳定资源。
   *
   * `canvasId` 语义同 `read`：属于远端画布时必须带，否则字节只落本机主存储，其他协作者
   * 与换机后的自己都读不到；省略表示与画布无关。
   */
  write(input:{bytes:Uint8Array;contentType:string;canvasId?:string}):Promise<MediaMetadata>;
  openRead?(storageKey:string,canvasId?:string):Promise<{bytes:AsyncIterable<Uint8Array>;contentType:string;size:number;cancel():void}>;
  writeStream?(input:{bytes:AsyncIterable<Uint8Array>;contentType:string;maxBytes?:number;signal?:AbortSignal;canvasId?:string}):Promise<MediaMetadata>;
};

/**
 * 完整媒体核验结果（change: 2026-10-12-add-extension-online-canvas-migration，任务 2.5）。
 *
 * 与 `stat` 的区别：`stat` 只回存在性与 contentType 的粗粒度探测；`verify` 回**完整**
 * 稳定 metadata（含真实 size 与 checksum），供来源迁移在目标同存储复用时核验，不得凭 key
 * 推断 size 或填 0。
 */
export type ApplicationExtensionMediaVerifyResult =
  | { exists: false }
  | { exists: true; metadata: MediaMetadata };

/** 插件任务关联 DTO：Task 侧持久化的恢复与查询依据（不含秘密与配置正文）。 */
export type ApplicationExtensionTaskAssociation = {
  extensionId: string;
  configVersion: number;
  /** 稳定幂等 key；同一逻辑工作重试复用。 */
  workerTaskKey: string;
};

/** 非画布插件任务提交结果（accepted 不等待 provider 终态）。 */
export type ApplicationExtensionTaskSubmitResult =
  | { ok: true; workerTaskKey: string; reused: boolean; state: string }
  | { ok: false; code: "unauthorized" | "unavailable" | "unsupported" | "key-reused" | "storage-failed"; message: string };

/** 插件可调用的 Task facade：只提交/查询/取消**自己拥有**的非画布任务。 */
export type ApplicationExtensionTaskFacade = {
  submit(input: {
    workerTaskKey: string;
    modelType: string;
    modelKey: string;
    prompt: string;
    parameters: Record<string, unknown>;
    inputs?: readonly { assetId: string; role: string; storageKey: string; mediaType: string; mediaKind?: string }[];
  }): Promise<ApplicationExtensionTaskSubmitResult>;
  result?(workerTaskKey: string): Promise<ApplicationExtensionTaskResult | null>;
  status(workerTaskKey: string): Promise<{ workerTaskKey: string; state: string } | null>;
  cancel(workerTaskKey: string): Promise<{ workerTaskKey: string; state: string } | null>;
};

/** 插件可调用的 Media facade：只构造稳定引用/上传结果，不接触 COS 凭据。 */
export type ApplicationExtensionMediaFacade = {
  resources?: ApplicationExtensionMediaResourcesFacade;
  stat(storageKey: string): Promise<{ exists: boolean; contentType?: string; size?: number }>;
  /**
   * 完整核验（change: 2026-10-12-add-extension-online-canvas-migration，任务 2.5）。
   *
   * 返回真实 size/checksum/contentType 或 `{ exists: false }`；只读，不接触 COS 凭据。
   * 可选：未实现的宿主下插件 MUST 按能力降级（不得用 stat 冒充已具备完整 metadata）。
   */
  verify?(storageKey: string, canvasId?: string): Promise<ApplicationExtensionMediaVerifyResult>;
};

/** 插件可调用的 Canvas facade：画布节点的 run/cancel 仍由 Canvas 生成权威 run identity。 */
export type ApplicationExtensionCanvasFacade = {
  requestNodeRun(input: {
    canvasId: string;
    nodeId: string;
    modelKey: string;
    prompt: string;
    parameters: Record<string, unknown>;
  }): Promise<{ ok: true; runId: string } | { ok: false; code: string; message: string }>;
  requestNodeCancel(input: { canvasId: string; nodeId: string; runId: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * 通知宿主重新解析画布同步上游凭据（`canvas-upstream:<id>` capability）。
   *
   * 能力交接面只提供 `resolve()`，宿主不会轮询扩展会话；因此扩展在**登录 / 登出 / 会话变化**
   * 后必须显式调用一次，否则宿主仍连着旧上游（或继续纯本地）。宿主侧解析幂等：同一份会话
   * 重复触发不会重建连接。
   *
   * 可选：未实现的宿主下扩展按能力降级（画布仍按静态配置或纯本地同步），不得把缺失当失败。
   */
  refreshSyncUpstream?(): Promise<void>;
  /**
   * 显式启动一次画布**媒体字节**补传（「同步远端」动作在文档链路建立后调用）。
   *
   * 与 `refreshSyncUpstream` 同一件事的两个面：那个把文档接到中继，这个把画布引用的存量资产
   * 对账到服务端托管存储。缺失时插件按能力降级（只同步文档），不得当作失败。
   */
  syncCanvasMedia?(canvasId: string): void;
};

/**
 * 项目读/写权限授权 facade（design D13；change: 2026-10-10-add-game-furnace-extension 任务 6.2）。
 *
 * 受控 DTO handler 不能只凭浏览器自报的 canvasId/nodeId 放行：宿主注入本 facade，插件用
 * **可信 principal.subject** 按画布读写权限判定。与 `extensionNodes` 不同，这里**不**读取/加载
 * 画布 room，只做权威授权判定，因此适用于不返回画布内容的项目元数据 handler。
 *
 * 未配置该能力的宿主下插件 MUST 按能力拒绝（fail closed），不得退回“知道 id 即可写”。
 */
export type ApplicationExtensionCanvasAccessFacade = {
  authorize(input: { subject: string; canvasId: string; permission: "read" | "write" }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
};

/** Structured assistant work uses the host conversation ledger and configured assistant connections. */
export type ApplicationExtensionAssistantFacade = {
  submit(input: { subject: string; canvasId: string; nodeId: string; requestId: string;
    connection: AgentConnectionBinding; model?: string;
    reasoningEffort?: AgentReasoningEffort; prompt: string;
    outputSchema: Record<string, unknown>; references: readonly { storageKey: string; checksum: string }[];
  }): Promise<{ ok: true; conversation?: { conversationId: string; requestId: string } } | { ok: false; code: string; message: string }>;
  query(input: { subject: string; canvasId: string; nodeId: string; requestId: string }): Promise<{
    state: string; text?: string; error?: { code: string; message: string };
    /** Exact host ledger identity for read-only conversation navigation. */
    conversation?: { conversationId: string; requestId: string };
  } | null>;
  cancel(input: { subject: string; canvasId: string; nodeId: string; requestId: string }): Promise<void>;
};

/** 仅操作通用 extension3d 节点，使用 Canvas 现有授权、CAS 与命令提交。 */
export type ApplicationExtensionNodeFacade = {
  read(input: { subject: string; canvasId: string; permission: "read" | "write" }): Promise<ServerCanvas>;
  commit(input: { subject: string; canvasId: string; nodeId: string; requestId: string; expectedRevision: number;
    value: Record<string, unknown>; create?: { position: { x: number; y: number } } }): Promise<{ revision: number }>;
};

/** 公共 Context 暴露给插件的受限服务集合；核心 Context 不属于可关闭插件集合。 */
export type ApplicationExtensionServices = {
  serviceConnections?: ApplicationServiceConnectionFacade;
  assistants?: ApplicationExtensionAssistantFacade;
  extensionNodes?: ApplicationExtensionNodeFacade;
  tasks: ApplicationExtensionTaskFacade;
  media: ApplicationExtensionMediaFacade;
  canvas: ApplicationExtensionCanvasFacade;
  /**
   * 项目读/写权限授权（design D13；任务 6.2）。
   * 可选：未配置的宿主不提供，插件 MUST fail closed，不得仅凭 canvasId/nodeId 放行。
   */
  canvasAccess?: ApplicationExtensionCanvasAccessFacade;
  /**
   * 受用户委托约束的 authoring/工具/个人生成端口（design D7/D8）。
   * 可选：未配置的宿主不提供，插件须按能力声明回退。
   */
  authoring?: ApplicationAuthoringServices;
  /** 按 plugin/owner/purpose 隔离的加密秘密仓库（design D5）。 */
  secrets?: ApplicationExtensionSecretStore;
  /** 个人生成能力（账户模型目录/可执行性；design D8）。 */
  personalGeneration?: ApplicationPersonalGenerationFacade;
  /**
   * owner-scoped 隔离通用数据存储（change: 2026-10-13-...，任务 0.4）。owner 来自可信
   * registration（extensionId），不来自请求体；facade 拒绝跨 owner 访问。
   */
  documents?: ExtensionDocumentStore;
  /**
   * 受限任务监控 facade（change: 2026-10-13-...，任务 0.6）：要求 `tasks.inspect` 并在
   * repository 查询前校验；只交给声明该 action 的 extension。
   */
  taskInspection?: TaskInspectionFacade;
};
