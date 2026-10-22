/**
 * 隔离通用扩展数据存储（Mongo 驱动）
 * （change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend，任务 1.2 / design D4）。
 *
 * 与 SQLite 驱动同一 `ExtensionDocumentStore` 异步契约：owner-scoped 文档、带版本读取、CAS、
 * 事务原子 batch、前缀扫描、schema 版本。owner 来自可信 registration，facade 拒绝跨 owner。
 * 集合：`extension_documents`（唯一索引 owner+key）、`extension_documents_meta`（唯一 owner）。
 *
 * 与 Canvas Mongo 仓库同样的 driver 注入策略：只依赖一个最小 `MongoDocumentClientLike`，
 * 生产注入真实 `MongoClient`（动态 import），测试注入内存 fake；刻意不暴露裸数据库句柄。
 */
import type {
  ExtensionDocument,
  ExtensionDocumentBatchResult,
  ExtensionDocumentOperation,
  ExtensionDocumentRead,
  ExtensionDocumentScanPage,
  ExtensionDocumentStore,
  ExtensionDocumentStoreProvider,
  ExtensionDocumentValue
} from "@woohaa3/contracts";
import { isExtensionDocumentValue } from "@woohaa3/contracts";
import { MongoClient } from "mongodb";

export const MONGO_EXTENSION_DOCUMENTS = "extension_documents";
export const MONGO_EXTENSION_DOCUMENTS_META = "extension_documents_meta";
export const MONGO_EXTENSION_DOCUMENT_SCHEMA_VERSION = 1;

/** 前缀扫描的上界哨兵（前缀之后的最高码位，用于 `key < high` 的范围过滤）。 */
const PREFIX_HIGH = "\uffff";

export type MongoDocumentDoc = {
  owner: string;
  key: string;
  value: ExtensionDocumentValue;
  revision: number;
  updatedAt: string;
};

export type MongoDocumentMetaDoc = {
  owner: string;
  schemaVersion: number;
};

export type MongoDocumentUpdateResult = { matchedCount: number; modifiedCount: number; upsertedCount?: number };

/** 一个 collection 的最小面；`session` 用于事务。 */
export type MongoDocumentCollectionLike<TDoc> = {
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<string>;
  findOne(filter: Record<string, unknown>, options?: { session?: unknown }): Promise<TDoc | null>;
  find(
    filter: Record<string, unknown>,
    options?: { session?: unknown }
  ): { sort(spec: Record<string, 1 | -1>): { limit(count: number): { toArray(): Promise<TDoc[]> } } };
  updateOne(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> },
    options?: { session?: unknown; upsert?: boolean }
  ): Promise<MongoDocumentUpdateResult>;
  insertOne(doc: TDoc, options?: { session?: unknown }): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>, options?: { session?: unknown }): Promise<{ deletedCount: number }>;
};

export type MongoDocumentSessionLike = {
  withTransaction<T>(run: () => Promise<T>): Promise<T | undefined>;
  endSession(): Promise<void>;
};

export type MongoDocumentClientLike = {
  startSession(): MongoDocumentSessionLike;
  db(name: string): {
    collection<TDoc>(name: string): MongoDocumentCollectionLike<TDoc>;
  };
  close(): Promise<void>;
};

export type MongoExtensionDocumentStoreOptions = {
  client: MongoDocumentClientLike;
  database: string;
  /** 该 provider 允许的 owner（extensionId）集合；未登记 owner 返回 null（fail closed）。 */
  owners: readonly string[];
  now?: () => Date;
};

export type MongoExtensionDocumentStoreProvider = ExtensionDocumentStoreProvider & {
  initialize: () => Promise<void>;
  close: () => Promise<void>;
};

/** CAS 冲突哨兵：用于在事务内中止并回滚整批，再向外返回 revision-conflict。 */
class RevisionConflict extends Error {
  constructor(
    readonly key: string,
    readonly currentRevision: number | null
  ) {
    super("revision-conflict");
    this.name = "RevisionConflict";
  }
}

export function createMongoExtensionDocumentStore(
  options: MongoExtensionDocumentStoreOptions
): MongoExtensionDocumentStoreProvider {
  const db = options.client.db(options.database);
  const documents = db.collection<MongoDocumentDoc>(MONGO_EXTENSION_DOCUMENTS);
  const sessionFactory = () => options.client.startSession();
  const allowed = new Set(options.owners);
  const now = options.now ?? (() => new Date());

  return {
    async initialize() {
      await documents.createIndex({ owner: 1, key: 1 }, { unique: true });
      await db.collection<MongoDocumentMetaDoc>(MONGO_EXTENSION_DOCUMENTS_META).createIndex({ owner: 1 }, { unique: true });
    },
    forExtension(extensionId: string): ExtensionDocumentStore | null {
      if (!allowed.has(extensionId)) return null;
      return createOwnerStore({ documents, meta: db.collection<MongoDocumentMetaDoc>(MONGO_EXTENSION_DOCUMENTS_META), owner: extensionId, now, sessionFactory });
    },
    async close() {
      await options.client.close();
    }
  };
}

type OwnerStoreContext = {
  documents: MongoDocumentCollectionLike<MongoDocumentDoc>;
  meta: MongoDocumentCollectionLike<MongoDocumentMetaDoc>;
  owner: string;
  now: () => Date;
  sessionFactory: () => MongoDocumentSessionLike;
};

function createOwnerStore(context: OwnerStoreContext): ExtensionDocumentStore {
  const { documents, meta, owner } = context;

  const toDocument = (row: MongoDocumentDoc): ExtensionDocument => ({
    key: row.key,
    value: row.value,
    revision: row.revision,
    updatedAt: row.updatedAt
  });

  return {
    owner: () => owner,
    async get<T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string): Promise<ExtensionDocumentRead<T>> {
      const row = await documents.findOne({ owner, key });
      return row ? { found: true, document: toDocument(row) as ExtensionDocument<T> } : { found: false };
    },
    async batch(operations: readonly ExtensionDocumentOperation[]): Promise<ExtensionDocumentBatchResult> {
      for (const operation of operations) {
        if (typeof operation.key !== "string" || operation.key === "" || operation.key.length > 512) {
          return { ok: false, code: "invalid", message: "文档 key 非法" };
        }
        if (operation.op === "set" && !isExtensionDocumentValue(operation.value)) {
          return { ok: false, code: "invalid", message: "文档值必须是结构性 JSON" };
        }
      }
      const session = context.sessionFactory();
      try {
        const result = await session.withTransaction(() => applyOperations(context, operations, session));
        return result ?? { ok: false, code: "invalid", message: "事务未返回结果" };
      } catch (error) {
        if (error instanceof RevisionConflict) {
          return { ok: false, code: "revision-conflict", key: error.key, currentRevision: error.currentRevision };
        }
        throw error;
      } finally {
        await session.endSession();
      }
    },
    async scan(prefix: string, scanOptions = {}): Promise<ExtensionDocumentScanPage> {
      const limit = Math.max(1, Math.min(scanOptions.limit ?? 100, 1000));
      const cursor = scanOptions.cursor ?? "";
      const keyFilter: Record<string, unknown> = cursor === "" ? { $gte: prefix } : { $gt: cursor };
      const rows = await documents
        .find({ owner, key: { ...keyFilter, $lt: `${prefix}${PREFIX_HIGH}` } })
        .sort({ key: 1 })
        .limit(limit)
        .toArray();
      const entries = rows.map(toDocument);
      const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.key ?? null) : null;
      return { entries, nextCursor };
    },
    async schemaVersion(): Promise<number> {
      const row = await meta.findOne({ owner });
      return row?.schemaVersion ?? 0;
    },
    async setSchemaVersion(version: number): Promise<void> {
      await meta.updateOne({ owner }, { $set: { schemaVersion: version } }, { upsert: true });
    }
  };
}

/** 在事务内执行一批操作；任一 CAS 冲突抛哨兵，由调用方回滚整批。 */
async function applyOperations(
  context: OwnerStoreContext,
  operations: readonly ExtensionDocumentOperation[],
  session: MongoDocumentSessionLike
): Promise<ExtensionDocumentBatchResult> {
  const { documents, owner, now } = context;
  const revisions: Record<string, number | null> = {};
  for (const operation of operations) {
    const current = await documents.findOne({ owner, key: operation.key }, { session });
    const expected = operation.expectedRevision;
    if (expected !== undefined) {
      const currentRevision = current ? current.revision : null;
      if (currentRevision !== expected) throw new RevisionConflict(operation.key, currentRevision);
    }
    if (operation.op === "delete") {
      if (current) await documents.deleteOne({ owner, key: operation.key }, { session });
      revisions[operation.key] = null;
      continue;
    }
    const nextRevision = (current?.revision ?? 0) + 1;
    const updatedAt = now().toISOString();
    if (current) {
      await documents.updateOne(
        { owner, key: operation.key, revision: current.revision },
        { $set: { value: operation.value, revision: nextRevision, updatedAt } },
        { session }
      );
    } else {
      await documents.insertOne({ owner, key: operation.key, value: operation.value, revision: nextRevision, updatedAt }, { session });
    }
    revisions[operation.key] = nextRevision;
  }
  return { ok: true, revisions };
}

export type ConnectMongoExtensionDocumentStoreOptions = {
  uri: string;
  database: string;
  owners: readonly string[];
  now?: () => Date;
};

/**
 * 用真实 `MongoClient` 构造 provider（同步；连接与索引建立由 `initialize()` 异步完成）。
 * 与 Canvas Mongo 适配器一致的 driver 注入：真实 client 只按结构面转成 `MongoDocumentClientLike`。
 */
export function createMongoExtensionDocumentStoreFromUri(
  options: ConnectMongoExtensionDocumentStoreOptions
): MongoExtensionDocumentStoreProvider {
  const client = new MongoClient(options.uri);
  return createMongoExtensionDocumentStore({
    client: client as unknown as MongoDocumentClientLike,
    database: options.database,
    owners: options.owners,
    ...(options.now ? { now: options.now } : {})
  });
}
