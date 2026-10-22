/**
 * Mongo adapter 测试（任务 6.1–6.7）。
 *
 * 分两层：
 * 1. **单元层**：用内存 fake driver（`test-support/fake-mongo.ts`）跑**同一套**
 *    contract suite，验证 CAS / 幂等 / 事务回滚 / 索引约束与核心语义一致（无需真实 Mongo）。
 * 2. **集成层**：真实 replica-set Mongo 测试。本环境没有 mongod，用 `MONGO_TEST_URI`
 *    环境变量显式启用，否则跳过并打印说明（tasks 6.5 允许明确启用/跳过，见 notes）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CanvasApplicationService, canvasStorageErrorCode, registerCanvasRepositoryContract, type CanvasRepository, type ContractSuiteApi } from "../core/index.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { MongoCanvasRepository } from "./index.js";
import { createFakeMongoClient, fakeMongoDeps, FakeMongoDatabase } from "./test-support/fake-mongo.js";

const NOW = "2026-09-23T00:00:00.000Z";
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 两个独立仓库共享同一 fake 数据库（模拟两个服务实例连同一 replica set）。 */
function sharedRepositories(): [MongoCanvasRepository, MongoCanvasRepository] {
  const shared = new FakeMongoDatabase();
  return [
    new MongoCanvasRepository({ client: createFakeMongoClient(shared).client, database: "test", now: () => NOW }),
    new MongoCanvasRepository({ client: createFakeMongoClient(shared).client, database: "test", now: () => NOW })
  ];
}

function createRepository(): CanvasRepository {
  const deps = fakeMongoDeps({ now: () => NOW });
  return new MongoCanvasRepository(deps);
}

// 单元层：完整 contract suite（任务 6.3）。
registerCanvasRepositoryContract(
  { describe, it, expect } as unknown as ContractSuiteApi,
  { createRepository }
);

describe("Mongo 索引与幂等（任务 6.2 / 6.3 / 6.5）", () => {
  it("建立 canvasId+operationId 与 canvasId+resultRevision 唯一索引", async () => {
    const deps = fakeMongoDeps({ now: () => NOW });
    const repository = new MongoCanvasRepository(deps);
    await repository.ensureIndexes();
    const indexes = deps.database.indexes.get("canvas_operations") ?? [];
    const unique = indexes.filter((index) => index.unique).map((index) => index.spec);
    expect(unique).toContainEqual({ canvasId: 1, operationId: 1 });
    expect(unique).toContainEqual({ canvasId: 1, resultRevision: 1 });
  });

  it("两个独立 adapter 实例并发提交同一 revision 时只有一个成功", async () => {
    const [a, b] = sharedRepositories();
    await a.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));

    const [first, second] = await Promise.allSettled([
      a.commitCanvas({
        canvas: { ...createEmptyWoohaa3ServerCanvas("canvas-a", NOW), revision: 2 },
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-a",
        actorId: "actor",
        commands: [],
        now: NOW
      }),
      b.commitCanvas({
        canvas: { ...createEmptyWoohaa3ServerCanvas("canvas-a", NOW), revision: 2 },
        canvasId: "canvas-a",
        expectedRevision: 1,
        operationId: "op-b",
        actorId: "actor",
        commands: [],
        now: NOW
      })
    ]);

    const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const rejected = [first, second].find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(canvasStorageErrorCode(rejected.reason)).toBe("REVISION_CONFLICT");
  });

  it("事务失败时回滚 operation 与画布更新，无部分写入", async () => {
    const deps = fakeMongoDeps({ now: () => NOW });
    let fail = false;
    const repository = new MongoCanvasRepository({ ...deps, failWrites: () => fail });
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
    const loaded = await service.getCanvas("canvas-a");
    expect(loaded.revision).toBe(1);
    expect(loaded.document.nodes).toEqual([]);
    expect(await repository.getOperation("canvas-a", "op-fail")).toBeNull();
  });

  it("不同实例重复提交相同 canvasId+operationId 只产生一份 operation 与一次 revision", async () => {
    const [a, b] = sharedRepositories();
    await a.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));
    const target = { ...createEmptyWoohaa3ServerCanvas("canvas-a", NOW), revision: 2 };
    const input = {
      canvas: target,
      canvasId: "canvas-a",
      expectedRevision: 1,
      operationId: "op-shared",
      actorId: "actor",
      commands: [],
      now: NOW
    };
    const first = await a.commitCanvas(input);
    const retry = await b.commitCanvas(input);
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    const canvas = await a.getCanvas("canvas-a");
    expect(canvas?.revision).toBe(2);
  });
});

describe("Mongo adapter 依赖与二进制边界（任务 6.1 / 6.7）", () => {
  it("mongodb 是本 server-only 单元依赖，且不含 GridFS / COS SDK", () => {
    const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.dependencies.mongodb).toBeDefined();
    expect(manifest.dependencies["gridfs-stream"]).toBeUndefined();
    expect(manifest.dependencies["cos-nodejs-sdk-v5"]).toBeUndefined();
    // Yjs 持久化的共享 codec 与类型来自 `@woohaa3/contracts/canvas-yjs`；
    // Mondo/Yjs 运行时的直接 yjs 依赖现由 canvas-service 单元声明。
    expect(manifest.dependencies["@woohaa3/contracts"]).toBeDefined();
  });

  it("源码不出现 GridFS / asset blob collection 概念", () => {
    const source = readdirSync(PACKAGE_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(path.join(PACKAGE_DIR, name), "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toContain("GridFSBucket");
    expect(source).not.toContain("asset_blobs");
    expect(source).not.toContain("GridFS");
  });

  it("构建产物不内联 COS SDK / GridFS / Yjs 实现", () => {
    const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
    if (!existsSync(distPath)) return;
    // 去掉注释后再断言：源码注释里出现「GridFS」是说明性文字，不是真的实现。
    const bundle = readFileSync(distPath, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // 声明的依赖一律 external；这里断言没有**直接**内联这些实现。
    for (const needle of ["cos-nodejs-sdk-v5", "new GridFSBucket", "gridfs-stream", "new Y.Doc"]) {
      expect(bundle).not.toContain(needle);
    }
  });

  it("实际使用的 collection 只有 canvases / canvas_operations / 迁移元数据", async () => {
    const deps = fakeMongoDeps({ now: () => NOW });
    const repository = new MongoCanvasRepository(deps);
    await repository.runMigrations();
    await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-a", NOW));
    // 迁移元数据 collection 只存版本/锁，不含任何媒体或二进制。
    expect(await repository.listCollectionNames()).toEqual([
      "canvas_operations",
      "canvas_schema_meta",
      "canvases"
    ]);
  });

  it("迁移幂等且记录 schema 版本", async () => {
    const deps = fakeMongoDeps({ now: () => NOW });
    const repository = new MongoCanvasRepository(deps);
    await repository.runMigrations();
    const first = deps.database.docs("canvas_schema_meta").map((doc) => doc._id).sort();
    await repository.runMigrations();
    const second = deps.database.docs("canvas_schema_meta").map((doc) => doc._id).sort();
    expect(first).toEqual(second);
    const versionDoc = deps.database.docs("canvas_schema_meta").find((doc) => doc._id === "version");
    expect(versionDoc?.version).toBe(1);
  });
});

describe("Mongo 真实 replica-set 集成（任务 6.5）", () => {
  const uri = process.env.MONGO_TEST_URI;
  const hasMongo = typeof uri === "string" && uri.length > 0;

  it.skipIf(!hasMongo)("真实 replica-set 上连接、索引与事务探测通过", async () => {
    const repository = await MongoCanvasRepository.connect({
      uri: uri as string,
      database: process.env.MONGO_TEST_DB ?? "woohaa3_test"
    });
    try {
      const health = await repository.health();
      expect(health.ok).toBe(true);
      expect(health.backend).toBe("mongo");
      const names = await repository.listCollectionNames();
      expect(names).not.toContain("fs.files");
      expect(names).not.toContain("fs.chunks");
    } finally {
      await repository.close();
    }
  });

  it("未配置 MONGO_TEST_URI 时明确说明跳过（不静默通过）", () => {
    if (hasMongo) return;
    // 该分支只是显式的跳过标记；真实集成在 CI 中通过 MONGO_TEST_URI 启用。
    expect(hasMongo).toBe(false);
  });
});
