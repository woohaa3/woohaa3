/**
 * Agent Canvas client 传输字段保留测试
 * （change: 2026-10-06-fix-model-media-references-and-animation-preview，任务 2.1/D3）。
 *
 * 回归：client 只剥离 envelope 的 `ok`，不得移除 graph/delta/view 自身的领域 `protocolVersion`。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentCanvasClient } from "./agent-canvas-client.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(response: Record<string, unknown>) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

function client(baseUrl: string) {
  return createAgentCanvasClient({ baseUrl, principalId: "dev" });
}

describe("Agent Canvas client 保留领域版本字段（D3）", () => {
  it("getGraph 保留 graph.protocolVersion", async () => {
    const baseUrl = await start({ ok: true, protocolVersion: 1, canvasId: "c", revision: 3, nodes: [], edges: [] });
    const result = await client(baseUrl).getGraph({ canvasId: "c" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.graph as { protocolVersion?: unknown }).protocolVersion).toBe(1);
  });

  it("getChanges 保留 delta.protocolVersion", async () => {
    const baseUrl = await start({ ok: true, protocolVersion: 1, canvasId: "c", revision: 3, nodes: [], edges: [], cursor: 3 });
    const result = await client(baseUrl).getChanges({ canvasId: "c", sinceRevision: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.delta as { protocolVersion?: unknown }).protocolVersion).toBe(1);
  });
});
