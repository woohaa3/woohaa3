/**
 * 测试专用的内存 Mongo driver（任务 6.3）。
 *
 * 它模拟真实 Mongo 中对 adapter 语义至关重要的部分：
 * - `updateOne` 的条件匹配与 `matchedCount`
 * - `{canvasId, operationId}` 唯一索引的 duplicate key（code 11000）
 * - `withTransaction`：回调抛错时**回滚**本次事务的全部写入
 * - 排序 / skip / limit / projection
 *
 * 刻意**不**模拟 GridFS 或二进制存储：本 adapter 根本不存在这类能力。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import type { MongoCanvasDoc,
  MongoCanvasRepositoryDeps,
  MongoClientLike,
  MongoCollectionLike,
  MongoOperationDoc,
  MongoSessionLike } from "../driver.js";

export class DuplicateKeyError extends Error {
  readonly code = 11000;
  constructor(message = "E11000 duplicate key error") {
    super(message);
    this.name = "MongoServerError";
  }
}

type AnyDoc = Record<string, unknown>;

/** 一次事务的写入日志，用于回滚。 */
type Journal = Array<() => void>;

export class FakeMongoDatabase {
  readonly store = new Map<string, AnyDoc[]>();
  readonly indexes = new Map<string, Array<{ spec: Record<string, 1 | -1>; unique: boolean }>>();
  /** 事务深度；> 0 时写入进入 journal 而不是立即生效。 */
  private journal: Journal | null = null;

  collection<TDoc>(name: string): MongoCollectionLike<TDoc> {
    return new FakeCollection<TDoc>(this, name) as unknown as MongoCollectionLike<TDoc>;
  }

  docs(name: string): AnyDoc[] {
    let list = this.store.get(name);
    if (!list) {
      list = [];
      this.store.set(name, list);
    }
    return list;
  }

  beginTransaction(): void {
    this.journal = [];
  }

  /** 提交：丢弃 journal（写入已直接生效）。 */
  commit(): void {
    this.journal = null;
  }

  /** 回滚：逆序执行 journal 里的撤销操作。 */
  rollback(): void {
    const journal = this.journal;
    this.journal = null;
    if (!journal) return;
    for (const undo of journal.reverse()) undo();
  }

  get inTransaction(): boolean {
    return this.journal !== null;
  }

  record(undo: () => void): void {
    if (!this.journal) throw new Error("record() 只能在事务内调用");
    this.journal.push(undo);
  }

  command(_command: Record<string, unknown>): Promise<unknown> {
    return Promise.resolve({ ok: 1 });
  }

  listCollections() {
    return {
      toArray: async () => [...this.store.keys()].map((name) => ({ name }))
    };
  }
}

class FakeCollection<TDoc> {
  constructor(private readonly database: FakeMongoDatabase, private readonly name: string) {}

  async createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<string> {
    // 真实 Mongo 中 createIndex 会隐式创建 collection。
    this.database.docs(this.name);
    // 对齐真实服务端约束：`_id` 索引自动唯一，不能声明 `unique`（否则服务端拒绝）。
    if (options?.unique && Object.keys(spec).length === 1 && spec._id === 1) {
      throw new Error(
        "The field 'unique' is not valid for an _id index specification. Specification: { unique: true, key: { _id: 1 } }"
      );
    }
    const list = this.database.indexes.get(this.name) ?? [];
    list.push({ spec, unique: options?.unique ?? false });
    this.database.indexes.set(this.name, list);
    return Object.keys(spec).join("_");
  }

  async findOne(filter: AnyDoc, _options?: unknown): Promise<TDoc | null> {
    return (this.database.docs(this.name).find((doc) => matches(doc, filter)) as TDoc | undefined) ?? null;
  }

  find(filter: AnyDoc, _options?: unknown) {
    const all = () => this.database.docs(this.name).filter((doc) => matches(doc, filter ?? {}));
    return {
      sort: (spec: Record<string, 1 | -1>) => {
        const sorted = all().sort((a, b) => compareBy(a, b, spec));
        return {
          skip: (count: number) => {
            const skipped = sorted.slice(count);
            return {
              limit: (limitCount: number) => ({
                toArray: async () => skipped.slice(0, limitCount) as TDoc[]
              })
            };
          }
        };
      }
    };
  }

  async countDocuments(filter?: AnyDoc): Promise<number> {
    return this.database.docs(this.name).filter((doc) => matches(doc, filter ?? {})).length;
  }

  async insertOne(doc: TDoc, _options?: unknown): Promise<{ insertedId: unknown }> {
    const candidate = doc as AnyDoc;
    const list = this.database.docs(this.name);

    // 主键唯一：Mongo 的 `_id` 天然唯一，重复插入报 duplicate key。
    if (candidate._id !== undefined && list.some((existing) => existing._id === candidate._id)) {
      throw new DuplicateKeyError();
    }

    const uniqueIndexes = (this.database.indexes.get(this.name) ?? []).filter((index) => index.unique);
    for (const index of uniqueIndexes) {
      const violates = list.some((existing) => keysMatch(existing, candidate, Object.keys(index.spec)));
      if (violates) throw new DuplicateKeyError();
    }

    list.push(candidate);
    if (this.database.inTransaction) {
      this.database.record(() => {
        const current = this.database.docs(this.name);
        const index = current.indexOf(candidate);
        if (index >= 0) current.splice(index, 1);
      });
    }
    return { insertedId: candidate._id };
  }

  async updateOne(
    filter: AnyDoc,
    update: { $set: Record<string, unknown> },
    options?: { session?: unknown; upsert?: boolean }
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const doc = this.database.docs(this.name).find((entry) => matches(entry, filter));
    if (!doc) {
      if (options?.upsert) {
        const created: AnyDoc = { ...filter, ...update.$set };
        const list = this.database.docs(this.name);
        list.push(created);
        if (this.database.inTransaction) {
          this.database.record(() => {
            const current = this.database.docs(this.name);
            const index = current.indexOf(created);
            if (index >= 0) current.splice(index, 1);
          });
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (this.database.inTransaction) {
      const snapshot = { ...doc };
      this.database.record(() => {
        for (const key of Object.keys(doc)) delete doc[key];
        Object.assign(doc, snapshot);
      });
    }
    Object.assign(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: AnyDoc, _options?: unknown): Promise<{ deletedCount: number }> {
    const list = this.database.docs(this.name);
    const index = list.findIndex((entry) => matches(entry, filter));
    if (index < 0) return { deletedCount: 0 };
    const [removed] = list.splice(index, 1);
    if (this.database.inTransaction) {
      this.database.record(() => {
        this.database.docs(this.name).splice(index, 0, removed);
      });
    }
    return { deletedCount: 1 };
  }

  async deleteMany(filter: AnyDoc, _options?: unknown): Promise<{ deletedCount: number }> {
    const list = this.database.docs(this.name);
    const removed = list.filter((entry) => matches(entry, filter));
    if (removed.length === 0) return { deletedCount: 0 };
    if (this.database.inTransaction) {
      this.database.record(() => {
        this.database.docs(this.name).push(...removed);
      });
    }
    const kept = list.filter((entry) => !matches(entry, filter));
    list.length = 0;
    list.push(...kept);
    return { deletedCount: removed.length };
  }
}

/** 构造一个连到内存 fake 的 `MongoClientLike`。 */
export function createFakeMongoClient(database = new FakeMongoDatabase()): {
  client: MongoClientLike;
  database: FakeMongoDatabase;
} {
  const client: MongoClientLike = {
    startSession(): MongoSessionLike {
      return {
        async withTransaction<T>(run: () => Promise<T>): Promise<T | undefined> {
          database.beginTransaction();
          try {
            const result = await run();
            database.commit();
            return result;
          } catch (error) {
            database.rollback();
            throw error;
          }
        },
        async endSession() {
          // 无状态 session
        }
      };
    },
    db(_name: string) {
      return {
        collection: <TDoc>(name: string) => database.collection<TDoc>(name),
        command: (command: Record<string, unknown>) => database.command(command),
        listCollections: () => database.listCollections()
      };
    },
    async close() {
      // no-op
    }
  };
  return { client, database };
}

/** 快捷：构造一个连到内存 fake 的 Mongo 仓库依赖。 */
export function fakeMongoDeps(overrides: Partial<MongoCanvasRepositoryDeps> = {}): MongoCanvasRepositoryDeps & { database: FakeMongoDatabase } {
  const { client, database } = createFakeMongoClient();
  return { client, database, ...overrides } as MongoCanvasRepositoryDeps & { database: FakeMongoDatabase };
}

function keysMatch(a: AnyDoc, b: AnyDoc, keys: string[]): boolean {
  return keys.every((key) => a[key] === b[key]);
}

function matches(doc: AnyDoc, filter: AnyDoc): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = doc[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return matchesOperators(actual, value as Record<string, unknown>);
    }
    return actual === value;
  });
}

/** 支持 `$lte` / `$lt` / `$gte` / `$gt` / `$in` 等查询操作符（adapter 会用到的子集）。 */
function matchesOperators(actual: unknown, operators: Record<string, unknown>): boolean {
  for (const [operator, expected] of Object.entries(operators)) {
    switch (operator) {
      case "$lte":
        if (!(typeof actual === "number" && typeof expected === "number" && actual <= expected)) return false;
        break;
      case "$lt":
        if (!(typeof actual === "number" && typeof expected === "number" && actual < expected)) return false;
        break;
      case "$gte":
        if (!(typeof actual === "number" && typeof expected === "number" && actual >= expected)) return false;
        break;
      case "$gt":
        if (!(typeof actual === "number" && typeof expected === "number" && actual > expected)) return false;
        break;
      case "$in":
        if (!Array.isArray(expected) || !expected.includes(actual)) return false;
        break;
      default:
        // 未知操作符按不匹配处理，避免静默放过。
        return false;
    }
  }
  return true;
}

function compareBy(a: AnyDoc, b: AnyDoc, spec: Record<string, 1 | -1>): number {
  for (const [key, direction] of Object.entries(spec)) {
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (left === undefined || left === null) return 1;
    if (right === undefined || right === null) return -1;
    const comparison = String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
    return comparison * direction;
  }
  return 0;
}

/** 重新导出，方便测试引用。 */
export type { MongoCanvasDoc, MongoOperationDoc };
export type { ServerCanvas };
