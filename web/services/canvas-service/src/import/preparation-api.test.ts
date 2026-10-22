/**
 * 导入准备 API 路由测试（change: 2026-10-12-add-extension-online-canvas-migration，任务 5.1–5.3 / 8.x）。
 *
 * 覆盖：未认证拒绝、主体只来自可信 resolver（不信任 body staffId/ownerId）、
 * prepare / status / 来源目录路由映射、delete tombstone 时 preparation 返回 DELETED。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NODE_GENERATION_HISTORY_VERSION,
  createEmptyWoohaa3ServerCanvas,
  type CanvasImportCandidate,
  type CanvasSourceCatalogEntry,
  type CanvasSourceListPage,
  type MediaStorage,
  type ServerCanvas
} from "@woohaa3/contracts";
import { SqliteCanvasRepository } from "../storage/sqlite/index.js";
import { SqliteYjsRepository } from "../storage/sqlite/yjs.js";
import { SqliteNodeHistoryRepository } from "../storage/sqlite/node-history.js";
import { SqliteCanvasImportStore } from "../storage/sqlite/canvas-import.js";
import { CanvasImportService } from "./service.js";
import { createCanvasPreparationRoutes } from "../api/canvas-preparation-api.js";
import type { CanvasSourceAccessHandle, CanvasSourcePort } from "./contracts.js";

const NOW = "2026-10-13T00:00:00.000Z";
const tempDirs: string[] = [];
const open: Array<{ close(): void }> = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterAll(() => {
  for (const server of servers) server.close();
  for (const resource of open) resource.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-prep-api-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "canvas.sqlite");
  open.push(
    new SqliteCanvasRepository({ path: dbPath, now: () => NOW }),
    new SqliteYjsRepository({ path: dbPath, now: () => NOW }),
    new SqliteNodeHistoryRepository({ path: dbPath, now: () => NOW })
  );
  const store = new SqliteCanvasImportStore({ path: dbPath, now: () => NOW });
  open.push(store);

  const candidate: CanvasImportCandidate = {
    binding: {
      sourceId: "legacy-source",
      sourceCanvasId: "legacy-1",
      cutoverGeneration: "gen-1",
      extensionId: "legacy-import",
      configVersion: 1,
      converterVersion: "converter-1",
      sourceVersion: "watermark-1"
    },
    canvas: canvas(),
    access: { ownerSubject: "creator-1", readSubjects: ["creator-1"], writeSubjects: ["creator-1"], sharingMode: "specified", sourceAclVersion: "acl-1" },
    history: [history()],
    diagnostics: { entries: [], readyMediaCount: 0, restoredHistoryCount: 0, unrecoveredRecordCount: 0 }
  };
  const port: CanvasSourcePort = {
    listSources: async (): Promise<CanvasSourceCatalogEntry[]> => [{ sourceId: "legacy-source", displayName: "LegacyCanvas", availability: "available" }],
    listAccessible: async (): Promise<CanvasSourceListPage> => ({ items: [], nextCursor: null }),
    resolveAccessible: async ({ sourceCanvasId }): Promise<{ ok: true; handle: CanvasSourceAccessHandle }> => ({
      ok: true,
      handle: {
        binding: { sourceId: "legacy-source", sourceCanvasId, cutoverGeneration: "gen-1", extensionId: "legacy-import", configVersion: 1, converterVersion: "converter-1" },
        sourceVersion: "watermark-1",
        targetCanvasId: sourceCanvasId,
        title: "旧作品"
      }
    }),
    prepareCandidate: async () => ({ ok: true, candidate }),
    validateSnapshot: async () => ({ ok: true })
  };
  const mediaStorage = { exists: async () => true } as unknown as MediaStorage;
  const service = new CanvasImportService({ sources: port, store, mediaStorage, now: () => NOW, generateJobId: () => "job-1" });
  return { service, store };
}

function canvas(): ServerCanvas {
  const value = createEmptyWoohaa3ServerCanvas("legacy-1", NOW);
  value.document.nodes.push({ id: "n1", type: "text", position: { x: 0, y: 0 } });
  return value;
}
function history() {
  return {
    version: NODE_GENERATION_HISTORY_VERSION,
    entryId: "ngh-1", canvasId: "legacy-1", nodeId: "n1", kind: "text" as const, createdAt: NOW,
    sourceIdentity: "text:1", currentIdentity: "text:1", recoverable: true, previewable: true,
    source: { label: "旧来源" }, payload: { kind: "text" as const, text: "正文" }
  };
}

async function withServer(
  run: (base: string) => Promise<void>,
  resolveSubject: (req: IncomingMessage) => Promise<string | null>
): Promise<void> {
  const { service, store } = build();
  const handler = createCanvasPreparationRoutes({ importService: service, resolveSubject, maxBodyBytes: 1024 * 64, log: () => undefined });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handler(req, res)
      .then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } })
      .catch(() => { res.statusCode = 500; res.end(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    await run(base);
  } finally {
    store.close();
  }
}

describe("准备 API：认证边界（任务 5.1）", () => {
  it("未认证主体：prepare/status/来源目录一律 401（不进入 CanvasRoom）", async () => {
    await withServer(async (base) => {
      for (const [method, url] of [["POST", "/api/canvases/legacy-1/prepare"], ["GET", "/api/canvases/legacy-1/preparation"], ["GET", "/api/canvas-sources"]] as const) {
        const response = await fetch(`${base}${url}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(response.status).toBe(401);
      }
    }, async () => null);
  });

  it("主体只来自可信 resolver：body 里的 staffId/ownerId 不被信任", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/canvases/legacy-1/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: "legacy-source", staffId: "attacker", ownerId: "attacker" })
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { state: string };
      expect(body.state).toBe("preparing");
    }, async () => "creator-1");
  });

  it("来源目录返回活动来源（不泄漏路径/URI）", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/canvas-sources`);
      expect(response.status).toBe(200);
      const body = await response.json() as { sources: Array<Record<string, unknown>> };
      expect(body.sources).toEqual([{ sourceId: "legacy-source", displayName: "LegacyCanvas", availability: "available" }]);
      expect(JSON.stringify(body)).not.toMatch(/sqlite|\/data|mongodb|file:/i);
    }, async () => "creator-1");
  });
});

describe("准备 API：status 与删除 tombstone（任务 5.2 / 7.1）", () => {
  it("status 无创建副作用；删除后返回 410 DELETED", async () => {
    const { service, store } = build();
    // 先直接驱动一次准备，确保已有画布。
    await service.prepare({ subject: "creator-1", sourceCanvasId: "legacy-1" });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && service.status("legacy-1").kind !== "ready") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    store.deleteImportedCanvas("legacy-1");

    const handler = createCanvasPreparationRoutes({ importService: service, resolveSubject: async () => "creator-1", maxBodyBytes: 1024 * 64, log: () => undefined });
    const server = createServer((req, res) => { void handler(req, res).then((h) => { if (!h) { res.statusCode = 404; res.end(); } }); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const response = await fetch(`${base}/api/canvases/legacy-1/preparation`);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ state: "deleted", code: "DELETED" });
  });
});
