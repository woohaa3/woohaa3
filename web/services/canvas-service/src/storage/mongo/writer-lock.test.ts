/**
 * Mongo 部署级 writer lock 测试
 * （change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend，任务 2.1/2.2）。
 *
 * 覆盖单文档 CAS：并发只有一方成功、不同 holder 抢不到、同 holder 重入、非持有者释放无效；
 * duplicate key 视为他人持有；以及注入该锁后 readiness 的单实例语义。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableWriterLock } from "../../sync/index.js";
import { InMemoryYjsDocumentRepository } from "../../sync/index.js";
import { createCanvasService } from "../../composition.js";
import { MongoYjsRepository, MONGO_WRITER_LOCK, createMongoWriterLockStore } from "./index.js";
import { createFakeMongoClient, DuplicateKeyError } from "./test-support/fake-mongo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-mongo-lock-"));
  dirs.push(dir);
  return path.join(dir, "canvas.sqlite");
}

function repository(client: ReturnType<typeof createFakeMongoClient>["client"], database: string) {
  return new MongoYjsRepository({ client, database });
}

describe("Mongo durable writer lock（任务 2.1）", () => {
  it("并发只有一方成功；同 holder 重入；非持有者释放无效", async () => {
    const client = createFakeMongoClient().client;
    const a = createMongoWriterLockStore(repository(client, "woohaa3"));
    const b = createMongoWriterLockStore(repository(client, "woohaa3"));

    expect(await a.tryAcquire("holder-a", "t1")).toBe(true);
    // 同一库的两个 store 共用单文档：另一方抢不到。
    expect(await b.tryAcquire("holder-b", "t1")).toBe(false);
    expect((await b.currentHolder())?.instanceId).toBe("holder-a");
    // 同 holder 重入成功（重启恢复不锁死自己）。
    expect(await a.tryAcquire("holder-a", "t2")).toBe(true);
    expect((await a.currentHolder())?.since).toBe("t2");
    // 非持有者释放无效。
    await b.release("holder-b");
    expect((await a.currentHolder())?.instanceId).toBe("holder-a");
    // 持有者释放后可为他人获取。
    await a.release("holder-a");
    expect(await a.currentHolder()).toBeNull();
    expect(await b.tryAcquire("holder-b", "t3")).toBe(true);
  });

  it("duplicate key 视为他人持有", async () => {
    const { client, database } = createFakeMongoClient();
    const original = database.collection.bind(database);
    // 模拟并发：本实例 findOne 看不到、insertOne 撞上他人已写入的 `_id`。
    database.collection = (<TDoc,>(name: string) => {
      const collection = original<TDoc>(name);
      if (name !== MONGO_WRITER_LOCK) return collection;
      // Proxy 保留原型方法（class 实例的方法不在自身属性上）。
      return new Proxy(collection as object, {
        get(target, property, receiver) {
          if (property === "insertOne") return async () => { throw new DuplicateKeyError(); };
          return Reflect.get(target, property, receiver);
        }
      }) as unknown as typeof collection;
    }) as typeof database.collection;

    const store = createMongoWriterLockStore(repository(client, "woohaa3"));
    expect(await store.tryAcquire("holder-me", "t1")).toBe(false);
  });

  it("强杀留下的陈旧锁可被接管；活进程持有者不被抢（缺陷 D3）", async () => {
    const client = createFakeMongoClient().client;
    const store = createMongoWriterLockStore(repository(client, "woohaa3"));
    const host = hostname();

    // 同主机、pid 已不存在 → 新实例接管。
    expect(await store.tryAcquire(`${host}:999999`, "t1")).toBe(true);
    expect(await store.tryAcquire(`${host}:${process.pid}`, "t2")).toBe(true);
    expect((await store.currentHolder())?.instanceId).toBe(`${host}:${process.pid}`);

    // 活跃持有者（同主机当前进程）不被其它实例抢；跨主机/旧格式同样保守拒绝。
    expect(await store.tryAcquire(`${host}:1`, "t3")).toBe(false);
    expect(await store.tryAcquire("other-host:999999", "t4")).toBe(false);
    expect(await store.tryAcquire("legacy-instance", "t5")).toBe(false);
    expect((await store.currentHolder())?.instanceId).toBe(`${host}:${process.pid}`);
  });

  it("health 反映后端连通性", async () => {
    const client = createFakeMongoClient().client;
    const store = createMongoWriterLockStore(repository(client, "woohaa3"));
    expect((await store.health()).ok).toBe(true);
  });
});

describe("注入 Mongo writer lock 的 readiness（任务 2.2）", () => {
  it("第一个实例 ready；第二个因锁失败；释放后第三个 ready", async () => {
    const client = createFakeMongoClient().client;
    const lockFor = () =>
      createDurableWriterLock(createMongoWriterLockStore(repository(client, "woohaa3")));
    const env = {
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb(),
      WOOHAA3_TASK_SERVICE_URL: "http://127.0.0.1:1",
      WOOHAA3_MEDIA_SERVICE_URL: "http://127.0.0.1:1"
    };

    const first = await createCanvasService({
      env,
      yjsRepository: new InMemoryYjsDocumentRepository(),
      writerLock: lockFor(),
      instanceId: "a"
    });
    expect((await first.readiness()).ready).toBe(true);

    const second = await createCanvasService({
      env,
      yjsRepository: new InMemoryYjsDocumentRepository(),
      writerLock: lockFor(),
      instanceId: "b"
    });
    const secondReadiness = await second.readiness();
    expect(secondReadiness.ready).toBe(false);
    expect(secondReadiness.reason).toMatch(/writer lock/);

    await first.close();
    const third = await createCanvasService({
      env,
      yjsRepository: new InMemoryYjsDocumentRepository(),
      writerLock: lockFor(),
      instanceId: "c"
    });
    expect((await third.readiness()).ready).toBe(true);
    await third.close();
    await second.close();
  });
});
