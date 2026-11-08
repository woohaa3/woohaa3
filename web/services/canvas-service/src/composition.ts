import { ContentContributionRegistry, ManagedNodeLifecycleRegistry, worldCameraCompletionKey } from "@woohaa3/contracts";
import type { MediaStorageScope, ServerCanvas } from "@woohaa3/contracts";
import type { IncomingMessage } from "node:http";
/**
 * Canvas Service composition root（change: split-web-runtime-services，任务 5.1–5.6；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R07 —— 抽出 env/部署
 *  配置与历史观察者子模块，本文件保留生命周期编排）。
 *
 * 独占画布生命周期、语义命令、业务 revision、权威 Y.Doc、room、Yjs WebSocket、画布数据库、
 * checkpoint/update、task result projector 与 archive/restore。
 *
 * **不** import COS adapter、provider 或 worker 实现：媒体经 Media client，任务经 Task client
 * （proposal BREAKING / design D2）。首版保持单实例 writer lock。
 */
import { CanvasTaskProjector, InMemoryProjectionReceiptStore, createPublishedReader, type YjsDocumentRepository, type CanvasWriterLock } from "./sync/index.js";
import { createSyncUpgradeHandler, type SyncUpgradeHandler } from "./sync/upgrade.js";
import { createSyncUpstream, resolveUpstreamConfig, syncStateOf, type SyncUpstream } from "./sync/upstream/relay-upstream.js";
import type { SyncUpstreamCredentialSource } from "./sync/upstream/relay-upstream.js";
import { CANVAS_STORAGE_BACKEND_ENV,
  CANVAS_STORAGE_SERVICE_TOKEN_ENV,
  composeCanvasStorage,
  resolveCanvasStorageConfig,
  type CanvasStorageComposition,
  type CanvasStorageConfigResult } from "./storage/composition.js";
import { CanvasRunService } from "./task/run-service.js";
import { createTaskResultConsumer, type TaskResultConsumer } from "./task/result-consumer.js";
import { createCanvasTaskClient } from "./clients/task-client.js";
import { createCanvasMediaClient } from "./clients/media-client.js";
import { createMediaVerifierStorage } from "./clients/media-verifier.js";
import { createDurableWriterLock } from "./sync/index.js";
import { hostname } from "node:os";
import { createManagedRendererClient } from "./model-renderer/managed-client.js";
import { createRendererClient } from "./model-renderer/index.js";
import { createVideoEncoderClient } from "./model-renderer/video-encoder.js";
import { createWorldCaptureProducer } from "./world-authoring/capture-producer.js";
import { isAggregateRunNode } from "@woohaa3/contracts";
import { composeSnippets, type SnippetComposition } from "./storage/snippet-composition.js";
import { composeNodeHistory, type NodeHistoryComposition } from "./storage/node-history-composition.js";
import { composeWorldCameraHistory, type WorldCameraHistoryComposition } from "./storage/world-camera-history-composition.js";
import { composeAssistantHostCompletions, type AssistantHostCompletionComposition } from "./storage/host-completion-composition.js";
import { AgentDeltaJournal } from "./agent-authoring/index.js";
import {
  CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV,
  CANVAS_MEDIA_SERVICE_TOKEN_ENV,
  CANVAS_MEDIA_SERVICE_URL_ENV,
  CANVAS_MCP_SERVICE_TOKEN_ENV,
  CANVAS_MODEL_RENDERER_CMD_ENV,
  CANVAS_MODEL_RENDERER_TIMEOUT_ENV,
  CANVAS_WORLD_VIDEO_ENCODER_CMD_ENV,
  CANVAS_TASK_SERVICE_TOKEN_ENV,
  CANVAS_TASK_SERVICE_URL_ENV,
  resolveAgentDeploymentProfile
} from "./composition/deployment.js";
import {
  recordModelPlacementHistory,
  registerTaskFailureRecord,
  registerTaskHistoryRecord
} from "./composition/history-observers.js";
import { buildMcpServicesProjection } from "./composition/mcp-services.js";
import { buildMcpRuntime } from "./composition/mcp-runtime.js";
import { composeRequestHandler } from "./composition/handlers.js";
import { composeOnlineMigration } from "./composition/online-migration.js";
import { canvasAccessFromPolicy, lifecyclePortFromPolicy, denyingCanvasAccessPort } from "./access/resolve-access.js";
import { createDiscoverableCanvasIds } from "./access/policy-agent-access.js";
import { composeImportedFirstCanvasAccess, importedPermissionFor, type ImportedCanvasAccessResolver } from "./access/import-access-port.js";
import type { CanvasAccessPort, CanvasLifecyclePort } from "./access/resolve-access.js";
import type { PrincipalContext } from "@woohaa3/contracts";
import type { CanvasMediaAssetSyncState, CanvasService, CanvasServiceOptions } from "./composition/service-types.js";
import { createWorldConversionService } from "./world-authoring/conversion-service.js";
import { createWorldAuthoringAuthority } from "./world-authoring/authority.js";
import { createWorldAuthoringService } from "./world-authoring/scene-area-service.js";
import { createWorldCameraSettingsService, type WorldCameraCompletionVerification } from "./world-authoring/camera-service.js";
import { createAssistantWorldService } from "./world-authoring/assistant-service.js";
import { createWorldCaptureService, type WorldCaptureService } from "./world-authoring/capture-service.js";

export type { CanvasMediaAssetSyncPort, CanvasMediaAssetSyncState, CanvasService, CanvasServiceOptions } from "./composition/service-types.js";

export {
  DEFAULT_CANVAS_ID,
  CANVAS_TASK_SERVICE_URL_ENV,
  CANVAS_MEDIA_SERVICE_URL_ENV,
  CANVAS_TASK_SERVICE_TOKEN_ENV,
  CANVAS_MEDIA_SERVICE_TOKEN_ENV,
  CANVAS_MCP_SERVICE_TOKEN_ENV,
  CANVAS_MODEL_RENDERER_CMD_ENV,
  CANVAS_MODEL_RENDERER_TIMEOUT_ENV,
  CANVAS_WORLD_VIDEO_ENCODER_CMD_ENV,
  CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV,
  CANVAS_AGENT_LOOPBACK_MODE_ENV,
  resolveAgentDeploymentProfile
} from "./composition/deployment.js";
export type { AgentDeploymentProfile } from "./composition/deployment.js";
export { recordModelPlacementHistory } from "./composition/history-observers.js";

/**
 * 合并「文档同步」与「媒体字节同步」两个状态。
 *
 * 文档链路 `synced` 不等于整张画布可用：字节还在补传时目录必须显示 `syncing`，失败则 `failed`。
 * 没有注入媒体同步端口（纯本地/测试）时保持文档状态。
 */
export function combineCanvasSyncState(
  base: import("@woohaa3/contracts").CanvasSyncState | undefined,
  asset: CanvasMediaAssetSyncState | undefined
): import("@woohaa3/contracts").CanvasSyncState | undefined {
  if (!base || !asset) return base;
  if (asset.state === "syncing") return "syncing";
  if (asset.state === "failed") return "failed";
  return base;
}

export async function createCanvasService(options: CanvasServiceOptions = {}): Promise<CanvasService> {
  // 统一入口认证：注入资源运行时（`accessRuntime`）时由可信 principal 判定；否则保持历史
  // 「服务令牌 / loopback」边界（独立单元与本机部署行为不变）。
  const authentication = options.accessRuntime?.enabled === false ? undefined : options.authenticate;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const contributions = options.contentRuntime?.contributions;
  const content = contributions ? new ContentContributionRegistry() : undefined;
  content?.activate(contributions ?? []);
  const managedLifecycles = new ManagedNodeLifecycleRegistry();
  for (const adapter of options.contentRuntime?.managedLifecycles ?? []) managedLifecycles.register(adapter);
  const log = options.logger ?? (() => undefined);
  const canvasEnabled =
    options.enableCanvasStorage ??
    (options.repository !== undefined || options.storageConfig !== undefined || env[CANVAS_STORAGE_BACKEND_ENV] !== undefined);

  /**
   * 存储配置的唯一解析口：bootstrap `storage` 槽位已解析时直接采用（部署侧凭据只出现在扩展目录的
   * 配置文件里），否则按本进程环境变量解析。所有子组合（Yjs 仓库 / writer lock / 结构化存储）
   * 都走这一个口，避免出现「槽位连上了、某个子面又缺环境变量」的分叉。
   */
  const resolveStorageConfig = (): CanvasStorageConfigResult =>
    options.storageConfig ? { ok: true, config: options.storageConfig } : resolveCanvasStorageConfig(env);

  // Media client 必须先于存储组合解析（资产校验 port 的生产实现就是 Media client）。
  const mediaClient =
    options.mediaClient ??
    (env[CANVAS_MEDIA_SERVICE_URL_ENV]
      ? createCanvasMediaClient({
          baseUrl: env[CANVAS_MEDIA_SERVICE_URL_ENV],
          serviceToken: env[CANVAS_MEDIA_SERVICE_TOKEN_ENV] ?? env[CANVAS_STORAGE_SERVICE_TOKEN_ENV],
          logger: log
        })
      : undefined);

  let yjsRepositoryPromise: Promise<YjsDocumentRepository> | null = null;
  /**
   * T06 production authority. It is the same instance handed to the SQLite
   * repository and to the semantic scene-area service, so acquire and commit use
   * one footprint cache. Test-injected repositories may omit it.
   */
  const spatialAuthority = options.spatialAuthority ?? createWorldAuthoringAuthority({ media: mediaClient });
  const worldAuthoringAuthority = "prepareCanvas" in spatialAuthority
    ? spatialAuthority as import("./world-authoring/authority.js").WorldAuthoringAuthority
    : null;
  const resolveYjsRepository = (): Promise<YjsDocumentRepository> => {
    if (options.yjsRepository) return Promise.resolve(options.yjsRepository);
    yjsRepositoryPromise ??= (async () => {
      const resolved = resolveStorageConfig();
      if (!resolved.ok) throw new Error(`画布存储配置无效：${resolved.reason}`);
      if (resolved.config.backend === "sqlite") {
        const { SqliteYjsRepository } = await import("./storage/sqlite/index.js");
        return new SqliteYjsRepository({ path: resolved.config.sqlitePath as string, spatialAuthority });
      }
      const { MongoYjsRepository } = await import("./storage/mongo/index.js");
      return MongoYjsRepository.connect({
        uri: resolved.config.mongoUri as string,
        database: resolved.config.mongoDb as string
      });
    })();
    return yjsRepositoryPromise;
  };

  let composition: CanvasStorageComposition | null = null;
  let unavailableReason: string | null = null;
  // 同步链路在目录之后构造；目录的同步状态读取因此走这个延迟引用。
  let upstreamRef: () => SyncUpstream | undefined = () => undefined;
  if (canvasEnabled) {
    try {
      const mediaStorage = mediaClient ? createMediaVerifierStorage({ client: mediaClient }) : undefined;
      let publishedReader: ReturnType<typeof createPublishedReader> | undefined;
      try {
        publishedReader = createPublishedReader(await resolveYjsRepository());
      } catch (error) {
        log({
          event: "canvas-catalog-unavailable",
          message: error instanceof Error ? error.message : "unknown"
        });
      }
      composition = await composeCanvasStorage({
        content,
        managedLifecycles,
        env,
        ...(options.storageConfig ? { storageConfig: options.storageConfig } : {}),
        mediaStorage,
        repository: options.repository,
        ...(publishedReader ? { publishedReader } : {}),
        // 目录来源与同步状态：远端登录后两者都生效，本地与远端取并集。
        // 来源原样转交（数组或函数），不在这里求值——求值发生在扩展装载之前，
        // 等于把"还没接上远端"写死进实例。
        ...(options.catalogSources ? { catalogSources: options.catalogSources } : {}),
        // 闭包延迟取值：`upstream` 在本段之后才构造（先有存储目录，后有同步链路）。
        catalogSyncState: (canvasId: string) =>
          combineCanvasSyncState(syncStateOf(upstreamRef(), canvasId), options.mediaAssetSync?.stateOf(canvasId)),
        // 归属同样延迟取值（upstream 在本段之后才构造）：它把"远端查不到"翻译成
        // "这个账号没有访问权限"，是进画布即提示只读的关键判据。
        catalogRemoteOwned: (canvasId: string) =>
          upstreamRef()?.remoteCanvasIds().includes(canvasId) ?? false,
        logger: (event) =>
          log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}) })
      });
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }
  }

  const taskClient =
    options.taskClient ??
    (env[CANVAS_TASK_SERVICE_URL_ENV]
      ? createCanvasTaskClient({
          baseUrl: env[CANVAS_TASK_SERVICE_URL_ENV],
          serviceToken: env[CANVAS_TASK_SERVICE_TOKEN_ENV] ?? env[CANVAS_STORAGE_SERVICE_TOKEN_ENV],
          logger: log
        })
      : undefined);

  const receipts = options.projectionReceipts ?? new InMemoryProjectionReceiptStore();
  const syncEnabled = (options.enableYjsSync ?? true) && canvasEnabled;

  // 部署级 writer lock（任务 3.7 / spec「首版 room 服务采用单应用实例」）。
  const instanceId = options.instanceId ?? `${hostname()}:${process.pid}`;
  let writerLock: CanvasWriterLock | null = null;
  let writerLockReason: string | null = null;
  let releaseWriterLock: (() => Promise<void>) | null = null;
  if (syncEnabled) {
    try {
      if (options.writerLock) {
        writerLock = options.writerLock;
      } else {
        const resolved = resolveStorageConfig();
        if (resolved.ok) {
          if (resolved.config.backend === "sqlite") {
            const { SqliteYjsRepository, createSqliteWriterLockStore } = await import("./storage/sqlite/index.js");
            const repository = new SqliteYjsRepository({ path: resolved.config.sqlitePath as string });
            writerLock = createDurableWriterLock(createSqliteWriterLockStore(repository));
          } else {
            throw new Error("Mongo writer lock 尚未实现 durable store");
          }
        } else if (options.yjsRepository) {
          const { createInMemoryWriterLock } = await import("./sync/index.js");
          writerLock = createInMemoryWriterLock();
        } else {
          throw new Error(`画布存储配置无效：${resolved.reason}`);
        }
      }
      const acquired = await writerLock.acquire(instanceId, options.now?.() ?? new Date().toISOString());
      if (acquired.ok) releaseWriterLock = acquired.release;
      else writerLockReason = acquired.reason;
    } catch (error) {
      writerLockReason = error instanceof Error ? error.message : String(error);
    }
  }

  // 编辑历史观察者需要 nodeHistory，但 sync 先于 nodeHistory 组合：用可变引用在提交时解析。
  let nodeHistoryRef: NodeHistoryComposition | null = null;
  const agentDeltaJournal = new AgentDeltaJournal();

  // 在线迁移准入：sync 组合先于 import service；用可变引用在 WS 建立时解析。
  let importAdmissionRef: ((canvasId: string) => { ok: true } | { ok: false; status: number; code: string; message: string }) | null = null;

  // 动态上游凭据来源（唯一的上游接入路径）：扩展登录远端后接管同步；未提供时纯本地。
  const upstreamCredential: SyncUpstreamCredentialSource | null = options.upstreamCredential ?? null;
  const upstream = syncEnabled
    ? createSyncUpstream(
        // 按画布解析：只对「已在远端 / 已显式启用同步」的画布返回会话，其余保持纯本地。
        (canvasId) => resolveUpstreamConfig(upstreamCredential, canvasId),
        {
          logger: (event) =>
            log({ event: event.event, status: 200, ...(event.code ? { code: event.code } : {}), canvasId: event.canvasId }),
          // 画布被打开、链路刚建立时也让宿主补传一次（只在 refresh 回调会漏掉启动后打开的画布）。
          onLinked: (canvasId) => options.onCanvasUpstreamLinked?.(canvasId),
          // 归属的持久记录：宿主注入后，重启也不会把「属于远端」的画布忘成本地。
          ...(options.upstreamOwnership ? { ownership: options.upstreamOwnership } : {})
        }
      )
    : undefined;
  upstreamRef = () => upstream;
  /** 诊断用：只记录是否接入了动态上游，不含地址与令牌（会话地址按画布在各自链路事件里出现）。 */
  const logUpstreamMode = () =>
    log({ event: "canvas-sync-upstream", status: 200, dynamic: upstreamCredential !== null });
  logUpstreamMode();

  /**
   * 用远端目录补齐归属：目录里能看到的画布，字节本来就在托管存储里。
   *
   * 专门堵「升级窗口」：老版本没有归属文件，重启后的终态对账可能在这些画布上采纳远端
   * 生成结果——没有归属就会去主存储读，把一个确实存在的对象报成不存在，把成功结果固化成
   * 失败。目录来源不可用时只是少一次补记（下次 refresh 再试），不影响同步本身。
   */
  const seedRemoteOwnership = async (): Promise<void> => {
    if (!options.upstreamOwnership || !upstream) return;
    const sources = typeof options.catalogSources === "function" ? options.catalogSources() : options.catalogSources ?? [];
    for (const source of sources) {
      let summaries: Awaited<ReturnType<typeof source.list>>;
      try {
        summaries = await source.list();
      } catch {
        // 目录来源本应自己处理不可用；这里再兜一层，坏来源不能拖垮整次 refresh。
        continue;
      }
      for (const summary of summaries) {
        const canvasId = typeof summary.id === "string" ? summary.id.trim() : "";
        if (canvasId !== "") upstream.rememberOwnership(canvasId);
      }
    }
  };

  /**
   * 重新解析所有已加载 room 的上游：动态来源优先，其次静态配置。
   *
   * 每个画布各自问一次来源，因此这里既覆盖「登录/登出导致会话变化」，也覆盖「用户刚对某张
   * 画布点了同步远端」——只让那一个 room 开始同步，而不是整体切换。
   */
  const reapplyUpstream = async (): Promise<void> => {
    if (!upstream) return;
    await seedRemoteOwnership();
    await upstream.refresh();
    logUpstreamMode();
    // 画布刚连上远端时，把「属于远端的媒体」这件事告诉宿主：它负责把存量资产补传到远端存储。
    // fire-and-forget：补传失败只影响远端可见性，不能回滚同步链路。
    const onLinked = options.onCanvasUpstreamLinked;
    if (onLinked) {
      for (const canvasId of upstream.linkedCanvasIds()) {
        void Promise.resolve()
          .then(() => onLinked(canvasId))
          .catch(() => undefined);
      }
    }
  };
  if (upstream && upstreamCredential) void reapplyUpstream().catch(() => undefined);

  // 资源授权端口（change: 2026-10-13-...，任务 4.4/6.1/6.2）：宿主注入 `ResourceAccessPolicy`；
  // 未注入时 fail closed（不因知道 canvasId 就放行，也不退回存在性判定）。Canvas 服务只消费决策。
  const baseAccess: CanvasAccessPort = options.access
    ?? (options.resourceAccessPolicy ? canvasAccessFromPolicy(options.resourceAccessPolicy) : denyingCanvasAccessPort());
  // 在线迁移导入目标带第二套 ACL：作为同一端口的前置判定（任务 5.9），在 importService 组合后回填。
  let importAccessResolver: ImportedCanvasAccessResolver | null = null;
  const access: CanvasAccessPort = composeImportedFirstCanvasAccess({
    imported: () => importAccessResolver,
    fallback: baseAccess
  });
  const lifecycle: CanvasLifecyclePort | null = options.resourceLifecyclePolicy
    ? lifecyclePortFromPolicy(options.resourceLifecyclePolicy)
    : null;
  const enterpriseDiscoverableIds = createDiscoverableCanvasIds(options.resourceDirectory ?? (() => null));
  const wsAuthorized = Boolean(authentication);
  const authorizeWs = async (input: { canvasId: string; principal: PrincipalContext; permission: "read" | "write" }): Promise<boolean> => {
    try {
      // 身份有效期：冻结 principal 过期后拒绝（任务 2.6）。
      if (input.principal.validUntil !== undefined && input.principal.validUntil <= Date.now()) return false;
      const decision = await access.authorize({
        principal: input.principal,
        canvasId: input.canvasId,
        permission: input.permission
      });
      return decision.allowed;
    } catch {
      return false;
    }
  };

  let syncHandler: SyncUpgradeHandler | null = null;
  let worldCapture: WorldCaptureService | null = null;
  const createSyncHandler = (): SyncUpgradeHandler => {
    const verifier = mediaClient ? createMediaVerifierStorage({ client: mediaClient }) : undefined;
    syncHandler ??= createSyncUpgradeHandler({
      content,
      lifecycle: managedLifecycles,
      ...(upstream ? { upstream } : {}),
      // 资源授权接管后，room 建立前的存在性判定改由下面的 principal read 判定负责；
      // 未注入认证（独立单元 / 本机单实例）时保留打开准入：本机有内容，或目录里是
      // remote-only（与 GET 的 remoteSummary 兜底同一口径）。结算用的 canvasContentExists
      // 仍只看本机持久化内容，不把「远端有、本机还没有」当成已建内容。
      ...(options.accessRuntime ? { canvasExists: (id: string) => canvasSessionExists(id) } : {}),
      accessRuntime: options.accessRuntime,
      repository: {
        loadYjsState: async (canvasId) => (await resolveYjsRepository()).loadYjsState(canvasId),
        commitYjsCommand: async (commit) => (await resolveYjsRepository()).commitYjsCommand(commit),
        getCommandRecord: async (canvasId, commandId) =>
          (await resolveYjsRepository()).getCommandRecord(canvasId, commandId),
        replaceCheckpoint: async (input) => (await resolveYjsRepository()).replaceCheckpoint(input),
        createYjsDocument: async (input) => (await resolveYjsRepository()).createYjsDocument(input),
        deleteYjsDocument: async (canvasId) => (await resolveYjsRepository()).deleteYjsDocument(canvasId),
        /**
         * 转发到**结构化**仓库，不是 Yjs 仓库。
         *
         * 从上游 seed 一张"只在远端存在"的画布时，room 必须同时补一条结构化目录行：
         * 两张表是独立的，只建 Yjs 文档的话，画布既不出现在「我的画布」里，后续命令
         * 提交也会因为找不到画布行失败。此前这一项在适配器里 **漏掉了**——room 用的是
         * `ensureCanvasRow?.()` 可选调用，漏了就静默跳过，表现为"画布能打开、内容也对，
         * 但目录里没有它、编辑保存失败"。
         */
        ensureCanvasRow: async (canvas: ServerCanvas) => {
          if (!composition) return;
          await composition.repository.ensureCanvasRow?.(canvas);
        },
        health: async () => (await resolveYjsRepository()).health()
      },
      mediaStorage: verifier,
      serviceToken: env[CANVAS_STORAGE_SERVICE_TOKEN_ENV],
      allowedOrigins: options.syncAllowedOrigins,
      now: options.now,
      bootstrap: async (canvasId) => {
        if (!composition) return null;
        try {
          return await composition.service.getCanvas(canvasId);
        } catch {
          return null;
        }
      },
      logger: (event) =>
        log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}),
          ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}) }),
      onClientAcquired: (room) => {
        const exported = room.exportCanvas();
        if (exported.ok) worldCapture?.observeCanonical({ canvasId: exported.canvas.id, canvas: exported.canvas });
      },
      onCommitted: (input) => {
        worldCapture?.observeCanonical({ canvasId: input.canvasId, canvas: input.canvas });
        void recordModelPlacementHistory(
          nodeHistoryRef && nodeHistoryRef.editCompletion
            ? {
                service: nodeHistoryRef.service,
                hasActiveSession: (canvasId, nodeId) => nodeHistoryRef!.editCompletion.hasActiveModelSession(canvasId, nodeId)
              }
            : nodeHistoryRef,
          input
        );
      },
      onDelta: (input) => {
        agentDeltaJournal.record(input.canvasId, input.before, input.after);
      },
      taskClient: () => taskClient,
      // 单实例写入门禁：未持有部署级 writer lock 的宿主不得接受 room 连接。第二个宿主
      // 静默写同一份协作存储会把另一个实例的 storageSeq 撞成永久过期（见 gate 的说明）。
      gate: () =>
        releaseWriterLock
          ? { ok: true as const }
          : { ok: false as const, status: 503, code: "writer-lock-unavailable" },
      // 在线迁移准入：preparing/deleted 的旧 ID 不进入 CanvasRoom（不触发读旧来源）。
      ...(importAdmissionRef ? { admit: (canvasId: string) => importAdmissionRef!(canvasId) } : {}),
      // 访问边界：WS 在 room acquire 前按可信 principal 判定 read（任务 6.2）；未注入认证时
      // 不传，保持历史服务令牌/loopback 行为。认证器与 access 端口与 HTTP 用同一实例。
      ...(authentication ? { authenticate: authentication, access } : {}),
      // WS 命令 write 复核 / 广播前 read 复核（任务 4.5/6.2/6.3）；未注入认证时不传。
      ...(wsAuthorized
        ? {
            authorizeCommand: (input: { canvasId: string; principal: PrincipalContext }) => authorizeWs({ ...input, permission: "write" }),
            authorizeRead: (input: { canvasId: string; principal: PrincipalContext }) => authorizeWs({ ...input, permission: "read" })
          }
        : {})
    });
    return syncHandler;
  };

  const sync = syncEnabled ? createSyncHandler() : null;

  // 节点生成历史：先于 projector/consumer 组合。
  let nodeHistory: NodeHistoryComposition | null = null;
  const activeSync = sync;
  if ((options.enableNodeHistory ?? true) && activeSync) {
    const verifier = mediaClient
      ? { exists: async (storageKey: string, scope?: MediaStorageScope) => (await mediaClient.verify(storageKey, undefined, scope)).exists }
      : undefined;
    try {
      nodeHistory = await composeNodeHistory({
        env,
        resolveRoom: async (canvasId) => activeSync.registry.resolve(canvasId),
        ...(options.nodeHistoryRepository ? { repository: options.nodeHistoryRepository } : {}),
        ...(options.editCompletionRepository ? { editCompletionRepository: options.editCompletionRepository } : {}),
        ...(verifier ? { mediaVerifier: verifier } : {}),
        logger: (event) => log(event)
      });
    } catch (error) {
      log({ event: "node-history-compose-failed", message: error instanceof Error ? error.message : "unknown" });
      nodeHistory = null;
    }
  }
  nodeHistoryRef = nodeHistory;

  // 世界镜头完成历史（T08）：独立表/事务，绝不进入画布聚合或节点历史。
  let cameraHistory: WorldCameraHistoryComposition | null = null;
  if (options.enableWorldCameraHistory ?? true) {
    try {
      cameraHistory = await composeWorldCameraHistory({
        env,
        ...(options.storageConfig ? { storageConfig: options.storageConfig } : {}),
        ...(options.worldCameraHistoryRepository ? { repository: options.worldCameraHistoryRepository } : {}),
        ...(options.now ? { now: options.now } : {})
      });
    } catch (error) {
      log({ event: "world-camera-history-compose-failed", message: error instanceof Error ? error.message : "unknown" });
      cameraHistory = null;
    }
  }

  // T11a trusted host-completion facts: separate durable row written before the
  // T08 history row so a transient history failure or restart can补记.
  let hostCompletions: AssistantHostCompletionComposition | null = null;
  if (options.enableWorldCameraHistory ?? true) {
    try {
      hostCompletions = await composeAssistantHostCompletions({
        env,
        ...(options.storageConfig ? { storageConfig: options.storageConfig } : {}),
        ...(options.assistantHostCompletionRepository ? { repository: options.assistantHostCompletionRepository } : {}),
        ...(options.now ? { now: options.now } : {})
      });
    } catch (error) {
      log({ event: "assistant-host-completion-compose-failed", message: error instanceof Error ? error.message : "unknown" });
      hostCompletions = null;
    }
  }

  if (nodeHistory) {
    void nodeHistory.editCompletion.processPending().then(
      (result) => {
        if (result.scanned > 0) log({ event: "edit-completion-compensated", scanned: result.scanned, completed: result.completed });
      },
      (error) => log({ event: "edit-completion-compensate-failed", message: error instanceof Error ? error.message : "unknown" })
    );
  }

  // T10 取景刷新/冻结：从权威 room 快照派生请求，只在创作版本变化时合并刷新。
  worldCapture = sync
    ? createWorldCaptureService({
        resolveRoom: async (canvasId) => sync.registry.resolve(canvasId),
        ...(options.worldCaptureMediaSave ? { mediaSave: options.worldCaptureMediaSave } : {}),
        ...(options.worldCaptureVideoMediaSave ? { videoMediaSave: options.worldCaptureVideoMediaSave } : {}),
        ...(options.worldCaptureOutputLongEdge ? { outputLongEdge: options.worldCaptureOutputLongEdge } : {}),
        ...(options.worldCaptureFreezeTimeoutMs ? { freezeTimeoutMs: options.worldCaptureFreezeTimeoutMs } : {}),
        ...(options.now ? { now: () => Date.parse(options.now!()) || Date.now() } : {}),
        logger: log
      })
    : null;

  // run/cancel 应用服务与 task projector（唯一终态写入方）。
  let runService: CanvasRunService | null = null;
  let consumer: TaskResultConsumer | null = null;
  if (sync && taskClient && options.resolveCatalog) {    const projector = new CanvasTaskProjector({
      resolveRoom: async (canvasId) => sync.registry.resolve(canvasId),
      receipts,
      ...(nodeHistory ? { registerHistory: (record) => registerTaskHistoryRecord(nodeHistory!.service, record) } : {}),
      ...(nodeHistory ? { registerFailure: (record) => registerTaskFailureRecord(nodeHistory!.service, record) } : {}),
      ...(options.onRunSettled ? { onSettled: options.onRunSettled } : {}),
      now: options.now
    });
    runService = new CanvasRunService({
      resolveRoom: async (canvasId) => sync.registry.resolve(canvasId),
      taskClient,
      resolveCatalog: options.resolveCatalog,
      now: options.now,
      logger: log,
      // 聚合节点（片场等）同一时间只允许一个运行任务，权威入口保证（design D5）。
      isAggregateNode: isAggregateRunNode,
      worldCapture
    });
    consumer = createTaskResultConsumer({
      projector,
      taskClient,
      mediaClient,
      receipts,
      intervalMs: options.reconcileIntervalMs,
      logger: log
    });
    consumer.start();
  }

  // 模型 MCP / Agent authoring 内部面：装配既有 service 端口（保持唯一 authority 与单实例）。
  const modelMcpEnabled = options.enableModelMcp ?? true;  const rendererCommand = env[CANVAS_MODEL_RENDERER_CMD_ENV];
  const modelRenderer =
    options.modelRenderer !== undefined
      ? options.modelRenderer
      : rendererCommand
        ? createRendererClient({
            command: rendererCommand,
            ...(env[CANVAS_MODEL_RENDERER_TIMEOUT_ENV]
              ? { timeoutMs: Number(env[CANVAS_MODEL_RENDERER_TIMEOUT_ENV]) }
              : {}),
            logger: (event) => log(event)
          })
        : createManagedRendererClient();
  // 共享世界镜头捕获由**页面**渲染：宿主只观察 canonical 变化并登记待取景
  // （`captures-page-pending`），前端在同一次渲染后经 `captures-page-commit` 回填。
  // 因此这里不注册静态图片 producer；`modelRenderer` 仍服务模型 MCP 预览。
  // 动态镜头需要真实视频资产：仅在配置了原生编码器时注册视频 producer，否则显式不可用。
  // 默认由前端渲染 + WebCodecs 录制；只有显式要求原生录制时才注册原生视频 producer。
  const videoEncoderCommand = env[CANVAS_WORLD_VIDEO_ENCODER_CMD_ENV];
  if (worldCapture && sync && videoEncoderCommand && modelRenderer && env.WOOHAA3_WORLD_VIDEO_NATIVE === "1") {
    const videoEncoder = createVideoEncoderClient({
      command: videoEncoderCommand,
      logger: (event) => log(event)
    });
    log({ event: "world-video-encoder-configured", available: videoEncoder.available(), command: videoEncoderCommand });
    const videoProducer = createWorldCaptureProducer({
      renderer: modelRenderer,
      resolveRoom: async (canvasId) => sync.registry.resolve(canvasId),
      media: mediaClient,
      videoEncoder
    });
    if (videoProducer.captureVideo) {
      worldCapture.registerVideoProducer({
        producerId: "native-world-camera-video-v1",
        captureVideo: videoProducer.captureVideo,
        ...(videoProducer.resolveContent ? { resolveContent: videoProducer.resolveContent } : {})
      });
    }
  }
  const agentProfile = resolveAgentDeploymentProfile(env, env[CANVAS_AGENT_DEVELOPMENT_PRINCIPAL_ENV]);
  const mcpRuntime =
    modelMcpEnabled && sync && composition
      ? buildMcpRuntime({
          sync,
          composition,
          nodeHistory,
          runService,
          ...(options.resolveCatalog ? { resolveCatalog: options.resolveCatalog } : {}),
          assistantTextRuns: options.assistantTextRuns,
          ...(options.skillAttempts ? { skillAttempts: options.skillAttempts } : {}),
          modelRenderer,
          agentDeltaJournal,
          modelMcpEnabled,
          env,
          now: options.now,
          log,
          serviceToken: env[CANVAS_MCP_SERVICE_TOKEN_ENV] ?? env[CANVAS_STORAGE_SERVICE_TOKEN_ENV],
          // Agent 读写/列举走与 HTTP/WS 同一资源策略（任务 4.4/6.5）——仅在**确实装配了**
          // 资源策略/端口时；两者都缺省时保留仓库派生的历史回退（存在性 + 开发 principal）。
          ...(options.access || options.resourceAccessPolicy ? { access } : {}),
          ...(options.resourceDirectory ? { resourceDirectory: options.resourceDirectory } : {})
        })
      : null;
  const {
    modelMcpInternalService,
    agentAuthoringService,
    modelMcpHandler,
    modelMcpInternalHandler,
    agentInternalHandler
  } = mcpRuntime ?? {
    modelMcpInternalService: undefined,
    agentAuthoringService: undefined,
    modelMcpHandler: null,
    modelMcpInternalHandler: null,
    agentInternalHandler: null
  };

  // 提示词片段目录。
  let snippets: SnippetComposition | null = null;
  if (options.enablePromptSnippets ?? true) {
    try {
      snippets = await composeSnippets({
        env,
        ...(options.snippetRepository ? { repository: options.snippetRepository } : {}),
        ...(options.now ? { now: options.now } : {})
      });
    } catch (error) {
      log({ event: "snippet-compose-failed", message: error instanceof Error ? error.message : "unknown" });
      snippets = null;
    }
  }

  // 画布可读性判定（存在性 + ACL 钩子）：节点历史与任务活动共用的前置归属校验。
  // change 2026-10-12：导入画布按目标标准 ACL 优先判定（无主体 fail-closed）；native 沿用既有路径。
  // change 2026-10-13-...：`accessRuntime` 显式关闭时跳过导入 ACL 钩子（独立单元历史行为）。
  const canvasExists = async (canvasId: string, req?: IncomingMessage): Promise<boolean> => {
    if (importService && options.accessRuntime?.enabled !== false) {
      const subject = req && options.canvasSubjectResolver ? await options.canvasSubjectResolver(req) : null;
      const decision = importService.authorize({ canvasId, subject: subject ?? "", permission: "read" });
      if (decision === false) return false;
    }
    return canvasContentExists(canvasId);
  };

  /**
   * 结算专用「内容是否真的存在」判定（任务 11.2 / D1）。
   *
   * 与 `canvasExists` 不同：**不**走 room 注册表——`registry.resolve` 会为任意 id 加载空房间，
   * 不能当作内容证据；否则崩溃前只 reserve 未建内容的预留会被误判为「内容已建」而 finalize 成
   * 无内容的孤儿 ACL。这里只看持久化内容：结构化存储的画布，或已存在的 Yjs 文档。
   * 存储故障原样抛出，交给调用方按 failed 处理（不误清理）。
   */
  const canvasContentExists = async (canvasId: string): Promise<boolean> => {
    if (composition) {
      try {
        await composition.service.getCanvas(canvasId);
        return true;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "CANVAS_NOT_FOUND") throw error;
      }
    }
    return (await (await resolveYjsRepository()).loadYjsState(canvasId)) !== null;
  };

  /** 打开 Canvas Session 的准入：本机有内容，或远端目录能给出摘要（内容由 room seed）。 */
  const canvasSessionExists = async (canvasId: string): Promise<boolean> => {
    if (await canvasContentExists(canvasId)) return true;
    const remote = await composition?.catalog?.remoteSummary(canvasId).catch(() => null);
    return remote !== null;
  };

  // 本地包只发布到本机 SQLite；在线迁移的 ACL/receipt 不参与此路径。
  const packageConfig = resolveStorageConfig();
  let scenePackages: import("./storage/sqlite/scene-package.js").SqliteScenePackageStore | null = null;
  if (composition && sync && packageConfig.ok && packageConfig.config.backend === "sqlite") {
    const { SqliteScenePackageStore } = await import("./storage/sqlite/scene-package.js");
    scenePackages = new SqliteScenePackageStore({path:packageConfig.config.sqlitePath!});
    scenePackages.recover();
  }

  // 在线迁移（change: 2026-10-12-add-extension-online-canvas-migration）：
  // 装配细节见 `composition/online-migration.ts`（仅在注入来源端口且目标为 SQLite 时挂载）。
  const { preparationHandler, importService, importStore, importGuard } = composeOnlineMigration({
    env,
    canvasSources: options.canvasSources,
    canvasImportStore: options.canvasImportStore,
    canvasSubjectResolver: options.canvasSubjectResolver,
    composition,
    mediaClient,
    sync,
    now: options.now,
    log
  });
  if (importService) {
    // 任务 5.9：导入目标 ACL 进入统一授权端口（HTTP / WS / Agent 同一决策）。
    const service = importService;
    if (options.accessRuntime?.enabled !== false) {
      importAccessResolver = (query) =>
        service.authorize({
          canvasId: query.canvasId,
          subject: query.subject,
          permission: importedPermissionFor(query.permission)
        });
    }
    importAdmissionRef = (canvasId: string) => {
      const state = importService!.guardState(canvasId);
      if (state.kind === "deleted") {
        return { ok: false as const, status: 410, code: "DELETED", message: "已删除的作品不会自动重建" };
      }
      if (state.kind === "preparing") {
        return { ok: false as const, status: 409, code: "PREPARATION_REQUIRED", message: "作品正在准备中，请稍后重试" };
      }
      return { ok: true as const };
    };
  }

  // 任务 5.5/5.9：可发现集合 = 企业目录 ∪ 导入目标可读集合；目录未注入时返回 null（逐项回退判定）。
  const discoverableCanvasIds = async (principal: PrincipalContext): Promise<string[] | null> => {
    const enterprise = await enterpriseDiscoverableIds(principal);
    if (enterprise === null) return null;
    const imported = importService ? importService.listReadableCanvasIds(principal.subject) : [];
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const id of [...enterprise, ...imported]) {
      if (typeof id !== "string" || id === "" || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    return merged;
  };

  const worldConversion = sync ? createWorldConversionService(async (id) =>
    await canvasContentExists(id) ? sync.registry.resolve(id) : null) : null;
  const spatialWrites: CanvasService["spatialWrites"] = sync ? {
    acquire: async (intent) => {
      // Refresh the authority's exact-revision footprint cache before the lease is
      // checked. The repository still validates every target inside its transaction.
      const room = await sync.registry.resolve(intent.canvasId);
      if (room && worldAuthoringAuthority && (!options.yjsRepository || options.spatialAuthority)) {
        const inspected = await room.inspectPublished(value => value);
        if (inspected.ok) {
          if (intent.scope.scope.kind === "scene-area") {
            await worldAuthoringAuthority.prepareCanvas(inspected.canvas, { kind: "scene-area", areaId: intent.scope.scope.areaId });
          } else if (intent.scope.scope.kind === "world-camera") {
            await worldAuthoringAuthority.prepareCamera(inspected.canvas, intent.scope.scope.cameraId);
          } else {
            await worldAuthoringAuthority.prepareGroup(inspected.canvas, intent.scope.scope.groupId);
          }
        }
      }
      return (await spatialRepository()).acquireSpatialRun(intent);
    },
    cancel: async (canvasId, requestId) => (await spatialRepository()).cancelSpatialRun(canvasId, requestId),
    confirmStopped: async (canvasId, requestId, runId, epoch, executionId, evidence) => (await spatialRepository()).confirmSpatialStopped(canvasId, requestId, runId, epoch, executionId, evidence),
    pending: async () => (await spatialRepository()).pendingSpatialRuns(),
    submit: async (canvasId, context, batch) => {
      if (!context) return { ok: false, status: "rejected", commandId: batch.commandId, code: "spatial-rejected", spatialReason: "unavailable", message: "运行尚未取得写能力，需先核对执行" };
      const room = await sync.registry.resolve(canvasId);
      if (!room) return { ok: false, status: "failed", commandId: batch.commandId, code: "canvas-unavailable", message: "画布不可用" };
      return room.submit(batch, { spatialContext: context });
    }
  } : null;
  const worldAuthoring = sync && worldAuthoringAuthority && (!options.yjsRepository || options.spatialAuthority) ? createWorldAuthoringService({
    authority: worldAuthoringAuthority,
    resolveRoom: async (canvasId) => await sync.registry.resolve(canvasId),
    acquire: async (intent) => (await spatialRepository()).acquireSpatialRun(intent),
    cancel: async (canvasId, requestId) => (await spatialRepository()).cancelSpatialRun(canvasId, requestId),
    readOccupancy: async (canvasId, targets) => {
      try {
        return (await spatialRepository()).readSpatialOccupancy(canvasId, targets);
      } catch {
        return { ok: false, reason: "store-unavailable" } as const;
      }
    },
    findLatest: async (canvasId, operationId) => {
      const repository = await spatialRepository();
      return repository.findLatestWorldAuthoringCommand(canvasId, operationId);
    }
  }) : null;
  let completionVerifier: ((completion: import("@woohaa3/contracts").WorldCompletion, evidence: unknown) => WorldCameraCompletionVerification | Promise<WorldCameraCompletionVerification>) | undefined =
    options.verifyWorldCameraCompletion;
  const cameraSettings = sync && cameraHistory ? createWorldCameraSettingsService({
    resolveRoom: async (canvasId) => await sync.registry.resolve(canvasId),
    resolveContext: (canvasId, contextId) => worldAuthoring
      ? worldAuthoring.resolveCapability(canvasId, contextId)
      : { ok: false, code: "not-ready", message: "世界工具上下文不可用" },
    history: cameraHistory.repository,
    verifyCompletion: (completion, evidence) => completionVerifier ? completionVerifier(completion, evidence) : false,
    ...(options.now ? { now: options.now } : {})
  }) : null;
  const assistantWorld = sync && worldAuthoringAuthority && worldAuthoring && cameraSettings
    ? createAssistantWorldService({
        authority: worldAuthoringAuthority,
        worldAuthoring,
        cameraSettings,
        resolveRoom: async (canvasId) => await sync.registry.resolve(canvasId),
        cancel: async (canvasId, requestId) => (await spatialRepository()).cancelSpatialRun(canvasId, requestId),
        confirmStopped: async (input) => {
          const repository = await spatialRepository();
          await repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence);
        },
        findRecordedCompletion: async (completion) => {
          const entry = await cameraHistory!.repository.get(completion.canvasId, worldCameraCompletionKey(completion));
          return !!entry
            && entry.runId === completion.runId
            && entry.completionId === completion.completionId
            && entry.cameraId === completion.cameraId
            && entry.settingsVersion === completion.settingsVersion;
        },
        ...(hostCompletions ? { hostCompletions: hostCompletions.repository } : {}),
        pending: async () => (await spatialRepository()).pendingSpatialRuns()
      })
    : null;
  if (assistantWorld) {
    const assistant = assistantWorld;
    completionVerifier = async (completion, evidence) => {
      if (options.verifyWorldCameraCompletion && !(await options.verifyWorldCameraCompletion(completion, evidence))) return false;
      return assistant.verifyCompletion(completion, evidence);
    };
    // Retry trusted completion facts left by a transient history failure before
    // the previous process stopped. This never re-runs the assistant.
    void assistant.resumePendingCompletions().then((result) => {
      if (!result.ok || result.remaining > 0) {
        log({ event: "assistant-host-completion-resume-pending", result });
      }
    }).catch((error) => {
      log({ event: "assistant-host-completion-resume-failed", message: error instanceof Error ? error.message : "unknown" });
    });
  }
  async function spatialRepository() {
    const repository = await resolveYjsRepository();
    const { SqliteYjsRepository } = await import("./storage/sqlite/index.js");
    if (!(repository instanceof SqliteYjsRepository)) throw new Error("spatial writes unavailable");
    // 存储槽位可能先于组合根构造仓库：补注同一空间权威，不能退回“无权威=unavailable”。
    repository.attachSpatialAuthority(spatialAuthority);
    return repository;
  }
  const composedHandler = composeRequestHandler({
    worldConversion,
    worldAuthoring,
    worldCamera: cameraSettings,
    worldCapture,
    env,
    canvasEnabled,
    unavailableReason,
    composition,
    runService,
    snippets,
    nodeHistory,
    modelMcpHandler,
    modelMcpInternalHandler,
    agentInternalHandler,
    taskClient,
    storageServiceToken: env[CANVAS_STORAGE_SERVICE_TOKEN_ENV],
    canvasExists,
    preparationHandler,
    importGuard,
    // 统一入口资源授权（任务 4.4/6.1/6.2/6.5）：HTTP native 路由按可信 principal 判定 read/write/delete。
    authenticate: authentication,
    accessRuntime: options.accessRuntime,
    access,
    lifecycle,
    // 任务 5.5：列表按可信主体的可发现集合在分页前过滤（与「我的目录」同一发现规则）。
    discoverableCanvasIds,
    ...(options.deleteRemote ? { deleteRemote: options.deleteRemote } : {}),
    // 任务 5.2：原生删除后断开该画布的全部实时会话（sync hub）。
    ...(sync
      ? {
          closeSessions: async (canvasId: string, reason: string) => {
            worldCapture?.forgetCanvas(canvasId);
            sync.hub.closeCanvas(canvasId, reason);
            await sync.registry.destroy(canvasId);
            // 画布不存在了，远端归属随之作废：否则同一 id 重建后会被误路由到托管存储。
            upstream?.forgetOwnership(canvasId);
          }
        }
      : {}),
    log
  });

  return {
    spatialWrites,
    worldConversion,
    worldAuthoring,
    cameraSettings,
    assistantWorld,
    worldCapture,
    scenePackages,
    sync,
    runService,
    consumer,
    composition,
    snippets,
    nodeHistory,
    writerLock,
    importService,
    mcpServices: () =>
      buildMcpServicesProjection({
        internalModelMcp: modelMcpInternalService ?? null,
        agent: agentAuthoringService ?? null
      }) as ReturnType<CanvasService["mcpServices"]>,
    handle: composedHandler,
    /**
     * 启动期结算遗留 provisioning 预留（任务 11.2 / D1）：内容已存在 → 补 finalize；不存在 → 清理预留。
     * 未注入生命周期提供者（默认无鉴权）或画布存储不可用时返回 null。
     */
    reconcileProvisioningReservations: async ({ reservedBefore }: { reservedBefore?: string } = {}) => {
      if (!lifecycle?.reconcileProvisioning) return null;
      if (!canvasEnabled || !composition) return null;
      return lifecycle.reconcileProvisioning({
        exists: (canvasId) => canvasContentExists(canvasId),
        ...(reservedBefore ? { reservedBefore } : {})
      });
    },
    // 动态上游凭据（扩展会话）变化时由宿主调用；未启用同步面时为空操作。
    refreshUpstream: reapplyUpstream,
    // 纯本地画布没有链路 → undefined；存储层据此决定媒体走主存储还是远端托管存储。
    syncStateOf: (canvasId: string) =>
      combineCanvasSyncState(upstream ? syncStateOf(upstream, canvasId) : undefined, options.mediaAssetSync?.stateOf(canvasId)),
    // 存储路由的判据：归属而不是链路。见 service-types.ts 的同名说明。
    remoteCanvasIds: () => (upstream ? upstream.remoteCanvasIds() : []),
    // 存储形态：归属 + 画布级地址覆盖。存储层按它决定字节落点与地址提供者。
    canvasStorageProfile: (canvasId: string) => upstream?.canvasStorageProfile(canvasId),
    rememberCanvasExposure: (canvasId: string, exposure: string) => upstream?.rememberCanvasExposure(canvasId, exposure),
    syncCanvasMedia: (canvasId: string) => options.mediaAssetSync?.run(canvasId, { force: true }),
    readiness: async () => {
      if (!canvasEnabled) return { ready: false, reason: unavailableReason ?? "画布存储未启用" };
      if (!composition) return { ready: false, reason: unavailableReason ?? "画布存储不可用" };
      if (!agentProfile.ok) return { ready: false, reason: agentProfile.reason };
      if (syncEnabled && !releaseWriterLock) {
        return { ready: false, reason: writerLockReason ?? "未持有协作 writer lock（需要单实例）" };
      }
      const health = await composition.service.health();
      if (!health.ok) return { ready: false, reason: `数据库不可用（${health.backend}）` };
      return { ready: true };
    },
    close: async () => {
      consumer?.stop();
      if (options.modelRenderer === undefined) await modelRenderer?.close().catch(() => undefined);
      await nodeHistory?.close().catch(() => undefined);
      await cameraHistory?.close().catch(() => undefined);
      await hostCompletions?.close().catch(() => undefined);

      if (syncHandler) await syncHandler.close();
      if (releaseWriterLock) await releaseWriterLock().catch(() => undefined);
      await snippets?.close().catch(() => undefined);
      await composition?.close();
      importStore?.close();
      scenePackages?.close();
    }
  };
}
