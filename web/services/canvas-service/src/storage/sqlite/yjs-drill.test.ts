/**
 * Yjs 备份/恢复演练（任务 8.7 / 8.5）。
 *
 * 在**真实 SQLite** 上执行「导出 → 校验 → 恢复到隔离环境 → 收敛比对」，
 * 覆盖 runbook §5 的恢复演练要求。
 *
 * Mongo 演练需要真实 replica set（本环境无 mongod），由 `MONGO_TEST_URI` 启用的
 * 集成测试覆盖同一 contract；本文件只跑 SQLite。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { SqliteYjsRepository } from "./index.js";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SYNC_PROTOCOL_VERSION, createInitialYDoc, encodeInitialCheckpoint } from "@woohaa3/contracts/canvas-yjs";
import { exportYjsArchive, restoreYjsArchive, verifyYjsArchive, applyCommandTransaction } from "../../sync/index.js";
import { type YjsArchiveSection } from "../../sync/index.js";


const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-drill";
const tempDirs: string[] = [];
const open: SqliteYjsRepository[] = [];

afterAll(() => {
  for (const repository of open) repository.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sqliteRepository(): SqliteYjsRepository {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-drill-"));
  tempDirs.push(dir);
  const repository = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite"), now: () => NOW });
  open.push(repository);
  return repository;
}

/** 在 SQLite 上建一个带若干 update 的文档。 */
async function seed(repository: SqliteYjsRepository): Promise<void> {
  const doc = createInitialYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
  await repository.createYjsDocument({
    canvasId: CANVAS,
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "epoch-drill",
    checkpoint: encodeInitialCheckpoint(createEmptyWoohaa3ServerCanvas(CANVAS, NOW)),
    projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
    revision: 0,
    createdAt: NOW
  });
  for (let index = 1; index <= 3; index += 1) {
    const outcome = await applyCommandTransaction({
      doc,
      batch: {
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: CANVAS,
        commandId: `cmd-${index}`,
        baseRevision: index - 1,
        actorId: "actor",
        commands: [{ type: "node.add", node: { id: `n${index}`, type: "text", position: { x: index * 10, y: 0 } } }]
      },
      now: NOW
    });
    if (!outcome.ok || !outcome.update) throw new Error("seed 失败");
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
}

describe("SQLite 恢复演练（任务 8.7）", () => {
  it("导出 → 校验 → 恢复到隔离环境 → storageSeq/updates/命令记录一致", async () => {
    const source = sqliteRepository();
    await seed(source);

    const section = await exportYjsArchive(source, [CANVAS], {
      now: NOW,
      listCommands: async () => [
        { commandId: "cmd-1", payloadHash: "a".repeat(64), revision: 1, changed: true, actorId: "actor", createdAt: NOW },
        { commandId: "cmd-2", payloadHash: "b".repeat(64), revision: 2, changed: true, actorId: "actor", createdAt: NOW }
      ]
    });
    // 归档本身合法且不含禁止内容。
    const verified = await verifyYjsArchive(section);
    expect(verified.ok).toBe(true);

    // 恢复到**隔离** SQLite 环境。
    const target = sqliteRepository();
    const restored = await restoreYjsArchive(target, section);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.restored).toEqual([CANVAS]);

    const sourceState = await source.loadYjsState(CANVAS);
    const targetState = await target.loadYjsState(CANVAS);
    expect(targetState?.storageSeq).toBe(sourceState?.storageSeq);
    expect(targetState?.checkpointSeq).toBe(sourceState?.checkpointSeq);
    expect(targetState?.updates.map((entry) => entry.seq)).toEqual(sourceState?.updates.map((entry) => entry.seq));
    expect(targetState?.formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
    expect(targetState?.roomEpoch).toBe("epoch-drill");
    // 命令幂等记录恢复。
    expect(await target.getCommandRecord(CANVAS, "cmd-1")).not.toBeNull();
    expect(await target.getCommandRecord(CANVAS, "cmd-2")).not.toBeNull();
  });

  it("恢复的仓储通过 Yjs contract 的 CAS 与幂等语义", async () => {
    const source = sqliteRepository();
    await seed(source);
    const section = await exportYjsArchive(source, [CANVAS], { now: NOW });

    const target = sqliteRepository();
    await restoreYjsArchive(target, section);

    // 在恢复后的仓储上继续提交：CAS 生效。
    const state = await target.loadYjsState(CANVAS);
    const stale = await target.commitYjsCommand({
      canvasId: CANVAS,
      expectedStorageSeq: 0,
      update: new Uint8Array([1]),
      revision: 99,
      updatedAt: NOW,
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      command: {
        commandId: "cmd-new",
        payloadHash: "c".repeat(64),
        revision: 99,
        changed: true,
        actorId: "actor",
        createdAt: NOW
      }
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("storage-seq-conflict");
    expect((await target.loadYjsState(CANVAS))?.storageSeq).toBe(state?.storageSeq);
  });

  it("损坏归档在恢复前被拒绝，目标不写入", async () => {
    const source = sqliteRepository();
    await seed(source);
    const section = await exportYjsArchive(source, [CANVAS], { now: NOW });
    const tampered: YjsArchiveSection = structuredClone(section);
    tampered.records[0].checkpointSha256 = "0".repeat(64);

    const target = sqliteRepository();
    const restored = await restoreYjsArchive(target, tampered);
    expect(restored.ok).toBe(false);
    expect(await target.loadYjsState(CANVAS)).toBeNull();
  });
});
