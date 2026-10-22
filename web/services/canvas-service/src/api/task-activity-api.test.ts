/**
 * Canvas task activity API
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 1.4 / 1.5；
 *   change: unify-canvas-session-websocket，任务 3.4：`/changes` 有限增量、
 *   移除 `/events` NDJSON 长连接）。
 *
 * 覆盖：画布 ACL **前置**（未授权不读取任务记录）、跨画布隔离、快照/增量形状、
 * 非法 cursor/limit 夹紧、已移除事件流的稳定 not-found（不泄露任务数量）。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskActivityRequestHandler } from "./task-activity-api.js";
import type { CanvasTaskClient } from "../clients/task-client.js";
import type { CanvasTaskActivity, CanvasTaskActivitySnapshot } from "@woohaa3/contracts";

const CANVAS = "canvas-a";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const active: CanvasTaskActivity = {
  taskKey: "t1",
  runId: "r1",
  nodeId: "n1",
  state: "running",
  modelType: "image",
  modelKey: "litellm:m1",
  progress: 0.5,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  durationMs: 1000
};

const snapshot: CanvasTaskActivitySnapshot = { active: [active], recent: [], cursor: 7 };

type Calls = { activity: string[]; changes: Array<{ canvasId: string; after: number; limit: number | undefined }> };

/** 记录被访问过的 canvasId 与增量参数，用于断言 ACL 前置与参数夹紧。 */
function fakeClient(calls: Calls): CanvasTaskClient {
  return {
    async submit() {
      throw new Error("not used");
    },
    async cancel() {},
    async status() {
      return null;
    },
    async history() {
      return { items: [], cursor: 0 };
    },
    async canvasActivity(canvasId) {
      calls.activity.push(canvasId);
      return snapshot;
    },
    async canvasActivitySince() {
      return { items: [active], cursor: snapshot.cursor };
    },
    async canvasActivityChanges(canvasId, after, limit) {
      calls.changes.push({ canvasId, after, limit });
      return { items: [active], cursor: snapshot.cursor };
    }
  };
}

async function start(options: { accessible?: string[] } = {}) {
  const calls: Calls = { activity: [], changes: [] };
  const accessible = new Set(options.accessible ?? [CANVAS]);
  const handler = createTaskActivityRequestHandler({
    taskClient: fakeClient(calls),
    canvasExists: async (canvasId) => accessible.has(canvasId)
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, calls };
}

describe("画布任务活动 API（任务 1.4 / 3.4）", () => {
  it("已授权画布返回安全快照", async () => {
    const { base, calls } = await start();
    const response = await fetch(`${base}/api/canvas-task-activity/${CANVAS}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CanvasTaskActivitySnapshot;
    expect(body.active[0].taskKey).toBe("t1");
    expect(calls.activity).toEqual([CANVAS]);
  });

  it("有限 /changes 返回持久化增量并夹紧 limit", async () => {
    const { base, calls } = await start();
    const response = await fetch(`${base}/api/canvas-task-activity/${CANVAS}/changes?after=2&limit=9999`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CanvasTaskActivity[]; cursor: number };
    expect(body.items[0].taskKey).toBe("t1");
    expect(calls.changes).toEqual([{ canvasId: CANVAS, after: 2, limit: 200 }]);
  });

  it("非法 after 视为 0，非法 limit 用默认值", async () => {
    const { base, calls } = await start();
    await fetch(`${base}/api/canvas-task-activity/${CANVAS}/changes?after=-5&limit=abc`);
    expect(calls.changes).toEqual([{ canvasId: CANVAS, after: 0, limit: 200 }]);
  });

  it("无权/跨画布在读取任务记录前拒绝，返回稳定 not-found", async () => {
    const { base, calls } = await start({ accessible: [CANVAS] });
    const response = await fetch(`${base}/api/canvas-task-activity/canvas-secret`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("TASK_ACTIVITY_NOT_FOUND");
    // 未读取任何任务记录。
    expect(calls.activity).toEqual([]);
    expect(calls.changes).toEqual([]);
  });

  it("旧 /events 长连接返回稳定 not-found 且不读取任务记录", async () => {
    const { base, calls } = await start();
    const response = await fetch(`${base}/api/canvas-task-activity/${CANVAS}/events?after=0`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("TASK_ACTIVITY_NOT_FOUND");
    expect(calls.activity).toEqual([]);
    expect(calls.changes).toEqual([]);
  });

  it("增量读取失败时返回 502，而不是让 handler 抛出", async () => {
    const handler = createTaskActivityRequestHandler({
      taskClient: {
        ...fakeClient({ activity: [], changes: [] }),
        async canvasActivityChanges() {
          throw new Error("未知的内部任务路由");
        }
      }
    });
    const server = createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/canvas-task-activity/${CANVAS}/changes?after=0`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("TASK_ACTIVITY_UNAVAILABLE");
    expect(body.message).toBe("未知的内部任务路由");
  });

  it("画布不存在时返回 404 且不调用 Task client", async () => {
    const { base, calls } = await start({ accessible: [] });
    const response = await fetch(`${base}/api/canvas-task-activity/${CANVAS}`);
    expect(response.status).toBe(404);
    expect(calls.activity).toEqual([]);
  });
});
