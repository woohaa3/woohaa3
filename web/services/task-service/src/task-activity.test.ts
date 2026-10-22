/**
 * Canvas-scoped task activity（change: 2026-09-29-add-canvas-task-activity-feed，任务 1.2–1.5）。
 *
 * 覆盖：画布严格过滤、active 不受分页/保留期影响、终态 keyset 分页、可恢复事件流幂等
 * 回补、跨画布隔离、字段脱敏，以及内部 activity 路由的受信任身份边界。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSqliteTaskHistoryRepository,
  type HistoryRecordInput
} from "./repository/history-repository.js";
import { createTaskApiHandler } from "./api/internal-api.js";
import {
  decodeCanvasActivityCursor,
  WOOHAA3_PROTOCOL_VERSION,
  type CanvasTaskCatalog
} from "@woohaa3/contracts";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-activity-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function record(patch: Partial<HistoryRecordInput> & { taskKey: string }): HistoryRecordInput {
  return {
    state: "running",
    providerId: "litellm",
    canvasId: "canvas-a",
    nodeId: "node-1",
    runId: `run-${patch.taskKey}`,
    createdAt: `2026-01-01T00:00:0${patch.taskKey.length % 10}Z`,
    updatedAt: "2026-01-01T00:00:05Z",
    durationMs: 0,
    ...patch
  };
}

describe("画布活动投影（任务 1.2 / 1.5）", () => {
  it("active 覆盖全部进行中项、终态走 keyset 分页，且严格按 canvasId 过滤", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord(record({ taskKey: "a1", state: "queued" }));
    repo.upsertRecord(record({ taskKey: "a2", state: "pending" }));
    repo.upsertRecord(record({ taskKey: "a3", state: "running" }));
    repo.upsertRecord(record({ taskKey: "a4", state: "succeeded", createdAt: "2026-01-02T00:00:00Z" }));
    repo.upsertRecord(record({ taskKey: "a5", state: "failed", createdAt: "2026-01-03T00:00:00Z" }));
    repo.upsertRecord(record({ taskKey: "b1", state: "running", canvasId: "canvas-b" }));

    const snapshot = repo.listCanvasActivity("canvas-a", { limit: 1 });
    expect(snapshot.active.map((item) => item.taskKey).sort()).toEqual(["a1", "a2", "a3"]);
    expect(snapshot.recent.map((item) => item.taskKey)).toEqual(["a5"]);
    expect(snapshot.nextCursor).toBeDefined();
    expect(decodeCanvasActivityCursor(snapshot.nextCursor)?.taskKey).toBe("a5");

    const next = repo.listCanvasActivity("canvas-a", { limit: 1, cursor: snapshot.nextCursor });
    expect(next.recent.map((item) => item.taskKey)).toEqual(["a4"]);

    // 另一画布完全隔离。
    const other = repo.listCanvasActivity("canvas-b", {});
    expect(other.active.map((item) => item.taskKey)).toEqual(["b1"]);
    expect(other.recent).toEqual([]);
    repo.close();
  });

  it("缺 runId/nodeId 的记录不进入画布活动面", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord(record({ taskKey: "ok", state: "running" }));
    repo.upsertRecord(record({ taskKey: "no-run", state: "running", runId: undefined }));
    repo.upsertRecord(record({ taskKey: "no-node", state: "running", nodeId: undefined }));
    const snapshot = repo.listCanvasActivity("canvas-a", {});
    expect(snapshot.active.map((item) => item.taskKey)).toEqual(["ok"]);
    repo.close();
  });

  it("活动项只含安全卡片字段，序列化不含 prompt/provider/URL/stack", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord(record({
      taskKey: "t",
      state: "failed",
      error: { name: "ProviderError", message: "boom" },
      request: { prompt: "秘密", parameters: { signedUrl: "https://x" } }
    }));
    const snapshot = repo.listCanvasActivity("canvas-a", {});
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("秘密");
    expect(serialized).not.toContain("signedUrl");
    expect(serialized).not.toContain("providerId");
    expect(snapshot.recent[0].error).toEqual({ name: "ProviderError", message: "boom" });
    repo.close();
  });

  it("事件流自 cursor 起有界返回且重复回补幂等", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord(record({ taskKey: "t1", state: "queued" }));
    const afterFirst = repo.currentCursor();
    repo.upsertRecord(record({ taskKey: "t1", state: "running" }));
    repo.upsertRecord(record({ taskKey: "other", state: "running", canvasId: "canvas-b" }));

    const batch = repo.listCanvasActivitySince("canvas-a", afterFirst);
    expect(batch.items.map((item) => item.state)).toEqual(["running"]);
    expect(batch.cursor).toBeGreaterThan(afterFirst);

    // 同一 cursor 重复回补结果一致（可恢复、不重复展示）。
    const replay = repo.listCanvasActivitySince("canvas-a", afterFirst);
    expect(replay.items).toEqual(batch.items);
    // 已推进的 cursor 无新增。
    expect(repo.listCanvasActivitySince("canvas-a", batch.cursor).items).toEqual([]);
    repo.close();
  });
});

// ---------------------------------------------------------------------------
// 内部 activity 路由（ACL 由 Canvas 前置；这里校验受信任身份与画布过滤）
// ---------------------------------------------------------------------------

function makeRequest(options: {
  method: string;
  url: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const socket = new Socket();
  if (options.remoteAddress) {
    Object.defineProperty(socket, "remoteAddress", { value: options.remoteAddress, configurable: true });
  }
  const req = new IncomingMessage(socket);
  req.method = options.method;
  req.url = options.url;
  for (const [key, value] of Object.entries(options.headers ?? {})) req.headers[key] = value;
  return req;
}

function mockResponse(req: IncomingMessage): { res: ServerResponse; written: string[] } {
  const written: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = (() => res) as typeof res.setHeader;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") written.push(chunk);
    return res;
  }) as typeof res.end;
  return { res, written };
}

const CATALOG: CanvasTaskCatalog = { available: true, models: [], defaultModels: {} };

function activityHandler(repo: ReturnType<typeof createSqliteTaskHistoryRepository>, serviceToken = "svc-token") {
  return createTaskApiHandler({
    resolveCatalog: async () => CATALOG,
    history: repo,
    submit: async () => ({ reused: false, state: "queued" }),
    cancel: async () => null,
    status: async () => undefined,
    listHistory: () => ({ items: [], cursor: 0 }),
    listCanvasActivity: (canvasId, query) => repo.listCanvasActivity(canvasId, query),
    listCanvasActivitySince: (canvasId, after, limit) => repo.listCanvasActivitySince(canvasId, after, limit),
    serviceToken
  });
}

describe("内部 activity 路由（任务 1.4）", () => {
  it("缺少服务令牌时拒绝且不读取 repository", async () => {
    let queried = false;
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    const original = repo.listCanvasActivity.bind(repo);
    repo.listCanvasActivity = ((...args: Parameters<typeof original>) => {
      queried = true;
      return original(...args);
    }) as typeof repo.listCanvasActivity;

    const handler = createTaskApiHandler({
      resolveCatalog: async () => CATALOG,
      history: repo,
      submit: async () => ({ reused: false, state: "queued" }),
      cancel: async () => null,
      status: async () => undefined,
      listHistory: () => ({ items: [], cursor: 0 }),
      listCanvasActivity: (canvasId, query) => repo.listCanvasActivity(canvasId, query),
      listCanvasActivitySince: (canvasId, after, limit) => repo.listCanvasActivitySince(canvasId, after, limit),
      serviceToken: "svc-token"
    });

    const req = makeRequest({
      method: "GET",
      url: "/internal/v1/canvases/canvas-a/task-activity",
      headers: { "x-woohaa3-protocol-version": String(WOOHAA3_PROTOCOL_VERSION) }
    });
    const { res } = mockResponse(req);
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(queried).toBe(false);
    repo.close();
  });

  it("持令牌时返回该画布快照，事件流子路径可用", async () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempDb() });
    repo.upsertRecord(record({ taskKey: "a1", state: "running" }));
    repo.upsertRecord(record({ taskKey: "b1", state: "running", canvasId: "canvas-b" }));
    const handler = activityHandler(repo);

    const req = makeRequest({
      method: "GET",
      url: "/internal/v1/canvases/canvas-a/task-activity",
      headers: {
        "x-woohaa3-protocol-version": String(WOOHAA3_PROTOCOL_VERSION),
        "x-woohaa3-service-token": "svc-token"
      }
    });
    const { res, written } = mockResponse(req);
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(written.join(""));
    expect(body.active.map((item: { taskKey: string }) => item.taskKey)).toEqual(["a1"]);

    const eventsReq = makeRequest({
      method: "GET",
      url: "/internal/v1/canvases/canvas-a/task-activity/events?after=0",
      headers: {
        "x-woohaa3-protocol-version": String(WOOHAA3_PROTOCOL_VERSION),
        "x-woohaa3-service-token": "svc-token"
      }
    });
    const eventsRes = mockResponse(eventsReq);
    await handler(eventsReq, eventsRes.res);
    expect(eventsRes.res.statusCode).toBe(200);
    const eventsBody = JSON.parse(eventsRes.written.join(""));
    expect(eventsBody.items).toHaveLength(1);
    expect(eventsBody.items[0].taskKey).toBe("a1");

    // 有限 `/changes` 与 `/events` 同形状（change: unify-canvas-session-websocket）。
    const changesReq = makeRequest({
      method: "GET",
      url: "/internal/v1/canvases/canvas-a/task-activity/changes?after=0",
      headers: {
        "x-woohaa3-protocol-version": String(WOOHAA3_PROTOCOL_VERSION),
        "x-woohaa3-service-token": "svc-token"
      }
    });
    const changesRes = mockResponse(changesReq);
    await handler(changesReq, changesRes.res);
    expect(changesRes.res.statusCode).toBe(200);
    const changesBody = JSON.parse(changesRes.written.join(""));
    expect(changesBody.items).toHaveLength(1);
    repo.close();
  });
});
