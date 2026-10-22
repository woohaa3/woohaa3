/**
 * MCP 工具结果与身份契约测试
 * （change: add-agent-canvas-authoring-mcp，任务 7.1–7.4；
 *  change: 2026-10-07-remove-residual-compatibility —— 删除 orchestrate_canvas 与 text JSON 兼容）。
 *
 * 覆盖：模型工具返回 structuredContent、set_node_prompt 走统一 planner、指南示例可用。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "./mcp-http.js";
import type { ModelMcpToolService } from "./mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function agentClient(overrides: Partial<AgentCanvasClient> = {}): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: true, graph: { protocolVersion: 1, canvasId: "c1", title: "t", revision: 1, nodes: [], edges: [], truncated: false } }; },
    async getChanges() { return { ok: true, delta: { protocolVersion: 1, canvasId: "c1", fromRevision: 1, currentRevision: 1, nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [], resetRequired: false } }; },
    async applyPlan(input) { return { ok: true, canvasId: input.canvasId ?? "c1", requestId: input.requestId, revision: 2, duplicate: false, noop: false, nodes: [], edges: [] }; },
    ...overrides
  };
}

async function start(options: { service?: ModelMcpToolService; agent?: AgentCanvasClient } = {}) {
  const handler = createModelMcpHttpHandler({
    ...(options.service ? { service: options.service } : {}),
    ...(options.agent ? { agentAuthoring: { client: options.agent } } : {})
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function rpc(base: string, body: unknown) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as { result: Record<string, unknown> };
}

async function callTool(base: string, name: string, args: Record<string, unknown>) {
  return (await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).result as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

describe("模型工具结果契约", () => {
  it("keeps rejected submissions valid MCP even when upstream omits its message", async () => {
    const base = await start({ service: {
      async getModelNode() { return { ok: false, code: "unknown-node", message: "missing" }; },
      async submitScript() { return { ok: false, code: "model-script-validate" } as never; }
    } });
    const result = await callTool(base, "submit_model_script", { canvasId: "c1", nodeId: "n1", source: "scene.box({});", requestId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "model-script-validate" });
    expect(result.content.every(item => typeof item.text === "string" && item.text.length > 0)).toBe(true);
  });
  it("get_model_node 的文本也包含完整脚本与并发哈希，兼容只转发 content 的客户端", async () => {
    const base = await start({
      service: {
        async getModelNode(input) {
          return { ok: true, ...input, title: "角色", prompt: "银色骑士", source: "scene.box({});", modelContentHash: "hash-current", references: [], cameras: [] };
        },
        async submitScript(input) { return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c", idempotent: false }; }
      }
    });
    const result = await callTool(base, "get_model_node", { canvasId: "c1", nodeId: "n1" });
    expect(result.structuredContent).toMatchObject({ ok: true, nodeId: "n1" });
    // change: 2026-10-07-remove-residual-compatibility —— text content 不再是完整 JSON。
    expect(() => JSON.parse(result.content[0]!.text)).toThrow();
    expect(result.content[0]!.text).toContain("nodeId=n1");
    expect(JSON.parse(result.content[1]!.text)).toMatchObject({ source: "scene.box({});", modelContentHash: "hash-current" });
  });

  it("失败时返回结构化错误与非 JSON 文本", async () => {
    const base = await start({ service: { async getModelNode() { return { ok: false, code: "unknown-node", message: "不存在" }; }, async submitScript() { return { ok: false, code: "x", message: "x" }; } } });
    const result = await callTool(base, "get_model_node", { canvasId: "c1", nodeId: "n1" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "unknown-node" });
    expect(result.content[0]!.text).toContain("不存在");
  });
});

describe("set_node_prompt（统一 planner）", () => {
  it("走统一 planner 并返回结构化回执", async () => {
    const applies: Array<{ requestId: string; commands: unknown[] }> = [];
    const base = await start({
      agent: agentClient({
        async getGraph() {
          return {
            ok: true,
            graph: {
              protocolVersion: 1,
              canvasId: "c1",
              title: "t",
              revision: 1,
              nodes: [{
                nodeId: "n1",
                kind: "image",
                canonicalType: "image",
                position: { x: 0, y: 0 },
                size: { width: 248, height: 232 },
                affordances: { canSetPrompt: true, canRun: true, canConnect: true, canDelete: true }
              }],
              edges: [],
              truncated: false
            }
          };
        },
        async applyPlan(input) { applies.push(input); return { ok: true, canvasId: "c1", requestId: input.requestId, revision: 5, duplicate: false, noop: false, nodes: [], edges: [] }; }
      }),
      service: { async getModelNode() { return { ok: false, code: "x", message: "x" }; }, async submitScript() { return { ok: false, code: "x", message: "x" }; } }
    });
    const result = await callTool(base, "set_node_prompt", { canvasId: "c1", nodeId: "n1", prompt: "hi", requestId: "req-9" });
    expect(applies[0]?.requestId).toBe("req-9");
    expect(applies[0]?.commands).toEqual([{ type: "nodeData.patch", nodeId: "n1", value: { prompt: "hi" } }]);
    expect(result.structuredContent).toMatchObject({ ok: true, revision: 5 });
  });

  it("缺少 requestId 时被 schema 拒绝（不再回退旧意图命令）", async () => {
    const base = await start({ agent: agentClient() });
    const result = await callTool(base, "set_node_prompt", { canvasId: "c1", nodeId: "n1", prompt: "hi" });
    expect(result.isError).toBe(true);
  });
});

describe("orchestrate_canvas 下线", () => {
  it("工具面不再包含 orchestrate_canvas", async () => {
    const base = await start({
      service: {
        async getModelNode() { return { ok: false, code: "x", message: "x" }; },
        async submitScript() { return { ok: false, code: "x", message: "x" }; }
      }
    });
    const tools = (await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).result.tools as Array<{ name: string }>;
    expect(tools.some((tool) => tool.name === "orchestrate_canvas")).toBe(false);
  });
});

describe("指南（任务 7.4）", () => {
  it("get_agent_canvas_guide 返回推荐调用顺序与最小示例", async () => {
    const base = await start({ agent: agentClient() });
    const result = await callTool(base, "get_agent_canvas_guide", {});
    const guide = result.structuredContent?.guide as string;
    expect(guide).toContain("validate_canvas_plan");
    expect(guide).toContain("apply_canvas_plan");
    expect(guide).toContain("requestId");
    expect(guide).toContain("run_canvas_node");
  });
});
