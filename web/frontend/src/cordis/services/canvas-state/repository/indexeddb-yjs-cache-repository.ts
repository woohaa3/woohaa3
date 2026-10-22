/**
 * IndexedDB Yjs cache 仓储（任务 6.3 / design D9）。
 *
 * 只缓存**服务端已发布**的 Yjs update 与格式元数据；提供清空、校验与重建能力。
 * 与规范画布仓储共享同一个数据库连接（v4）。
 */
import { CANVAS_STORE_YJS_CACHE_META,
  CANVAS_STORE_YJS_CACHE_UPDATES,
  requestToPromise,
  transactionDone } from "../indexeddb/canvas-db.js";
import { yjsCacheUpdateId,
  type YjsCacheLoadResult,
  type YjsCacheMetadata,
  type YjsCacheUpdate } from "../indexeddb/yjs-cache.js";

export type YjsCacheRepository = {
  /** 读取某 canvas 的 cache；不存在返回 null。 */
  load(canvasId: string): Promise<YjsCacheLoadResult | null>;
  /** 覆盖元数据（每次应用服务端 update 后更新 revision/epoch）。 */
  saveMetadata(metadata: YjsCacheMetadata): Promise<void>;
  /** 追加一条服务端 update。`origin` 固定为 server。 */
  appendUpdate(input: {
    canvasId: string;
    seq: number;
    update: Uint8Array;
    createdAt: string;
  }): Promise<void>;
  /** 清空某 canvas 的全部 cache（格式/epoch 不匹配时丢弃）。 */
  clear(canvasId: string): Promise<void>;
  /** 当前 cache 的 update 条数（测试/配额用）。 */
  count(canvasId: string): Promise<number>;
};

export type IndexedDbYjsCacheRepositoryOptions = {
  indexedDb?: IDBFactory;
  databaseName?: string;
  /** 与画布仓储共用同一连接（推荐）；省略时自行打开 v4。 */
  open?: () => Promise<IDBDatabase>;
};

export class IndexedDbYjsCacheRepository implements YjsCacheRepository {
  private readonly factory: IDBFactory | undefined;
  private readonly databaseName: string;
  private readonly injectedOpen: (() => Promise<IDBDatabase>) | undefined;
  private dbPromise: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbYjsCacheRepositoryOptions = {}) {
    this.factory = options.indexedDb ?? globalThis.indexedDB ?? undefined;
    this.databaseName = options.databaseName ?? "woohaa3-canvas";
    this.injectedOpen = options.open;
  }

  private open(): Promise<IDBDatabase> {
    if (this.injectedOpen) return this.injectedOpen();
    if (this.dbPromise) return this.dbPromise;
    if (!this.factory) {
      return Promise.reject(new Error("当前环境没有 IndexedDB；请注入 indexedDb 或只在浏览器中使用该仓储"));
    }
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(this.databaseName, 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("打开 Yjs cache 数据库失败"));
    });
    this.dbPromise = promise;
    promise.catch(() => {
      if (this.dbPromise === promise) this.dbPromise = undefined;
    });
    return promise;
  }

  async load(canvasId: string): Promise<YjsCacheLoadResult | null> {
    const db = await this.open();
    const transaction = db.transaction(
      [CANVAS_STORE_YJS_CACHE_META, CANVAS_STORE_YJS_CACHE_UPDATES],
      "readonly"
    );
    const metadata = await requestToPromise<YjsCacheMetadata | undefined>(
      transaction.objectStore(CANVAS_STORE_YJS_CACHE_META).get(canvasId) as IDBRequest<
        YjsCacheMetadata | undefined
      >
    );
    if (!metadata) return null;

    const all = await requestToPromise<YjsCacheUpdate[]>(
      transaction.objectStore(CANVAS_STORE_YJS_CACHE_UPDATES).getAll() as IDBRequest<YjsCacheUpdate[]>
    );
    const updates = all
      .filter((entry) => entry.canvasId === canvasId)
      .sort((left, right) => left.seq - right.seq)
      // 还原成新数组，避免外部持有 IDB 内部视图。
      .map((entry) => ({ ...entry, update: toBytes(entry.update) }));
    return { metadata, updates };
  }

  async saveMetadata(metadata: YjsCacheMetadata): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(CANVAS_STORE_YJS_CACHE_META, "readwrite");
    transaction.objectStore(CANVAS_STORE_YJS_CACHE_META).put(metadata);
    await transactionDone(transaction);
  }

  async appendUpdate(input: { canvasId: string; seq: number; update: Uint8Array; createdAt: string }): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(CANVAS_STORE_YJS_CACHE_UPDATES, "readwrite");
    const record: YjsCacheUpdate = {
      id: yjsCacheUpdateId(input.canvasId, input.seq),
      canvasId: input.canvasId,
      seq: input.seq,
      update: toBytes(input.update),
      origin: "server",
      createdAt: input.createdAt
    };
    transaction.objectStore(CANVAS_STORE_YJS_CACHE_UPDATES).put(record);
    await transactionDone(transaction);
  }

  async clear(canvasId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      [CANVAS_STORE_YJS_CACHE_META, CANVAS_STORE_YJS_CACHE_UPDATES],
      "readwrite"
    );
    transaction.objectStore(CANVAS_STORE_YJS_CACHE_META).delete(canvasId);
    const all = await requestToPromise<YjsCacheUpdate[]>(
      transaction.objectStore(CANVAS_STORE_YJS_CACHE_UPDATES).getAll() as IDBRequest<YjsCacheUpdate[]>
    );
    const store = transaction.objectStore(CANVAS_STORE_YJS_CACHE_UPDATES);
    for (const entry of all) {
      if (entry.canvasId === canvasId) store.delete(entry.id);
    }
    await transactionDone(transaction);
  }

  async count(canvasId: string): Promise<number> {
    const load = await this.load(canvasId);
    return load?.updates.length ?? 0;
  }
}

/** 内存实现（测试与非浏览器环境）。 */
export class InMemoryYjsCacheRepository implements YjsCacheRepository {
  private readonly metadata = new Map<string, YjsCacheMetadata>();
  private readonly updates = new Map<string, YjsCacheUpdate[]>();

  async load(canvasId: string): Promise<YjsCacheLoadResult | null> {
    const metadata = this.metadata.get(canvasId);
    if (!metadata) return null;
    const updates = [...(this.updates.get(canvasId) ?? [])]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => ({ ...entry, update: new Uint8Array(entry.update) }));
    return { metadata: { ...metadata }, updates };
  }

  async saveMetadata(metadata: YjsCacheMetadata): Promise<void> {
    this.metadata.set(metadata.canvasId, { ...metadata });
  }

  async appendUpdate(input: { canvasId: string; seq: number; update: Uint8Array; createdAt: string }): Promise<void> {
    const list = this.updates.get(input.canvasId) ?? [];
    list.push({
      id: yjsCacheUpdateId(input.canvasId, input.seq),
      canvasId: input.canvasId,
      seq: input.seq,
      update: new Uint8Array(input.update),
      origin: "server",
      createdAt: input.createdAt
    });
    this.updates.set(input.canvasId, list);
  }

  async clear(canvasId: string): Promise<void> {
    this.metadata.delete(canvasId);
    this.updates.delete(canvasId);
  }

  async count(canvasId: string): Promise<number> {
    return this.updates.get(canvasId)?.length ?? 0;
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}
