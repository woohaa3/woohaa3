import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { SqliteYjsRepository } from "./sqlite/yjs.js";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { SqliteCanvasRepository } from "./sqlite/index.js";
import { InMemoryCanvasRepository } from "./core/in-memory-repository.js";
import { MongoCanvasRepository } from "./mongo/index.js";
import { createFakeMongoClient } from "./mongo/test-support/fake-mongo.js";

const canvas = (id: string) => createEmptyWoohaa3ServerCanvas(id, "2026-10-16T00:00:00Z");
it("SQLite 内容与回执原子提交，重启后恢复，删除后不复活", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "canvas-receipts-"));
  let repository = new SqliteCanvasRepository({ path: path.join(dir, "canvas.sqlite") });
  try {
    const original = await repository.createCanvas(canvas("a"), "create-a");
    repository.close();
    repository = new SqliteCanvasRepository({ path: path.join(dir, "canvas.sqlite") });
    expect(await repository.createCanvas(canvas("a"), "create-a")).toEqual(original);
    await expect(repository.createCanvas(canvas("b"), "create-a")).rejects.toThrow();
    const yjs = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite") });
    try {
      await yjs.createYjsDocument({ canvasId: "a", formatVersion: YJS_CANVAS_FORMAT_VERSION, roomEpoch: "test", checkpoint: new Uint8Array(), projection: original, revision: 1, createdAt: original.updatedAt });
      expect(await yjs.loadYjsState("a")).not.toBeNull();
      await repository.deleteCanvas("a", 1, "delete-a");
      expect(await yjs.loadYjsState("a")).toBeNull();
    } finally { yjs.close(); }
    repository.close();
    repository = new SqliteCanvasRepository({ path: path.join(dir, "canvas.sqlite") });
    await repository.deleteCanvas("a", 1, "delete-a");
    await expect(repository.deleteCanvas("a", 2, "delete-a")).rejects.toThrow();
    expect(await repository.createCanvas(canvas("a"), "create-a")).toEqual(original);
    expect(await repository.getCanvas("a")).toBeNull();
    const reopenedYjs = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite") });
    try { expect(await reopenedYjs.loadYjsState("a")).toBeNull(); } finally { reopenedYjs.close(); }
  } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("内存与 Mongo adapter 保留相同的创建、删除幂等语义", async () => {
  const repositories = [new InMemoryCanvasRepository(), new MongoCanvasRepository({ client: createFakeMongoClient().client, database: "receipts" })];
  for (const repository of repositories) {
    const original = await repository.createCanvas(canvas("a"), "create-a");
    expect(await repository.createCanvas(canvas("a"), "create-a")).toEqual(original);
    await expect(repository.createCanvas(canvas("b"), "create-a")).rejects.toThrow();
    await repository.deleteCanvas("a", 1, "delete-a");
    await repository.deleteCanvas("a", 1, "delete-a");
    expect(await repository.getCanvas("a")).toBeNull();
  }
});


it("生命周期写失败回滚内容和回执，重试仍能提交", async () => {
  let fail = true;
  const repository = new SqliteCanvasRepository({ path: ":memory:", failWrites: () => fail });
  try {
    await expect(repository.createCanvas(canvas("a"), "create-a")).rejects.toThrow();
    expect(await repository.getCanvas("a")).toBeNull();
    fail = false;
    await repository.createCanvas(canvas("a"), "create-a");
    fail = true;
    await expect(repository.deleteCanvas("a", 1, "delete-a")).rejects.toThrow();
    expect(await repository.getCanvas("a")).not.toBeNull();
    fail = false;
    await repository.deleteCanvas("a", 1, "delete-a");
    expect(await repository.getCanvas("a")).toBeNull();
  } finally { repository.close(); }
});
