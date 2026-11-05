/**
 * 在线画布迁移：单连接原子导入存储测试
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.5、4.6、4.9、7.1、7.2）。
 *
 * 覆盖：整画布同事务原子性（失败零残留）、job 幂等 + attempt fencing、重启恢复、
 * 收据权威性（已 ready 不重复导入）、删除 tombstone（DELETED 不自动复活）、
 * 配置换代 supersede、来源换代/损坏不回源覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NODE_GENERATION_HISTORY_VERSION,
  createEmptyWoohaa3ServerCanvas,
  type NodeGenerationHistoryEntry,
  type ServerCanvas
} from "@woohaa3/contracts";
import { SqliteCanvasRepository } from "./index.js";
import { SqliteYjsRepository } from "./yjs.js";
import { SqliteNodeHistoryRepository } from "./node-history.js";
import { CanvasStorageError } from "../core/index.js";
import { SqliteCanvasImportStore } from "./canvas-import.js";
import { SqliteSpatialLeaseStore } from "./spatial-leases.js";
import { loadNodeSqlite } from "./sqlite-loader.js";

const NOW = "2026-10-13T00:00:00.000Z";
const tempDirs: string[] = [];
const open: Array<{ close(): void }> = [];

afterAll(() => {
  for (const resource of open) resource.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function basePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-import-"));
  tempDirs.push(dir);
  return path.join(dir, "canvas.sqlite");
}

/** 建好既有 repository 迁移的三张目标表，再打开导入存储。 */
function openStore(options: { failWrites?: () => boolean; onWritePoint?: (point: string) => void } = {}): { store: SqliteCanvasImportStore; dbPath: string } {
  const dbPath = basePath();
  const canvases = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
  const yjs = new SqliteYjsRepository({ path: dbPath, now: () => NOW });
  const history = new SqliteNodeHistoryRepository({ path: dbPath, now: () => NOW });
  open.push(canvases, yjs, history);
  const store = new SqliteCanvasImportStore({ path: dbPath, now: () => NOW, ...options });
  open.push(store);
  return { store, dbPath };
}

function binding(overrides: Partial<{ sourceVersion: string; configVersion: number; converterVersion: string; sourceId: string }> = {}) {
  return {
    sourceId: overrides.sourceId ?? "legacy-source",
    sourceCanvasId: "legacy-canvas-1",
    cutoverGeneration: "gen-2026-10",
    extensionId: "legacy-import",
    configVersion: overrides.configVersion ?? 1,
    converterVersion: overrides.converterVersion ?? "converter-1",
    sourceVersion: overrides.sourceVersion ?? "watermark-1"
  };
}

function candidateCanvas(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("legacy-canvas-1", NOW);
  canvas.title = "裂隙突围";
  canvas.document.nodes.push({ id: "n1", type: "text", position: { x: 0, y: 0 } });
  canvas.nodeData.n1 = { panelPrompt: "hello", title: "任务" };
  return canvas;
}

function access() {
  return {
    ownerSubject: "creator-1",
    readSubjects: ["creator-1", "collab-1"],
    writeSubjects: ["creator-1"],
    sharingMode: "specified" as const,
    sourceAclVersion: "acl-1"
  };
}

function historyEntries(): NodeGenerationHistoryEntry[] {
  return [
    {
      version: NODE_GENERATION_HISTORY_VERSION,
      entryId: "ngh-abc",
      canvasId: "legacy-canvas-1",
      nodeId: "n1",
      kind: "text",
      createdAt: NOW,
      sourceIdentity: "text:deadbeef",
      currentIdentity: "text:deadbeef",
      recoverable: true,
      previewable: true,
      source: { label: "旧来源" },
      payload: { kind: "text", text: "历史正文" }
    }
  ];
}

function commitInput(store: SqliteCanvasImportStore, jobId: string, overrides: Partial<{ fence: number; now: string }> = {}) {
  return {
    jobId,
    fence: overrides.fence ?? store.getJob(jobId)!.fence,
    candidateCanvas: candidateCanvas(),
    checkpoint: new Uint8Array([1, 2, 3, 4]),
    roomEpoch: "epoch-import-1",
    formatVersion: "woohaa-canvas-yjs-v1",
    access: access(),
    historyJson: JSON.stringify(historyEntries()),
    diagnostics: [{ kind: "note" as const, detail: "ok" }],
    diagSummary: { readyMediaCount: 2, restoredHistoryCount: 1, unrecoveredRecordCount: 0 },
    now: overrides.now ?? NOW
  };
}

describe("导入存储：整画布单连接原子提交（任务 4.5 / 4.9）", () => {
  it("COMMIT 后结构化聚合 / Yjs checkpoint / ACL / 历史 / 收据一次性可见", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 2 });
    store.beginAttempt("j1", "reading");
    const receipt = store.commitImport(commitInput(store, "j1"));

    expect(receipt.targetCanvasId).toBe("legacy-canvas-1");
    expect(receipt.ownerSubject).toBe("creator-1");
    expect(receipt.diagnostics).toEqual({ readyMediaCount: 2, restoredHistoryCount: 1, unrecoveredRecordCount: 0 });

    expect(store.hasCanvas("legacy-canvas-1")).toBe(true);
    expect(store.debugQuery<{ revision: number }>("SELECT revision FROM canvases WHERE id = ?", "legacy-canvas-1")).toEqual([{ revision: 1 }]);
    const yjsRow = store.debugQuery<{ room_epoch: string; snapshot_seq: number }>(
      "SELECT room_epoch, snapshot_seq FROM canvas_yjs_documents WHERE canvas_id = ?",
      "legacy-canvas-1"
    );
    // 新 epoch、storageSeq=0；未复制旧 update/operation。
    expect(yjsRow).toEqual([{ room_epoch: "epoch-import-1", snapshot_seq: 0 }]);
    expect(store.getImportedAccess("legacy-canvas-1")?.access.ownerSubject).toBe("creator-1");
    expect(store.debugQuery<{ c: number }>("SELECT COUNT(*) AS c FROM node_generation_history WHERE canvas_id = ?", "legacy-canvas-1")).toEqual([{ c: 1 }]);
    expect(store.getJob("j1")!.state).toBe("committed");
  });

  it("注入写失败：canvases / Yjs / ACL / 历史 / 收据全部零残留（同一事务回滚）", () => {
    const { store } = openStore({ failWrites: () => true });
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 2 });
    store.beginAttempt("j1", "reading");
    expect(() => store.commitImport(commitInput(store, "j1"))).toThrow();
    expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
    expect(store.debugQuery("SELECT 1 FROM canvas_yjs_documents WHERE canvas_id = ?", "legacy-canvas-1")).toEqual([]);
    expect(store.getImportedAccess("legacy-canvas-1")).toBeNull();
    expect(store.debugQuery("SELECT 1 FROM node_generation_history WHERE canvas_id = ?", "legacy-canvas-1")).toEqual([]);
    expect(store.getReceipt("legacy-canvas-1")).toBeNull();
    expect(store.hasReceiptRow("legacy-canvas-1")).toBe(false);
  });

  it("目标已存在（外来画布）：TARGET_CONFLICT，绝不覆盖", () => {
    const { store, dbPath } = openStore();
    // 先放一个同 id 的既有画布（模拟目标冲突），再用导入作业尝试提交。
    const seeded = new SqliteCanvasRepository({ path: dbPath, now: () => NOW });
    open.push(seeded);
    const seededCanvas = createEmptyWoohaa3ServerCanvas("legacy-canvas-1", NOW);
    seededCanvas.revision = 3;
    // 同步写入：调用 createCanvas（既有 repository API）。
    return seeded.createCanvas(seededCanvas).then(() => {
      store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
      store.beginAttempt("j1", "reading");
      const error = (() => {
        try {
          store.commitImport(commitInput(store, "j1"));
          return null;
        } catch (caught) {
          return caught as CanvasStorageError;
        }
      })();
      expect(error?.code).toBe("TARGET_CONFLICT");
      // 既有目标行仍在（未被导入覆盖），且没有写收据。
      expect(store.debugQuery("SELECT id FROM canvases WHERE id = ?", "legacy-canvas-1")).toHaveLength(1);
      expect(store.hasReceiptRow("legacy-canvas-1")).toBe(false);
    });
  });

  it("ready 收据但目标缺失（目标损坏）：不回源覆盖", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j1", "reading");
    store.commitImport(commitInput(store, "j1"));
    // 只删 canvases 行，保留 ready 收据（模拟目标损坏）。
    store.debugQuery("DELETE FROM canvases WHERE id = ?", "legacy-canvas-1");
    expect(store.getReceipt("legacy-canvas-1")).not.toBeNull();
    expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
    // 再次提交同目标被拒绝（收据行仍在）。
    store.createJob({ jobId: "j2", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j2", "reading");
    expect(() => store.commitImport(commitInput(store, "j2"))).toThrow();
  });
});

describe("导入存储：作业幂等 / fencing / 恢复（任务 4.6）", () => {
  it("createJob 幂等：同 jobId 不重开 attempt", () => {
    const { store } = openStore();
    const first = store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    const second = store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 5 });
    expect(second.attempt).toBe(first.attempt);
    expect(second.totalMedia).toBe(0);
  });

  it("beginAttempt 推进 fence；旧 attempt 的提交被拒绝（SOURCE_CHANGED）", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j1", "reading");
    const staleFence = store.getJob("j1")!.fence;
    store.beginAttempt("j1", "reading"); // 新 attempt 推进 fence，旧 attempt 失效
    const error = (() => {
      try {
        store.commitImport(commitInput(store, "j1", { fence: staleFence }));
        return null;
      } catch (caught) {
        return caught as CanvasStorageError;
      }
    })();
    expect(error?.code).toBe("SOURCE_CHANGED");
    expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
  });

  it("recoverInterruptedJobs：running 降回 pending", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j1", "reading");
    expect(store.getJob("j1")!.state).toBe("running");
    expect(store.recoverInterruptedJobs()).toBe(1);
    expect(store.getJob("j1")!.state).toBe("pending");
    expect(store.getJob("j1")!.fence).toBeGreaterThan(1);
  });

  it("配置换代 supersede：同来源同画布旧活动作业被取代", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j-old", targetCanvasId: "legacy-canvas-1", binding: binding({ configVersion: 1 }), subject: "creator-1", totalMedia: 0 });
    store.createJob({ jobId: "j-new", targetCanvasId: "legacy-canvas-1", binding: binding({ configVersion: 2 }), subject: "creator-1", totalMedia: 0 });
    expect(store.supersedeOtherActiveJobs("legacy-source", "legacy-canvas-1", "j-new")).toBe(1);
    expect(store.getJob("j-old")!.state).toBe("superseded");
    expect(store.getJob("j-new")!.state).toBe("pending");
  });
});

describe("导入存储：删除 tombstone 与反复活（任务 7.1 / 7.2）", () => {
  it("拒绝删除仍有占用的导入画布并保留所有内容", () => {
    const { store, dbPath } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j1", "reading");
    store.commitImport(commitInput(store, "j1"));
    const db = new (loadNodeSqlite().DatabaseSync)(dbPath);
    const leases = new SqliteSpatialLeaseStore(db, { eligible: () => true, stopped: () => true });
    leases.acquire({ requestId: "request", canvasId: "legacy-canvas-1", runId: "run", epoch: 1, executionId: "exec", scope: { scope: { kind: "scene-area", areaId: "area" }, scopeVersion: "v1" }, writable: [{ kind: "instance", instanceId: "model", version: "v1" }], readOnly: [] });
    expect(() => store.deleteImportedCanvas("legacy-canvas-1")).toThrow();
    expect(store.hasCanvas("legacy-canvas-1")).toBe(true);
    expect(store.getReceiptState("legacy-canvas-1")).toBe("ready");
    expect(store.debugQuery("SELECT 1 FROM canvas_yjs_documents WHERE canvas_id = ?", "legacy-canvas-1")).toHaveLength(1);
    db.close();
  });
  it("删除后 receipt 保留 state=deleted，来源绑定不被级联删除", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j1", "reading");
    store.commitImport(commitInput(store, "j1"));

    store.deleteImportedCanvas("legacy-canvas-1");

    expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
    expect(store.getReceipt("legacy-canvas-1")).toBeNull(); // ready 收据不再返回
    expect(store.getReceiptState("legacy-canvas-1")).toBe("deleted");
    // 来源绑定仍保留（不级联删除）。
    const row = store.debugQuery<{ source_id: string; source_canvas_id: string }>(
      "SELECT source_id, source_canvas_id FROM canvas_import_receipts WHERE target_canvas_id = ?",
      "legacy-canvas-1"
    );
    expect(row).toEqual([{ source_id: "legacy-source", source_canvas_id: "legacy-canvas-1" }]);
    // 活动 ACL / 历史 / canonical / Yjs 已清理。
    expect(store.getImportedAccess("legacy-canvas-1")).toBeNull();
    expect(store.debugQuery("SELECT 1 FROM canvas_yjs_documents WHERE canvas_id = ?", "legacy-canvas-1")).toEqual([]);
  });

  it("删除 tombstone 存在时，重新提交被拒绝（不自动复活）", () => {
    const { store } = openStore();
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j1", "reading");
    store.commitImport(commitInput(store, "j1"));
    store.deleteImportedCanvas("legacy-canvas-1");

    store.createJob({ jobId: "j2", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 0 });
    store.beginAttempt("j2", "reading");
    const error = (() => {
      try {
        store.commitImport(commitInput(store, "j2"));
        return null;
      } catch (caught) {
        return caught as CanvasStorageError;
      }
    })();
    expect(error?.code).toBe("TARGET_CONFLICT");
    expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
  });
});

describe("导入存储：每个写入点故障注入全目标回滚（任务 6.3）", () => {
  for (const point of ["canvases", "yjs", "history", "acl", "diagnostics", "receipt"]) {
    it(`在 ${point} 之后失败：canonical/Yjs/历史/ACL/诊断/收据全部零残留，job 未 committed`, () => {
      const { store } = openStore({ onWritePoint: (p) => { if (p === point) throw new Error(`注入失败：${p}`); } });
      store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 2 });
      store.beginAttempt("j1", "reading");
      expect(() => store.commitImport(commitInput(store, "j1"))).toThrow();

      expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
      expect(store.debugQuery("SELECT 1 FROM canvas_yjs_documents WHERE canvas_id = ?", "legacy-canvas-1")).toEqual([]);
      expect(store.debugQuery("SELECT 1 FROM node_generation_history WHERE canvas_id = ?", "legacy-canvas-1")).toEqual([]);
      expect(store.getImportedAccess("legacy-canvas-1")).toBeNull();
      expect(store.getDiagnostics("legacy-canvas-1")).toEqual([]);
      expect(store.hasReceiptRow("legacy-canvas-1")).toBe(false);
      expect(store.getJob("j1")!.state).toBe("running"); // 未被标 committed
      expect(store.hasCanvas("legacy-canvas-1")).toBe(false);
    });
  }

  it("某写入点失败后，同一 attempt 重试可幂等成功提交（fence 未推进）", () => {
    let failAt: string | null = "diagnostics";
    const { store } = openStore({ onWritePoint: (p) => { if (p === failAt) throw new Error("注入失败"); } });
    store.createJob({ jobId: "j1", targetCanvasId: "legacy-canvas-1", binding: binding(), subject: "creator-1", totalMedia: 2 });
    store.beginAttempt("j1", "reading");
    expect(() => store.commitImport(commitInput(store, "j1"))).toThrow();
    failAt = null;
    const receipt = store.commitImport(commitInput(store, "j1"));
    expect(receipt.targetCanvasId).toBe("legacy-canvas-1");
    expect(store.getJob("j1")!.state).toBe("committed");
  });
});
