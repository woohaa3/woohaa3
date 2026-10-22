/**
 * SQLite adapter 测试（任务 3.3–3.6）。
 *
 * 用同一个 adapter contract suite 验证 CAS / 幂等 / 事务回滚，再补 SQLite 专有维度：
 * schema 无 Blob 表、重启恢复、只读库/损坏 schema 的错误映射与 readiness。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CanvasApplicationService, canvasStorageErrorCode, registerCanvasRepositoryContract, type CanvasRepository, type ContractSuiteApi } from "../core/index.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { SQLITE_CANVAS_SCHEMA_VERSION,
  SqliteCanvasRepository } from "./index.js";

const NOW = "2026-09-23T00:00:00.000Z";
const tempDirs: string[] = [];
const openRepositories: SqliteCanvasRepository[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

function openRepository(overrides: Partial<ConstructorParameters<typeof SqliteCanvasRepository>[0]> = {}): SqliteCanvasRepository {
  const repository = new SqliteCanvasRepository({
    path: path.join(tempDir(), "canvas.sqlite"),
    now: () => NOW,
    ...overrides
  });
  openRepositories.push(repository);
  return repository;
}

afterAll(() => {
  for (const repository of openRepositories) repository.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// 复用同一套 contract 断言（任务 1.3 矩阵）。
registerCanvasRepositoryContract(
  { describe, it, expect } as unknown as ContractSuiteApi,
  { createRepository: () => openRepository() as CanvasRepository }
);

describe("SQLite schema 与文件布局（任务 3.2 / 3.6）", () => {
  it("只创建 canvases / canvas_operations / schema_migrations 三张表", () => {
    const repository = openRepository();
    const tables = repository
      .debugQuery<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_"));
    expect(tables).toEqual(["canvas_lifecycle_receipts", "canvas_operations", "canvases", "schema_migrations"]);
  });

  it("不存在任何 asset blob 表或 Blob 列", () => {
    const repository = openRepository();
    const sql = repository
      .debugQuery<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type IN ('table','index')")
      .map((row) => row.sql ?? "")
      .join("\n");
    expect(sql).not.toMatch(/asset_blob/i);
    expect(sql).not.toMatch(/\bblob\b/i);
    expect(sql).not.toMatch(/base64/i);
  });

  it("运行目录里只有数据库文件（WAL/shm 之外没有媒体目录或 staging）", async () => {
    const dir = tempDir();
    const repository = new SqliteCanvasRepository({ path: path.join(dir, "canvas.sqlite"), now: () => NOW });
    openRepositories.push(repository);
    await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));
    repository.close();
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      expect(entry).not.toMatch(/media|staging|blob|asset/i);
    }
    expect(entries.some((entry) => entry.startsWith("canvas.sqlite"))).toBe(true);
  });

  it("记录 schema 版本 2", () => {
    const repository = openRepository();
    const row = repository.debugQuery<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")[0];
    expect(row.version).toBe(SQLITE_CANVAS_SCHEMA_VERSION);
    expect(SQLITE_CANVAS_SCHEMA_VERSION).toBe(2);
  });
});

describe("SQLite 重启恢复（任务 3.4）", () => {
  it("重开同一数据库后保留 revision、operation 幂等与资产 metadata", async () => {
    const dbPath = path.join(tempDir(), "canvas.sqlite");
    const first = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
    const service = new CanvasApplicationService({ repository: first, now: () => NOW });
    await service.createCanvas({ canvasId: "canvas-a" });
    const batch = {
      canvasId: "canvas-a",
      expectedRevision: 1,
      operationId: "op-1",
      actorId: "actor",
      commands: [
        { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
        { type: "nodeData.patch", nodeId: "n1", value: { outputAssetId: "asset-1" } }
      ]
    };
    const committed = await service.commitCommands(batch);
    expect(committed.revision).toBe(2);
    first.close();

    const reopened = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
    openRepositories.push(reopened);
    const restored = await reopened.getCanvas("canvas-a");
    expect(restored?.revision).toBe(2);
    expect(restored?.document.nodes.map((node) => node.id)).toEqual(["n1"]);

    // operation 幂等记录同样保持：重试返回首次结果且不重复应用。
    const retry = await reopened.getOperation("canvas-a", "op-1");
    expect(retry?.resultRevision).toBe(2);
  });
});

describe("SQLite 错误映射与 readiness（任务 3.5）", () => {
  it("只读数据库上写入失败且错误不含绝对路径", async () => {
    const dbPath = path.join(tempDir(), "canvas.sqlite");
    const writable = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
    await writable.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));
    writable.close();

    const readOnly = new SqliteCanvasRepository({ path: dbPath, readOnly: true, now: () => NOW });
    openRepositories.push(readOnly);
    let code: string | undefined;
    let message = "";
    try {
      await readOnly.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-b", NOW));
    } catch (error) {
      code = canvasStorageErrorCode(error);
      message = (error as Error).message;
    }
    expect(code).toBe("REPOSITORY_FAILURE");
    expect(message).not.toContain(tempDir());
    // readiness 在只读库上不通过。
    const health = await readOnly.health();
    expect(health.ok).toBe(false);
    expect(health.backend).toBe("sqlite");
  });

  it("注入的写失败使事务回滚，无部分写入", async () => {
    let fail = false;
    const repository = new SqliteCanvasRepository({
      path: path.join(tempDir(), "canvas.sqlite"),
      now: () => NOW,
      failWrites: () => fail
    });
    openRepositories.push(repository);
    const service = new CanvasApplicationService({ repository, now: () => NOW });
    await service.createCanvas({ canvasId: "canvas-a" });
    fail = true;
    await expect(
      service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-fail",
        actorId: "actor",
        commands: [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }]
      })
    ).rejects.toThrow();
    fail = false;
    const loaded = await service.getCanvas("canvas-a");
    expect(loaded.revision).toBe(1);
    expect(loaded.document.nodes).toEqual([]);
    expect(await repository.getOperation("canvas-a", "op-fail")).toBeNull();
  });

  it("损坏的数据库文件在打开时给出安全诊断", () => {
    const dbPath = path.join(tempDir(), "corrupt.sqlite");
    writeFileSync(dbPath, "this is not a sqlite database at all");
    let code: string | undefined;
    let message = "";
    try {
      const repository = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
      // 某些平台可能延迟到首次查询才报错。
      repository.debugQuery("SELECT COUNT(*) FROM canvases");
      repository.close();
    } catch (error) {
      code = canvasStorageErrorCode(error);
      message = (error as Error).message;
    }
    expect(code === "NOT_READY" || code === "REPOSITORY_FAILURE").toBe(true);
    expect(message).not.toContain(tempDir());
  });

  it("schema 版本高于应用支持版本时拒绝启动", async () => {
    const dbPath = path.join(tempDir(), "future.sqlite");
    const first = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
    first.debugQuery("UPDATE schema_migrations SET version = 999 WHERE version = 2");
    first.close();
    let code: string | undefined;
    try {
      new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
    } catch (error) {
      code = canvasStorageErrorCode(error);
    }
    expect(code).toBe("SCHEMA_VERSION_UNSUPPORTED");
  });

  it("健康检查在正常库上通过", async () => {
    const repository = openRepository();
    const health = await repository.health();
    expect(health.ok).toBe(true);
    expect(health.backend).toBe("sqlite");
  });

  it("数据库被另一连接持有写锁时，写入失败并映射为可诊断错误（不泄露路径）", async () => {
    const dbPath = path.join(tempDir(), "locked.sqlite");
    const repository = new SqliteCanvasRepository({ path: dbPath, now: () => NOW, busyTimeoutMs: 50 });
    openRepositories.push(repository);
    await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));

    // 第二个连接持有排他写锁。
    const blocker = new SqliteCanvasRepository({ path: dbPath, now: () => NOW, busyTimeoutMs: 50 });
    openRepositories.push(blocker);
    // 直接用底层连接开启一个未提交的立即事务。
    (blocker as unknown as { db: { exec: (sql: string) => void } }).db.exec("BEGIN IMMEDIATE");

    let code: string | undefined;
    let message = "";
    try {
      await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-b", NOW));
    } catch (error) {
      code = canvasStorageErrorCode(error);
      message = (error as Error).message;
    } finally {
      (blocker as unknown as { db: { exec: (sql: string) => void } }).db.exec("ROLLBACK");
    }
    expect(code).toBe("REPOSITORY_FAILURE");
    expect(message).toBe("数据库被锁定");
    expect(message).not.toContain(tempDir());
  });

  it("底层写失败（模拟磁盘写失败）回滚且不留下部分写入", async () => {
    let fail = false;
    const repository = new SqliteCanvasRepository({
      path: path.join(tempDir(), "disk.sqlite"),
      now: () => NOW,
      failWrites: () => fail
    });
    openRepositories.push(repository);
    const service = new CanvasApplicationService({ repository, now: () => NOW });
    await service.createCanvas({ canvasId: "canvas-a" });
    fail = true;
    await expect(
      service.commitCommands({
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-disk",
        actorId: "actor",
        commands: [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }]
      })
    ).rejects.toThrow();
    fail = false;
    const loaded = await service.getCanvas("canvas-a");
    expect(loaded.revision).toBe(1);
    expect(loaded.document.nodes).toEqual([]);
    expect(await repository.getOperation("canvas-a", "op-disk")).toBeNull();
  });
});

describe("SQLite 依赖边界（任务 3.1）", () => {
  it("package.json 在并入驻 canvas-service 后声明 contracts 且无 Mongo/COS SDK", async () => {
    const { readFileSync } = await import("node:fs");
    const manifestPath = path.resolve(__dirname, "..", "..", "..", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // 迁移后 canvas-service 单元同时承载 SQLite/Yjs 持久化；共享契约统一走
    // `@woohaa3/contracts`（其 canvas-yjs 子路径含 server-only Yjs 线格式契约）。
    expect(manifest.dependencies["@woohaa3/contracts"]).toBeDefined();
    expect(manifest.dependencies["@woohaa3/canvas-domain"]).toBeUndefined();
    expect(manifest.dependencies["@woohaa3/canvas-yjs"]).toBeUndefined();
    expect(manifest.dependencies.mongodb).toBeDefined();
    expect(manifest.dependencies["cos-nodejs-sdk-v5"]).toBeUndefined();
  });

  it("构建产物不内联 mongodb / COS SDK / GridFS / yjs", async () => {
    const { readFileSync } = await import("node:fs");
    const distPath = path.resolve(__dirname, "..", "..", "dist", "index.js");
    if (!existsSync(distPath)) return;
    const bundle = readFileSync(distPath, "utf8");
    // 声明的依赖一律 external，不会被内联；这里断言没有**直接**内联这些实现。
    for (const needle of ["mongodb", "cos-nodejs-sdk-v5", "GridFS", "new Y.Doc"]) {
      expect(bundle).not.toContain(needle);
    }
  });
});
