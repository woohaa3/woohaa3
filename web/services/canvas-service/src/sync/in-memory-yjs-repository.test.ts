/**
 * in-memory Yjs 仓储的 contract 验证（任务 3.1 / 3.4）。
 *
 * 先在这里固定「所有 Yjs adapter 必须一致」的行为，SQLite/Mongo 再跑**同一套**断言。
 */
import { describe, expect, it } from "vitest";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { registerYjsRepositoryContract, seedDocument } from "./yjs-contract-suite.js";
import type { YjsContractSuiteApi } from "./yjs-contract-suite.js";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";

registerYjsRepositoryContract(
  { describe, it, expect } as unknown as YjsContractSuiteApi,
  { createRepository: () => new InMemoryYjsDocumentRepository() }
);

describe("in-memory adapter 专有（任务 3.4）", () => {
  it("注入的提交失败会抛出（调用方据此回滚 room）", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    await seedDocument(repository);
    repository.failNextCommit(new Error("模拟数据库失败"));
    await expect(
      repository.commitYjsCommand({
        canvasId: "canvas-contract",
        expectedStorageSeq: 0,
        update: new Uint8Array([1]),
        revision: 1,
        updatedAt: "2026-09-23T00:00:00.000Z",
        projection: createEmptyWoohaa3ServerCanvas("canvas-contract", "2026-09-23T00:00:00.000Z"),
        command: {
          commandId: "cmd-1",
          payloadHash: "a".repeat(64),
          revision: 1,
          changed: true,
          actorId: "actor",
          createdAt: "2026-09-23T00:00:00.000Z"
        }
      })
    ).rejects.toThrow();
    // 失败后没有留下任何写入。
    const state = await repository.loadYjsState("canvas-contract");
    expect(state?.storageSeq).toBe(0);
    expect(state?.updates.length).toBe(0);
    expect(await repository.getCommandRecord("canvas-contract", "cmd-1")).toBeNull();
  });

  it("createYjsDocument 的格式版本被原样保存", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    await repository.createYjsDocument({
      canvasId: "c1",
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "e1",
      checkpoint: new Uint8Array([0]),
      projection: createEmptyWoohaa3ServerCanvas("c1", "2026-09-23T00:00:00.000Z"),
      revision: 0,
      createdAt: "2026-09-23T00:00:00.000Z"
    });
    expect((await repository.loadYjsState("c1"))?.formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
  });
});
