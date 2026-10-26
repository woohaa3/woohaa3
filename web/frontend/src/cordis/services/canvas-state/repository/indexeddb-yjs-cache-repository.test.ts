/**
 * Yjs cache 测试（任务 6.3）。
 *
 * 验证：cache 可存取、格式/epoch 不匹配被检出、清空后可重建、损坏 cache 被检出、
 * IndexedDB 与内存实现语义一致。
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { InMemoryYjsCacheRepository,
  IndexedDbYjsCacheRepository,
  type YjsCacheRepository } from "./indexeddb-yjs-cache-repository.js";
import { CanvasDatabase } from "../indexeddb/canvas-db.js";
import { YjsCacheError,
  applyYjsCacheToDoc,
  validateYjsCache,
  yjsCacheUpdateId,
  type YjsCacheMetadata } from "../indexeddb/yjs-cache.js";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-cache";
const FORMAT = "woohaa3-ycanvas-v1";

function metadata(overrides: Partial<YjsCacheMetadata> = {}): YjsCacheMetadata {
  return {
    canvasId: CANVAS,
    formatVersion: FORMAT,
    roomEpoch: "epoch-1",
    revision: 2,
    updatedAt: NOW,
    ...overrides
  };
}

function suite(name: string, create: () => Promise<YjsCacheRepository> | YjsCacheRepository) {
  describe(name, () => {
    it("保存元数据与 update 后可完整读回（按 seq 升序）", async () => {
      const repository = await create();
      await repository.saveMetadata(metadata());
      await repository.appendUpdate({ canvasId: CANVAS, seq: 2, update: new Uint8Array([2]), createdAt: NOW });
      await repository.appendUpdate({ canvasId: CANVAS, seq: 1, update: new Uint8Array([1]), createdAt: NOW });

      const load = await repository.load(CANVAS);
      expect(load).not.toBeNull();
      if (!load) return;
      expect(load.metadata.revision).toBe(2);
      expect(load.updates.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(load.updates.every((entry) => entry.origin === "server")).toBe(true);
    });

    it("不存在的 canvas 返回 null", async () => {
      const repository = await create();
      expect(await repository.load("missing")).toBeNull();
    });

    it("清空后 cache 消失（可重建路径）", async () => {
      const repository = await create();
      await repository.saveMetadata(metadata());
      await repository.appendUpdate({ canvasId: CANVAS, seq: 1, update: new Uint8Array([1]), createdAt: NOW });
      await repository.clear(CANVAS);
      expect(await repository.load(CANVAS)).toBeNull();
      expect(await repository.count(CANVAS)).toBe(0);
    });

    it("多 canvas 互不干扰", async () => {
      const repository = await create();
      await repository.saveMetadata(metadata());
      await repository.saveMetadata(metadata({ canvasId: "canvas-other", revision: 9 }));
      await repository.appendUpdate({ canvasId: CANVAS, seq: 1, update: new Uint8Array([1]), createdAt: NOW });
      await repository.appendUpdate({ canvasId: "canvas-other", seq: 1, update: new Uint8Array([9]), createdAt: NOW });

      expect((await repository.load(CANVAS))?.metadata.revision).toBe(2);
      expect((await repository.load("canvas-other"))?.metadata.revision).toBe(9);
      expect((await repository.load(CANVAS))?.updates.map((entry) => entry.update[0])).toEqual([1]);
    });
  });
}

suite("InMemoryYjsCacheRepository", () => new InMemoryYjsCacheRepository());
suite("IndexedDbYjsCacheRepository", () => {
  const factory = new IDBFactory();
  const database = new CanvasDatabase({ indexedDb: factory });
  return new IndexedDbYjsCacheRepository({ indexedDb: factory, open: () => database.open() });
});

describe("cache 校验与重建（任务 6.3）", () => {
  it("格式不匹配被检出（必须丢弃 cache）", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata({ formatVersion: "woohaa3-ycanvas-v0" }));
    const load = await repository.load(CANVAS);
    const result = validateYjsCache(load, { formatVersion: FORMAT, roomEpoch: "epoch-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/格式/);
  });

  it("room epoch 过期被检出", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata({ roomEpoch: "old-epoch" }));
    const load = await repository.load(CANVAS);
    const result = validateYjsCache(load, { formatVersion: FORMAT, roomEpoch: "new-epoch" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/epoch/);
  });

  it("无 cache 时校验失败（需从服务端全量同步）", () => {
    const result = validateYjsCache(null, { formatVersion: FORMAT, roomEpoch: null });
    expect(result.ok).toBe(false);
  });

  it("匹配时校验通过", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata());
    const load = await repository.load(CANVAS);
    expect(validateYjsCache(load, { formatVersion: FORMAT, roomEpoch: "epoch-1" }).ok).toBe(true);
  });

  it("客户端尚无 epoch 时接受 cache（首次连接）", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata());
    const load = await repository.load(CANVAS);
    expect(validateYjsCache(load, { formatVersion: FORMAT, roomEpoch: null }).ok).toBe(true);
  });

  it("applyYjsCacheToDoc 按 seq 应用并返回 revision", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata({ revision: 3 }));
    await repository.appendUpdate({ canvasId: CANVAS, seq: 1, update: new Uint8Array([1]), createdAt: NOW });
    await repository.appendUpdate({ canvasId: CANVAS, seq: 2, update: new Uint8Array([2]), createdAt: NOW });
    const load = await repository.load(CANVAS);
    if (!load) throw new Error("cache 缺失");

    const applied: number[] = [];
    const revision = applyYjsCacheToDoc({}, load, (_doc: unknown, update: Uint8Array) => applied.push(update[0]));
    expect(revision).toBe(3);
    expect(applied).toEqual([1, 2]);
  });

  it("cache seq 非单调（损坏）抛 CACHE_CORRUPT", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata());
    // 直接构造 seq 回退的 cache（模拟损坏）。
    const corrupt = {
      metadata: metadata(),
      updates: [
        { id: yjsCacheUpdateId(CANVAS, 2), canvasId: CANVAS, seq: 2, update: new Uint8Array([2]), origin: "server" as const, createdAt: NOW },
        { id: yjsCacheUpdateId(CANVAS, 1), canvasId: CANVAS, seq: 1, update: new Uint8Array([1]), origin: "server" as const, createdAt: NOW }
      ]
    };
    expect(() => applyYjsCacheToDoc({}, corrupt, () => undefined)).toThrow(YjsCacheError);
    try {
      applyYjsCacheToDoc({}, corrupt, () => undefined);
    } catch (error) {
      expect((error as YjsCacheError).code).toBe("CACHE_CORRUPT");
    }
    void repository;
  });

  it("cache 可清空后由空状态重建（无残留）", async () => {
    const repository = new InMemoryYjsCacheRepository();
    await repository.saveMetadata(metadata());
    await repository.appendUpdate({ canvasId: CANVAS, seq: 1, update: new Uint8Array([1]), createdAt: NOW });
    await repository.clear(CANVAS);
    // 重建：从空 cache 开始追加服务端 update。
    await repository.saveMetadata(metadata({ revision: 1 }));
    await repository.appendUpdate({ canvasId: CANVAS, seq: 5, update: new Uint8Array([5]), createdAt: NOW });
    const load = await repository.load(CANVAS);
    expect(load?.updates.map((entry) => entry.seq)).toEqual([5]);
    expect(load?.metadata.revision).toBe(1);
  });
});

it("rejects legacy or older-capability caches before hydration and accepts the current capability", () => {
  const load = { metadata: { canvasId: "capability", formatVersion: FORMAT, roomEpoch: "epoch", revision: 4, updatedAt: "2026-10-26" }, updates: [] };
  expect(validateYjsCache(load, { formatVersion: FORMAT, roomEpoch: null, protocolVersion: 7 }).ok).toBe(false);
  expect(validateYjsCache({ ...load, metadata: { ...load.metadata, protocolVersion: 6 } }, { formatVersion: FORMAT, roomEpoch: null, protocolVersion: 7 }).ok).toBe(false);
  expect(validateYjsCache({ ...load, metadata: { ...load.metadata, protocolVersion: 7 } }, { formatVersion: FORMAT, roomEpoch: null, protocolVersion: 7 }).ok).toBe(true);
});
