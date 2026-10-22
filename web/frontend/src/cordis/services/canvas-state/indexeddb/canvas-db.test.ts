/**
 * IndexedDB 层测试。
 *
 * 每个用例用独立的 `IDBFactory`（fake-indexeddb），所以用例之间没有数据库污染。
 * Yjs 是唯一持久化路径：数据库只含 Yjs update cache，不再有本地权威画布或
 * remote-cas 时代的 store。
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { CANVAS_DB_VERSION,
  CANVAS_STORE_YJS_CACHE_META,
  CANVAS_STORE_YJS_CACHE_UPDATES,
  CanvasDatabase } from "./canvas-db.js";

function freshFactory(): IDBFactory {
  return new IDBFactory();
}

function database(factory: IDBFactory, version?: number): CanvasDatabase {
  return new CanvasDatabase({ indexedDb: factory, databaseVersion: version ?? CANVAS_DB_VERSION });
}

describe("数据库与 object store 初始化", () => {
  it("首次打开只创建 Yjs cache 的两个 store", async () => {
    const db = await database(freshFactory()).open();
    expect(db.name).toBe("woohaa3-canvas");
    expect(db.version).toBe(CANVAS_DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(
      [CANVAS_STORE_YJS_CACHE_META, CANVAS_STORE_YJS_CACHE_UPDATES].sort()
    );
    db.close();
  });

  it("没有 IndexedDB 的环境会给出明确错误", () => {
    expect(() => new CanvasDatabase({ indexedDb: undefined as unknown as IDBFactory })).toThrow(
      /没有 IndexedDB/
    );
  });

  it("受支持的旧版本升级后删除旧 store，并失效旧发布缓存", async () => {
    const factory = freshFactory();
    // 造一个 v5 库：含本地权威画布与 remote-cas 时代的 store。
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("woohaa3-canvas", 5);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("canvases", { keyPath: "id" });
        db.createObjectStore("settings", { keyPath: "key" });
        db.createObjectStore("outbox", { keyPath: "id" });
        db.createObjectStore("syncCaches", { keyPath: "canvasId" });
        db.createObjectStore("yjsCacheMeta", { keyPath: "canvasId" });
        db.createObjectStore("yjsCacheUpdates", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["canvases", "settings", "yjsCacheMeta"], "readwrite");
        tx.objectStore("canvases").put({ id: "canvas-legacy", revision: 3 });
        tx.objectStore("settings").put({ key: "currentCanvasId", value: "canvas-legacy" });
        tx.objectStore("yjsCacheMeta").put({ canvasId: "c1", formatVersion: "woohaa3-ycanvas-v1" });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const upgraded = await database(factory).open();
    expect(upgraded.version).toBe(CANVAS_DB_VERSION);
    expect([...upgraded.objectStoreNames].sort()).toEqual(
      [CANVAS_STORE_YJS_CACHE_META, CANVAS_STORE_YJS_CACHE_UPDATES].sort()
    );
    // 旧 cache 不能作为新格式 published 文档载入。
    const read = upgraded.transaction(CANVAS_STORE_YJS_CACHE_META, "readonly").objectStore(CANVAS_STORE_YJS_CACHE_META).get("c1");
    const meta = await new Promise<{ canvasId: string } | undefined>((resolve) => {
      read.onsuccess = () => resolve(read.result as { canvasId: string } | undefined);
    });
    expect(meta).toBeUndefined();
    upgraded.close();
  });
});

describe("复合资产格式切换缓存边界", () => {
  it("v6 标签页让出升级，旧发布缓存被清除，无关偏好保留", async () => {
    const factory = freshFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("woohaa3-canvas", 6);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(CANVAS_STORE_YJS_CACHE_META, { keyPath: "canvasId" });
        request.result.createObjectStore(CANVAS_STORE_YJS_CACHE_UPDATES, { keyPath: "id" });
        request.result.createObjectStore("unrelatedPreferences", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction([CANVAS_STORE_YJS_CACHE_META, CANVAS_STORE_YJS_CACHE_UPDATES, "unrelatedPreferences"], "readwrite");
        tx.objectStore(CANVAS_STORE_YJS_CACHE_META).put({ canvasId: "c1", formatVersion: "woohaa3-ycanvas-v1" });
        tx.objectStore(CANVAS_STORE_YJS_CACHE_UPDATES).put({ id: "c1:1", canvasId: "c1", seq: 1, update: new Uint8Array([1]) });
        tx.objectStore("unrelatedPreferences").put({ key: "theme", value: "dark" });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const oldTab = database(factory, 6);
    await oldTab.open();
    const current = database(factory);
    const db = await current.open();
    const tx = db.transaction([CANVAS_STORE_YJS_CACHE_META, CANVAS_STORE_YJS_CACHE_UPDATES, "unrelatedPreferences"], "readonly");
    const count = (store: string) => new Promise<number>(resolve => {
      const request = tx.objectStore(store).count(); request.onsuccess = () => resolve(request.result);
    });
    const preference = new Promise<unknown>(resolve => {
      const request = tx.objectStore("unrelatedPreferences").get("theme"); request.onsuccess = () => resolve(request.result);
    });
    // 同时发起请求，保持同一 readonly transaction 活跃。
    const [metaCount, updateCount, savedPreference] = await Promise.all([
      count(CANVAS_STORE_YJS_CACHE_META), count(CANVAS_STORE_YJS_CACHE_UPDATES), preference
    ]);
    expect(metaCount).toBe(0); expect(updateCount).toBe(0);
    expect(savedPreference).toEqual({ key: "theme", value: "dark" });
    await oldTab.close(); await current.close();
  });

  it("当前版本重开保留新格式发布缓存", async () => {
    const factory = freshFactory();
    const first = database(factory);
    const db = await first.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CANVAS_STORE_YJS_CACHE_META, "readwrite");
      tx.objectStore(CANVAS_STORE_YJS_CACHE_META).put({ canvasId: "c1", formatVersion: "woohaa3-ycanvas-v2" });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    await first.close();
    const second = database(factory);
    const reopened = await second.open();
    const value = await new Promise<unknown>(resolve => {
      const request = reopened.transaction(CANVAS_STORE_YJS_CACHE_META, "readonly").objectStore(CANVAS_STORE_YJS_CACHE_META).get("c1");
      request.onsuccess = () => resolve(request.result);
    });
    expect(value).toEqual({ canvasId: "c1", formatVersion: "woohaa3-ycanvas-v2" });
    await second.close();
  });
});
