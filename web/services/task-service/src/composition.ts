/**
 * Task Service composition root（change: split-web-runtime-services，任务 4.1–4.5；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R10 —— 抽出 provider
 *  input / catalog runtime / HTTP handler 子模块，本文件保留唯一生命周期编排）。
 *
 * 独立运行单元：durable task store + history read model + provider catalog + worker runtime +
 * 内部 submit/cancel/status 与受保护的浏览器只读 history API。
 *
 * API 与 worker 首版同进程。**不**读取 `COS_*`、**不**写 Canvas。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMemoryJobRepository, type PptaskJobRepository } from "@sdppp/pptask";
import { createInProcessDispatchNotifier } from "@sdppp/pptask-worker-server";
import { createSqliteTaskStore, type SqliteTaskStore } from "./repository/sqlite-task-store.js";
import {
  createSqliteTaskHistoryRepository,
  type SqliteTaskHistoryRepository,
  type HistoryRecordInput
} from "./repository/history-repository.js";
import { createSqliteSubmitKeyRepository, computeSubmitPayloadHash } from "./repository/submit-keys.js";
import { createTaskRuntime, type TaskRuntime, type TaskAssociation } from "./worker/runtime.js";
import { createResultArchiver } from "./worker/result-archive.js";
import { recoverTerminalHistory } from "./worker/terminal-recovery.js";
import { stripSecrets } from "./worker/normalize.js";
import { createMediaClient, type MediaClient } from "./clients/media-client.js";
import { resolveTaskServiceConfig, type PptaskEnvConfig } from "./config/env.js";
import type { ArkVideoImageAsset, ArkVideoImageAssetInput } from "./providers/ark-types.js";
import { parseModelsConfig, type ModelsConfig } from "./config/models-config.js";

export { parseModelsConfig };
export type { PptaskEnvConfig };
import { createTaskApiHandler } from "./api/internal-api.js";
import { createTaskHistoryHandler } from "./api/history-api.js";
import { createExtensionTaskFacade } from "./application/extension-tasks.js";
import { createTaskInspectionFacade } from "./application/task-inspection.js";
import { createTaskExtensionTaskApiHandler, type TaskExtensionTaskApiDependencies } from "./api/extension-task-api.js";
import { createSqliteExtensionTaskAssociationRepository } from "./repository/extension-task-association-repository.js";
import {
  CANVAS_TASK_LIMITS,
  type BackendTaskPort,
  type CanvasTaskActivityEventBatch,
  type CanvasTaskActivitySnapshot,
  type CanvasTaskCatalog,
  type PrincipalContext,
  type TaskInspectionFacade,
  type TaskAdmissionVersions,
  type TaskSubmitRequest,
  type TaskSubmitResponse,
  type TaskExecutionState,
  type TaskExecutionDetail,
  withWorldCaptureTaskInput,
  worldCaptureReferenceInput
} from "@woohaa3/contracts";
import { buildProviderInputForResource } from "./composition/provider-input.js";
import { resolveReferenceUrls, type ReferenceObjectReader } from "./composition/reference-urls.js";
import { createCatalogRuntime } from "./composition/catalog-runtime.js";
import {
  createCatalogHandler,
  createHealthHandler,
  recordState
} from "./composition/http-handlers.js";

/**
 * 提交阶段失败原因的安全化：历史不得落签名 URL 或凭据（spec「临时 URL MUST NOT 出现在 Task history」）。
 * 先抹掉 URL 形态的片段，再走统一的 secrets 清理与长度上限。
 */
function safeSubmitFailureReason(reason: string): string {
  return stripSecrets(reason.replace(/https?:\/\/\S+/gi, "[url]"));
}

export type TaskServiceOptions = {
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  env?: Record<string, string | undefined>;
  modelsConfig: ModelsConfig;
  storePath?: string;
  serviceToken?: string;
  mediaServiceUrl?: string;
  ensureVideoImageAsset?: (input: ArkVideoImageAssetInput) => Promise<ArkVideoImageAsset>;
  /** 读取参考输入字节（Provider 自带上传用）；缺省时参考输入只走存储 expose 签出地址。 */
  readReferenceObject?: ReferenceObjectReader;
  mediaClient?: MediaClient;
  jobRepository?: PptaskJobRepository;
  workerServer?: import("@sdppp/pptask-worker-server").PptaskWorkerServer;
  fetchImpl?: typeof globalThis.fetch;
  logger?: (event: Record<string, unknown>) => void;
  historyRetentionDays?: number;
  historyMaxRecords?: number;
  generationProviders?: () => readonly import("@woohaa3/contracts").GenerationProvider[];
  serviceConnections?: {
    freeze(providerId: string, modelId: string, modelType: string, selected?: TaskSubmitRequest["serviceConnection"]): Promise<(import("@woohaa3/contracts").ServiceConnectionResolve & { owner?: string }) | null>;
    resolve(reference: import("@woohaa3/contracts").ServiceConnectionResolve & { owner?: string }, providerId: string): Promise<unknown>;
  };
  /**
   * 运营策略版本戳：只改启用集合时，任务目录（模型 catalog）也要重算。
   * 与 `composition/types.ts` 的同名选项一致；统一后端按当前策略 revision 注入。
   */
  selectionStamp?: () => string;
  resolveModelSelection?: (registry: ReadonlyArray<{ modelKey: string; providerId: string; providerModelId: string; modelType: import("@woohaa3/contracts").CanvasTaskModelType }>) =>
    | { ok: true; models: import("./config/models-config.js").ResolvedModel[]; defaults: Partial<Record<import("@woohaa3/contracts").CanvasTaskModelType, string>> }
    | { ok: false; reason: string };
};

export type TaskService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
  runtime: () => TaskRuntime | null;
  catalog: () => Promise<CanvasTaskCatalog>;
  /**
   * 任务目录修订（单调，轻量读）。宿主在已被轮询的管理快照里透出它，浏览器据此使已打开画布的
   * 目录缓存失效；不触发完整 catalog 构建。
   */
  catalogRevision: () => number;
  history: () => SqliteTaskHistoryRepository;
  /**
   * 受限任务监控 facade（恢复自迁移前的 `composition.ts`）：宿主注入查询前授权检查。
   */
  taskInspection: (assertAuthorized: (principal: PrincipalContext) => Promise<void>) => TaskInspectionFacade;
  taskStore: () => SqliteTaskStore;
  port: () => BackendTaskPort;
  start: () => void;
};

/** 孤儿提交对账的宽限期。 */
export const ORPHAN_GRACE_MS = 2 * 60 * 1000;
/** 对账周期。 */
export const ORPHAN_RECONCILE_INTERVAL_MS = 30 * 1000;

/**
 * Task → Media 的内部请求超时（仅分立部署走 HTTP client 时生效）。
 *
 * 不能沿用内部请求的 5s 默认值：转存是一次「受控下载最多 30s + 写入存储」的同步调用，
 * 5s 会让慢下来的 provider 输出在客户端侧先失败（服务端其实还在跑）。
 */
const MEDIA_TRANSPORT_TIMEOUT_MS = 40_000;

export function createTaskService(options: TaskServiceOptions): TaskService {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const configResult = resolveTaskServiceConfig({ ...env, ...(options.storePath ? { WOOHAA3_TASK_STORE_PATH: options.storePath } : {}) });
  if (!configResult.ok) throw new Error(configResult.reason);
  const config = { ...configResult.config, ...(options.serviceToken ? { serviceToken: options.serviceToken } : {}) };

  // Media client 必须先于 task store 建：store 的「落库前归档」钩子要把 provider 字节
  // 转存成稳定对象，记录里只留引用（见 worker/result-archive.ts）。
  const mediaClient =
    options.mediaClient ??
    (options.mediaServiceUrl ?? config.mediaServiceUrl
      ? createMediaClient({
          baseUrl: (options.mediaServiceUrl ?? config.mediaServiceUrl) as string,
          serviceToken: config.serviceToken,
          // Media 的受控下载预算是 30s（DEFAULT_IMPORT_TIMEOUT_MS）；用内部请求的 5s 默认值
          // 会在分立部署下先打断转存（视频/大图必然踩），这里给下载留出同样预算 + 写入余量。
          timeoutMs: MEDIA_TRANSPORT_TIMEOUT_MS,
          fetchImpl: options.fetchImpl,
          logger: options.logger
        })
      : undefined);

  const taskStore = createSqliteTaskStore({
    path: config.storePath,
    transformPayload: createResultArchiver({ mediaClient, logger: options.logger })
  });
  const history = createSqliteTaskHistoryRepository({
    path: config.storePath,
    maxEventsPerRecord: config.historyMaxEventsPerRecord
  });
  const submitKeys = createSqliteSubmitKeyRepository({ path: config.storePath });
  const jobRepository = options.jobRepository ?? createMemoryJobRepository();

  const { registry, resolveCatalog, catalogRevision } = createCatalogRuntime({
    ...(options.generationProviders ? { generationProviders: options.generationProviders } : {}),
    modelsConfig: options.modelsConfig,
    ...(options.resolveModelSelection ? { resolveModelSelection: options.resolveModelSelection } : {}),
    ...(options.selectionStamp ? { selectionStamp: options.selectionStamp } : {})
  });

  const notifier = createInProcessDispatchNotifier();

  const resolveAdmissionVersions = async (
    request: TaskSubmitRequest,
    extensionAssociation?: { extensionId: string; configVersion: number }
  ): Promise<TaskAdmissionVersions> => {
    const admission: TaskAdmissionVersions = {};
    try {
      const catalog = await resolveCatalog();
      if (typeof catalog.catalogRevision === "number") admission.catalogRevision = catalog.catalogRevision;
      const model = catalog.models.find(
        (entry) => entry.modelKey === request.modelKey && entry.modelType === request.modelType
      );
      if (model && typeof model.schemaRevision === "number") admission.schemaRevision = model.schemaRevision;
      if (model && typeof model.configVersion === "number") admission.configVersion = model.configVersion;
    } catch {
      // 目录不可用：受理版本缺失，不阻断提交（执行路径会再校验 catalog）。
    }
    if (extensionAssociation) admission.extensionConfigVersion = extensionAssociation.configVersion;
    return admission;
  };

  let runtimePromise: Promise<TaskRuntime> | null = null;
  const resolveRuntime = (): Promise<TaskRuntime> => {
    runtimePromise ??= (async () => {
      if (registry().resources.length === 0 && !options.workerServer) throw new Error("任务凭据不可用");
      return createTaskRuntime({
        taskStore,
        history,
        provider: undefined as never,
        providerId: registry().resources[0]?.providerId ?? "test",
        resolveProvider: async (providerId: string | undefined, record?: import("@sdppp/pptask-worker-server").PptaskTaskRecord) => {
          const reference = (record?.context as { serviceConnection?: import("@woohaa3/contracts").ServiceConnectionResolve } | undefined)?.serviceConnection;
          if (reference) {
            if (!options.serviceConnections || !providerId) throw Object.assign(new Error("来源解析器不可用"), { sourceStale: true });
            return await options.serviceConnections.resolve(reference, providerId) as import("@sdppp/pptask").PptaskProvider;
          }
          return registry().resolveProvider(providerId);
        },
        mediaClient,
        jobRepository,
        notifier,
        concurrency: config.workerConcurrency,
        leaseMs: config.leaseMs,
        recoveryIntervalMs: config.recoveryIntervalMs,
        recoveryJitterMs: config.recoveryJitterMs,
        shutdownGraceMs: config.shutdownGraceMs,
        server: options.workerServer,
        logger: (event) => options.logger?.(event)
      });
    })();
    return runtimePromise;
  };

  /**
   * 启动终态对账：调度 store 已终结、执行历史仍非终态的记录（二进制结果转存 Media 途中被
   * 重启）重放终态投影，让画布补偿能读到终态并投影资产。
   *
   * 与 dispatcher 的启动恢复互补：dispatcher 只接管非终态调度记录，本对账只处理终态记录；
   * 对账失败只记日志，绝不阻塞启动与任务受理。
   */
  let terminalRecovery: Promise<void> | null = null;
  const startTerminalRecovery = (): Promise<void> => {
    terminalRecovery ??= recoverTerminalHistory({
      taskStore,
      history,
      ...(mediaClient ? { mediaClient } : {}),
      ...(options.logger ? { logger: options.logger } : {})
    })
      .then(() => undefined)
      .catch((error) => {
        options.logger?.({
          event: "task-terminal-recovery-startup-failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    return terminalRecovery;
  };

  const startRuntimeRecovery = (): void => {
    if (registry().resources.length > 0 || options.workerServer) {
      void resolveRuntime().catch((error) => {
        options.logger?.({
          event: "task-runtime-startup-failed",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
  };

  if (!options.generationProviders) {
    startRuntimeRecovery();
  }
  // 独立入口没有 host/ready 事件，构造即开始对账；统一宿主里 `start()` 会先跑对账再起 worker。
  void startTerminalRecovery();

  /** submit：登记业务关联 → 调度任务。 */
  const submit = async (
    request: TaskSubmitRequest,
    extensionAssociation?: { extensionId: string; configVersion: number }
  ): Promise<{ reused: boolean; state: TaskExecutionState; conflict?: boolean; mediaError?: string }> => {
    const association: TaskAssociation = {
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      runId: request.runId,
      jobId: request.jobId
    };
    if (extensionAssociation) {
      const owner = extensionTaskAssociations.find(request.workerTaskKey);
      if (owner && owner.extensionId !== extensionAssociation.extensionId) throw new Error("任务不属于该扩展");
      if (!owner && history.get(request.workerTaskKey)) throw new Error("扩展不能接管既有画布任务");
      extensionTaskAssociations.upsert({
        workerTaskKey: request.workerTaskKey,
        extensionId: extensionAssociation.extensionId,
        configVersion: extensionAssociation.configVersion,
        modelType: request.modelType,
        canvasId: null,
        createdAt: new Date().toISOString()
      });
    }
    const now = new Date().toISOString();
    // T10: the claimed framing is carried as a stable reference input as well as
    // metadata. Normalizing here covers in-process ports that did not come through
    // the HTTP decoder; the helper de-duplicates an already materialized input.
    const inputs = withWorldCaptureTaskInput(request.inputs, request.worldCapture);
    const payloadHash = computeSubmitPayloadHash({ ...request, inputs });
    const claim = submitKeys.claim(request.workerTaskKey, payloadHash, now);
    if (claim.conflict) {
      return { reused: false, state: "queued", conflict: true };
    }

    const resource = registry().resolveResource(request.modelKey);
    const providerId = resource?.providerId ?? "litellm";
    const providerModelId = resource?.providerModelId ?? request.modelKey;
    const generationProvider = options.generationProviders?.().find((entry) => entry.providerId === providerId);
    const existing = history.get(request.workerTaskKey);
    if (request.parameters.serviceConnectionId && !request.serviceConnection) throw new Error("个人来源缺少可信 owner，禁止从 HTTP 请求自报身份");

    /**
     * 提交阶段失败（provider 调用之前）落**安全失败终态**。
     *
     * spec `canvas-reference-inputs`「materialization 失败 / 签名 URL 生成失败」要求 Task Service
     * 在调用主生成接口前把任务置为安全失败终态，由 projector 消费。此前只把 `mediaError` 返回给
     * 调用方、不写终态：画布节点永远停在 processing（job 一直是 running），生成溯源按 taskKey
     * 读详情必然 404（被展示成「任务不存在或已超过保留期」），任务监控里也完全没有这条失败。
     */
    const markSubmitFailed = (reason: string, errorName: string): void => {
      const failedAt = new Date().toISOString();
      const message = safeSubmitFailureReason(reason);
      history.upsertRecord({
        taskKey: request.workerTaskKey,
        state: "failed",
        providerId,
        ...(request.modelType ? { modelType: request.modelType } : {}),
        modelKey: request.modelKey,
        ...(request.modelTitle ? { modelTitle: request.modelTitle } : {}),
        ...(request.providerName ? { providerName: request.providerName } : {}),
        ...(extensionAssociation
          ? {}
          : {
              ...(association.canvasId ? { canvasId: association.canvasId } : {}),
              ...(request.canvasTitle ? { canvasTitle: request.canvasTitle } : {}),
              ...(association.nodeId ? { nodeId: association.nodeId } : {}),
              ...(request.nodeTitle ? { nodeTitle: request.nodeTitle } : {}),
              ...(association.runId ? { runId: association.runId } : {})
            }),
        ...(association.jobId && !extensionAssociation ? { jobId: association.jobId } : {}),
        // inputs 只带稳定引用身份（assetId/storageKey/role/mediaType），执行期签出 URL 不入库。
        request: { prompt: request.prompt, parameters: request.parameters, inputs, ...(request.worldCapture ? { worldCapture: request.worldCapture } : {}) },
        source: extensionAssociation ? "extension" : "canvas",
        ...(extensionAssociation ? { extensionId: extensionAssociation.extensionId } : {}),
        error: { name: errorName, message },
        createdAt: existing?.createdAt ?? failedAt,
        updatedAt: failedAt,
        finishedAt: failedAt,
        durationMs: 0
      });
      options.logger?.({
        event: "task-submit-failed",
        taskKey: request.workerTaskKey,
        code: errorName,
        reason: message
      });
    };

    if (request.worldCapture) {
      const captureReference = worldCaptureReferenceInput(request.worldCapture);
      if (!captureReference.ok) {
        markSubmitFailed(captureReference.message, "CaptureMediaUnavailable");
        return { reused: false, state: "failed", mediaError: captureReference.message };
      }
    }

    if (claim.reused) {
      const scheduled = await taskStore.find(request.workerTaskKey);
      if (scheduled) {
        return { reused: true, state: recordState(scheduled.status) };
      }
      options.logger?.({ event: "task-submit-reschedule", taskKey: request.workerTaskKey });
    }
    let sourceReference: import("@woohaa3/contracts").ServiceConnectionResolve | null = null;
    try { if (request.serviceConnection && !options.serviceConnections) throw new Error("来源解析器未装配"); sourceReference = await options.serviceConnections?.freeze(providerId, providerModelId, request.modelType, request.serviceConnection) ?? null; }
    catch { markSubmitFailed("服务来源不可用或已变化，请重新确认配置", "ServiceConnectionUnavailable"); return { reused: false, state: "failed" }; }
    // 参考输入的位置解析：Provider 先自己上传（拿到 locator 或它自己素材服务的 url），
    // 不行才由存储 expose 签出执行期地址。两种结果都记下来，Provider 按能力挑一个。
    let referenceUrls: string[] = [];
    let referenceLocators: Array<string | undefined> = [];
    if (inputs.length > 0) {
      const resolved = await resolveReferenceUrls({
        inputs,
        ...(extensionAssociation ? {} : { scope: { canvasId: request.canvasId } }),
        provider: request.serviceConnection ? undefined : generationProvider,
        readReferenceObject: options.readReferenceObject,
        mediaClient,
        expiresSeconds: CANVAS_TASK_LIMITS.referenceUrlTtlSeconds,
        logger: options.logger
      });
      if (!resolved.ok) {
        // 调 provider 之前就已知失败：落失败终态（spec「签名 URL 生成失败」）。
        markSubmitFailed(resolved.reason, "ReferenceInputUnavailable");
        return { reused: false, state: "failed", mediaError: resolved.reason };
      }
      referenceUrls = resolved.urls;
      referenceLocators = resolved.locators;
    }
    const admission = await resolveAdmissionVersions(request, extensionAssociation);
    const initial: HistoryRecordInput = {
      taskKey: request.workerTaskKey,
      state: existing?.state ?? "queued",
      providerId,
      modelType: request.modelType,
      modelKey: request.modelKey,
      ...(request.modelTitle ? { modelTitle: request.modelTitle } : {}),
      ...(request.providerName ? { providerName: request.providerName } : {}),
      ...(extensionAssociation
        ? {}
        : {
            ...(association.canvasId ? { canvasId: association.canvasId } : {}),
            ...(request.canvasTitle ? { canvasTitle: request.canvasTitle } : {}),
            ...(association.nodeId ? { nodeId: association.nodeId } : {}),
            ...(request.nodeTitle ? { nodeTitle: request.nodeTitle } : {}),
            ...(association.runId ? { runId: association.runId } : {})
          }),
      ...(association.jobId && !extensionAssociation ? { jobId: association.jobId } : {}),
      // inputs 只带稳定引用身份（assetId/storageKey/role/mediaType），执行期签出 URL 不入库。
      request: { prompt: request.prompt, parameters: request.parameters, inputs, ...(request.worldCapture ? { worldCapture: request.worldCapture } : {}) },
      source: extensionAssociation ? "extension" : "canvas",
      ...(extensionAssociation ? { extensionId: extensionAssociation.extensionId } : {}),
      ...(Object.keys(admission).length > 0 ? { admission } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      durationMs: existing?.durationMs ?? 0
    };
    history.upsertRecord(initial);


    let providerInput: Record<string, unknown>;
    // 交给 Provider 的不只是执行期 URL：远端托管 Provider 需要画布身份（服务端 ACL/对象键
    // 作用域）、客户端幂等键，以及参考输入的稳定身份（storageKey/assetId）。URL 仍保留给
    // 本机 Provider；远端 Provider 只应使用稳定身份，不把签名地址交给服务端。
    const { serviceConnectionId: _selectedSource, ...providerParameters } = request.parameters;
    const providerInputContext = {
      providerModelId,
      modelType: request.modelType,
      prompt: request.prompt,
      parameters: providerParameters,
      references: inputs.map((input, index) => ({
        role: input.role,
        ...(input.mediaKind ? { mediaKind: input.mediaKind } : {}),
        mediaType: input.mediaType,
        // 位置二选一：locator（本部署存储）优先，没有才给执行期地址。空串不入契约。
        ...(referenceLocators[index] ? { locator: referenceLocators[index] as string } : {}),
        ...(!referenceLocators[index] && referenceUrls[index] ? { url: referenceUrls[index] as string } : {}),
        assetId: input.assetId,
        storageKey: input.storageKey
      })),
      ...(association.canvasId ? { canvasId: association.canvasId } : {}),
      taskKey: request.workerTaskKey,
      ...(association.runId ? { runId: association.runId } : {})
    };
    const resolvedModelId = (await generationProvider?.resolveProviderModel?.(providerInputContext)) ?? providerModelId;
    try {
      if (generationProvider?.prepareInput) {
        providerInput = await generationProvider.prepareInput({ ...providerInputContext, endpoint: resolvedModelId });
      } else {
        providerInput = await buildProviderInputForResource({
          request: { ...request, parameters: providerParameters },
          referenceUrls,
          providerId,
          mediaClient,
          ensureVideoImageAsset: options.ensureVideoImageAsset,
          ...(options.logger ? { logger: options.logger } : {})
        });
      }
    } catch (error) {
      const reason = error instanceof Error && error.message !== "" ? error.message : "参考输入 materialization 失败";
      markSubmitFailed(reason, "ReferenceInputUnavailable");
      return { reused: false, state: "failed", mediaError: reason };
    }

    let runtime: Awaited<ReturnType<typeof resolveRuntime>>;
    try {
      runtime = await resolveRuntime();
    } catch (error) {
      // 运行时/凭据不可用：任务从未进入调度，同样落失败终态，避免节点永久 processing。
      markSubmitFailed(error instanceof Error ? error.message : "任务运行时不可用", "RuntimeUnavailable");
      throw error;
    }
    const result = await runtime.server.submit({
      key: request.workerTaskKey,
      providerId,
      modelType: request.modelType,
      modelId: resolvedModelId,
      input: providerInput,
      context: { ...association, ...(sourceReference ? { serviceConnection: sourceReference } : {}) }
    });
    return { reused: !result.created, state: recordState(result.record.status) };
  };

  const cancel = async (workerTaskKey: string): Promise<TaskExecutionState | null> => {
    const record = await taskStore.find(workerTaskKey);
    if (!record) return null;
    const runtime = await resolveRuntime();
    await runtime.server.cancel(workerTaskKey);
    const updated = await taskStore.find(workerTaskKey);
    return recordState(updated?.status);
  };

  const status = async (workerTaskKey: string) => history.get(workerTaskKey, { fullText: true });

  const listHistory = (query: { after?: number; limit?: number }) => {
    const result = history.listSince(query.after ?? 0, query.limit ?? 200);
    return {
      items: result.messages
        .map((message) => history.get(message.record.taskKey, { fullText: true }))
        .filter((detail): detail is TaskExecutionDetail => detail !== undefined),
      cursor: result.cursor
    };
  };

  const listCanvasActivity = (canvasId: string, query: { cursor?: string; limit?: number }) =>
    history.listCanvasActivity(canvasId, query);
  const listCanvasActivitySince = (canvasId: string, after: number, limit?: number) => {
    const result = history.listCanvasActivitySince(canvasId, after, limit);
    return { items: result.items, cursor: result.cursor };
  };

  const api = createTaskApiHandler({
    resolveCatalog,
    history,
    submit,
    cancel,
    status,
    listHistory,
    listCanvasActivity,
    listCanvasActivitySince,
    mediaClient,
    serviceToken: config.serviceToken,
    logger: options.logger
  });

  const historyHandler = createTaskHistoryHandler({
    history,
    serviceToken: config.serviceToken,
    logger: options.logger,
    retentionDays: options.historyRetentionDays ?? config.historyRetentionDays,
    maxRecords: options.historyMaxRecords ?? config.historyMaxRecords
  });

  const extensionTaskAssociations = createSqliteExtensionTaskAssociationRepository({ path: config.storePath });
  const extensionTaskDependencies: TaskExtensionTaskApiDependencies = {
    resolveCatalog,
    history,
    associations: extensionTaskAssociations,
    submit: (request, association) => submit(request, association),
    cancel,
    status,
    ...(mediaClient ? { mediaClient } : {}),
    serviceToken: config.serviceToken,
    logger: options.logger
  };
  const extensionTaskApi = createTaskExtensionTaskApiHandler(extensionTaskDependencies);

  const pruneHistory = (): void => {
    try {
      const retentionDays = options.historyRetentionDays ?? config.historyRetentionDays;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      history.pruneTerminalBefore(cutoff);
      history.enforceMaxRecords(options.historyMaxRecords ?? config.historyMaxRecords);
    } catch (error) {
      options.logger?.({ event: "history-prune-failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const pruneTimer = setInterval(pruneHistory, 60 * 60 * 1000);
  pruneTimer.unref?.();

  const reconcileOrphanRuns = async (): Promise<void> => {
    try {
      const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
      for (const record of history.listUnsettledBefore(cutoff)) {
        const scheduled = await taskStore.find(record.taskKey);
        if (scheduled !== null) continue;
        const settled = history.settleOrphanFailure(record.taskKey, {
          message: "任务未进入执行队列（提交在调度前失败）",
          updatedAt: new Date().toISOString()
        });
        if (settled) options.logger?.({ event: "task-orphan-settled", taskKey: record.taskKey });
      }
    } catch (error) {
      options.logger?.({ event: "task-orphan-reconcile-failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const orphanTimer = setInterval(() => void reconcileOrphanRuns(), ORPHAN_RECONCILE_INTERVAL_MS);
  orphanTimer.unref?.();
  void reconcileOrphanRuns();

  const catalogHandler = createCatalogHandler(resolveCatalog, options.logger);
  const serviceReadiness = async (): Promise<{ ready: boolean; reason?: string }> => {
    if (registry().resources.length === 0 && !options.workerServer) {
      return { ready: false, reason: "没有可用的生成 Provider" };
    }
    return { ready: true };
  };
  const healthHandler = createHealthHandler(() => serviceReadiness(), options.logger);

  const port: BackendTaskPort = {
    extensionTasks: (extensionId, configVersion) => createExtensionTaskFacade(extensionTaskDependencies, extensionId, configVersion),
    async submit(request) {
      const outcome = await submit(request);
      if (outcome.conflict) {
        throw new Error("相同 workerTaskKey 使用了不同 payload");
      }
      if (outcome.mediaError) {
        throw new Error(outcome.mediaError);
      }
      return {
        workerTaskKey: request.workerTaskKey,
        state: outcome.state,
        reused: outcome.reused,
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        runId: request.runId
      } satisfies TaskSubmitResponse;
    },
    async cancel(workerTaskKey) {
      await cancel(workerTaskKey);
    },
    status: async (workerTaskKey) => (await status(workerTaskKey)) ?? null,
    history: async (query) => listHistory(query),
    canvasActivity: async (canvasId, query) => listCanvasActivity(canvasId, query ?? {}) as CanvasTaskActivitySnapshot,
    canvasActivitySince: async (canvasId, after, limit) =>
      listCanvasActivitySince(canvasId, after, limit) as CanvasTaskActivityEventBatch,
    canvasActivityChanges: async (canvasId, after, limit) =>
      listCanvasActivitySince(canvasId, after, limit) as CanvasTaskActivityEventBatch
  };

  return {
    runtime: () => null,
    catalog: resolveCatalog,
    catalogRevision,
    history: () => history,
    taskInspection: (assertAuthorized) => createTaskInspectionFacade({ history, assertAuthorized, ...(options.accessRuntime ? { accessRuntime: options.accessRuntime } : {}) }),
    taskStore: () => taskStore,
    port: () => port,
    start: () => {
      // 先补写历史终态，再让 dispatcher 处理新 claim：避免同一批记录被两条路径同时处置。
      void startTerminalRecovery().finally(startRuntimeRecovery);
    },
    handle: async (req, res) => {
      if (await extensionTaskApi(req, res)) return true;
      if (await api(req, res)) return true;
      if (await catalogHandler(req, res)) return true;
      if (await historyHandler(req, res)) return true;
      if (await healthHandler(req, res)) return true;
      return false;
    },
    readiness: async () => serviceReadiness(),
    close: async () => {
      clearInterval(pruneTimer);
      clearInterval(orphanTimer);
      // 对账可能还在转存：等它在停机宽限内收尾，再关掉 store 连接。
      if (terminalRecovery) {
        await Promise.race([
          terminalRecovery,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, config.shutdownGraceMs);
            timer.unref?.();
          })
        ]);
      }
      if (runtimePromise) await (await runtimePromise).close();
      history.close();
      taskStore.close();
      extensionTaskAssociations.close();
    }
  };
}

