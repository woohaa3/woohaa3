/**
 * SQLite Yjs 持久化测试（任务 3.2）。
 *
 * 用同一套 Yjs adapter contract suite 验证 CAS / 幂等 / 压缩保留语义，再补 SQLite 专有维度：
 * schema 表结构、迁移幂等、重启恢复、无媒体 bytes、事务回滚。
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { seedDocument } from "../../sync/index.js";
import { registerYjsRepositoryContract, type YjsContractSuiteApi } from "../../sync/index.js";
import { SqliteYjsRepository, SQLITE_YJS_SCHEMA_VERSION } from "./yjs.js";

const NOW = "2026-09-23T00:00:00.000Z";
const tempDirs: string[] = [];
const openRepositories: SqliteYjsRepository[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-yjs-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

function open(pathName = path.join(tempDir(), "canvas.sqlite")): SqliteYjsRepository {
  const repository = new SqliteYjsRepository({ path: pathName, now: () => NOW });
  openRepositories.push(repository);
  return repository;
}

afterAll(() => {
  for (const repository of openRepositories) repository.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// 复用同一套 contract 断言（任务 3.1 的可复用 suite）。
registerYjsRepositoryContract(
  { describe, it, expect } as unknown as YjsContractSuiteApi,
  { createRepository: () => open() }
);

describe("SQLite Yjs schema 与文件布局（任务 3.2）", () => {
  it("创建 Yjs、writer lock 和空间占用表", () => {
    const repository = open();
    const tables = repository
      .debugQuery<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"));
    // v4 起删除 canvas_sync_modes（remote-cas 模式元数据已无读者）；
    // v3 起新增 canvas_writer_lock（部署级单实例 writer lock）。
    expect(tables).toEqual([
      "canvas_writer_lock",
      "canvas_yjs_commands",
      "canvas_yjs_documents",
      "canvas_yjs_schema_migrations",
      "canvas_yjs_updates",
      "spatial_lease_locks",
      "spatial_lease_runs"
    ]);
  });

  it("Yjs 表不含 Blob 列类型 / 媒体 bytes 概念", () => {
    const repository = open();
    const sql = repository
      .debugQuery<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.sql ?? "")
      .join("\n");
    // snapshot / update 是 Yjs bytes（BLOB 合法）；不得出现媒体 blob 表或 base64。
    expect(sql).not.toMatch(/asset_blob/i);
    expect(sql).not.toMatch(/base64/i);
    expect(sql).not.toMatch(/media/i);
  });

  it("记录 Yjs schema 版本", () => {
    const repository = open();
    const row = repository.debugQuery<{ version: number }>(
      "SELECT MAX(version) AS version FROM canvas_yjs_schema_migrations"
    )[0];
    expect(row.version).toBe(SQLITE_YJS_SCHEMA_VERSION);
  });

  it("重复构造（迁移幂等）不报错且保留数据", async () => {
    const dbPath = path.join(tempDir(), "canvas.sqlite");
    const first = new SqliteYjsRepository({ path: dbPath, now: () => NOW });
    await seedDocument(first);
    first.close();

    const second = new SqliteYjsRepository({ path: dbPath, now: () => NOW });
    openRepositories.push(second);
    expect((await second.loadYjsState("canvas-contract"))?.storageSeq).toBe(0);
  });
});

describe("SQLite Yjs 重启恢复（任务 3.2 / 3.5 基础）", () => {
  it("重开后 checkpoint、updates、seq 与幂等记录保持", async () => {
    const dbPath = path.join(tempDir(), "canvas.sqlite");
    const first = new SqliteYjsRepository({ path: dbPath, now: () => NOW });
    await seedDocument(first);
    const commit = await first.commitYjsCommand({
      canvasId: "canvas-contract",
      expectedStorageSeq: 0,
      update: new Uint8Array([1, 2, 3]),
      revision: 1,
      updatedAt: NOW,
      projection: { ...createEmptyWoohaa3ServerCanvas("canvas-contract", NOW), revision: 1 },
      command: {
        commandId: "cmd-1",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    expect(commit.ok).toBe(true);
    first.close();

    const reopened = new SqliteYjsRepository({ path: dbPath, now: () => NOW });
    openRepositories.push(reopened);
    const state = await reopened.loadYjsState("canvas-contract");
    expect(state?.storageSeq).toBe(1);
    expect(state?.updates.length).toBe(1);
    expect(Array.from(state!.updates[0].update)).toEqual([1, 2, 3]);
    // checksum 是可复算的真实 SHA-256（非占位）。
    expect(state?.updates[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await reopened.getCommandRecord("canvas-contract", "cmd-1")).not.toBeNull();
  });
});

describe("SQLite Yjs 事务失败回滚（任务 3.4）", () => {
  it("注入写失败使事务回滚，无部分写入", async () => {
    let fail = false;
    const dir = tempDir();
    const repository = new SqliteYjsRepository({
      path: path.join(dir, "canvas.sqlite"),
      now: () => NOW,
      failWrites: () => fail
    });
    openRepositories.push(repository);
    await seedDocument(repository);

    fail = true;
    await expect(
      repository.commitYjsCommand({
        canvasId: "canvas-contract",
        expectedStorageSeq: 0,
        update: new Uint8Array([9]),
        revision: 1,
        updatedAt: NOW,
        projection: createEmptyWoohaa3ServerCanvas("canvas-contract", NOW),
        command: {
          commandId: "cmd-fail",
          payloadHash: "a".repeat(64),
          revision: 1,
          changed: true,
          actorId: "actor",
          createdAt: NOW
        }
      })
    ).rejects.toThrow();

    fail = false;
    const state = await repository.loadYjsState("canvas-contract");
    expect(state?.storageSeq).toBe(0);
    expect(state?.updates.length).toBe(0);
    expect(await repository.getCommandRecord("canvas-contract", "cmd-fail")).toBeNull();
  });
});

describe("SQLite Yjs 运行时目录与依赖（任务 3.2）", () => {
  it("运行目录里只有数据库文件（无媒体目录）", async () => {
    const dir = tempDir();
    const repository = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite"), now: () => NOW });
    openRepositories.push(repository);
    await seedDocument(repository);
    repository.close();
    for (const entry of readdirSync(dir)) {
      expect(entry).not.toMatch(/media|staging|blob|asset/i);
    }
  });

  it("构造时 format 版本原样保存", async () => {
    const repository = open();
    await seedDocument(repository);
    expect((await repository.loadYjsState("canvas-contract"))?.formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
  });
});
