/**
 * Agent Canvas MCP 工具面测试
 * （change: add-agent-canvas-authoring-mcp，任务 1.4 / 5.2 / 5.3 / 5.4 / 5.5）。
 *
 * 覆盖：工具 annotations/schema、capabilities、structuredContent、简单工具与 apply_canvas_plan
 * 生成等价命令、validationToken 绑定与过期、错误结构化。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient, AgentApplyClientInput } from "../downstream/agent-canvas-client.js";
import type { AgentCanvasGraph, CanvasCommand } from "@woohaa3/contracts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

type Recorder = { applies: AgentApplyClientInput[] };

function fakeAgentClient(graph: AgentCanvasGraph, recorder: Recorder, options: { apply?: (input: AgentApplyClientInput) => unknown } = {}): AgentCanvasClient {
  return {
    async listCanvases() {
      return { ok: true, canvases: [{ canvasId: graph.canvasId, title: graph.title, revision: graph.revision, updatedAt: "x", nodeCount: graph.nodes.length }] };
    },
    async getGraph() {
      return { ok: true, graph };
    },
    async getChanges() {
      return { ok: true, delta: { protocolVersion: 1, canvasId: graph.canvasId, fromRevision: graph.revision, currentRevision: graph.revision, nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [], resetRequired: false } };
    },
    async applyPlan(input) {
      recorder.applies.push(input);
      if (options.apply) return options.apply(input) as never;
      return { ok: true, canvasId: input.canvasId ?? graph.canvasId, requestId: input.requestId, revision: graph.revision + 1, duplicate: false, noop: false, nodes: [], edges: [] };
    }
  };
}

function sampleGraph(): AgentCanvasGraph {
  return {
    protocolVersion: 1,
    canvasId: "c1",
    title: "画布",
    revision: 5,
    nodes: [
      {
        nodeId: "text-1",
        kind: "text",
        canonicalType: "text",
        position: { x: 0, y: 0 },
        size: { width: 248, height: 232 },
        prompt: "hi",
        affordances: { canSetPrompt: true, canRun: true, canConnect: true, canDelete: true }
      }
    ],
    edges: [],
    truncated: false
  };
}

async function start(graph = sampleGraph(), recorder: Recorder = { applies: [] }, options: { apply?: (input: AgentApplyClientInput) => unknown } = {}) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: { client: fakeAgentClient(graph, recorder, options) }
  });
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
  return { base: `http://127.0.0.1:${port}`, recorder };
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
  const body = JSON.parse(payload) as { result?: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } };
  return body.result!;
}

async function listTools(base: string) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return (JSON.parse(payload) as { result: { tools: Array<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown; inputSchema?: { properties?: Record<string, unknown> } }> } }).result.tools;
}

describe("Agent Canvas 工具元数据（任务 1.4）", () => {
  it("注册全部 Agent 工具并声明 annotations", async () => {
    const { base } = await start();
    const tools = await listTools(base);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "get_canvas_capabilities",
      "list_canvases",
      "get_canvas_graph",
      "get_canvas_changes",
      "validate_canvas_plan",
      "apply_canvas_plan",
      "create_canvas_node",
      "connect_canvas_nodes",
      "delete_canvas_entities"
    ]));
    const readOnly = tools.find((tool) => tool.name === "get_canvas_graph");
    expect(readOnly?.annotations).toMatchObject({ readOnlyHint: true });
    const destructive = tools.find((tool) => tool.name === "delete_canvas_entities");
    expect(destructive?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    const idempotent = tools.find((tool) => tool.name === "create_canvas_node");
    expect(idempotent?.annotations).toMatchObject({ idempotentHint: true });
    // 严格 schema：create 不接受原始 nodeData/type。
    expect(Object.keys(idempotent?.inputSchema?.properties ?? {})).not.toContain("nodeData");
    expect(Object.keys(idempotent?.inputSchema?.properties ?? {})).not.toContain("type");
  });
});

describe("读取工具 structuredContent（任务 5.1 / 5.2）", () => {
  it("capabilities 返回节点种类、limits 与 run 可用性", async () => {
    const { base } = await start();
    const result = await callTool(base, "get_canvas_capabilities", { canvasId: "c1" });
    expect(result.structuredContent).toMatchObject({ protocolVersion: 1 });
    expect(result.structuredContent?.nodeKinds).toBeDefined();
    expect(result.structuredContent?.limits).toBeDefined();
    expect(result.structuredContent?.run).toMatchObject({ available: false });
    expect(result.structuredContent?.recommendedFlow).toContain("import_generated_image");
  });

  it("graph 返回 structuredContent 与简短 text 摘要", async () => {
    const { base } = await start();
    const result = await callTool(base, "get_canvas_graph", { canvasId: "c1" });
    expect(result.structuredContent).toMatchObject({ canvasId: "c1", revision: 5 });
    expect(result.content[0]?.text).toContain("revision 5");
  });

  // ---- 任务 2.2：真实 MCP tools/call 的结构化输出通过声明 schema ----

  it("get_canvas_graph / get_canvas_changes 的真实 MCP 输出通过 outputSchema 校验", async () => {
    const { base } = await start();
    // 真实传输：MCP server 会用 `outputSchema` 校验 `structuredContent`，不符即 isError。
    // 根因（本 change）：client 曾剥离 `protocolVersion`，使 graph/changes 输出 schema 校验失败。
    const graph = await callTool(base, "get_canvas_graph", { canvasId: "c1" });
    expect(graph.isError).toBeFalsy();
    expect(typeof graph.structuredContent?.protocolVersion).toBe("number");
    expect(typeof graph.structuredContent?.canvasId).toBe("string");
    expect(typeof graph.structuredContent?.revision).toBe("number");
    expect(Array.isArray(graph.structuredContent?.nodes)).toBe(true);
    expect(Array.isArray(graph.structuredContent?.edges)).toBe(true);

    const changes = await callTool(base, "get_canvas_changes", { canvasId: "c1", sinceRevision: 0 });
    expect(changes.isError).toBeFalsy();
    expect(typeof changes.structuredContent?.protocolVersion).toBe("number");
    expect(typeof changes.structuredContent?.canvasId).toBe("string");
    expect(typeof changes.structuredContent?.currentRevision).toBe("number");
    expect(typeof changes.structuredContent?.resetRequired).toBe("boolean");
  });
});

describe("validate/apply 与 token（任务 5.4 / design D7）", () => {
  it("validate 不调用 apply 且返回 token", async () => {
    const { base, recorder } = await start();
    const result = await callTool(base, "validate_canvas_plan", {
      canvasId: "c1",
      operations: [{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 5000, y: 0 } } }]
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.validationToken).toBeDefined();
    expect(recorder.applies).toHaveLength(0);
  });

  it("带有效 token 的 apply 成功", async () => {
    const { base, recorder } = await start();
    const validated = await callTool(base, "validate_canvas_plan", {
      canvasId: "c1",
      operations: [{ op: "set_prompt", target: { nodeId: "text-1" }, prompt: "draw" }]
    });
    const token = validated.structuredContent?.validationToken as string;
    const applied = await callTool(base, "apply_canvas_plan", {
      canvasId: "c1",
      requestId: "req-1",
      validationToken: token,
      operations: [{ op: "set_prompt", target: { nodeId: "text-1" }, prompt: "draw" }]
    });
    expect(applied.isError).toBeFalsy();
    expect(applied.structuredContent).toMatchObject({ ok: true, requestId: "req-1" });
    expect(recorder.applies[0]?.commands).toEqual([{ type: "nodeData.patch", nodeId: "text-1", value: { prompt: "draw" } }]);
  });

  it("basisRevision 变化时 token 过期返回 plan-stale", async () => {
    let revision = 5;
    const graph = sampleGraph();
    const recorder: Recorder = { applies: [] };
    const client: AgentCanvasClient = {
      async listCanvases() { return { ok: true, canvases: [] }; },
      async getGraph() { return { ok: true, graph: { ...graph, revision } }; },
      async getChanges() { return { ok: true, delta: { protocolVersion: 1, canvasId: "c1", fromRevision: revision, currentRevision: revision, nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [], resetRequired: false } }; },
      async applyPlan(input) { recorder.applies.push(input); return { ok: true, canvasId: "c1", requestId: input.requestId, revision, duplicate: false, noop: false, nodes: [], edges: [] }; }
    };
    const handler = createModelMcpHttpHandler({ agentAuthoring: { client } });
    const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    closers.push(async () => { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const base = `http://127.0.0.1:${port}`;

    const validated = await callTool(base, "validate_canvas_plan", {
      canvasId: "c1",
      operations: [{ op: "set_prompt", target: { nodeId: "text-1" }, prompt: "draw" }]
    });
    const token = validated.structuredContent?.validationToken as string;
    revision = 6;
    const applied = await callTool(base, "apply_canvas_plan", {
      canvasId: "c1",
      requestId: "req-2",
      validationToken: token,
      operations: [{ op: "set_prompt", target: { nodeId: "text-1" }, prompt: "draw" }]
    });
    expect(applied.isError).toBe(true);
    expect(applied.structuredContent).toMatchObject({ ok: false, code: "plan-stale" });
  });
});

describe("简单工具与 plan 等价（任务 5.3）", () => {
  it("create_canvas_node 生成与等价 apply_canvas_plan 相同的命令结构", async () => {
    const { base, recorder } = await start();
    await callTool(base, "create_canvas_node", {
      canvasId: "c1",
      requestId: "req-create",
      kind: "image",
      prompt: "a cat",
      placement: { mode: "absolute", position: { x: 4000, y: 0 } }
    });
    const simple = recorder.applies.at(-1)!;

    const planRecorder: Recorder = { applies: [] };
    const plan = await start(sampleGraph(), planRecorder);
    await callTool(plan.base, "apply_canvas_plan", {
      canvasId: "c1",
      requestId: "req-create",
      operations: [{ op: "create_node", ref: "n0", kind: "image", prompt: "a cat", placement: { mode: "absolute", position: { x: 4000, y: 0 } } }]
    });
    const full = planRecorder.applies.at(-1)!;

    // 同一 requestId + 同一意图 ⇒ 相同命令（含确定性实体 ID）。
    expect(simple.commands).toEqual(full.commands);
  });

  it("delete_canvas_entities 编译为单个 node.remove", async () => {
    const { base, recorder } = await start();
    await callTool(base, "delete_canvas_entities", { canvasId: "c1", requestId: "req-del", nodeIds: ["text-1"] });
    expect(recorder.applies[0]?.commands).toEqual([{ type: "node.remove", nodeIds: ["text-1"] }] satisfies CanvasCommand[]);
  });
});

describe("结构化错误（任务 5.5）", () => {
  it("下游失败映射为可修复的结构化错误", async () => {
    const { base } = await start(sampleGraph(), { applies: [] }, {
      apply: () => ({ ok: false, code: "precondition-failed", message: "prompt 已变化", currentRevision: 9, preconditionIndex: 0 })
    });
    const result = await callTool(base, "apply_canvas_plan", {
      canvasId: "c1",
      requestId: "req-3",
      operations: [{ op: "set_prompt", target: { nodeId: "text-1" }, prompt: "draw" }]
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "precondition-failed", currentRevision: 9 });
  });

  it("未知节点引用返回可定位错误", async () => {
    const { base } = await start();
    const result = await callTool(base, "apply_canvas_plan", {
      canvasId: "c1",
      requestId: "req-4",
      operations: [{ op: "set_prompt", target: { nodeId: "ghost" }, prompt: "x" }]
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "unknown-node" });
  });
});
