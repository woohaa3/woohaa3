/**
 * import_generated_image 工具（change: 2026-11-03-add-codex-image-import，任务 6）。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function client(importGeneratedImage: AgentCanvasClient["importGeneratedImage"]): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: false, code: "unused", message: "unused" }; },
    async getChanges() { return { ok: false, code: "unused", message: "unused" }; },
    async applyPlan() { return { ok: false, code: "unused", message: "unused" }; },
    ...(importGeneratedImage ? { importGeneratedImage } : {})
  };
}

async function start(options: Parameters<typeof createModelMcpHttpHandler>[0]) {
  const handler = createModelMcpHttpHandler(options);
  const server = http.createServer((req, res) => {
    void handler.handle(req, res).then((handled) => {
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
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${port}`;
}

async function callTool(base: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_generated_image", arguments: args } })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
}

describe("import_generated_image", () => {
  it("成功时回执包含节点、媒体引用与索引", async () => {
    const base = await start({
      agentAuthoring: {
        client: client(async () => ({
          ok: true,
          duplicate: false,
          receipt: { nodeId: "codex-image-1", mediaRef: "sha256-abc", sha256: "abc", totalGenerated: 3, importedIndex: 1 }
        }))
      }
    });
    const body = await callTool(base, { canvasId: "c1", requestId: "r1", index: 1 });
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toMatchObject({
      ok: true,
      nodeId: "codex-image-1",
      mediaRef: "sha256-abc",
      sha256: "abc",
      totalGenerated: 3,
      importedIndex: 1
    });
  });

  it("索引越界时回执带 totalGenerated", async () => {
    const base = await start({
      agentAuthoring: {
        client: client(async () => ({ ok: false, code: "image-index-out-of-range", message: "超出", totalGenerated: 1 }))
      }
    });
    const body = await callTool(base, { canvasId: "c1", requestId: "r1", index: 4 });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toMatchObject({
      ok: false,
      code: "image-index-out-of-range",
      details: { totalGenerated: 1 }
    });
  });

  it("grant 拒绝时不调用导入", async () => {
    let called = 0;
    const base = await start({
      agentAuthoring: {
        client: client(async () => {
          called += 1;
          return { ok: true, duplicate: false, receipt: { nodeId: "n", mediaRef: "m", sha256: "s", totalGenerated: 1, importedIndex: 0 } };
        })
      },
      toolGrant: {
        authorize: () => ({ ok: false, reason: "group-scope-forbidden" })
      }
    });
    const body = await callTool(base, { canvasId: "c1", requestId: "r1" }, { authorization: "Bearer bad" });
    expect(body.result?.isError).toBe(true);
    expect(called).toBe(0);
  });
});
