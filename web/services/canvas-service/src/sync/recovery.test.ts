/**
 * Y.Doc 恢复与压缩测试（任务 3.4–3.6）。
 *
 * 覆盖：多 update 按 seq 恢复、checksum/格式/revision 校验失败隔离、损坏 update 不创建空文档、
 * cutoff-safe 压缩（cutoff 后保留、幂等记录保留、压缩前后收敛等价）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { applyCommandTransaction } from "./command-transaction.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { compactYjsCheckpoint, recoverYjsDocument, shouldCompact } from "./recovery.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-recovery";

function batch(overrides: Partial<CanvasCommandBatch> = {}): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "canvas.setTitle", title: "x" }],
    ...overrides
  };
}

/** 建立一份带若干 update 的存储。 */
async function seedWithUpdates(count: number): Promise<InMemoryYjsDocumentRepository> {
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

  for (let index = 1; index <= count; index += 1) {
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commandId: `cmd-${index}`,
        baseRevision: index - 1,
        commands: [{ type: "node.add", node: { id: `n${index}`, type: "image", position: { x: index * 10, y: 0 } } }]
      }),
      now: NOW
    });
    if (!outcome.ok || !outcome.update) throw new Error("seed 命令失败");
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
    if (!result.ok) throw new Error("seed 提交失败");
  }
  return repository;
}

describe("恢复（任务 3.5）", () => {
  it("checkpoint + 多个 updates 按 seq 恢复，revision 与投影一致", async () => {
    const repository = await seedWithUpdates(3);
    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.revision).toBe(3);
    expect(recovered.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("不存在的文档返回 not-found", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const result = await recoverYjsDocument({ repository, canvasId: "missing" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-found");
  });

  it("no-op 命令持久化的 0 字节 update 被跳过（不隔离）", async () => {
    const repository = await seedWithUpdates(1);
    const state = await repository.loadYjsState(CANVAS);
    // 模拟 no-op：追加一条 0 字节 update（room 会对无净变化命令写空 update 行）。
    // projection 用当时的真值（revision 1），与 room 的实际行为一致。
    const commit = await repository.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 1,
      update: new Uint8Array(0),
      revision: 1,
      updatedAt: NOW,
      projection: state!.projection!,
      command: {
        commandId: "cmd-noop",
        payloadHash: "f".repeat(64),
        revision: 1,
        changed: false,
        actorId: "actor",
        createdAt: NOW
      }
    });
    expect(commit.ok).toBe(true);

    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.revision).toBe(1);
    expect(recovered.canvas.document.nodes.map((node) => node.id)).toEqual(["n1"]);
  });

  it("不支持的格式版本被拒绝", async () => {
    const repository = await seedWithUpdates(1);
    // 直接篡改文档格式版本。
    const state = await repository.loadYjsState(CANVAS);
    await repository.deleteYjsDocument(CANVAS);
    await repository.createYjsDocument({
      canvasId: CANVAS,
      formatVersion: "woohaa3-ycanvas-v99",
      roomEpoch: state?.roomEpoch ?? "e",
      checkpoint: state?.checkpoint ?? new Uint8Array(0),
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      revision: 0,
      createdAt: NOW
    });
    const result = await recoverYjsDocument({ repository, canvasId: CANVAS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported-format");
  });

  it("checksum 不一致时隔离（不创建空文档）", async () => {
    // 用一个可控的仓储包装，篡改 checksum 而不改 update 字节。
    const inner = await seedWithUpdates(1);
    const state = await inner.loadYjsState(CANVAS);
    if (!state) throw new Error("应能加载");
    const tampered = new InMemoryYjsDocumentRepository();
    await tampered.createYjsDocument({
      canvasId: CANVAS,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "epoch-1",
      checkpoint: state.checkpoint,
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      revision: 0,
      createdAt: NOW
    });
    await tampered.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 0,
      update: state.updates[0].update,
      revision: 1,
      updatedAt: NOW,
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      command: {
        commandId: "cmd-1",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    // 篡改存储内 checksum（模拟磁盘损坏 / 位翻转）。
    const store = (tampered as unknown as { documents: Map<string, { updates: Array<{ sha256: string }> }> })
      .documents.get(CANVAS);
    if (!store) throw new Error("内部文档缺失");
    store.updates[0].sha256 = "0".repeat(64);

    const result = await recoverYjsDocument({ repository: tampered, canvasId: CANVAS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("checksum-mismatch");
    // 隔离：不得创建空文档替代（存储原样保留）。
    expect((await tampered.loadYjsState(CANVAS))?.updates.length).toBe(1);
  });

  it("update seq 非单调（损坏）被隔离", async () => {
    const inner = await seedWithUpdates(2);
    const state = await inner.loadYjsState(CANVAS);
    if (!state) throw new Error("应能加载");
    const tampered = new InMemoryYjsDocumentRepository();
    // checkpointSeq 设为 2，但只保留 seq=1 的 update → 应用时 1 <= 2 非单调。
    await tampered.createYjsDocument({
      canvasId: CANVAS,
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "epoch-1",
      checkpoint: state.checkpoint,
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      revision: 0,
      createdAt: NOW
    });
    await tampered.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 0,
      update: state.updates[0].update,
      revision: 1,
      updatedAt: NOW,
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      command: {
        commandId: "cmd-seq",
        payloadHash: "a".repeat(64),
        revision: 1,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    // 把 checkpointSeq 人为抬到 5，使 seq=1 的 update 变成「已覆盖」的重复。
    const store = (tampered as unknown as { documents: Map<string, { checkpointSeq: number }> })
      .documents.get(CANVAS);
    if (!store) throw new Error("内部文档缺失");
    store.checkpointSeq = 5;

    const result = await recoverYjsDocument({ repository: tampered, canvasId: CANVAS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("corrupt-document");
  });
});

describe("压缩（任务 3.6）", () => {
  it("压缩后 cutoff 内 update 删除、cutoff 后保留、幂等记录保留", async () => {
    const repository = await seedWithUpdates(4);
    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    const compacted = await compactYjsCheckpoint({
      repository,
      canvasId: CANVAS,
      doc: recovered.doc,
      projection: { ok: true, canvas: recovered.canvas },
      now: NOW
    });
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    expect(compacted.cutoffSeq).toBe(4);

    const state = await repository.loadYjsState(CANVAS);
    expect(state?.updates).toEqual([]);
    expect(state?.checkpointSeq).toBe(4);
    // 幂等记录全部保留。
    for (let index = 1; index <= 4; index += 1) {
      expect(await repository.getCommandRecord(CANVAS, `cmd-${index}`)).not.toBeNull();
    }
  });

  it("压缩前后规范聚合与 revision 等价", async () => {
    const repository = await seedWithUpdates(3);
    const before = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    await compactYjsCheckpoint({
      repository,
      canvasId: CANVAS,
      doc: before.doc,
      projection: { ok: true, canvas: before.canvas },
      now: NOW
    });

    const after = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.revision).toBe(before.revision);
    expect(after.canvas.document.nodes.map((node) => node.id).sort())
      .toEqual(before.canvas.document.nodes.map((node) => node.id).sort());
    expect(after.canvas.title).toBe(before.canvas.title);
  });

  it("cutoff 之后仍需恢复（压缩不丢后续 update）", async () => {
    const repository = await seedWithUpdates(2);
    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    await compactYjsCheckpoint({
      repository,
      canvasId: CANVAS,
      doc: recovered.doc,
      projection: { ok: true, canvas: recovered.canvas },
      now: NOW
    });

    // 压缩后继续提交一个 update。
    const outcome = await applyCommandTransaction({
      doc: recovered.doc,
      batch: batch({
        commandId: "cmd-after",
        baseRevision: 2,
        commands: [{ type: "node.add", node: { id: "n99", type: "text", position: { x: 999, y: 0 } } }]
      }),
      now: NOW
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.update) return;
    await repository.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 2,
      update: outcome.update,
      revision: outcome.revision,
      updatedAt: NOW,
      projection: outcome.canvas,
      command: {
        commandId: "cmd-after",
        payloadHash: "z".repeat(64),
        revision: outcome.revision,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });

    const final = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.canvas.document.nodes.map((node) => node.id)).toContain("n99");
    expect(final.revision).toBe(3);
  });

  it("shouldCompact 按 update 数量或字节阈值判定", () => {
    const state = { updates: [{ seq: 1, update: new Uint8Array(100), sha256: "" }] };
    expect(shouldCompact(state, { maxUpdates: 1, maxBytes: 1_000 })).toBe(true);
    expect(shouldCompact(state, { maxUpdates: 10, maxBytes: 50 })).toBe(true);
    expect(shouldCompact(state, { maxUpdates: 10, maxBytes: 1_000 })).toBe(false);
  });
});
