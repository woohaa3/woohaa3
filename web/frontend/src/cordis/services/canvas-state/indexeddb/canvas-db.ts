/**
 * 浏览器 IndexedDB 层。
 *
 * 布局（Yjs 是唯一持久化路径）：
 *
 * | Store | Key | 内容 |
 * | --- | --- | --- |
 * | `yjsCacheMeta` | `canvasId` | 服务端已发布 Yjs update 的格式/epoch/revision 元数据 |
 * | `yjsCacheUpdates` | `id` | 服务端已发布 Yjs update 分片 |
 *
 * 不再有本地权威画布（`canvases`/`settings`）：规范状态在服务端 published Y.Doc，
 * 浏览器只缓存服务端已发布内容，可随时丢弃并重建。
 */
export const CANVAS_DB_NAME = "woohaa3-canvas";
/**
 * v7：复合资产切换时失效旧 published update cache；无关 store 保持不变。
 */
export const CANVAS_DB_VERSION = 7;

/**
 * v4：Yjs 模式的 update cache（任务 6.3）。
 *
 * `yjsCacheMeta` 每 canvas 一条元数据；`yjsCacheUpdates` 分片保存服务端已发布 update。
 * 内容全部来自服务端广播，可随时丢弃。
 */
export const CANVAS_STORE_YJS_CACHE_META = "yjsCacheMeta";
export const CANVAS_STORE_YJS_CACHE_UPDATES = "yjsCacheUpdates";

/** 已废弃的 store 名：升级时删除。 */
const DROPPED_STORES = ["canvases", "settings", "outbox", "syncCaches", "assetBlobs"] as const;

export type CanvasDatabaseOptions = {
  /** 注入 IDBFactory；默认取 `globalThis.indexedDB`。测试传 fake-indexeddb。 */
  indexedDb?: IDBFactory;
  databaseName?: string;
  databaseVersion?: number;
};

/** 打开（必要时升级）画布数据库。失败后允许重试，不缓存失败的 Promise。 */
export class CanvasDatabase {
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private readonly databaseVersion: number;
  private dbPromise: Promise<IDBDatabase> | undefined;

  constructor(options: CanvasDatabaseOptions = {}) {
    const factory = options.indexedDb ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error("当前环境没有 IndexedDB；请注入 indexedDb 或仅在浏览器中使用");
    }
    this.factory = factory;
    this.databaseName = options.databaseName ?? CANVAS_DB_NAME;
    this.databaseVersion = options.databaseVersion ?? CANVAS_DB_VERSION;
  }

  open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      let upgradeError: unknown;
      const request = this.factory.open(this.databaseName, this.databaseVersion);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction;
        try {
          ensureBaseStores(db);
          // cache 是派生的 published bytes，不能原地改写成新权威文档。
          // 与 v2 格式门禁一起，在任何 hydration 前失效旧格式记录。
          if (event.oldVersion > 0 && event.oldVersion < 7 && db.version >= 7) {
            transaction!.objectStore(CANVAS_STORE_YJS_CACHE_META).clear();
            transaction!.objectStore(CANVAS_STORE_YJS_CACHE_UPDATES).clear();
          }
        } catch (error) {
          // 中止 versionchange 事务：IndexedDB 保留原有记录与旧版本。
          upgradeError = error;
          try {
            transaction?.abort();
          } catch {
            /* 已经结束的事务无法再中止，交给 onerror 报错 */
          }
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // 另一个标签页要求升级时主动让路，避免阻塞它的 versionchange。
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(upgradeError ?? request.error ?? new Error("打开画布数据库失败"));
      request.onblocked = () => {
        /* 等待其它连接关闭；不额外处理 */
      };
    });

    this.dbPromise = promise;
    promise.catch(() => {
      if (this.dbPromise === promise) this.dbPromise = undefined;
    });
    return promise;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise.catch(() => null);
    db?.close();
    this.dbPromise = undefined;
  }
}

function ensureBaseStores(db: IDBDatabase): void {
  // v4：Yjs update cache（元数据 + 分片 update）。只含服务端已发布内容。
  if (!db.objectStoreNames.contains(CANVAS_STORE_YJS_CACHE_META)) {
    db.createObjectStore(CANVAS_STORE_YJS_CACHE_META, { keyPath: "canvasId" });
  }
  if (!db.objectStoreNames.contains(CANVAS_STORE_YJS_CACHE_UPDATES)) {
    const store = db.createObjectStore(CANVAS_STORE_YJS_CACHE_UPDATES, { keyPath: "id" });
    store.createIndex("byCanvasSeq", ["canvasId", "seq"]);
  }
  // v6：删除 remote-cas 时代与本地权威画布的 store。这些内容不再被任何代码读取。
  for (const name of DROPPED_STORES) {
    if (db.objectStoreNames.contains(name)) {
      db.deleteObjectStore(name);
    }
  }
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务被中止"));
  });
}
