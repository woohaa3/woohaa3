/**
 * 测试用内存 Mongo driver（扩展文档存储）
 * （change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend，任务 1.2/1.4）。
 *
 * 模拟扩展文档存储语义所依赖的 Mongo 子集：条件匹配（$gte/$gt/$lt/$lte）、唯一索引、
 * `upsert`、排序 + limit，以及 `withTransaction`（回调抛错时回滚全部写入）。
 */
import type {
  MongoDocumentClientLike,
  MongoDocumentCollectionLike,
  MongoDocumentSessionLike,
  MongoDocumentUpdateResult
} from "../../src/repository/mongo-extension-document-store.js";

type AnyDoc = Record<string, unknown>;

export class DuplicateKeyError extends Error {
  readonly code = 11000;
  constructor(message = "E11000 duplicate key error") {
    super(message);
    this.name = "MongoServerError";
  }
}

function matches(doc: AnyDoc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
      const c = condition as Record<string, unknown>;
      const value = doc[field];
      if ("$gte" in c && !((value as never) >= (c.$gte as never))) return false;
      if ("$gt" in c && !((value as never) > (c.$gt as never))) return false;
      if ("$lt" in c && !((value as never) < (c.$lt as never))) return false;
      if ("$lte" in c && !((value as never) <= (c.$lte as never))) return false;
      return true;
    }
    return doc[field] === condition;
  });
}

class FakeCollection<TDoc extends AnyDoc> {
  private journal: Array<() => void> | null = null;
  private readonly unique: Array<{ fields: string[] }> = [];

  constructor(
    private readonly store: Map<string, AnyDoc[]>,
    private readonly name: string
  ) {}

  private docs(): TDoc[] {
    const existing = this.store.get(this.name);
    if (existing) return existing as unknown as TDoc[];
    const created: AnyDoc[] = [];
    this.store.set(this.name, created);
    return created as unknown as TDoc[];
  }

  private assertUnique(candidate: AnyDoc): void {
    for (const index of this.unique) {
      const clash = this.docs().some((row) =>
        index.fields.every((field) => (row as unknown as AnyDoc)[field] === candidate[field])
      );
      if (clash) throw new DuplicateKeyError();
    }
  }

  async createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<string> {
    if (options?.unique) this.unique.push({ fields: Object.keys(spec) });
    return this.name;
  }

  async findOne(filter: Record<string, unknown>): Promise<TDoc | null> {
    return this.docs().find((doc) => matches(doc as unknown as AnyDoc, filter)) ?? null;
  }

  find(filter: Record<string, unknown>) {
    const rows = this.docs().filter((doc) => matches(doc as unknown as AnyDoc, filter));
    return {
      sort(spec: Record<string, 1 | -1>) {
        const [field, direction] = Object.entries(spec)[0]!;
        const sorted = [...rows].sort((a, b) => {
          const av = (a as unknown as AnyDoc)[field];
          const bv = (b as unknown as AnyDoc)[field];
          if (av === bv) return 0;
          return (av! < bv! ? -1 : 1) * direction;
        });
        return {
          limit(count: number) {
            return { toArray: async () => sorted.slice(0, count) as unknown as TDoc[] };
          }
        };
      }
    };
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: { $set: Record<string, unknown> },
    options?: { upsert?: boolean }
  ): Promise<MongoDocumentUpdateResult> {
    const row = this.docs().find((doc) => matches(doc as unknown as AnyDoc, filter));
    if (!row) {
      if (!options?.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const equality: AnyDoc = {};
      for (const [field, condition] of Object.entries(filter)) {
        if (condition === null || typeof condition !== "object") equality[field] = condition;
      }
      const inserted = { ...equality, ...update.$set };
      this.assertUnique(inserted);
      this.docs().push(inserted as unknown as TDoc);
      if (this.journal) this.journal.push(() => this.docs().pop());
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    const before = { ...(row as unknown as AnyDoc) };
    Object.assign(row as unknown as AnyDoc, update.$set);
    if (this.journal) this.journal.push(() => Object.assign(row as unknown as AnyDoc, before));
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async insertOne(doc: TDoc): Promise<unknown> {
    this.assertUnique(doc as unknown as AnyDoc);
    this.docs().push(doc);
    if (this.journal) this.journal.push(() => this.docs().pop());
    return { insertedId: undefined };
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const rows = this.docs();
    const index = rows.findIndex((doc) => matches(doc as unknown as AnyDoc, filter));
    if (index < 0) return { deletedCount: 0 };
    const [removed] = rows.splice(index, 1);
    if (this.journal) this.journal.push(() => rows.splice(index, 0, removed!));
    return { deletedCount: 1 };
  }

  setJournal(journal: Array<() => void> | null): void {
    this.journal = journal;
  }
}

export class FakeMongoClient implements MongoDocumentClientLike {
  private readonly store = new Map<string, AnyDoc[]>();
  private readonly collections = new Map<string, FakeCollection<AnyDoc>>();
  private journal: Array<() => void> | null = null;
  closed = false;

  private collectionRef(name: string): FakeCollection<AnyDoc> {
    const existing = this.collections.get(name);
    if (existing) return existing;
    const created = new FakeCollection<AnyDoc>(this.store, name);
    this.collections.set(name, created);
    return created;
  }

  db(_name: string) {
    return { collection: <TDoc>(name: string) => this.collectionRef(name) as unknown as MongoDocumentCollectionLike<TDoc> };
  }

  startSession(): MongoDocumentSessionLike {
    const self = this;
    const journal: Array<() => void> = [];
    return {
      async withTransaction<T>(run: () => Promise<T>): Promise<T | undefined> {
        const previous = self.journal;
        self.setJournal(journal);
        try {
          return await run();
        } catch (error) {
          for (const undo of journal.reverse()) undo();
          throw error;
        } finally {
          self.setJournal(previous);
        }
      },
      async endSession() {}
    };
  }

  private setJournal(journal: Array<() => void> | null): void {
    this.journal = journal;
    for (const collection of this.collections.values()) collection.setJournal(journal);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
