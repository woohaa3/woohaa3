/**
 * Yjs 事务原子性、writer lock 与基线（任务 3.4 / 3.7 / 3.8）。
 *
 * 3.4：逐阶段注入故障，验证 update/sequence/派生 JSON/command result 全回滚。
 * 3.7：协作 writer lock —— 第二个实例不得进入 ready。
 * 3.8：真实尺度画布的 update bytes / 恢复 / 压缩基线，并验证不含媒体 bytes。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CanvasStorageError } from "../storage/core/index.js";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { applyCommandTransaction } from "./command-transaction.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { compactYjsCheckpoint, recoverYjsDocument } from "./recovery.js";
import { createInMemoryWriterLock } from "./writer-lock.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-atomic";

function batch(index: number): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: `cmd-${index}`,
    baseRevision: index - 1,
    actorId: "actor",
    commands: [{ type: "node.add", node: { id: `n${index}`, type: "image", position: { x: index * 10, y: 0 } } }]
  };
}

async function seed(): Promise<{ repository: InMemoryYjsDocumentRepository; doc: Y.Doc }> {
  const repository = new InMemoryYjsDocumentRepository();
  const doc = serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
  await repository.createYjsDocument({
    canvasId: CANVAS,
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "epoch-1",
    checkpoint: Y.encodeStateAsUpdate(doc),
    projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
    revision: 0,
    createdAt: NOW
  });
  return { repository, doc };
}

describe("事务原子性：逐阶段故障（任务 3.4）", () => {
  it("命令应用阶段失败：无 update、无记录、seq 不变", async () => {
    const { repository, doc } = await seed();
    const outcome = await applyCommandTransaction({
      doc,
      batch: { ...batch(1), commands: [{ type: "edge.add", edge: { source: "n1", target: "ghost" } }] },
      now: NOW
    });
    expect(outcome.ok).toBe(false);
    const state = await repository.loadYjsState(CANVAS);
    expect(state?.storageSeq).toBe(0);
    expect(state?.updates.length).toBe(0);
  });

  it("持久化阶段失败：整批回滚（update/seq/projection/command 全部不写）", async () => {
    const { repository, doc } = await seed();
    const outcome = await applyCommandTransaction({ doc, batch: batch(1), now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.update) return;

    repository.failNextCommit(new Error("磁盘写失败"));
    await expect(
      repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: outcome.update,
        revision: outcome.revision,
        updatedAt: NOW,
        projection: outcome.canvas,
        command: {
          commandId: "cmd-1",
          payloadHash: "a".repeat(64),
          revision: 1,
          changed: true,
          actorId: "actor",
          createdAt: NOW
        }
      })
    ).rejects.toThrow();

    const state = await repository.loadYjsState(CANVAS);
    expect(state?.storageSeq).toBe(0);
    expect(state?.updates.length).toBe(0);
    expect(state?.projection?.revision).toBe(0);
    expect(await repository.getCommandRecord(CANVAS, "cmd-1")).toBeNull();
  });

  it("commit 后 broadcast 前崩溃：恢复包含该 update（state-vector 可补齐）", async () => {
    const { repository, doc } = await seed();
    const outcome = await applyCommandTransaction({ doc, batch: batch(1), now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.update) return;

    // 已持久化。
    const committed = await repository.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 0,
      update: outcome.update,
      revision: outcome.revision,
      updatedAt: NOW,
      projection: outcome.canvas,
      command: {
        commandId: "cmd-1",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    expect(committed.ok).toBe(true);
    // 模拟「广播前进程退出」：新进程从存储恢复。
    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.revision).toBe(1);
    expect(recovered.canvas.document.nodes.map((node) => node.id)).toEqual(["n1"]);
    // commandId 重试返回首次结果（幂等）。
    const retry = await repository.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 0,
      update: outcome.update,
      revision: outcome.revision,
      updatedAt: NOW,
      projection: outcome.canvas,
      command: {
        commandId: "cmd-1",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.duplicate).toBe(true);
  });
});

describe("协作 writer lock（任务 3.7）", () => {
  it("第二个实例无法取得锁，readiness 失败", async () => {
    const lock = createInMemoryWriterLock();
    const first = await lock.acquire("instance-a", NOW);
    expect(first.ok).toBe(true);

    const second = await lock.acquire("instance-b", NOW);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/已被/);

    // health 反映「锁已被谁持有」；第二个实例的 readiness 失败来自它**抢不到锁**，
    // 而不是锁本身不健康。
    const health = await lock.health();
    expect(health.ok).toBe(true);
    expect(health.holder).toBe("instance-a");
  });

  it("释放后另一实例可取得锁", async () => {
    const lock = createInMemoryWriterLock();
    const first = await lock.acquire("instance-a", NOW);
    expect(first.ok).toBe(true);
    if (first.ok) await first.release();

    const second = await lock.acquire("instance-b", NOW);
    expect(second.ok).toBe(true);
    const health = await lock.health();
    expect(health.ok).toBe(true);
    expect(health.holder).toBe("instance-b");
  });

  it("持有者重复获取保持幂等", async () => {
    const lock = createInMemoryWriterLock();
    await lock.acquire("instance-a", NOW);
    const again = await lock.acquire("instance-a", NOW);
    expect(again.ok).toBe(true);
  });
});

describe("基线（任务 3.8）", () => {
  it("真实尺度画布的 update bytes / 恢复 / 压缩耗时记录且不含媒体 bytes", async () => {
    const baseline: Record<string, number> = {};
    const { repository, doc } = await seed();

    // 100 个节点，分 100 个命令提交（模拟真实编辑节奏）。
    const started = performance.now();
    let totalUpdateBytes = 0;
    for (let index = 1; index <= 100; index += 1) {
      const outcome = await applyCommandTransaction({ doc, batch: batch(index), now: NOW });
      if (!outcome.ok || !outcome.update) throw new Error("命令失败");
      totalUpdateBytes += outcome.update.byteLength;
      const result = await repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: index - 1,
        update: outcome.update,
        revision: outcome.revision,
        updatedAt: NOW,
        projection: outcome.canvas,
        command: {
          commandId: `cmd-${index}`,
          payloadHash: `${index}`.repeat(64).slice(0, 64),
          revision: outcome.revision,
          changed: true,
          actorId: "actor",
          createdAt: NOW
        }
      });
      if (!result.ok) throw new Error("提交失败");
    }
    baseline.commit100Ms = performance.now() - started;
    baseline.totalUpdateBytes = totalUpdateBytes;

    const readStart = performance.now();
    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    baseline.recoverMs = performance.now() - readStart;
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.canvas.document.nodes.length).toBe(100);

    const compactStart = performance.now();
    await compactYjsCheckpoint({
      repository,
      canvasId: CANVAS,
      doc: recovered.doc,
      projection: { ok: true, canvas: recovered.canvas },
      now: NOW
    });
    baseline.compactMs = performance.now() - compactStart;

    const preCompact = totalUpdateBytes;
    const state = await repository.loadYjsState(CANVAS);
    const checkpointBytes = state?.checkpoint.byteLength ?? 0;
    baseline.checkpointBytes = checkpointBytes;

    // 压缩后 checkpoint 尺寸通常小于累加的所有 update（增量有重复开销）。
    expect(checkpointBytes).toBeLessThan(preCompact);
    expect(baseline.commit100Ms).toBeLessThan(20_000);
    expect(baseline.recoverMs).toBeLessThan(5_000);

    // 无媒体 bytes：存储里不含 blob/base64/签名 URL。
    const serialized = JSON.stringify(state?.projection ?? {});
    expect(serialized).not.toContain("blob:");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("X-Amz-Signature");

    // eslint-disable-next-line no-console
    console.info("[yjs-baseline]", JSON.stringify(baseline));
  });

  it("CanvasStorageError 被原样透传（不吞掉稳定错误码）", async () => {
    const { repository } = await seed();
    repository.failNextCommit(new CanvasStorageError("REPOSITORY_FAILURE", "已诊断"));
    await expect(
      repository.commitYjsCommand({
        canvasId: CANVAS,
        expectedStorageSeq: 0,
        update: new Uint8Array([1]),
        revision: 1,
        updatedAt: NOW,
        projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
        command: {
          commandId: "cmd-x",
          payloadHash: "a".repeat(64),
          revision: 1,
          changed: true,
          actorId: "actor",
          createdAt: NOW
        }
      })
    ).rejects.toThrow("已诊断");
  });
});
