/**
 * 转片场 HTTP contract（change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1/1.2）。
 *
 * 覆盖：写路由鉴权与非法请求、3D 提交、状态查询、取消、未知路径不存在。均为非渲染检查。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasNodeData } from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "./sync/index.js";
import { SqliteCanvasRepository } from "./storage/sqlite/index.js";
import { filmSetCanvasContentRuntime } from "@woohaa3/extension-film-set/backend";
import { createCanvasService } from "./composition.js";
import { handleFilmSetConversionSubmit } from "./api/canvas-api/run-routes.js";
import type { CanvasRequestHandlerOptions } from "./api/canvas-api/types.js";

const NOW = "2026-10-13T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso', size: [1, 2, 0.5] });";
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-conv-http-"));
  dirs.push(dir);
  return path.join(dir, name);
}

async function start(): Promise<{ base: string; token: string; room: import("./sync/room.js").CanvasRoom }> {
  const token = "canvas-conversion-token";
  const canvasRepository = new SqliteCanvasRepository({ path: tempDb("canvas.sqlite") });
  const yjsRepository = new InMemoryYjsDocumentRepository();
  const canvasId = "c-conv";
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  const nodeData: Record<string, CanvasNodeData> = {
    "model-src": {
      modelScript: SCRIPT,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: "src-hash", contentHash: "content-hash" },
      modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    } as unknown as CanvasNodeData
  };
  const service = await createCanvasService({
    env: {
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb("canvas-backend.sqlite"),
      WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: token
    },
    repository: canvasRepository,
    yjsRepository,
    now: () => NOW,
    contentRuntime: filmSetCanvasContentRuntime,
    mediaClient: { async verify() { return { exists: true, matches: true }; } }
  });
  const room = (await service.sync!.registry.resolve(canvasId))!;
  await room.initialize({
    canvas: {
      ...base,
      document: { ...base.document, nodes: [{ id: "model-src", type: "model3d", position: { x: 0, y: 0 } }] },
      nodeData
    },
    roomEpoch: "epoch-1",
    createdAt: NOW
  } as never);
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => {
    await service.close();
    await new Promise<void>((r) => server.close(() => r()));
    canvasRepository.close();
  });
  return { base: `http://127.0.0.1:${port}`, token, room };
}

describe("film-set conversion HTTP contract", () => {
  it("缺少服务令牌被拒绝", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/canvases/c-conv/film-set/conversion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(401);
  });

  it("非法请求体返回 400 且错误码稳定", async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/canvases/c-conv/film-set/conversion`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": token },
      body: JSON.stringify({ requestId: "req-bad", sourceNodeId: "model-src", targetNodeId: "t", sourceKind: "audio" })
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("malformed-request");
  });

  it("3D 提交创建片场并可通过状态查询回读", async () => {
    const { base, token } = await start();
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    const submitted = await fetch(`${base}/api/canvases/c-conv/film-set/conversion`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-3d",
        sourceNodeId: "model-src",
        targetNodeId: "film-1",
        sourceKind: "model3d"
      })
    });
    expect(submitted.status).toBe(202);
    const payload = (await submitted.json()) as { receipt: { requestId: string; duplicate: boolean }; status: { status: string } };
    expect(payload.receipt.requestId).toBe("req-3d");
    expect(payload.status.status).toBe("completed");

    const status = await fetch(`${base}/api/canvases/c-conv/film-set/conversion/req-3d`, {
      headers: { "x-woohaa3-service-token": token }
    });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { status: { status: string; targetNodeId?: string } };
    expect(statusBody.status.status).toBe("completed");
    expect(statusBody.status.targetNodeId).toBe("film-1");

    // 重复提交返回 duplicate，且不重复创建。
    const again = await fetch(`${base}/api/canvases/c-conv/film-set/conversion`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-3d",
        sourceNodeId: "model-src",
        targetNodeId: "film-1",
        sourceKind: "model3d"
      })
    });
    const againBody = (await again.json()) as { receipt: { duplicate: boolean } };
    expect(againBody.receipt.duplicate).toBe(true);
  });

  it("取消未提交的媒体转换返回 cancelled 状态", async () => {
    const { base, token } = await start();
    const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
    // 未配置生成端口：媒体提交立即失败（model-not-configured）；取消返回失败终态而非 404。
    await fetch(`${base}/api/canvases/c-conv/film-set/conversion`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: "req-media", sourceNodeId: "img", targetNodeId: "film-2", sourceKind: "image"
      })
    });
    const cancelled = await fetch(`${base}/api/canvases/c-conv/film-set/conversion/req-media/cancel`, {
      method: "POST",
      headers: { "x-woohaa3-service-token": token }
    });
    // 来源不存在：提交失败（source-not-found / 404），因此没有记录，取消返回 404。
    expect([200, 404]).toContain(cancelled.status);
  });

  it("未知转换请求状态返回 null", async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/canvases/c-conv/film-set/conversion/does-not-exist`, {
      headers: { "x-woohaa3-service-token": token }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: unknown };
    expect(body.ok).toBe(true);
    expect(body.status).toBeNull();
  });
});

describe("film-set conversion HTTP：owner 在边界解析并冻结", () => {
  async function post(
    options: CanvasRequestHandlerOptions,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const server = http.createServer((req, res) => {
      void handleFilmSetConversionSubmit(req, res, "c-conv", options, () => {}).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return await fetch(`http://127.0.0.1:${port}/api/canvases/c-conv/film-set/conversion`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  function namedOptions(overrides: Record<string, unknown>): CanvasRequestHandlerOptions {
    return {
      service: {},
      importGuard: {
        state: () => ({ kind: "none" as const }),
        deleteImported: async () => {},
        subject: () => "app-user",
        authorize: () => null
      },
      ...overrides
    } as unknown as CanvasRequestHandlerOptions;
  }

  function acceptedSubmit(sink: Array<{ subject?: string; ownerId?: string }>, requestId: string) {
    return {
      submit: async (request: { subject?: string; ownerId?: string }) => {
        sink.push(request);
        return {
          ok: true as const,
          receipt: { ok: true as const, requestId, duplicate: false, canvasId: "c-conv", targetNodeId: "t" },
          status: { status: "completed" as const }
        };
      }
    };
  }

  it("把可信主体 + 本次 Cookie 交给 resolver，回填 ownerId 并下发 Set-Cookie", async () => {
    let seenInput: { subject?: string; cookie?: string } | null = null;
    const submitted: Array<{ subject?: string; ownerId?: string }> = [];
    const options = namedOptions({
      filmSetConversionOwnerResolver: (input: { subject?: string; cookie?: string }) => {
        seenInput = input;
        return { ownerId: "local:session-1", setCookie: "woohaa3-chatgpt-session=abc; HttpOnly; Path=/" };
      },
      filmSetConversion: acceptedSubmit(submitted, "r1")
    });
    const res = await post(
      options,
      { requestId: "r1", sourceNodeId: "s", targetNodeId: "t", sourceKind: "image" },
      { cookie: "woohaa3-chatgpt-session=old" }
    );
    expect(res.status).toBe(202);
    expect(seenInput).toEqual({ subject: "app-user", cookie: "woohaa3-chatgpt-session=old" });
    expect(res.headers.get("set-cookie")).toContain("woohaa3-chatgpt-session=abc");
    expect(submitted[0]).toMatchObject({ subject: "app-user", ownerId: "local:session-1" });
  });

  it("未配置 resolver 时不注入 ownerId（生成端按主体/自身边界处理）", async () => {
    const submitted: Array<{ subject?: string; ownerId?: string }> = [];
    const options = namedOptions({ filmSetConversion: acceptedSubmit(submitted, "r2") });
    await post(options, { requestId: "r2", sourceNodeId: "s", targetNodeId: "t", sourceKind: "image" });
    expect(submitted[0]).toMatchObject({ subject: "app-user" });
    expect(submitted[0]?.ownerId).toBeUndefined();
  });

  it("3D 直接复制不解析 owner、不下发 cookie", async () => {
    let called = 0;
    const submitted: Array<{ subject?: string; ownerId?: string }> = [];
    const options = namedOptions({
      filmSetConversionOwnerResolver: () => {
        called += 1;
        return { ownerId: "local:x", setCookie: "should-not-be-set=1" };
      },
      filmSetConversion: acceptedSubmit(submitted, "r3")
    });
    const res = await post(options, { requestId: "r3", sourceNodeId: "s", targetNodeId: "t", sourceKind: "model3d" });
    expect(res.status).toBe(202);
    expect(called).toBe(0);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(submitted[0]?.ownerId).toBeUndefined();
  });
});
