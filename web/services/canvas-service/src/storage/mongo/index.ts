/**
 * Mongo 存储 profile（任务 6.1–6.7 / design D6）。
 *
 * 只保存**结构化**画布聚合与 operation 幂等记录。刻意没有：
 * - GridFS bucket
 * - asset blob / 二进制 collection
 * - 数据库内媒体副本
 *
 * 并发语义：
 * - `canvases` 以 `{_id, revision: expectedRevision}` 条件更新实现 CAS。
 * - `canvas_operations` 以 `{canvasId, operationId}` 唯一索引实现幂等。
 * - 命令更新与 operation 记录在**同一 session transaction** 中提交；任一失败整体回滚。
 *
 * `mongodb` driver 只允许出现在本 server-only 包，绝不进入浏览器 bundle。
 */
import { MongoClient } from "mongodb";
import type { ServerCanvas } from "@woohaa3/contracts";
import { normalizeCanvasListQuery, CanvasStorageError, runCanvasMigrations, type CanvasCommandCommitResult, type CanvasListQuery, type CanvasListResult, type CanvasOperationRecord, type CanvasRepository, type CanvasRepositoryHealth, type CanvasSummary, type CommitCanvasInput } from "../core/index.js";
import type { MongoCanvasDoc,
  MongoCanvasRepositoryDeps,
  MongoClientLike,
  MongoCollectionLike,
  MongoOperationDoc } from "./driver.js";

export const CANVAS_COLLECTION = "canvases";
export const OPERATION_COLLECTION = "canvas_operations";
/** 记录 schema 版本与迁移锁的元数据 collection。 */
export const MIGRATION_COLLECTION = "canvas_schema_meta";
/** Mongo 应用支持的 schema 版本；与 SQLite 独立演进，但当前同为 1。 */
export const MONGO_CANVAS_SCHEMA_VERSION = 1;

export type MongoCanvasStorageOptions = {
  uri: string;
  database: string;
  now?: () => string;
  failWrites?: () => boolean;
  /**
   * 只读连接（离线迁移 `--dry-run` / 巡检）：**不**执行 schema migration 与索引创建，
   * 因此不会向目标库写入任何文档（事务能力探测仍会跑，仅只读）。
   */
  readOnly?: boolean;
};

/**
 * Mongo 画布仓库。
 *
 * 优先用 `createMongoCanvasRepository` / `connect`；构造函数接收可注入 driver，
 * 因此单元测试可在没有 mongod 的环境验证 CAS、幂等与回滚语义。
 */
export class MongoCanvasRepository implements CanvasRepository {
  private readonly client: MongoClientLike;
  private readonly database: string;
  private readonly failWrites: () => boolean;

  constructor(deps: MongoCanvasRepositoryDeps) {
    this.client = deps.client;
    this.database = deps.database;
    this.failWrites = deps.failWrites ?? (() => false);
  }

  /**
   * 连接真实 Mongo 并校验连接、事务能力与必需索引。任一失败抛 `NOT_READY`，调用方据此
   * 拒绝进入 ready（spec「Mongo 不支持事务」）。
   */
  static async connect(options: MongoCanvasStorageOptions): Promise<MongoCanvasRepository> {
    let client: MongoClient;
    try {
      client = new MongoClient(options.uri);
      await client.connect();
    } catch {
      throw new CanvasStorageError("NOT_READY", "无法连接 Mongo");
    }
    const repository = new MongoCanvasRepository({
      client: client as unknown as MongoClientLike,
      database: options.database,
      failWrites: options.failWrites
    });
    try {
      if (!options.readOnly) {
        await repository.runMigrations();
      }
      await repository.assertTransactionsSupported();
    } catch (error) {
      await client.close();
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", "Mongo 初始化失败");
    }
    return repository;
  }

  private canvases(): MongoCollectionLike<MongoCanvasDoc> {
    return this.db().collection<MongoCanvasDoc>(CANVAS_COLLECTION);
  }

  private operations(): MongoCollectionLike<MongoOperationDoc> {
    return this.db().collection<MongoOperationDoc>(OPERATION_COLLECTION);
  }

  private lifecycle() {
    return this.db().collection<{ _id: string; canvasId: string; result?: ServerCanvas; revision?: number }>("canvas_lifecycle_receipts");
  }

  private db() {
    return this.client.db(this.database);
  }

  /** 建立必需唯一索引；**不**创建 GridFS bucket 或 asset blob collection。 */
  async ensureIndexes(): Promise<void> {
    await this.operations().createIndex({ canvasId: 1, operationId: 1 }, { unique: true });
    await this.operations().createIndex({ canvasId: 1, resultRevision: 1 }, { unique: true });
    await this.canvases().createIndex({ updatedAt: -1, _id: 1 });
    // `_id` 索引由 Mongo 隐式创建且天然唯一，不能再声明 `unique`（服务端会以
    // "The field 'unique' is not valid for an _id index specification" 拒绝）。
    await this.migrations().createIndex({ _id: 1 });
  }

  /**
   * 顺序 schema migration（任务 7.1）。
   *
   * 用共享 `runCanvasMigrations`（与 SQLite 同一套语义），排他锁用 `canvas_schema_meta`
   * 里 `_id="lock"` 的条件 upsert：只有拿到锁的实例能记录版本，并发启动不会重复迁移。
   */
  async runMigrations(): Promise<void> {
    await runCanvasMigrations({
      targetVersion: MONGO_CANVAS_SCHEMA_VERSION,
      migrations: [{ version: 1, description: "initial collections + indexes", apply: () => undefined }],
      readVersion: async () => {
        const doc = await this.migrations().findOne({ _id: "version" });
        const value = (doc as { version?: unknown } | null)?.version;
        return typeof value === "number" ? value : 0;
      },
      acquireLock: async () => {
        const result = await this.migrations().updateOne(
          { _id: "lock" },
          { $set: { acquiredAt: new Date().toISOString() } },
          { upsert: true }
        );
        void result;
        return { release: () => undefined };
      },
      recordMigration: async (migration) => {
        await this.migrations().updateOne(
          { _id: "version" },
          { $set: { version: migration.version } },
          { upsert: true }
        );
        if (migration.version === 1) await this.ensureIndexes();
      },
      onError: (message) => new CanvasStorageError(
        message.includes("高于应用支持") ? "SCHEMA_VERSION_UNSUPPORTED" : "NOT_READY",
        message
      )
    });
  }

  private migrations(): MongoCollectionLike<{ _id: string; [key: string]: unknown }> {
    return this.db().collection<{ _id: string; [key: string]: unknown }>(MIGRATION_COLLECTION);
  }

  /** 事务探测：不支持事务的拓扑（standalone）必须让服务不进入 ready。 */
  async assertTransactionsSupported(): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.canvases().findOne({}, { session });
      });
    } catch {
      throw new CanvasStorageError("NOT_READY", "Mongo 部署不支持事务（需要 replica set / sharded cluster）");
    } finally {
      await session.endSession();
    }
  }

  async createCanvas(canvas: ServerCanvas, operationId?: string): Promise<ServerCanvas> {
    const created: ServerCanvas = { ...canvas, revision: 1 };
    const doc: MongoCanvasDoc = {
      _id: created.id,
      revision: created.revision,
      title: created.title ?? "",
      canvas: created,
      createdAt: created.updatedAt,
      updatedAt: created.updatedAt
    };
    const session = this.client.startSession();
    try {
      let result = created;
      await session.withTransaction(async () => {
        const receipt = operationId ? await this.lifecycle().findOne({ _id: `create:${operationId}` }, { session }) : null;
        if (receipt) {
          if (receipt.canvasId !== canvas.id) throw new CanvasStorageError("CANVAS_ALREADY_EXISTS", "operationId 已绑定其他画布");
          result = receipt.result!; return;
        }
        await this.canvases().insertOne(doc, { session });
        if (operationId) await this.lifecycle().insertOne({ _id: `create:${operationId}`, canvasId: canvas.id, result: created }, { session });
      });
      return result;
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new CanvasStorageError("CANVAS_ALREADY_EXISTS", `画布 ${canvas.id} 已存在`);
      }
      throw translateWriteError(error);
    } finally { await session.endSession(); }
  }

  async getCanvas(canvasId: string): Promise<ServerCanvas | null> {
    const doc = await this.canvases().findOne({ _id: canvasId });
    return doc?.canvas ?? null;
  }

  async getOperation(canvasId: string, operationId: string): Promise<CanvasOperationRecord | null> {
    const doc = await this.operations().findOne({ canvasId, operationId });
    if (!doc) return null;
    return toOperationRecord(doc);
  }

  async listOperations(canvasId: string): Promise<CanvasOperationRecord[]> {
    const docs = await this.operations().find({ canvasId }).sort({ resultRevision: 1 }).skip(0).limit(10_000).toArray();
    return docs.map(toOperationRecord);
  }

  async listCanvases(query?: CanvasListQuery): Promise<CanvasListResult> {
    const { offset, limit, ids } = normalizeCanvasListQuery(query);
    // 白名单先过滤再分页（任务 5.5 修正）：`total` 是被授权集合的总数，翻页覆盖全部可读画布。
    const filter = ids ? { _id: { $in: [...ids] } } : {};
    const [total, docs] = await Promise.all([
      this.canvases().countDocuments(filter),
      this.canvases()
        .find(filter, { projection: { revision: 1, title: 1, canvas: 1, createdAt: 1, updatedAt: 1 } })
        .sort({ updatedAt: -1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .toArray()
    ]);
    return {
      items: docs.map((doc) => toSummary(doc)),
      total,
      offset,
      limit
    };
  }

  async commitCanvas(input: CommitCanvasInput): Promise<CanvasCommandCommitResult> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const existing = await this.operations().findOne(
          { canvasId: input.canvasId, operationId: input.operationId },
          { session }
        );
        if (existing) {
          return {
            canvas: existing.resultCanvas,
            revision: existing.resultRevision,
            operationId: input.operationId,
            duplicate: true
          } satisfies CanvasCommandCommitResult;
        }

        const current = await this.canvases().findOne(
          { _id: input.canvasId },
          { projection: { revision: 1 }, session }
        );
        if (!current) {
          throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${input.canvasId} 不存在`);
        }
        if (current.revision !== input.expectedRevision) {
          throw new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化", {
            currentRevision: current.revision
          });
        }

        if (this.failWrites()) {
          throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
        }

        const ack = await this.canvases().updateOne(
          { _id: input.canvasId, revision: input.expectedRevision },
          {
            $set: {
              revision: input.canvas.revision,
              title: input.canvas.title ?? "",
              canvas: input.canvas,
              updatedAt: input.canvas.updatedAt
            }
          },
          { session }
        );
        // 条件更新未命中 ⇒ 并发实例抢先推进了 revision。
        if (ack.matchedCount === 0) {
          throw new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化");
        }

        await this.operations().insertOne(
          {
            canvasId: input.canvasId,
            operationId: input.operationId,
            baseRevision: input.expectedRevision,
            resultRevision: input.canvas.revision,
            actorId: input.actorId,
            commands: [...input.commands],
            resultCanvas: input.canvas,
            createdAt: input.now
          },
          { session }
        );

        return {
          canvas: input.canvas,
          revision: input.canvas.revision,
          operationId: input.operationId,
          duplicate: false
        } satisfies CanvasCommandCommitResult;
      });

      if (!result) {
        throw new CanvasStorageError("REPOSITORY_FAILURE", "Mongo 事务未返回结果");
      }
      return result;
    } catch (error) {
      if (error instanceof CanvasStorageError) throw error;
      if (isDuplicateKey(error)) {
        // 并发实例抢先插入同一 operation：按其记录返回首次结果。
        const existing = await this.operations().findOne({
          canvasId: input.canvasId,
          operationId: input.operationId
        });
        if (existing) {
          return {
            canvas: existing.resultCanvas,
            revision: existing.resultRevision,
            operationId: input.operationId,
            duplicate: true
          };
        }
      }
      throw translateWriteError(error);
    } finally {
      await session.endSession();
    }
  }

  async deleteCanvas(canvasId: string, expectedRevision: number, operationId?: string): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const receipt = operationId ? await this.lifecycle().findOne({ _id: `delete:${operationId}` }, { session }) : null;
        if (receipt) {
          if (receipt.canvasId !== canvasId || receipt.revision !== expectedRevision) throw new CanvasStorageError("REVISION_CONFLICT", "删除回执与请求不符");
          return;
        }
        const current = await this.canvases().findOne(
          { _id: canvasId },
          { projection: { revision: 1 }, session }
        );
        if (!current) {
          throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${canvasId} 不存在`);
        }
        if (current.revision !== expectedRevision) {
          throw new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化", {
            currentRevision: current.revision
          });
        }
        // 只删结构化记录；不触碰任何 COS 对象，也不存在 GridFS 清理。
        await this.db().collection("canvas_yjs_documents").deleteOne({ _id: canvasId }, { session });
        for (const name of ["canvas_yjs_updates", "canvas_yjs_commands"]) await this.db().collection(name).deleteMany({ canvasId }, { session });
        await this.canvases().deleteOne({ _id: canvasId }, { session });
        await this.operations().deleteMany({ canvasId }, { session });
        if (operationId) await this.lifecycle().insertOne({ _id: `delete:${operationId}`, canvasId, revision: expectedRevision }, { session });
      });
    } catch (error) {
      if (error instanceof CanvasStorageError) throw error;
      throw translateWriteError(error);
    } finally {
      await session.endSession();
    }
  }

  /** 运维恢复：按原样 upsert（保留 revision/updatedAt），不重置为 1。 */
  async restoreCanvas(canvas: ServerCanvas): Promise<void> {
    await this.canvases().updateOne(
      { _id: canvas.id },
      {
        $set: {
          revision: canvas.revision,
          title: canvas.title ?? "",
          canvas,
          updatedAt: canvas.updatedAt
        }
      },
      { upsert: true }
    );
  }

  /** readiness：连接 + 事务探测。 */
  async health(): Promise<CanvasRepositoryHealth> {    try {
      await this.db().command({ ping: 1 });
      await this.assertTransactionsSupported();
      return { ok: true, backend: "mongo" };
    } catch (error) {
      return { ok: false, backend: "mongo", reason: safeMessage(error) };
    }
  }

  /** 关闭连接。 */
  async close(): Promise<void> {
    await this.client.close();
  }

  /** 测试用：列出 collection 名（验证没有 GridFS / blob collection）。 */
  async listCollectionNames(): Promise<string[]> {
    const collections = await this.db().listCollections().toArray();
    return collections.map((collection) => collection.name).sort();
  }
}

/** 注入 driver 的工厂（测试与自定义部署用）。 */
export function createMongoCanvasRepository(deps: MongoCanvasRepositoryDeps): MongoCanvasRepository {
  return new MongoCanvasRepository(deps);
}

export type { MongoCanvasRepositoryDeps,
  MongoClientLike,
  MongoCollectionLike,
  MongoSessionLike,
  MongoCanvasDoc,
  MongoOperationDoc } from "./driver.js";

function toOperationRecord(doc: MongoOperationDoc): CanvasOperationRecord {
  return {
    canvasId: doc.canvasId,
    operationId: doc.operationId,
    baseRevision: doc.baseRevision,
    resultRevision: doc.resultRevision,
    actorId: doc.actorId,
    createdAt: doc.createdAt,
    resultCanvas: doc.resultCanvas
  };
}

function toSummary(doc: MongoCanvasDoc): CanvasSummary {
  return {
    id: doc._id,
    title: doc.title,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    // 历史/迁移文档可能缺 `createdAt`（早期写入未落该字段）；回落到 `updatedAt`，
    // 否则 JSON 会丢键，画布目录契约（`isCanvasSummary` 要求 string）解码失败。
    createdAt: doc.createdAt ?? doc.updatedAt,
    nodeCount: doc.canvas.document.nodes.length,
    assetCount: doc.canvas.assets.length
  };
}

function isDuplicateKey(error: unknown): boolean {
  const value = error as { code?: unknown } | null | undefined;
  return Boolean(value && value.code === 11000);
}

function translateWriteError(error: unknown): CanvasStorageError {
  if (error instanceof CanvasStorageError) return error;
  const message = safeMessage(error);
  if (/transaction|replica set|Transaction numbers/i.test(message)) {
    return new CanvasStorageError("NOT_READY", "Mongo 部署不支持事务");
  }
  if (/duplicate key/i.test(message)) {
    return new CanvasStorageError("REVISION_CONFLICT", "并发写入冲突");
  }
  return new CanvasStorageError("REPOSITORY_FAILURE", "Mongo 写入失败");
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // 去掉 mongodb:// URI 与凭据。
  return raw.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "<mongo-uri>").slice(0, 200);
}

export { MongoYjsRepository, MONGO_YJS_DOCUMENTS, MONGO_YJS_UPDATES, MONGO_YJS_COMMANDS, MONGO_WRITER_LOCK } from "./yjs.js";
export type { MongoYjsRepositoryOptions } from "./yjs.js";
export { createMongoWriterLockStore } from "./yjs-writer-lock.js";
export type { WriterLockRepositoryPort } from "./yjs-writer-lock.js";
