/**
 * Yjs 归档扩展测试（任务 8.5）。
 *
 * 覆盖：导出 checkpoint/format/roomEpoch/命令记录、篡改被拒、恢复收敛、禁止内容拦截。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { applyCommandTransaction } from "./command-transaction.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { YJS_ARCHIVE_SECTION,
  exportYjsArchive,
  fromBase64,
  restoreYjsArchive,
  toBase64,
  verifyYjsArchive,
  type YjsArchiveSection } from "./archive.js";
import * as Y from "yjs";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-archive";

async function seeded() {
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
  for (let index = 1; index <= 2; index += 1) {
    const outcome = await applyCommandTransaction({
      doc,
      batch: {
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: CANVAS,
        commandId: `cmd-${index}`,
        baseRevision: index - 1,
        actorId: "actor",
        commands: [{ type: "node.add", node: { id: `n${index}`, type: "text", position: { x: 0, y: 0 } } }]
      },
      now: NOW
    });
    if (!outcome.ok || !outcome.update) throw new Error("seed 失败");
    await repository.commitYjsCommand({
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
  }
  return { repository, doc };
}

describe("导出 Yjs 段（任务 8.5）", () => {
  it("包含 checkpoint、format、roomEpoch、updates 与命令记录", async () => {
    const { repository } = await seeded();
    const section = await exportYjsArchive(repository, [CANVAS], {
      now: NOW,
      listCommands: async () => [
        { commandId: "cmd-1", payloadHash: "a".repeat(64), revision: 1, changed: true, actorId: "actor", createdAt: NOW },
        { commandId: "cmd-2", payloadHash: "b".repeat(64), revision: 2, changed: true, actorId: "actor", createdAt: NOW }
      ]
    });
    expect(section.section).toBe(YJS_ARCHIVE_SECTION);
    expect(section.formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
    expect(section.records).toHaveLength(1);
    const record = section.records[0];
    expect(record.roomEpoch).toBe("epoch-1");
    expect(record.updates).toHaveLength(2);
    // 每条 update 携带其来源命令（1:1）。
    expect(record.updates.map((entry) => entry.command?.commandId)).toEqual(["cmd-1", "cmd-2"]);
    expect(record.checkpointSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("base64 往返保真", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("校验 Yjs 段（任务 8.5）", () => {
  it("合法段校验通过", async () => {
    const { repository } = await seeded();
    const section = await exportYjsArchive(repository, [CANVAS], { now: NOW });
    const result = await verifyYjsArchive(section);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recordCount).toBe(1);
    expect(result.updateCount).toBe(2);
  });

  it("篡改 update 导致 checksum-mismatch", async () => {
    const { repository } = await seeded();
    const section = await exportYjsArchive(repository, [CANVAS], { now: NOW });
    const tampered = structuredClone(section) as YjsArchiveSection;
    tampered.records[0].updates[0].updateBase64 = toBase64(new Uint8Array([9, 9, 9]));
    const result = await verifyYjsArchive(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("checksum-mismatch");
  });

  it("篡改 checkpoint 导致 checksum-mismatch", async () => {
    const { repository } = await seeded();
    const section = await exportYjsArchive(repository, [CANVAS], { now: NOW });
    const tampered = structuredClone(section) as YjsArchiveSection;
    tampered.records[0].checkpointBase64 = toBase64(new Uint8Array([1, 1]));
    const result = await verifyYjsArchive(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("checksum-mismatch");
  });

  it("格式版本不匹配被拒绝", async () => {
    const { repository } = await seeded();
    const section = await exportYjsArchive(repository, [CANVAS], { now: NOW });
    const tampered = structuredClone(section) as YjsArchiveSection;
    tampered.formatVersion = "woohaa3-ycanvas-v0";
    const result = await verifyYjsArchive(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported-format");
  });

  it("含签名 URL / blob / data URL 的段被拒绝", async () => {
    const { repository } = await seeded();
    const section = await exportYjsArchive(repository, [CANVAS], { now: NOW });
    for (const needle of ["X-Amz-Signature=abc", "blob:http://x", "data:image/png;base64,AA"]) {
      const tampered = structuredClone(section) as YjsArchiveSection & { extra?: string };
      tampered.extra = needle;
      const result = await verifyYjsArchive(tampered);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("forbidden-content");
    }
  });

  it("非 Yjs 段被拒绝", async () => {
    const result = await verifyYjsArchive({ section: "other", records: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-shape");
  });
});

describe("恢复到空的 Yjs 仓储（任务 8.5）", () => {
  it("恢复后状态与源收敛", async () => {
    const { repository: source } = await seeded();
    const section = await exportYjsArchive(source, [CANVAS], { now: NOW });

    const target = new InMemoryYjsDocumentRepository();
    const restored = await restoreYjsArchive(target, section);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.restored).toEqual([CANVAS]);

    const sourceState = await source.loadYjsState(CANVAS);
    const targetState = await target.loadYjsState(CANVAS);
    expect(targetState?.storageSeq).toBe(sourceState?.storageSeq);
    expect(targetState?.updates.map((entry) => entry.seq)).toEqual(sourceState?.updates.map((entry) => entry.seq));
    expect(targetState?.formatVersion).toBe(YJS_CANVAS_FORMAT_VERSION);
  });

  it("恢复前先校验：损坏段不写目标", async () => {
    const { repository: source } = await seeded();
    const section = await exportYjsArchive(source, [CANVAS], { now: NOW });
    const tampered = structuredClone(section) as YjsArchiveSection;
    tampered.records[0].updates[0].sha256 = "0".repeat(64);

    const target = new InMemoryYjsDocumentRepository();
    const restored = await restoreYjsArchive(target, tampered);
    expect(restored.ok).toBe(false);
    expect(await target.loadYjsState(CANVAS)).toBeNull();
  });

  it("恢复保持命令幂等记录（重试不重复应用）", async () => {
    const { repository: source } = await seeded();
    const section = await exportYjsArchive(source, [CANVAS], {
      now: NOW,
      listCommands: async () => [
        { commandId: "cmd-1", payloadHash: "a".repeat(64), revision: 1, changed: true, actorId: "actor", createdAt: NOW },
        { commandId: "cmd-2", payloadHash: "b".repeat(64), revision: 2, changed: true, actorId: "actor", createdAt: NOW }
      ]
    });
    const target = new InMemoryYjsDocumentRepository();
    await restoreYjsArchive(target, section);
    // 命令记录随 update 一起恢复（1:1 配对），重试不会重复应用。
    expect(await target.getCommandRecord(CANVAS, "cmd-1")).not.toBeNull();
    expect(await target.getCommandRecord(CANVAS, "cmd-2")).not.toBeNull();
  });
});
