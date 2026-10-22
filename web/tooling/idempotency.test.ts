/**
 * 三层幂等与恢复（change: split-web-runtime-services，任务 7.2）。
 *
 * 验证三种稳定幂等键在重复/超时/响应丢失下都不会导致：
 * - provider 重复执行；
 * - Canvas revision 重复推进。
 *
 * 三层：
 *   Media object:      storageKey = content hash（同内容同键）
 *   Task execution:    workerTaskKey（同 key+payload 复用、不同 payload 拒绝）
 *   Canvas projection: commandId = workerTaskKey + terminal identity（同终态只投影一次）
 */
import { YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom, CanvasTaskProjector, InMemoryProjectionReceiptStore, InMemoryYjsDocumentRepository, projectionCommandId } from "@woohaa3/canvas-service";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { computeStorageKey } from "@woohaa3/contracts";
import { createSqliteTaskStore } from "@woohaa3/task-service";
import { createSqliteSubmitKeyRepository, computeSubmitPayloadHash } from "@woohaa3/task-service";
import { createSqliteTaskHistoryRepository } from "@woohaa3/task-service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-idem-"));
  dirs.push(dir);
  return path.join(dir, name);
}

describe("三层幂等（任务 7.2）", () => {
  it("Media：相同内容解析到相同 storageKey（重复写入幂等）", () => {
    const checksum = "b".repeat(64);
    expect(computeStorageKey(checksum)).toBe(`sha256-${checksum}`);
    expect(computeStorageKey(checksum)).toBe(computeStorageKey(checksum));
  });

  it("Task：同 key + 同 payload 复用；不同 payload 拒绝；不重复创建", async () => {
    const store = createSqliteTaskStore({ path: tempDb("task.sqlite") });
    const keys = createSqliteSubmitKeyRepository({ path: tempDb("keys.sqlite") });
    const request = {
      canvasId: "c", nodeId: "n", runId: "r", jobId: "j",
      nodeType: "text" as const, modelType: "language" as const, modelKey: "p:m",
      prompt: "p", parameters: {}, inputs: []
    };
    const hash = computeSubmitPayloadHash(request);

    // 首次 submit：created。
    const first = await store.submit({ key: "worker-1", providerId: "p", now: new Date(1000) });
    expect(first.created).toBe(true);
    expect(keys.claim("worker-1", hash, "2026-01-01T00:00:00Z")).toEqual({ created: true, reused: false, conflict: false });

    // 响应丢失后重试：同 key 不重复创建、同 payload 复用。
    const retry = await store.submit({ key: "worker-1", providerId: "p", now: new Date(2000) });
    expect(retry.created).toBe(false);
    expect(keys.claim("worker-1", hash, "2026-01-01T00:00:01Z")).toEqual({ created: false, reused: true, conflict: false });

    // 不同 payload：稳定拒绝，且不再创建第二个任务记录。
    const other = computeSubmitPayloadHash({ ...request, prompt: "changed" });
    expect(keys.claim("worker-1", other, "2026-01-01T00:00:02Z")).toEqual({ created: false, reused: false, conflict: true });

    store.close();
    keys.close();
  });

  it("Canvas：相同终态产生相同 commandId，重复投影不推进 revision", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const canvas = createEmptyWoohaa3ServerCanvas("canvas-a");
    canvas.document.nodes.push({ id: "text-1", type: "text", position: { x: 0, y: 0 } });
    await repository.createYjsDocument({
      canvasId: "canvas-a",
      formatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: "e",
      checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(canvas)),
      projection: canvas,
      revision: canvas.revision,
      createdAt: "2026-01-01T00:00:00Z"
    });
    const room = new CanvasRoom({ canvasId: "canvas-a", repository, now: () => "2026-01-01T00:00:00Z" });
    await room.load();
    await room.submit({
      protocolVersion: 1, canvasId: "canvas-a", commandId: "begin",
      baseRevision: 0, actorId: "t",
      commands: [{ type: "nodeData.patch", nodeId: "text-1", value: { activeRunId: "run-1" } }]
    });

    const projector = new CanvasTaskProjector({
      resolveRoom: async () => room,
      receipts: new InMemoryProjectionReceiptStore(),
      now: () => "2026-01-01T00:00:00Z"
    });
    const record = {
      taskKey: "run-1",
      status: "succeeded" as const,
      canvasId: "canvas-a",
      nodeId: "text-1",
      runId: "run-1",
      jobId: "job-1",
      terminalAt: "2026-01-01T00:00:02Z",
      output: { mediaKind: "text" as const, text: "ok" }
    };
    // 同一个终态标识重复投影（模拟实时通知 + 补偿扫描 + 响应丢失后重试）。
    const first = await projector.project(record);
    expect(first.status).toBe("projected");
    const revisionAfterFirst = room.exportCanvas().ok ? (room.exportCanvas() as { canvas: { revision: number } }).canvas.revision : -1;
    const second = await projector.project(record);
    expect(second.status).toBe("duplicate");
    const third = await projector.project(record);
    expect(third.status).toBe("duplicate");
    const revisionAfter = room.exportCanvas().ok ? (room.exportCanvas() as { canvas: { revision: number } }).canvas.revision : -1;
    expect(revisionAfter).toBe(revisionAfterFirst);

    // commandId 是确定性的（同 key + 同终态标识）。
    expect(projectionCommandId(record)).toBe(projectionCommandId(record));
  });

  it("history cursor 可重复读取同一区间（恢复幂等）", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb("history.sqlite") });
    history.upsertRecord({ taskKey: "t1", state: "succeeded", providerId: "p", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });
    const cursor = history.currentCursor();
    history.upsertRecord({ taskKey: "t2", state: "failed", providerId: "p", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
    const first = history.listSince(cursor);
    const second = history.listSince(cursor);
    expect(first.messages.map(({ record }) => record.taskKey)).toEqual(["t2"]);
    expect(second.messages.map(({ record }) => record.taskKey)).toEqual(["t2"]);
    history.close();
  });

  it("进程重启后同 key 不重复执行：durable store 恢复幂等键", async () => {
    const file = tempDb("restart.sqlite");
    const first = createSqliteTaskStore({ path: file });
    await first.submit({ key: "worker-restart", providerId: "p", params: { modelKey: "p:m" }, now: new Date(1000) });
    first.close();

    // 模拟重启：重新打开同一 durable store。
    const reopened = createSqliteTaskStore({ path: file });
    const duplicate = await reopened.submit({ key: "worker-restart", providerId: "p", now: new Date(5000) });
    // created=false 表示不会再次执行 provider。
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.key).toBe("worker-restart");
    reopened.close();
  });

  it("Task client 对 5xx / 网络错误做有限重试，对 4xx 不重试", async () => {
    const { shouldRetryTransport } = await import("@woohaa3/contracts");
    // 网络异常（无 status）：重试。
    expect(shouldRetryTransport({ attempt: 0 })).toBe(true);
    // 5xx：重试。
    expect(shouldRetryTransport({ attempt: 0, status: 503 })).toBe(true);
    // 4xx：不重试。
    expect(shouldRetryTransport({ attempt: 0, status: 400, code: "malformed-request" })).toBe(false);
    // 可重试协议错误：重试。
    expect(shouldRetryTransport({ attempt: 0, status: 503, code: "unavailable" })).toBe(true);
    // 超过上限：不再重试。
    expect(shouldRetryTransport({ attempt: 5, status: 503, maxRetries: 2 })).toBe(false);
  });
});
