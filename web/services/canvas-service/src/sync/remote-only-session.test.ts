/**
 * remote-only 画布的 Canvas Session 准入
 *
 * GET 对本机没有的远端画布会回 200 + pendingFetch，内容应由房间 seedFromUpstream。
 * 本机单实例（accessRuntime.enabled=false）仍会把 canvasExists 交给 upgrade；
 * 若只查本机内容，WebSocket 会在进房间之前 404，远端快照永远拉不下来。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import {
  CANVAS_SESSION_PROTOCOL_VERSION,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION
} from "@woohaa3/contracts/canvas-yjs";
import { createCanvasService } from "../composition.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";

const closers: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REMOTE_ID = "canvas-remote-only";
const LOCAL_ID = "canvas-local";
const MISSING_ID = "canvas-missing";
const REMOTE_SUMMARY = {
  id: REMOTE_ID,
  title: "远端画布",
  revision: 3,
  updatedAt: "2026-10-22T00:00:00.000Z"
};

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-remote-session-"));
  dirs.push(dir);
  return path.join(dir, "canvas.sqlite");
}

async function handshake(url: string): Promise<{ status: number | null; ws: WebSocket | null }> {
  const ws = new WebSocket(
    `${url}?sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}`
    + `&protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}&formatVersion=${YJS_CANVAS_FORMAT_VERSION}`
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

async function start(): Promise<{ base: string; wsBase: string }> {
  const repository = new InMemoryCanvasRepository();
  await repository.createCanvas(createEmptyWoohaa3ServerCanvas(LOCAL_ID, "2026-10-22T00:00:00.000Z"));
  const service = await createCanvasService({
    repository,
    yjsRepository: new InMemoryYjsDocumentRepository(),
    storageConfig: { backend: "sqlite", sqlitePath: tempDb(), limits: {} },
    mediaClient: { async verify() { return { exists: true, matches: true }; } },
    accessRuntime: Object.freeze({
      enabled: false as const,
      instance: Object.freeze({
        kind: "instance" as const,
        id: "instance:local",
        ownerId: "dev-admin",
        credentialOwnerId: "principal:dev-admin"
      })
    }),
    catalogSources: [
      {
        id: "remote:test",
        label: "远端 test",
        list: async () => [REMOTE_SUMMARY],
        get: async (canvasId) => (canvasId === REMOTE_ID ? REMOTE_SUMMARY : null)
      }
    ]
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  if (service.sync) {
    server.on("upgrade", (req, socket, head) => {
      if (!service.sync?.handle(req, socket, head)) socket.destroy();
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("未取得监听端口");
  closers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  });
  const origin = `http://127.0.0.1:${address.port}`;
  return { base: origin, wsBase: `ws://127.0.0.1:${address.port}` };
}

describe("remote-only Canvas Session", () => {
  it("GET 对本机没有的远端画布返回 pendingFetch，WebSocket 仍能升级", async () => {
    const { base, wsBase } = await start();
    const get = await fetch(`${base}/api/canvases/${REMOTE_ID}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ pendingFetch: true, canvas: { id: REMOTE_ID, title: "远端画布" } });

    const session = await handshake(`${wsBase}/api/canvases/${REMOTE_ID}/sync`);
    expect(session.status).toBeNull();
    session.ws?.close();
  });

  it("本机画布仍能升级；目录里没有的 id 仍 404", async () => {
    const { wsBase } = await start();
    const local = await handshake(`${wsBase}/api/canvases/${LOCAL_ID}/sync`);
    expect(local.status).toBeNull();
    local.ws?.close();

    const missing = await handshake(`${wsBase}/api/canvases/${MISSING_ID}/sync`);
    expect(missing.status).toBe(404);
    missing.ws?.close();
  });
});
