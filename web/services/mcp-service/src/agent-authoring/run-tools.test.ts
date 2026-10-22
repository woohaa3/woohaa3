/**
 * Agent run 工具与审计测试
 * （change: add-agent-canvas-authoring-mcp，任务 6.2–6.5 / 7.5）。
 *
 * 覆盖：run/status/cancel/output 工具注册与 structuredContent、run 不可用时降级、
 * 审计字段白名单（不落 prompt/令牌/URL）。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { AgentAuditEvent } from "./tools.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function baseClient(overrides: Partial<AgentCanvasClient> = {}): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: true, graph: { protocolVersion: 1, canvasId: "c1", title: "t", revision: 1, nodes: [], edges: [], truncated: false } }; },
    async getChanges() { return { ok: true, delta: { protocolVersion: 1, canvasId: "c1", fromRevision: 1, currentRevision: 1, nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [], resetRequired: false } }; },
    async applyPlan(input) { return { ok: true, canvasId: input.canvasId ?? "c1", requestId: input.requestId, revision: 1, duplicate: false, noop: false, nodes: [], edges: [] }; },
    async runNode(input) { return { ok: true, canvasId: "c1", nodeId: input.nodeId, runId: "run-default", jobId: "job-default", state: "accepted" }; },
    async getRun(input) { return { ok: true, view: { protocolVersion: 1, canvasId: "c1", nodeId: input.nodeId, runId: input.runId, jobId: "j1", phase: "running", stale: false } }; },
    async cancelRun(input) { return { ok: true, canvasId: "c1", nodeId: input.nodeId, runId: input.runId, state: "cancel-requested" }; },
    async getOutput(input) { return { ok: true, canvasId: "c1", nodeId: input.nodeId, runId: input.runId, view: { available: false, reason: "no-output", message: "无输出" } }; },
    ...overrides
  };
}

async function start(client: AgentCanvasClient, options: { audit?: (e: AgentAuditEvent) => void; runAvailable?: boolean } = {}) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: {
      client,
      ...(options.runAvailable === false
        ? { runAvailability: { available: false, reason: "disabled" } }
        : { runAvailability: { available: true } }),
      ...(options.audit ? { audit: options.audit } : {})
    }
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function callTool(base: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return (JSON.parse(payload) as { result: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } }).result;
}

async function listToolNames(base: string): Promise<string[]> {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return ((JSON.parse(payload) as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name);
}

describe("Agent run 工具（任务 6.2–6.5）", () => {
  it("run 可用时注册 run/status/cancel/output", async () => {
    const base = await start(baseClient());
    const names = await listToolNames(base);
    expect(names).toEqual(expect.arrayContaining(["run_canvas_node", "get_canvas_run", "cancel_canvas_run", "get_node_output"]));
  });

  it("run 不可用时按 capability 降级（不注册 run 工具）", async () => {
    const base = await start(baseClient(), { runAvailable: false });
    const names = await listToolNames(base);
    expect(names).not.toContain("run_canvas_node");
    expect(names).toContain("get_canvas_capabilities");
  });

  it("run_canvas_node 返回 structuredContent 与 runId", async () => {
    const client = baseClient({ async runNode(input) { return { ok: true as const, canvasId: "c1", nodeId: input.nodeId, runId: "run-xyz", jobId: "job-xyz", state: "accepted" as const }; } });
    const base = await start(client);
    const result = await callTool(base, "run_canvas_node", { canvasId: "c1", requestId: "req-1", nodeId: "img-1" });
    expect(result.structuredContent).toMatchObject({ ok: true, runId: "run-xyz" });
  });

  it("get_canvas_run 暴露 phase/stale", async () => {
    const client = baseClient({ async getRun() { return { ok: true as const, view: { protocolVersion: 1, canvasId: "c1", nodeId: "img-1", runId: "r1", jobId: "j1", phase: "running" as const, stale: false } }; } });
    const base = await start(client);
    const result = await callTool(base, "get_canvas_run", { canvasId: "c1", nodeId: "img-1", runId: "r1" });
    expect(result.structuredContent).toMatchObject({ phase: "running", stale: false });
  });

  it("get_node_output 返回媒体同源引用", async () => {
    const client = baseClient({ async getOutput() { return { ok: true as const, canvasId: "c1", nodeId: "img-1", runId: "r1", view: { available: true as const, output: { kind: "image" as const, runId: "r1", url: "/api/media/sha256-abc", contentType: "image/png", size: 10, provenance: { canvasId: "c1", nodeId: "img-1", runId: "r1", jobId: "j1" } } } }; } });
    const base = await start(client);
    const result = await callTool(base, "get_node_output", { canvasId: "c1", nodeId: "img-1", runId: "r1" });
    expect(result.structuredContent).toMatchObject({ available: true });
    expect(JSON.stringify(result.structuredContent)).toContain("/api/media/");
  });
});

describe("安全审计（任务 7.5）", () => {
  it("写工具记录白名单字段且不含 prompt", async () => {
    const events: AgentAuditEvent[] = [];
    const base = await start(baseClient(), { audit: (event) => events.push(event) });
    await callTool(base, "create_canvas_node", {
      canvasId: "c1",
      requestId: "req-secret",
      kind: "image",
      prompt: "SECRET-PROMPT-TEXT"
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({ event: "agent-tool", tool: "create_canvas_node", canvasId: "c1", requestId: "req-secret" });
    expect(typeof event.latencyMs).toBe("number");
    expect(event.revision).toBe(1);
    // 审计对象结构上不含 prompt 正文。
    expect(JSON.stringify(event)).not.toContain("SECRET-PROMPT-TEXT");
    expect(Object.keys(event)).not.toContain("prompt");
  });

  it("run 工具记录 tool/latency 且不含 prompt", async () => {
    const events: AgentAuditEvent[] = [];
    const client = baseClient({ async runNode(input) { return { ok: true as const, canvasId: "c1", nodeId: input.nodeId, runId: "r", jobId: "j", state: "accepted" as const }; } });
    const base = await start(client, { audit: (event) => events.push(event) });
    await callTool(base, "run_canvas_node", { canvasId: "c1", requestId: "req-run", nodeId: "img-1", prompt: "SECRET-TOKEN-abc" });
    expect(events[0]).toMatchObject({ tool: "run_canvas_node", canvasId: "c1" });
    expect(JSON.stringify(events[0])).not.toContain("SECRET-TOKEN-abc");
  });
});
