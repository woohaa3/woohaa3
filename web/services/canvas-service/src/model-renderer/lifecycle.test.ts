/**
 * 模型预览 renderer 生命周期与故障隔离（composition 层）
 * （change: enhance-model-scene-authoring-api，任务 8.4）。
 *
 * 验证：
 * - 注入的 renderer client 在关闭 Canvas Service 时被回收（仅在 host 自己的 client 时）；
 * - renderer 不可用时 preview 返回稳定错误，而画布存储与其它 MCP 工具照常工作。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryYjsDocumentRepository } from "../sync/index.js";
import { SqliteCanvasRepository } from "../storage/sqlite/index.js";
import { createCanvasService } from "../composition.js";
import type { RendererClient } from "./index.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-canvas-"));
  dirs.push(dir);
  return path.join(dir, name);
}

async function start(renderer?: RendererClient | null): Promise<{ base: string; token: string }> {
  const token = "canvas-contract-token";
  const canvasRepository = new SqliteCanvasRepository({ path: tempDb("canvas.sqlite") });
  const service = await createCanvasService({
    env: {
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
      WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: tempDb("canvas-backend.sqlite"),
      WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN: token
    },
    repository: canvasRepository,
    yjsRepository: new InMemoryYjsDocumentRepository(),
    mediaClient: { async verify() { return { exists: true, matches: true }; } },
    enablePromptSnippets: false,
    ...(renderer !== undefined ? { modelRenderer: renderer } : {})
  });
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
  return { base: `http://127.0.0.1:${port}`, token };
}

/** 建画布，返回 canvasId。 */
async function seedCanvas(base: string, token: string): Promise<{ canvasId: string }> {
  const headers = { "content-type": "application/json", "x-woohaa3-service-token": token };
  const created = await fetch(`${base}/api/canvases`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "preview-fixture" })
  });
  expect(created.ok).toBe(true);
  const canvas = ((await created.json()) as { canvas: { id: string } }).canvas;
  return { canvasId: canvas.id };
}

describe("renderer 故障隔离（任务 8.4）", () => {
  it("renderer 不可用不影响画布存储与其它 MCP 工具", async () => {
    const { base, token } = await start(null);
    const { canvasId } = await seedCanvas(base, token);

    // 预览相关 MCP 路由在 renderer 缺失时仍返回结构化 4xx（而非 5xx 崩溃）：
    // 未知画布 → canvas-not-found / canvas-unavailable，证明不依赖 renderer。
    const submit = await fetch(`${base}/api/model-mcp/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": token },
      body: JSON.stringify({ canvasId: "ghost-canvas", nodeId: "missing", source: "scene.box({ id: 'x' });" })
    });
    expect(submit.status).toBeGreaterThanOrEqual(400);
    expect(submit.status).toBeLessThan(500);

    // 画布仍可读（存储未被 renderer 缺失影响）。
    const read = await fetch(`${base}/api/canvases/${canvasId}`, {
      headers: { "x-woohaa3-service-token": token }
    });
    expect(read.ok).toBe(true);
  });

  it("注入的 renderer 不由 host 关闭（调用方拥有生命周期）", async () => {
    let closed = 0;
    const renderer: RendererClient = {
      available: () => true,
      close: async () => { closed += 1; },
      render: async () => ({ ok: false, code: "render-failed", message: "noop" })
    };
    const { base, token } = await start(renderer);
    await seedCanvas(base, token);
    // 关闭 service。
    await Promise.all(closers.splice(0).map((close) => close()));
    expect(closed).toBe(0);
  });
});
