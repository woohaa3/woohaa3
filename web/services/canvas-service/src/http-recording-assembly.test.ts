import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CanvasRecordingPort } from "@woohaa3/contracts";
import { InMemoryCanvasRepository } from "./storage/core/index.js";
import { InMemoryYjsDocumentRepository, createInMemoryWriterLock } from "./sync/index.js";
import { createCanvasService } from "./composition.js";

it("resolves recording after canvas initialization through the real HTTP assembly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wo-recording-route-"));
  let recording: CanvasRecordingPort | undefined;
  const service = await createCanvasService({
    env: { WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: join(directory, "canvas.sqlite"), WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: "test-recording" },
    mediaClient: { async verify() { return { exists: true, matches: true }; } },
    storageConfig: { backend: "sqlite", sqlitePath: join(directory, "canvas.sqlite"), limits: {} },
    repository: new InMemoryCanvasRepository(), yjsRepository: new InMemoryYjsDocumentRepository(), writerLock: createInMemoryWriterLock(),
    get recording() { return recording; }
  });
  const canvas = await service.composition!.service.createCanvas({ title: "recording route" });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/canvases/${canvas.id}/recording`;
  const headers = { "x-woohaa3-service-token": "test-recording" };
  try {
    expect((await fetch(url, { headers })).status).toBe(503);
    const list = vi.fn(async () => ({ ok: true as const, jobs: [] }));
    recording = { list } as unknown as CanvasRecordingPort;
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ ok: true });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
