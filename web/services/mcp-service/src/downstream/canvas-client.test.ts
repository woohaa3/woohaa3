/**
 * Canvas 内部协议 client 测试（change: split-model-mcp-into-mcp-service）。
 *
 * 验证 mcp-service 只经版本化、受认证协议访问 Canvas：令牌/协议头、稳定错误映射、
 * 下游不可用与超时的可诊断降级。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasMcpClient } from "./canvas-client.js";

const closers: Array<() => Promise<void>> = [];
const TOKEN = "mcp-token";

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      handler(req, res, text ? JSON.parse(text) : {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

describe("Canvas 内部 MCP client", () => {
  it("携带协议版本头与服务令牌", async () => {
    const seen: Record<string, string | string[] | undefined> = {};
    const baseUrl = await start((req, res) => {
      Object.assign(seen, req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, canvasId: "c", nodes: [] }));
    });
    const client = createCanvasMcpClient({ baseUrl, serviceToken: TOKEN });
    const result = await client.listModelNodes({ canvasId: "c" });
    expect(result).toEqual({ ok: true, canvasId: "c", nodes: [] });
    expect(seen["x-woohaa3-mcp-protocol-version"]).toBe("1");
    expect(seen["x-woohaa3-service-token"]).toBe(TOKEN);
  });

  it("把下游错误码原样映射", async () => {
    const baseUrl = await start((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "canvas-not-found", error: "无画布" }));
    });
    const client = createCanvasMcpClient({ baseUrl, serviceToken: TOKEN });
    const result = await client.getModelNode({ canvasId: "c", nodeId: "n" });
    expect(result).toMatchObject({ ok: false, code: "canvas-not-found" });
  });

  it("下游不可达时返回可诊断 unavailable", async () => {
    const client = createCanvasMcpClient({ baseUrl: "http://127.0.0.1:1", serviceToken: TOKEN, timeoutMs: 200 });
    const result = await client.listModelNodes({ canvasId: "c" });
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("ready 探针在协议头被接受时为 true，在未认证时为 false", async () => {
    const baseUrl = await start((req, res) => {
      if (req.headers["x-woohaa3-service-token"] !== TOKEN) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "unauthorized" }));
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "malformed-request" }));
    });
    const good = createCanvasMcpClient({ baseUrl, serviceToken: TOKEN });
    expect(await good.ready()).toEqual({ ready: true });
    const bad = createCanvasMcpClient({ baseUrl, serviceToken: "wrong" });
    expect((await bad.ready()).ready).toBe(false);
  });

  it("批量模型能力走 /models/{nodes,validate,submit} 三条内部路径", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const baseUrl = await start((req, res, body) => {
      seen.push({ path: req.url ?? "", body: body as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, canvasId: "c", requestId: "b1", commandId: "cmd", revision: 1, nodes: [] }));
    });
    const client = createCanvasMcpClient({ baseUrl, serviceToken: TOKEN });
    await client.getModelNodes?.({ canvasId: "c", nodeIds: ["m1", "m2"], includeSource: true });
    const batch = { canvasId: "c", requestId: "b1", items: [{ nodeId: "m1", source: "export default {}" }] };
    await client.validateScripts?.(batch);
    await client.submitScripts?.(batch);
    expect(seen.map((entry) => entry.path)).toEqual([
      "/internal/v1/model-mcp/models/nodes",
      "/internal/v1/model-mcp/models/validate",
      "/internal/v1/model-mcp/models/submit"
    ]);
    expect(seen[0]?.body).toMatchObject({ canvasId: "c", nodeIds: ["m1", "m2"], includeSource: true });
    expect(seen[1]?.body).toMatchObject({ requestId: "b1" });
    expect(seen[2]?.body).toMatchObject({ items: [{ nodeId: "m1", source: "export default {}" }] });
  });

  it("批量模型能力：非法入参在发请求前返回 malformed-request", async () => {
    let calls = 0;
    const baseUrl = await start((_req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const client = createCanvasMcpClient({ baseUrl, serviceToken: TOKEN });
    const result = await client.getModelNodes?.({ canvasId: "c", nodeIds: [] });
    expect(result).toMatchObject({ ok: false, code: "malformed-request" });
    expect(calls).toBe(0);
  });
});
