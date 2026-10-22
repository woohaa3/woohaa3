import { randomBytes } from "node:crypto";
/**
 * Canvas API 在线迁移访问门测试
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.9、5.3）。
 *
 * 覆盖：未准备返回 PREPARATION_REQUIRED（不进入 CanvasRoom）；删除 tombstone 返回 410 DELETED；
 * ready 时 DELETE 走导入 tombstone（不直接删 canonical）；none 时沿用既有路径。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { createCanvasRequestHandler } from "./canvas-api.js";
import type { CanvasApplicationService } from "../storage/core/index.js";
import type { CanvasImportGuard } from "./canvas-api/types.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterAll(() => { for (const server of servers) server.close(); });

function guard(overrides: Partial<CanvasImportGuard> = {}): CanvasImportGuard {
  return {
    state: () => ({ kind: "none" }),
    deleteImported: async () => undefined,
    subject: async () => "creator-1",
    authorize: () => null,
    ...overrides
  };
}

function serviceStub(): CanvasApplicationService {
  return {
    getCanvas: async (canvasId: string) => ({ id: canvasId, revision: 1, title: "t", document: { schemaVersion: "x", nodes: [], edges: [], updatedAt: "x" }, nodeData: {}, assets: [], jobs: [], updatedAt: "x" }),
    deleteCanvas: async () => undefined
  } as unknown as CanvasApplicationService;
}

async function withServer(
  run: (base: string) => Promise<void>,
  options: { importGuard?: CanvasImportGuard; deleted?: string[] } = {}
): Promise<void> {
  const deleted = options.deleted ?? [];
  const handler = createCanvasRequestHandler({
    service: serviceStub(),
    ...(options.importGuard ? { importGuard: options.importGuard } : {}),
    logger: () => undefined
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    await run(base);
  } finally {
    void deleted;
  }
}

describe("Canvas API：在线迁移访问门（任务 5.3）", () => {
  it("preparing：GET 返回 409 PREPARATION_REQUIRED（不越过 CanvasRoom）", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/canvases/legacy-1`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "PREPARATION_REQUIRED" });
    }, { importGuard: guard({ state: () => ({ kind: "preparing", jobId: "job-1" }) }) });
  });

  it("deleted tombstone：GET 返回 410 DELETED，不自动复活", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/canvases/legacy-1`);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "DELETED" });
    }, { importGuard: guard({ state: () => ({ kind: "deleted" }) }) });
  });

  it("ready：DELETE 走导入 tombstone（调用 deleteImported，返回 204），不直接删 canonical", async () => {
    let deletedId: string | null = null;
    let canonicalDeleted = false;
    const stub = serviceStub();
    const originalDelete = stub.deleteCanvas.bind(stub);
    stub.deleteCanvas = async (...args: Parameters<typeof originalDelete>) => { canonicalDeleted = true; return originalDelete(...args); };

    const handler = createCanvasRequestHandler({
      service: stub,
      importGuard: guard({
        state: () => ({ kind: "ready" }),
        deleteImported: async (canvasId) => { deletedId = canvasId; }
      }),
      logger: () => undefined
    });
    const server = createServer((req, res) => { void handler(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const response = await fetch(`${base}/api/canvases/legacy-1?expectedRevision=1`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(deletedId).toBe("legacy-1");
    expect(canonicalDeleted).toBe(false);
  });

  it("none：GET 沿用既有 canonical 路径", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/canvases/native-1`);
      expect(response.status).toBe(200);
      expect((await response.json() as { canvas: { id: string } }).canvas.id).toBe("native-1");
    }, { importGuard: guard() });
  });
});

describe("Canvas API：导入画布 ACL 优先判定（任务 4.8）", () => {
  it("导入画布无主体（未认证）：GET fail-closed，不返回 canonical", async () => {
    let canonicalRead = false;
    const stub = serviceStub();
    const originalGet = stub.getCanvas.bind(stub);
    stub.getCanvas = async (...args: Parameters<typeof originalGet>) => { canonicalRead = true; return originalGet(...args); };
    const handler = createCanvasRequestHandler({
      service: stub,
      importGuard: guard({
        state: () => ({ kind: "ready" }),
        subject: async () => null,
        // 导入画布：authorize 返回布尔（非 null）→ 无主体即拒绝。
        authorize: ({ subject }) => subject === "creator-1"
      }),
      logger: () => undefined
    });
    const server = createServer((req, res) => { void handler(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    // 无认证头 → subject=null → 导入画布拒绝。
    const denied = await fetch(`${base}/api/canvases/legacy-1`);
    expect(denied.status).toBe(403);
    expect(canonicalRead).toBe(false);
  });

  it("导入画布有主体但无权：GET 403（不泄漏存在性），写路由同样拒绝", async () => {
    const stub = serviceStub();
    let canonicalRead = false;
    let canonicalDelete = false;
    stub.getCanvas = async () => { canonicalRead = true; throw new Error("should not read"); };
    stub.deleteCanvas = async () => { canonicalDelete = true; };
    const handler = createCanvasRequestHandler({
      service: stub,
      importGuard: guard({
        state: () => ({ kind: "ready" }),
        subject: async () => "outsider",
        authorize: ({ subject, permission }) => subject === "creator-1" && permission === "read" ? true : false
      }),
      logger: () => undefined
    });
    const server = createServer((req, res) => { void handler(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const get = await fetch(`${base}/api/canvases/legacy-1`);
    expect(get.status).toBe(403);
    expect(canonicalRead).toBe(false);
    const del = await fetch(`${base}/api/canvases/legacy-1?expectedRevision=1`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(canonicalDelete).toBe(false);
  });

  it("导入画布有权限者可读：GET 200；列表过滤掉不可读者", async () => {
    const stub = serviceStub();
    stub.getCanvas = async (canvasId: string) => ({ id: canvasId, revision: 1, title: "t", document: { schemaVersion: "x", nodes: [], edges: [], updatedAt: "x" }, nodeData: {}, assets: [], jobs: [], updatedAt: "x" }) as never;
    stub.listCanvases = async () => ({
      items: [
        { id: "legacy-1", title: "L", revision: 1, updatedAt: "t", createdAt: "t", nodeCount: 0, assetCount: 0 },
        { id: "legacy-2", title: "L2", revision: 1, updatedAt: "t", createdAt: "t", nodeCount: 0, assetCount: 0 },
        { id: "native-1", title: "N", revision: 1, updatedAt: "t", createdAt: "t", nodeCount: 0, assetCount: 0 }
      ],
      total: 3,
      offset: 0,
      limit: 20
    }) as never;
    const handler = createCanvasRequestHandler({
      service: stub,
      importGuard: guard({
        subject: async () => "creator-1",
        // legacy-1 可读；legacy-2 不可读；native-1 非导入（null）→ 保留。
        authorize: ({ canvasId }) => canvasId === "legacy-1" ? true : canvasId === "legacy-2" ? false : null
      }),
      logger: () => undefined
    });
    const server = createServer((req, res) => { void handler(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const get = await fetch(`${base}/api/canvases/legacy-1`);
    expect(get.status).toBe(200);
    const list = await fetch(`${base}/api/canvases`);
    const page = await list.json() as { items: Array<{ id: string }> };
    expect(page.items.map((entry) => entry.id)).toEqual(["legacy-1", "native-1"]);
  });
});

describe("Canvas Sync WS：在线迁移准入（任务 5.3）", () => {
  it("preparing / deleted 在建立 WS 前被拒绝，不触发 room resolve", async () => {
    const { createSyncUpgradeHandler } = await import("../sync/upgrade.js");
    const { InMemoryYjsDocumentRepository } = await import("../sync/index.js");
    const resolved: string[] = [];
    const yjs = new InMemoryYjsDocumentRepository();
    const sync = createSyncUpgradeHandler({
      repository: {
        loadYjsState: async (canvasId) => { resolved.push(canvasId); return yjs.loadYjsState(canvasId); },
        commitYjsCommand: async (commit) => yjs.commitYjsCommand(commit),
        getCommandRecord: async (canvasId, commandId) => yjs.getCommandRecord(canvasId, commandId),
        replaceCheckpoint: async (input) => yjs.replaceCheckpoint(input),
        createYjsDocument: async (input) => yjs.createYjsDocument(input),
        deleteYjsDocument: async (canvasId) => yjs.deleteYjsDocument(canvasId),
        health: async () => yjs.health()
      },
      admit: (canvasId) => canvasId === "preparing-1"
        ? { ok: false, status: 409, code: "PREPARATION_REQUIRED", message: "准备中" }
        : canvasId === "deleted-1"
          ? { ok: false, status: 410, code: "DELETED", message: "已删除" }
          : { ok: true }
    });

    const server = createServer();
    const statuses: number[] = [];
    server.on("upgrade", (req, socket, head) => {
      if (sync.matches(req.url)) {
        if (!sync.handle(req, socket, head)) { /* 未接管 */ }
      }
    });
    // 用 http request 触发 upgrade 并捕获拒绝状态码。
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const { request } = await import("node:http");
    const attempt = (canvasId: string): Promise<number> => new Promise((resolve) => {
      const req = request({
        host: "127.0.0.1", port, path: `/api/canvases/${canvasId}/sync?sessionProtocolVersion=2`,
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" }
      });
      req.on("upgrade", () => resolve(101));
      req.on("response", (res) => { resolve(res.statusCode ?? 0); res.resume(); });
      req.on("error", () => resolve(0));
      req.end();
    });
    statuses.push(await attempt("preparing-1"));
    statuses.push(await attempt("deleted-1"));
    expect(statuses).toEqual([409, 410]);
    expect(resolved).toEqual([]);
    await sync.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
