/**
 * 编辑完成 HTTP API 契约测试
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.4/2.5）。
 *
 * 真实 HTTP server：begin/complete/status/abandon、幂等、冲突、越权与 not-found。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  IMAGE_EDIT_DOCUMENT_VERSION, IMAGE_PROJECT_CONTENT_TYPE, PHOTOCRAFT_ENGINE_VERSION,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { InMemoryNodeHistoryRepository } from "../storage/core/in-memory-node-history-repository.js";
import { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import { EditCompletionService } from "../storage/core/edit-completion-service.js";
import { InMemoryEditCompletionRepository } from "../storage/core/in-memory-edit-completion-repository.js";
import { createEditCompletionRequestHandler } from "./edit-completion-api.js";
import type { CanvasRoom } from "../sync/index.js";

const NOW = "2026-10-08T00:00:00.000Z";
const CANVAS = "canvas-1";
const BASE_KEY = "sha256-" + "a".repeat(64);
const OUT_KEY = "generation-outputs/" + "b".repeat(64) + ".png";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function fakeRoom(canvas: ServerCanvas): CanvasRoom & { canvas: ServerCanvas } {
  let current = canvas;
  return {
    get canvas() {
      return current;
    },
    exportCanvas: () => ({ ok: true as const, canvas: current }),
    async submit(batch: { commands: readonly unknown[] }) {
      const applied = applyCanvasCommands(current, batch.commands as never, { now: NOW });
      if (!applied.ok) return { ok: false as const, status: "rejected" as const, commandId: "x", code: applied.rejection.code, message: applied.rejection.message };
      current = { ...applied.canvas, revision: current.revision + 1 };
      return { ok: true as const, status: "accepted" as const, commandId: "x", revision: current.revision, noop: false, update: null };
    }
  } as unknown as CanvasRoom & { canvas: ServerCanvas };
}

function imageCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  const output: StoredAsset = {
    id: "asset-output", title: "图片", mediaKind: "image", source: "uploaded", status: "ready", createdAt: NOW,
    metadata: { storageKey: BASE_KEY, checksum: "a".repeat(64), contentType: "image/png", size: 10 }
  };
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "node-1", type: "image", position: { x: 0, y: 0 }, width: 248, height: 232 }] },
    assets: [output],
    nodeData: { "node-1": { title: "图", outputAssetId: output.id, taskStatus: "successed" } }
  } as unknown as ServerCanvas;
}

async function start(canvas: ServerCanvas, options: { extraCanvas?: ServerCanvas; mediaExists?: (key: string) => boolean;
  canvasExists?: Parameters<typeof createEditCompletionRequestHandler>[0]["canvasExists"] } = {}): Promise<{ base: string }> {
  const repository = new InMemoryNodeHistoryRepository();
  const completions = new InMemoryEditCompletionRepository();
  const room = fakeRoom(canvas);
  const rooms = new Map([[canvas.id, room], ...(options.extraCanvas ? [[options.extraCanvas.id, fakeRoom(options.extraCanvas)] as const] : [])]);
  const history = new NodeHistoryApplicationService({ repository, resolveRoom: async (id) => rooms.get(id) ?? null });
  const edit = new EditCompletionService({
    completions,
    publisher: {
      registerEntry: (entry) => history.registerEntry(entry),
      listEntriesForNode: (canvasId, nodeId) => history.listEntriesForNode(canvasId, nodeId)
    },
    resolveRoom: async (id) => rooms.get(id) ?? null,
    ...(options.mediaExists ? { mediaVerifier: { exists: async (key: string) => options.mediaExists!(key) } } : {}),
    now: () => NOW
  });
  const handler = createEditCompletionRequestHandler({
    service: edit,
    canvasExists: options.canvasExists ?? (async (canvasId) => rooms.has(canvasId))
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}` };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

describe("编辑完成 HTTP API", () => {
  it("begin/complete/status 全链路", async () => {
    const { base } = await start(imageCanvas());
    const begin = await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-begin`, {
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s1", requestId: "begin:s1", kind: "image",
      baselineContentIdentity: `media:${BASE_KEY}`
    });
    expect(begin.status).toBe(200);
    expect(begin.body.baselineContentIdentity).toBe(`media:${BASE_KEY}`);

    const complete = await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-complete`, {
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s1", requestId: "req-1", kind: "image",
      baselineContentIdentity: `media:${BASE_KEY}`,
      media: {
        baseAssetId: "asset-base", baseStorageKey: BASE_KEY, sourceWidth: 100, sourceHeight: 80,
        outputAssetId: "asset-out", outputStorageKey: OUT_KEY, checksum: "b".repeat(64),
        contentType: "image/png", size: 20,
        imageEdit: {
          version: IMAGE_EDIT_DOCUMENT_VERSION, baseAssetId: "asset-base", sourceWidth: 100, sourceHeight: 80,
          shapes: [{ id: "s1", tool: "pen", color: "#ff3b30", widthInSourcePixels: 2, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }]
        }
      }
    });
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);
    expect(complete.body.receipt.status).toBe("completed");

    const status = await fetch(`${base}/api/canvas-node-history/${CANVAS}/node-1/edit-status?requestId=req-1`);
    expect(status.status).toBe(200);
    expect((await status.json() as any).receipt.entryId).toBe(complete.body.receipt.entryId);
  });

  it("同 requestId 不同 payload 返回 409 冲突", async () => {
    const { base } = await start(imageCanvas());
    const body = (outputStorageKey: string) => ({
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s1", requestId: "req-1", kind: "image",
      baselineContentIdentity: `media:${BASE_KEY}`,
      media: { baseAssetId: "asset-base", baseStorageKey: BASE_KEY, sourceWidth: 10, sourceHeight: 10, outputAssetId: "o", outputStorageKey, checksum: "b".repeat(64), contentType: "image/png", size: 1 }
    });
    await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-complete`, body(OUT_KEY));
    const conflict = await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-complete`, body("generation-outputs/" + "c".repeat(64) + ".png"));
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("EDIT_SESSION_REQUEST_CONFLICT");
  });

  it("越权/未知画布返回 404；未知请求 status 返回 not-found", async () => {
    const { base } = await start(imageCanvas());
    const forbidden = await post(base, `/api/canvas-node-history/other-canvas/node-1/edit-begin`, {
      canvasId: "other-canvas", nodeId: "node-1", sessionId: "s", requestId: "begin:s", kind: "image", baselineContentIdentity: "media:x"
    });
    expect(forbidden.status).toBe(404);
    const missing = await fetch(`${base}/api/canvas-node-history/${CANVAS}/node-1/edit-status?requestId=nope`);
    expect(missing.status).toBe(404);
  });

  it("非编辑路径返回 false（不拦截其它路由）", async () => {
    const { base } = await start(imageCanvas());
    const response = await fetch(`${base}/api/canvas-node-history/${CANVAS}/node-1`);
    expect(response.status).toBe(404);
  });

  it("prepared 草稿可 abandon", async () => {
    const { base } = await start(imageCanvas());
    await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-begin`, {
      canvasId: CANVAS, nodeId: "node-1", sessionId: "s1", requestId: "begin:s1", kind: "image", baselineContentIdentity: `media:${BASE_KEY}`
    });
    const abandoned = await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-abandon`, { requestId: "begin:s1" });
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.status).toBe("abandoned");
  });
});


it("begin 的 body 不能改成未经路由授权的目标", async () => {
  const { base } = await start(imageCanvas());
  const result = await post(base, `/api/canvas-node-history/${CANVAS}/node-1/edit-begin`, {
    canvasId: CANVAS, nodeId: "node-other", sessionId: "s", requestId: "begin:s", kind: "image", baselineContentIdentity: `media:${BASE_KEY}`
  });
  expect(result.status).toBe(400);
});

it("跨画布引用核验要求目标与来源均可读取，并返回权威资产 metadata", async () => {
  const source = imageCanvas();
  const project = { storageKey: `sha256-${"c".repeat(64)}`, checksum: "c".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 100 };
  (source.nodeData["node-1"] as Record<string, unknown>).imageEdit = {
    version: "woohaa-image-project-v1", engine: "photocraft", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1,
    baseAssetId: "asset-output", sourceWidth: 100, sourceHeight: 80, canvasWidth: 100, canvasHeight: 80,
    documentContentHash: "1".repeat(16), project, sourceAssetIds: ["asset-output"]
  };
  const permissions: string[] = [];
  let deniedCanvas: string | null = CANVAS, missing = false;
  const { base } = await start(source, { extraCanvas: createEmptyWoohaa3ServerCanvas("target"), mediaExists: () => !missing,
    canvasExists: async (id) => { permissions.push(id); return id !== deniedCanvas; } });
  const path = "/api/canvas-node-history/target/_/image-project-references";
  const request = { canvasId: "target", sourceCanvasId: CANVAS, nodeIds: ["node-1"], assetIds: ["asset-output"], projects: [project] };
  expect((await post(base, path, request)).status).toBe(404);
  expect(permissions).toEqual(["target", CANVAS]);
  deniedCanvas = "target"; permissions.length = 0;
  expect((await post(base, path, request)).status).toBe(404);
  expect(permissions).toEqual(["target"]);
  deniedCanvas = null;
  const accepted = await post(base, path, request);
  expect(accepted.status).toBe(200); expect(accepted.body.assets).toEqual(source.assets);
  missing = true;
  expect((await post(base, path, request)).body.code).toBe("EDIT_SESSION_MEDIA_UNRESOLVABLE");
  missing = false;
  // 失败原因分开上报：工程记录与来源不一致、素材不在来源画布，都给出可读原因而不是同一句笼统文案。
  const mismatch = await post(base, path, { ...request, projects: [{ ...project, checksum: "d".repeat(64) }] });
  expect(mismatch.body.code).toBe("EDIT_SESSION_INVALID");
  expect(mismatch.body.message).toContain("工程记录");
  const missingAsset = await post(base, path, { ...request, assetIds: ["asset-not-in-canvas"] });
  expect(missingAsset.body.code).toBe("EDIT_SESSION_INVALID");
  expect(missingAsset.body.message).toContain("来源素材");
});
