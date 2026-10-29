/**
 * Canvas Session WebSocket 授权与 Origin 门禁测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 6.2/6.3；
 *  change 2026-10-16：Origin 允许列表由后端 `WOOHAA3_ALLOWED_ORIGINS` 接入）。
 *
 * 覆盖：注入 `authenticate`/`access` 后 WS 升级在 room acquire **之前**判定 read —— 未认证 401、
 * 无权限 403、有权限升级成功（101）；`allowedOrigins` 非空时跨源升级 403。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CANVAS_SESSION_PROTOCOL_VERSION, YJS_CANVAS_FORMAT_VERSION, YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasAccessPort } from "../access/access-port.js";
import type { CanvasRequestAuthenticator } from "../access/resolve-access.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { createSyncUpgradeHandler, type SyncUpgradeHandler } from "./upgrade.js";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const CANVAS_ID = "ws-canvas";

async function start(input: {
  authenticate?: CanvasRequestAuthenticator;
  access?: CanvasAccessPort;
  allowedOrigins?: readonly string[];
  gate?: () => { ok: true } | { ok: false; status: number; code: string };
}): Promise<{ url: string; handler: SyncUpgradeHandler }> {
  const repository = new InMemoryYjsDocumentRepository();
  const Y = await import("yjs");
  const { serverCanvasToYDoc } = await import("@woohaa3/contracts/canvas-yjs");
  const empty = createEmptyWoohaa3ServerCanvas(CANVAS_ID, "2026-10-16T00:00:00.000Z");
  await repository.createYjsDocument({
    canvasId: CANVAS_ID,
    formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "ws-epoch",
    checkpoint: Y.encodeStateAsUpdate(serverCanvasToYDoc(empty)),
    projection: empty,
    revision: empty.revision,
    createdAt: "2026-10-16T00:00:00.000Z"
  });
  const handler = createSyncUpgradeHandler({
    repository,
    accessRuntime: Object.freeze({ enabled: true as const }),
    ...(input.authenticate ? { authenticate: input.authenticate } : {}),
    ...(input.access ? { access: input.access } : {}),
    ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
    ...(input.gate ? { gate: input.gate } : {})
  });
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!handler.handle(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  closers.push(async () => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${port}/api/canvases/${CANVAS_ID}/sync`, handler };
}

/** 发起一次升级，返回升级被拒时的 HTTP 状态或 `null`（成功）。 */
async function upgrade(url: string, headers: Record<string, string> = {}): Promise<{ status: number | null; ws: WebSocket | null }> {
  const ws = new WebSocket(
    `${url}?sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}`
    + `&protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}&formatVersion=${YJS_CANVAS_FORMAT_VERSION}`,
    { headers }
  );
  return await new Promise((resolve) => {
    ws.once("open", () => resolve({ status: null, ws }));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, ws: null });
    });
    ws.once("error", () => resolve({ status: -1, ws: null }));
  });
}

const principalFromHeader: CanvasRequestAuthenticator = async (req) => {
  const raw = req.headers["x-test-subject"];
  const subject = Array.isArray(raw) ? raw[0] : raw;
  return typeof subject === "string" && subject.trim() !== ""
    ? { subject: subject.trim(), identityProvider: "test-identity" }
    : null;
};

/** 只允许 `creator-1` 读取。 */
function creatorOnlyRead(): CanvasAccessPort {
  return {
    async authorize({ principal, permission }) {
      if (principal.subject !== "creator-1" || permission !== "read") {
        return { allowed: false, code: "forbidden", message: "无权访问该画布" };
      }
      return { allowed: true };
    }
  };
}

describe("WS 升级授权（任务 6.2/6.3）", () => {
  it("未认证（无主体）→ 401 拒绝", async () => {
    const { url } = await start({ authenticate: principalFromHeader, access: creatorOnlyRead() });
    const result = await upgrade(url);
    expect(result.status).toBe(401);
    result.ws?.close();
  });

  it("已认证但无 read 权限 → 403 拒绝", async () => {
    const { url } = await start({ authenticate: principalFromHeader, access: creatorOnlyRead() });
    const result = await upgrade(url, { "x-test-subject": "intruder" });
    expect(result.status).toBe(403);
    result.ws?.close();
  });

  it("同一主体有 read 权限 → 升级成功", async () => {
    const { url, handler } = await start({ authenticate: principalFromHeader, access: creatorOnlyRead() });
    const result = await upgrade(url, { "x-test-subject": "creator-1" });
    expect(result.status).toBeNull();
    expect(handler.connectionCount()).toBe(1);
    result.ws?.close();
  });

  it("Origin 不在允许列表 → 403 拒绝；同源允许列表命中 → 升级成功", async () => {
    const { url } = await start({
      authenticate: principalFromHeader,
      access: creatorOnlyRead(),
      allowedOrigins: ["http://app.example"]
    });
    const rejected = await upgrade(url, { "x-test-subject": "creator-1", origin: "http://evil.example" });
    expect(rejected.status).toBe(403);

    const allowed = await upgrade(url, { "x-test-subject": "creator-1", origin: "http://app.example" });
    expect(allowed.status).toBeNull();
    allowed.ws?.close();
  });

  it("未注入认证时保持历史 loopback 行为（允许列表仍生效）", async () => {
    const { url, handler } = await start({ allowedOrigins: ["http://app.example"] });
    const allowed = await upgrade(url, { origin: "http://app.example" });
    expect(allowed.status).toBeNull();
    expect(handler.connectionCount()).toBe(1);
    allowed.ws?.close();
  });
});

/**
 * 单实例门禁（change: 2026-10-29-recover-storage-seq-conflict）。
 *
 * spec「首版 room 服务采用单应用实例」要求同一时刻只有一个实例接受 room 连接与命令。
 * readiness 过去只体现在 /readyz 上，写路径不消费它：第二个本机宿主于是能悄悄写同一份协作
 * 存储，把第一个实例 room 的内存 storageSeq 撞成永久过期（客户端卡在「请重试」）。
 */
describe("WS 升级 writer lock 门禁", () => {
  it("未持有 writer lock → 503 拒绝，且不进入 room", async () => {
    const { url, handler } = await start({
      gate: () => ({ ok: false, status: 503, code: "writer-lock-unavailable" })
    });
    const result = await upgrade(url);
    expect(result.status).toBe(503);
    expect(handler.connectionCount()).toBe(0);
    result.ws?.close();
  });

  it("持有 writer lock → 正常升级", async () => {
    const { url, handler } = await start({ gate: () => ({ ok: true }) });
    const result = await upgrade(url);
    expect(result.status).toBeNull();
    expect(handler.connectionCount()).toBe(1);
    result.ws?.close();
  });
});
