/**
 * Canvas Service composition：Yjs 仓库解析、存储组合与 writer lock 获取
 * （自 `composition.ts` 拆出，change: 2026-10-13-add-enterprise-access-and-production-deployment，
 *  规模门禁 ≤500 行；沿用 change: 2026-10-09-... R07 的分层方式）。
 *
 * 保持原实现语义：Yjs 仓库惰性解析并缓存；存储组合失败记录 unavailableReason 而不抛出；
 * writer lock 按 sqlite durable / 测试注入 in-memory 解析，获取失败记录原因。
 * 不新增第二份状态：本模块只返回组合结果，由 composition root 持有并回收。
 */
import { hostname } from "node:os";
import type { CanvasRepository } from "../storage/core/index.js";
import {
  createDurableWriterLock,
  createPublishedReader,
  type CanvasWriterLock,
  type YjsDocumentRepository
} from "../sync/index.js";
import {
  composeCanvasStorage,
  resolveCanvasStorageConfig,
  type CanvasStorageComposition,
  type CanvasStorageConfig
} from "../storage/composition.js";
import { createMediaVerifierStorage } from "../clients/media-verifier.js";
import type { CanvasMediaClient } from "../clients/media-client.js";

/** 惰性解析 Yjs 文档仓库（显式注入优先；否则按 env 后端构造并缓存同一 Promise）。 */
export function createYjsRepositoryResolver(input: {
  env: Record<string, string | undefined>;
  yjsRepository?: YjsDocumentRepository;
}): () => Promise<YjsDocumentRepository> {
  let promise: Promise<YjsDocumentRepository> | null = null;
  return () => {
    if (input.yjsRepository) return Promise.resolve(input.yjsRepository);
    promise ??= (async () => {
      const resolved = resolveCanvasStorageConfig(input.env);
      if (!resolved.ok) throw new Error(`画布存储配置无效：${resolved.reason}`);
      if (resolved.config.backend === "sqlite") {
        const { SqliteYjsRepository } = await import("../storage/sqlite/index.js");
        return new SqliteYjsRepository({ path: resolved.config.sqlitePath as string });
      }
      const { MongoYjsRepository } = await import("../storage/mongo/index.js");
      return MongoYjsRepository.connect({
        uri: resolved.config.mongoUri as string,
        database: resolved.config.mongoDb as string
      });
    })();
    return promise;
  };
}

/** 组合结构化存储；失败时返回 `unavailableReason`（不抛出，保持服务可启动并以 readiness 暴露）。 */
export async function composeCanvasStorageRuntime(input: {
  env: Record<string, string | undefined>;
  /** 存储槽位已解析的配置；提供时不再从 env 解析（部署侧配置文件的唯一来源）。 */
  storageConfig?: CanvasStorageConfig;
  mediaClient?: CanvasMediaClient;
  repository?: CanvasRepository;
  resolveYjsRepository: () => Promise<YjsDocumentRepository>;
  log: (event: Record<string, unknown>) => void;
}): Promise<{ composition: CanvasStorageComposition | null; unavailableReason: string | null }> {
  const { log } = input;
  let composition: CanvasStorageComposition | null = null;
  let unavailableReason: string | null = null;
  try {
    const mediaStorage = input.mediaClient ? createMediaVerifierStorage({ client: input.mediaClient }) : undefined;
    let publishedReader: ReturnType<typeof createPublishedReader> | undefined;
    try {
      publishedReader = createPublishedReader(await input.resolveYjsRepository());
    } catch (error) {
      log({
        event: "canvas-catalog-unavailable",
        message: error instanceof Error ? error.message : "unknown"
      });
    }
    composition = await composeCanvasStorage({
      env: input.env,
      ...(input.storageConfig ? { storageConfig: input.storageConfig } : {}),
      mediaStorage,
      repository: input.repository,
      ...(publishedReader ? { publishedReader } : {}),
      logger: (event) =>
        log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}) })
    });
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
  }
  return { composition, unavailableReason };
}

/** 部署级 writer lock（单实例约束）。返回持有状态：ok → release 回调；否则原因字符串。 */
export async function acquireCanvasWriterLock(input: {
  env: Record<string, string | undefined>;
  yjsRepository?: YjsDocumentRepository;
  writerLock?: CanvasWriterLock;
  instanceId?: string;
  now?: () => string;
}): Promise<{
  writerLock: CanvasWriterLock | null;
  releaseWriterLock: (() => Promise<void>) | null;
  writerLockReason: string | null;
  /** 接管失效持有者的上一个 instanceId（缺陷 D3 恢复路径）；未接管为 null。 */
  writerLockTookOverFrom: string | null;
}> {
  // 部署级 writer lock（任务 3.7 / spec「首版 room 服务采用单应用实例」）。
  const instanceId = input.instanceId ?? `${hostname()}:${process.pid}`;
  let writerLock: CanvasWriterLock | null = null;
  let writerLockReason: string | null = null;
  let releaseWriterLock: (() => Promise<void>) | null = null;
  let writerLockTookOverFrom: string | null = null;
  try {
    if (input.writerLock) {
      writerLock = input.writerLock;
    } else {
      const resolved = resolveCanvasStorageConfig(input.env);
      if (resolved.ok) {
        if (resolved.config.backend === "sqlite") {
          const { SqliteYjsRepository, createSqliteWriterLockStore } = await import("../storage/sqlite/index.js");
          const repository = new SqliteYjsRepository({ path: resolved.config.sqlitePath as string });
          writerLock = createDurableWriterLock(createSqliteWriterLockStore(repository));
        } else {
          // Mongo durable writer lock（change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend，任务 2.2）。
          const { MongoYjsRepository, createMongoWriterLockStore } = await import("../storage/mongo/index.js");
          const repository = await MongoYjsRepository.connect({
            uri: resolved.config.mongoUri as string,
            database: resolved.config.mongoDb as string
          });
          writerLock = createDurableWriterLock(createMongoWriterLockStore(repository));
        }
      } else if (input.yjsRepository) {
        const { createInMemoryWriterLock } = await import("../sync/index.js");
        writerLock = createInMemoryWriterLock();
      } else {
        throw new Error(`画布存储配置无效：${resolved.reason}`);
      }
    }
    const acquired = await writerLock.acquire(instanceId, input.now?.() ?? new Date().toISOString());
    if (acquired.ok) {
      releaseWriterLock = acquired.release;
      writerLockTookOverFrom = acquired.tookOverFrom ?? null;
    } else writerLockReason = acquired.reason;
  } catch (error) {
    writerLockReason = error instanceof Error ? error.message : String(error);
  }
  return { writerLock, releaseWriterLock, writerLockReason, writerLockTookOverFrom };
}
