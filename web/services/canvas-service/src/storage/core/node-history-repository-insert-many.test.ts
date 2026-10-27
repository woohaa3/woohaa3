/**
 * 节点历史 repository 批量登记契约（change: 2026-10-27-merge-same-type-node-history，任务 3.1）。
 *
 * 覆盖：空列表、重复插入只报告不追加、单事务回滚（不可序列化 payload 使整批失败）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NODE_GENERATION_HISTORY_VERSION,
  nodeHistoryEntryId,
  type NodeGenerationHistoryEntry
} from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "./in-memory-node-history-repository.js";
import { SqliteNodeHistoryRepository } from "../sqlite/node-history.js";
import type { NodeHistoryRepository } from "./node-history-contracts.js";

const NOW = "2026-10-27T00:00:00.000Z";
const CANVAS = "canvas-merge";

function textEntry(runId: string, nodeId = "node-1", text = `text-${runId}`): NodeGenerationHistoryEntry {
  return {
    version: NODE_GENERATION_HISTORY_VERSION,
    entryId: nodeHistoryEntryId({ canvasId: CANVAS, nodeId, identity: { kind: "task-run", runId } }),
    canvasId: CANVAS,
    nodeId,
    kind: "text",
    createdAt: NOW,
    sourceIdentity: `task-run:${runId}`,
    currentIdentity: `text:${text}`,
    recoverable: true,
    previewable: true,
    source: { label: "生成" },
    payload: { kind: "text", text }
  };
}

async function exercise(repository: NodeHistoryRepository): Promise<void> {
  expect(await repository.insertMany([])).toEqual({ insertedIds: [], duplicateIds: [] });

  const first = textEntry("run-1");
  const second = textEntry("run-2");
  const inserted = await repository.insertMany([first, second]);
  expect(inserted.insertedIds).toEqual([first.entryId, second.entryId]);
  expect(inserted.duplicateIds).toEqual([]);
  expect((await repository.listForNode(CANVAS, "node-1")).map((entry) => entry.entryId).sort())
    .toEqual([first.entryId, second.entryId].sort());

  // 重复项只报告，不追加；同批内重复同样识别。
  const again = await repository.insertMany([first, textEntry("run-3"), textEntry("run-3")]);
  expect(again.insertedIds).toEqual([textEntry("run-3").entryId]);
  expect(again.duplicateIds).toEqual([first.entryId, textEntry("run-3").entryId]);
  expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(3);
}

describe("NodeHistoryRepository.insertMany", () => {
  it("内存实现：批量幂等与去重语义", async () => {
    await exercise(new InMemoryNodeHistoryRepository());
  });

  it("内存实现：不可序列化条目使整批不提交", async () => {
    const repository = new InMemoryNodeHistoryRepository();
    const broken = textEntry("run-broken") as NodeGenerationHistoryEntry & { payload: unknown };
    (broken as { payload: unknown }).payload = { kind: "text", text: "x", circular: broken };
    await expect(repository.insertMany([textEntry("run-ok"), broken])).rejects.toThrow();
    expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(0);
  });

  it("SQLite 实现：批量幂等与去重语义", async () => {
    const repository = new SqliteNodeHistoryRepository({
      path: path.join(mkdtempSync(path.join(tmpdir(), "ngh-insert-many-")), "canvas.sqlite")
    });
    try {
      await exercise(repository);
    } finally {
      repository.close();
    }
  });

  it("SQLite 实现：内容身份相同但 entryId 不同的条目都保留", async () => {
    const repository = new SqliteNodeHistoryRepository({
      path: path.join(mkdtempSync(path.join(tmpdir(), "ngh-insert-many-same-content-")), "canvas.sqlite")
    });
    try {
      const first = textEntry("run-same-a", "node-1", "same-content");
      const second = textEntry("run-same-b", "node-1", "same-content");
      const inserted = await repository.insertMany([first, second]);
      expect(inserted.duplicateIds).toEqual([]);
      expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(2);
    } finally {
      repository.close();
    }
  });

  it("SQLite 实现：单事务回滚不留下部分复制", async () => {
    const repository = new SqliteNodeHistoryRepository({
      path: path.join(mkdtempSync(path.join(tmpdir(), "ngh-insert-many-rollback-")), "canvas.sqlite")
    });
    try {
      const broken = textEntry("run-broken") as NodeGenerationHistoryEntry & { payload: unknown };
      (broken as { payload: unknown }).payload = { kind: "text", text: "x", circular: broken };
      await expect(repository.insertMany([textEntry("run-ok"), broken])).rejects.toThrow();
      expect(await repository.listForNode(CANVAS, "node-1")).toHaveLength(0);
      // 事务已释放：后续正常批量仍可写入。
      const retry = await repository.insertMany([textEntry("run-ok")]);
      expect(retry.insertedIds).toHaveLength(1);
    } finally {
      repository.close();
    }
  });
});
