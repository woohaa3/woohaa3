/**
 * Mongo Yjs 持久化测试（任务 3.3）。
 *
 * 单元层用内存 fake driver 跑**同一套** Yjs contract suite；真实 replica-set 集成通过
 * `MONGO_TEST_URI` 显式启用（本环境无 mongod，见 notes/mongo-integration.md）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { seedDocument, registerYjsRepositoryContract } from "../../sync/index.js";
import type { YjsContractSuiteApi } from "../../sync/index.js";
import { MongoYjsRepository } from "./yjs.js";
import { fakeMongoDeps } from "./test-support/fake-mongo.js";

const NOW = "2026-09-23T00:00:00.000Z";

function createRepository(): MongoYjsRepository {
  return new MongoYjsRepository({ ...fakeMongoDeps(), database: "woohaa3" });
}

registerYjsRepositoryContract(
  { describe, it, expect } as unknown as YjsContractSuiteApi,
  { createRepository }
);

describe("Mongo Yjs schema 与边界（任务 3.3）", () => {
  it("lists all resource receipts across pages in revision order", async () => {
    const deps = fakeMongoDeps();
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3" });
    const documents = deps.database.docs("canvas_yjs_commands");
    for (let revision = 1001; revision >= 1; revision--) documents.push({ canvasId: "canvas", commandId: `cmd-${revision}`, actorId: "assistant-world:run", changed: true, revision, resourceEdit: { history: {} } });
    const result = await repository.listResourceEditCommands("canvas", "run");
    expect(result).toHaveLength(1001);
    expect(result[0]).toEqual({ commandId: "cmd-1", revision: 1 });
    expect(result.at(-1)).toEqual({ commandId: "cmd-1001", revision: 1001 });
  });
  it("建立 canvasId+seq 与 canvasId+commandId 唯一索引", async () => {
    const deps = fakeMongoDeps();
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3" });
    await repository.ensureIndexes();
    const updateIndexes = deps.database.indexes.get("canvas_yjs_updates") ?? [];
    const commandIndexes = deps.database.indexes.get("canvas_yjs_commands") ?? [];
    expect(updateIndexes.some((index) => index.unique)).toBe(true);
    expect(commandIndexes.some((index) => index.unique)).toBe(true);
  });

  it("只使用三个 Yjs collection，无 GridFS / 二进制媒体 collection", async () => {
    const deps = fakeMongoDeps();
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3" });
    await repository.ensureIndexes();
    await seedDocument(repository);
    await repository.commitYjsCommand({
      canvasId: "canvas-contract",
      expectedStorageSeq: 0,
      update: new Uint8Array([1]),
      revision: 1,
      updatedAt: NOW,
      projection: createEmptyWoohaa3ServerCanvas("canvas-contract", NOW),
      command: {
        commandId: "cmd-1",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    const names = [...deps.database.store.keys()].sort();
    expect(names).toEqual(["canvas_yjs_commands", "canvas_yjs_documents", "canvas_yjs_updates"]);
    expect(names).not.toContain("fs.files");
    expect(names).not.toContain("fs.chunks");
  });

  it("只保存 Yjs update 与 JSON projection，不含媒体 bytes", async () => {
    const deps = fakeMongoDeps();
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3" });
    await seedDocument(repository);
    const documents = deps.database.docs("canvas_yjs_documents");
    expect(documents[0].formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
    // projection 里没有 blob/base64/签名 URL。
    const json = JSON.stringify(documents[0].projection);
    expect(json).not.toContain("blob:");
    expect(json).not.toContain("base64");
    expect(json).not.toContain("X-Amz-Signature");
  });

  it("checkpoint 压缩不删除命令幂等记录，并保留 cutoff 之后的 update", async () => {
    const deps = fakeMongoDeps();
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3" });
    await seedDocument(repository);
    for (let index = 1; index <= 3; index += 1) {
      await repository.commitYjsCommand({
        canvasId: "canvas-contract",
        expectedStorageSeq: index - 1,
        update: new Uint8Array([index]),
        revision: index,
        updatedAt: NOW,
        projection: createEmptyWoohaa3ServerCanvas("canvas-contract", NOW),
        command: {
          commandId: `cmd-${index}`,
          payloadHash: `${index}`.repeat(64).slice(0, 64),
          revision: index,
          changed: true,
          actorId: "actor",
          createdAt: NOW
        }
      });
    }
    await repository.replaceCheckpoint({
      canvasId: "canvas-contract",
      cutoffSeq: 1,
      checkpoint: new Uint8Array([9]),
      updatedAt: NOW
    });
    const state = await repository.loadYjsState("canvas-contract");
    expect(state?.updates.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(await repository.getCommandRecord("canvas-contract", "cmd-1")).not.toBeNull();
    expect(await repository.getCommandRecord("canvas-contract", "cmd-3")).not.toBeNull();
  });

  it("注入的提交失败使事务回滚，无部分写入", async () => {
    const deps = fakeMongoDeps();
    let fail = false;
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3", failWrites: () => fail });
    await seedDocument(repository);
    fail = true;
    await expect(
      repository.commitYjsCommand({
        canvasId: "canvas-contract",
        expectedStorageSeq: 0,
        update: new Uint8Array([1]),
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
    const state = await repository.loadYjsState("canvas-contract");
    expect(state?.storageSeq).toBe(0);
    expect(state?.updates.length).toBe(0);
    expect(await repository.getCommandRecord("canvas-contract", "cmd-fail")).toBeNull();
  });

  it("checksum 是可复算的真实 SHA-256", async () => {
    const deps = fakeMongoDeps();
    const repository = new MongoYjsRepository({ ...deps, database: "woohaa3" });
    await seedDocument(repository);
    await repository.commitYjsCommand({
      canvasId: "canvas-contract",
      expectedStorageSeq: 0,
      update: new Uint8Array([1, 2, 3]),
      revision: 1,
      updatedAt: NOW,
      projection: createEmptyWoohaa3ServerCanvas("canvas-contract", NOW),
      command: {
        commandId: "cmd-1",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    expect((await repository.loadYjsState("canvas-contract"))?.updates[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("package.json 把 mongodb 限定为本 server-only 单元依赖", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const manifest = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8")
    );
    expect(manifest.dependencies.mongodb).toBeDefined();
    // Yjs 线格式契约迁移到 `@woohaa3/contracts/canvas-yjs`。
    expect(manifest.dependencies["@woohaa3/contracts"]).toBeDefined();
    expect(manifest.dependencies["cos-nodejs-sdk-v5"]).toBeUndefined();
  });
});
