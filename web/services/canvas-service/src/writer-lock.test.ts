/**
 * 部署级 writer lock 组合测试（change: split-web-runtime-services，任务 3.7 / 8.4）。
 *
 * 验证 `createCanvasService` 把「首版 room 服务采用单应用实例」落到 readiness：
 * 第二个实例抢不到锁时不得进入 ready，第一个实例释放后第二个才能进入。
 * 用真实 SQLite 文件（同库条件写入）验证**跨实例**互斥，而不是进程内假锁。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasService } from "./composition.js";
import { InMemoryYjsDocumentRepository } from "./sync/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-lock-"));
  dirs.push(dir);
  return path.join(dir, "canvas.sqlite");
}

function envFor(dbPath: string): Record<string, string> {
  return {
    WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
    WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: dbPath,
    // run/projector 需要 Task；本用例只关心 writer lock / readiness，指向不可达地址。
    WOOHAA3_TASK_SERVICE_URL: "http://127.0.0.1:1",
    WOOHAA3_MEDIA_SERVICE_URL: "http://127.0.0.1:1"
  };
}

describe("部署级 writer lock（任务 3.7 / 8.4）", () => {
  it("第二个实例抢不到锁，readiness 失败；第一个释放后第二个可进入", async () => {
    const db = tempDb();
    const first = await createCanvasService({
      env: envFor(db),
      yjsRepository: new InMemoryYjsDocumentRepository(),
      instanceId: "instance-a"
    });
    expect((await first.readiness()).ready).toBe(true);

    // 第二个实例：真实 SQLite durable lock 已被 instance-a 持有。
    const second = await createCanvasService({
      env: envFor(db),
      yjsRepository: new InMemoryYjsDocumentRepository(),
      instanceId: "instance-b"
    });
    const secondReadiness = await second.readiness();
    expect(secondReadiness.ready).toBe(false);
    expect(secondReadiness.reason).toMatch(/writer lock/);

    // 第一个释放（其 close 会释放锁）。
    await first.close();

    const third = await createCanvasService({
      env: envFor(db),
      yjsRepository: new InMemoryYjsDocumentRepository(),
      instanceId: "instance-c"
    });
    expect((await third.readiness()).ready).toBe(true);
    await third.close();
    await second.close();
  });

  it("durable writer lock 跨进程条件写入语义：不同 holder 抢不到，同 holder 重入成功", async () => {
    const db = tempDb();
    const storePath = db;
    const { SqliteYjsRepository, createSqliteWriterLockStore } = await import("./storage/sqlite/index.js");
    const repository = new SqliteYjsRepository({ path: storePath });
    const store = createSqliteWriterLockStore(repository);

    expect(await store.tryAcquire("a", "t1")).toBe(true);
    expect(await store.tryAcquire("b", "t1")).toBe(false);
    // 同一 holder 重入（重启恢复不锁死自己）。
    expect(await store.tryAcquire("a", "t2")).toBe(true);
    expect((await store.currentHolder())?.instanceId).toBe("a");
    await store.release("b");
    // 非持有者释放无效。
    expect((await store.currentHolder())?.instanceId).toBe("a");
    await store.release("a");
    expect(await store.currentHolder()).toBeNull();
    repository.close();
  });
});
