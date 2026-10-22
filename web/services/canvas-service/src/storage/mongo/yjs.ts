/**
 * Mongo Yjs 持久化（任务 3.3 / design D7）。
 *
 * collections：
 * ```
 * canvas_yjs_documents  {_id: canvasId, formatVersion, roomEpoch, snapshot(Binary),
 *                        snapshotSeq, revision, projection, createdAt, updatedAt}
 * canvas_yjs_updates    {canvasId, seq, update(Binary), sha256, createdAt}
 * canvas_yjs_commands   {canvasId, commandId, payloadHash, revision, changed,
 *                        actorId, createdAt}
 * ```
 *
 * 关键性质：
 * - `commitYjsCommand` 在**同一个 session transaction** 内写 update、sequence、派生 JSON
 *   与 command result（design D6 步骤 3）。
 * - checkpoint 压缩只删被覆盖的 updates；命令幂等记录**不删**（design D8）。
 * - 首版即使使用 Mongo 也只运行一个协作应用实例（design D7）；多实例需独立 capability。
 *
 * 媒体 bytes 仍只在 COS：这里只存 Yjs update 与 JSON projection。
 */
import type { YjsArchiveSnapshot } from "../../sync/archive-publication.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import { computeUpdateSha256 } from "../../sync/yjs-repository.js";
import { writerLockHolderIsStale } from "../../sync/writer-lock.js";
import { type YjsCommandCommit, type YjsCommandRecord, type YjsCommitResult, type YjsDocumentRepository, type YjsLoadedState, type YjsRepositoryHealth } from "../../sync/index.js";
import { CanvasStorageError } from "../core/index.js";
import type { MongoCanvasRepositoryDeps,
  MongoClientLike,
  MongoCollectionLike,
  MongoSessionLike } from "./driver.js";

export const MONGO_YJS_DOCUMENTS = "canvas_yjs_documents";
export const MONGO_YJS_UPDATES = "canvas_yjs_updates";
export const MONGO_YJS_COMMANDS = "canvas_yjs_commands";
export const MONGO_WRITER_LOCK = "canvas_writer_lock";

type YjsDocumentDoc = {
  _id: string;
  formatVersion: string;
  roomEpoch: string | null;
  snapshot: Uint8Array;
  snapshotSeq: number;
  revision: number;
  projection: ServerCanvas | null;
  createdAt: string;
  updatedAt: string;
};

type YjsUpdateDoc = {
  canvasId: string;
  seq: number;
  update: Uint8Array;
  sha256: string;
  createdAt: string;
};

type YjsCommandDoc = {
  canvasId: string;
  commandId: string;
  payloadHash: string;
  revision: number;
  changed: boolean;
  actorId: string;
  createdAt: string;
  /** Canvas script 首次提交元数据（源码无关）；旧文档缺省。 */
  script?: import("@woohaa3/contracts").CanvasScriptSubmissionMeta;
  modelBatch?: import("@woohaa3/contracts").ModelScriptBatchMeta;
};

/** 部署级 writer lock 单文档（`_id` 天然唯一，提供跨进程 CAS）。 */
type WriterLockDoc = {
  _id: string;
  holder: string;
  since: string;
};

export type MongoYjsRepositoryOptions = {
  uri?: string;
  database?: string;
  /** 注入 driver（测试用内存 fake；生产用真实 `MongoClient`）。 */
  client: MongoClientLike;
  databaseName: string;
  failWrites?: () => boolean;
};

export class MongoYjsRepository implements YjsDocumentRepository {
  private readonly client: MongoClientLike;
  private readonly database: string;
  private readonly failWrites: () => boolean;

  constructor(deps: MongoCanvasRepositoryDeps & { failWrites?: () => boolean }) {
    this.client = deps.client;
    this.database = deps.database;
    this.failWrites = deps.failWrites ?? (() => false);
  }

  /**
   * 连接真实 Mongo 并建立必需索引。
   *
   * 放在 adapter 内部（而不是让 composition root import `mongodb`）：driver 只允许出现在
   * 本 server-only 包，组合根通过动态 import 本模块间接使用它。
   */
  static async connect(options: {
    uri: string;
    database: string;
    failWrites?: () => boolean;
  }): Promise<MongoYjsRepository> {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(options.uri);
    await client.connect();
    const repository = new MongoYjsRepository({
      client: client as unknown as MongoClientLike,
      database: options.database,
      failWrites: options.failWrites
    });
    await repository.ensureIndexes();
    return repository;
  }

  /** 建立必需的唯一索引；**不**创建 GridFS bucket 或二进制媒体 collection。 */
  async ensureIndexes(): Promise<void> {
    await this.updates().createIndex({ canvasId: 1, seq: 1 }, { unique: true });
    await this.commands().createIndex({ canvasId: 1, commandId: 1 }, { unique: true });
  }

  private documents(): MongoCollectionLike<YjsDocumentDoc> {
    return this.db().collection<YjsDocumentDoc>(MONGO_YJS_DOCUMENTS);
  }

  private updates(): MongoCollectionLike<YjsUpdateDoc> {
    return this.db().collection<YjsUpdateDoc>(MONGO_YJS_UPDATES);
  }

  private commands(): MongoCollectionLike<YjsCommandDoc> {
    return this.db().collection<YjsCommandDoc>(MONGO_YJS_COMMANDS);
  }

  private writerLock(): MongoCollectionLike<WriterLockDoc> {
    return this.db().collection<WriterLockDoc>(MONGO_WRITER_LOCK);
  }

  private db() {
    return this.client.db(this.database);
  }

  async loadYjsState(canvasId: string): Promise<YjsLoadedState | null> {
    const document = await this.documents().findOne({ _id: canvasId });
    if (!document) return null;

    const updates = await this.updates()
      .find({ canvasId })
      .sort({ seq: 1 })
      .skip(0)
      .limit(100_000)
      .toArray();

    const lastSeq = updates.length > 0 ? updates[updates.length - 1].seq : document.snapshotSeq;
    return {
      canvasId: document._id,
      formatVersion: document.formatVersion,
      roomEpoch: document.roomEpoch,
      checkpoint: toBytes(document.snapshot),
      checkpointSeq: document.snapshotSeq,
      updates: updates.map((entry) => ({
        seq: entry.seq,
        update: toBytes(entry.update),
        sha256: entry.sha256
      })),
      storageSeq: Math.max(document.snapshotSeq, lastSeq),
      projection: document.projection ?? null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt
    };
  }

  async commitYjsCommand(commit: YjsCommandCommit): Promise<YjsCommitResult> {
    // 幂等优先（在事务外先查，命中即直接返回）。
    const existing = await this.getCommandRecord(commit.canvasId, commit.command.commandId);
    if (existing) {
      if (existing.payloadHash !== commit.command.payloadHash) {
        return { ok: false, code: "command-id-reused", existingHash: existing.payloadHash };
      }
      const state = await this.loadYjsState(commit.canvasId);
      return { ok: true, storageSeq: state?.storageSeq ?? 0, revision: existing.revision, duplicate: true };
    }

    // 真实 SHA-256 在事务外算好（Web Crypto 异步；事务内保持简单）。
    const sha256 = await computeUpdateSha256(commit.update);

    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const document = await this.documents().findOne({ _id: commit.canvasId }, { session });
        if (!document) {
          throw new CanvasStorageError("CANVAS_NOT_FOUND", `Yjs 文档 ${commit.canvasId} 不存在`);
        }
        const currentSeq = Math.max(document.snapshotSeq, await this.maxSeq(commit.canvasId, session));
        if (currentSeq !== commit.expectedStorageSeq) {
          return { ok: false, code: "storage-seq-conflict", currentSeq } satisfies YjsCommitResult;
        }
        if (this.failWrites()) {
          throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
        }

        const nextSeq = currentSeq + 1;
        await this.updates().insertOne(
          {
            canvasId: commit.canvasId,
            seq: nextSeq,
            update: commit.update,
            sha256,
            createdAt: commit.updatedAt
          },
          { session }
        );
        await this.documents().updateOne(
          { _id: commit.canvasId },
          {
            $set: {
              revision: commit.revision,
              projection: commit.projection,
              updatedAt: commit.updatedAt
            }
          },
          { session }
        );
        await this.commands().insertOne(
          {
            canvasId: commit.canvasId,
            commandId: commit.command.commandId,
            payloadHash: commit.command.payloadHash,
            revision: commit.command.revision,
            changed: commit.command.changed,
            actorId: commit.command.actorId,
            createdAt: commit.command.createdAt,
            ...(commit.command.script ? { script: commit.command.script } : {}),
            ...(commit.command.modelBatch ? { modelBatch: commit.command.modelBatch } : {})
          },
          { session }
        );
        return { ok: true, storageSeq: nextSeq, revision: commit.revision, duplicate: false } satisfies YjsCommitResult;
      });

      if (!result) throw new CanvasStorageError("REPOSITORY_FAILURE", "Mongo 事务未返回结果");
      return result;
    } catch (error) {
      if (error instanceof CanvasStorageError) throw error;
      throw translate(error);
    } finally {
      await session.endSession();
    }
  }

  async getCommandRecord(canvasId: string, commandId: string): Promise<YjsCommandRecord | null> {
    const doc = await this.commands().findOne({ canvasId, commandId });
    if (!doc) return null;
    return {
      commandId: doc.commandId,
      payloadHash: doc.payloadHash,
      revision: doc.revision,
      changed: doc.changed,
      actorId: doc.actorId,
      createdAt: doc.createdAt,
      ...(doc.script ? { script: doc.script } : {}),
      ...(doc.modelBatch ? { modelBatch: doc.modelBatch } : {})
    };
  }

  async replaceCheckpoint(input: {
    canvasId: string;
    cutoffSeq: number;
    checkpoint: Uint8Array;
    updatedAt: string;
  }): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.documents().updateOne(
          { _id: input.canvasId },
          { $set: { snapshot: input.checkpoint, snapshotSeq: input.cutoffSeq, updatedAt: input.updatedAt } },
          { session }
        );
        // 只删被覆盖的 updates；cutoff 之后保留，命令记录不删（design D8）。
        await this.updates().deleteMany(
          { canvasId: input.canvasId, seq: { $lte: input.cutoffSeq } },
          { session }
        );
      });
    } catch (error) {
      if (error instanceof CanvasStorageError) throw error;
      throw translate(error);
    } finally {
      await session.endSession();
    }
  }

  async createYjsDocument(input: {
    canvasId: string;
    formatVersion: string;
    roomEpoch: string;
    checkpoint: Uint8Array;
    projection: ServerCanvas;
    revision: number;
    createdAt: string;
  }): Promise<void> {
    await this.documents().insertOne({
      _id: input.canvasId,
      formatVersion: input.formatVersion,
      roomEpoch: input.roomEpoch,
      snapshot: input.checkpoint,
      snapshotSeq: 0,
      revision: input.revision,
      projection: input.projection,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    });
  }

  async deleteYjsDocument(canvasId: string): Promise<void> {
    await this.documents().deleteOne({ _id: canvasId });
    await this.updates().deleteMany({ canvasId });
    await this.commands().deleteMany({ canvasId });
  }

  async captureArchiveState(canvasId: string): Promise<YjsArchiveSnapshot | null> {
    const state = await this.loadYjsState(canvasId);
    if (!state) return null;
    const document = await this.documents().findOne({ _id: canvasId });
    const rows: YjsCommandDoc[] = [];
    for (;;) {
      const page = await this.commands().find({ canvasId }).sort({ commandId: 1 }).skip(rows.length).limit(1000).toArray();
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return { state, revision: document!.revision, commands: rows.map(({ canvasId: _id, ...command }) => command) };
  }

  async replaceArchiveState(canvasId: string, snapshot: YjsArchiveSnapshot | null): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.documents().deleteOne({ _id: canvasId }, { session });
        await this.updates().deleteMany({ canvasId }, { session });
        await this.commands().deleteMany({ canvasId }, { session });
        if (!snapshot) return;
        if (this.failWrites()) throw new Error("injected archive write failure");
        const { state, revision, commands } = snapshot;
        await this.documents().insertOne({ _id: canvasId, formatVersion: state.formatVersion,
          roomEpoch: state.roomEpoch, snapshot: state.checkpoint, snapshotSeq: state.checkpointSeq,
          revision, projection: state.projection, createdAt: state.createdAt, updatedAt: state.updatedAt }, { session });
        for (const entry of state.updates) await this.updates().insertOne({ canvasId, seq: entry.seq,
          update: entry.update, sha256: entry.sha256, createdAt: state.updatedAt }, { session });
        for (const entry of commands) await this.commands().insertOne({ canvasId, ...entry }, { session });
      });
    } catch (error) { throw translate(error); }
    finally { await session.endSession(); }
  }

  async health(): Promise<YjsRepositoryHealth> {
    try {
      await this.db().command({ ping: 1 });
      return { ok: true, backend: "mongo" };
    } catch (error) {
      return { ok: false, backend: "mongo", reason: safe(error) };
    }
  }

  /**
   * 部署级 writer lock（任务 2.1）：单文档 `_id="singleton"` CAS。
   *
   * - 首次获取走 `insertOne`；`_id` 唯一性保证并发只有一个成功，另一个拿到 duplicate key
   *   即视为「他人持有」；
   * - 同实例重入只刷新 `since`；
   * - 不同实例：若当前持有者已失效（同主机进程被强杀，缺陷 D3）则条件接管，否则返回 false。
   */
  async tryAcquireWriterLock(instanceId: string, now: string): Promise<boolean> {
    const current = await this.writerLock().findOne({ _id: "singleton" });
    if (!current) {
      try {
        await this.writerLock().insertOne({ _id: "singleton", holder: instanceId, since: now });
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    }
    if (current.holder !== instanceId) {
      if (!writerLockHolderIsStale(current.holder)) return false;
      // 条件接管：只更新仍由失效持有者占据的文档，避免与并发接管相互覆盖。
      const taken = await this.writerLock().updateOne(
        { _id: "singleton", holder: current.holder },
        { $set: { holder: instanceId, since: now } }
      );
      return taken.modifiedCount === 1;
    }
    await this.writerLock().updateOne({ _id: "singleton", holder: instanceId }, { $set: { since: now } });
    return true;
  }

  async currentWriterLock(): Promise<{ instanceId: string; since: string } | null> {
    const doc = await this.writerLock().findOne({ _id: "singleton" });
    return doc ? { instanceId: doc.holder, since: doc.since } : null;
  }

  async releaseWriterLock(instanceId: string): Promise<void> {
    await this.writerLock().deleteOne({ _id: "singleton", holder: instanceId });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async maxSeq(canvasId: string, session: MongoSessionLike): Promise<number> {
    const docs = await this.updates()
      .find({ canvasId })
      .sort({ seq: -1 })
      .skip(0)
      .limit(1)
      .toArray();
    void session;
    return docs.length > 0 ? docs[0].seq : 0;
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // mongodb v6 默认把 BSON Binary 反序列化为 `Binary`（不是 Buffer/Uint8Array）。
  // 优先用 `.value()`（按 position 截断），退化到 `.buffer`；否则会把字节读成空数组，
  // 导致 checksum 校验失败并隔离 room。
  if (value && typeof value === "object") {
    const binary = value as { value?: unknown; buffer?: unknown };
    if (typeof binary.value === "function") {
      const inner = (binary.value as () => unknown)();
      if (inner instanceof Uint8Array) return new Uint8Array(inner);
      if (inner instanceof ArrayBuffer) return new Uint8Array(inner);
    }
    if (binary.buffer instanceof Uint8Array) return new Uint8Array(binary.buffer);
  }
  return new Uint8Array(0);
}

function translate(error: unknown): CanvasStorageError {
  if (error instanceof CanvasStorageError) return error;
  const message = safe(error);
  if (/transaction|replica set|Transaction numbers/i.test(message)) {
    return new CanvasStorageError("NOT_READY", "Mongo 部署不支持事务");
  }
  return new CanvasStorageError("REPOSITORY_FAILURE", "Mongo Yjs 写入失败");
}

function safe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "<mongo-uri>").slice(0, 200);
}

/** Mongo duplicate key（E11000）识别；用于 writer lock 的并发 CAS 结果。 */
function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}
