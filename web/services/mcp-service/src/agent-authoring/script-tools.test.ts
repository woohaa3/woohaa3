/**
 * Canvas Script MCP 工具面测试
 * （change: 2026-10-13-add-canvas-script-authoring，任务 4.3 / 4.4 / 4.6）。
 *
 * 经**真实 MCP Streamable HTTP** 覆盖：
 * - `get_canvas_script_api` / `validate_canvas_script` / `submit_canvas_script` 注册、严格 input
 *   schema 与 annotations（validate/get 只读，submit 保守标记 destructive 且幂等）；
 * - capabilities.script 投影与脚本优先的 recommendedFlow，移除 JSON plan 提交；
 * - 下游能力面缺失时明确 `script-unavailable`，不静默替代；
 * - 工具事件/文本摘要不回显源码。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { CanvasScriptSubmitReceipt, CanvasScriptValidateReceipt } from "@woohaa3/contracts";
import type { AgentAuditEvent } from "./tool-policy.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const VERSION = "woohaa-canvas-js-v1";
const CANVAS = "c1";
const SOURCE = `canvas.node("text", { key: "t", title: "场景", prompt: "一只猫" });`;

function validateReceipt(overrides: Partial<CanvasScriptValidateReceipt> = {}): CanvasScriptValidateReceipt {
  return {
    ok: true,
    protocolVersion: 1,
    version: VERSION,
    canvasId: CANVAS,
    basisRevision: 5,
    normalized: [],
    refs: { t: "text-1" },
    warnings: [],
    predicted: { t: { x: 0, y: 0 } },
    ...overrides
  };
}

function submitReceipt(overrides: Partial<CanvasScriptSubmitReceipt> = {}): CanvasScriptSubmitReceipt {
  return {
    ok: true,
    protocolVersion: 1,
    version: VERSION,
    canvasId: CANVAS,
    requestId: "req-1",
    submissionHash: "a".repeat(64),
    revision: 6,
    duplicate: false,
    noop: false,
    refs: { t: "text-1" },
    nodes: [],
    edges: [],
    deletedNodeIds: [],
    deletedEdgeIds: [],
    ...overrides
  };
}

/** 脚本能力面可注入的 client；默认三项都装配。 */
function scriptClient(overrides: Partial<AgentCanvasClient> = {}): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: true, graph: { protocolVersion: 1, canvasId: CANVAS, title: "t", revision: 5, nodes: [], edges: [], truncated: false } }; },
    async getChanges() { return { ok: true, delta: { protocolVersion: 1, canvasId: CANVAS, fromRevision: 5, currentRevision: 5, nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [], resetRequired: false } }; },
    async applyPlan(input) { return { ok: true, canvasId: input.canvasId ?? CANVAS, requestId: input.requestId, revision: 6, duplicate: false, noop: false, nodes: [], edges: [] }; },
    async scriptCapability() {
      return {
        ok: true,
        available: true,
        descriptor: { version: VERSION, versions: [VERSION], apiNames: ["node"], limits: { maxOperations: 256 }, example: SOURCE },
        nodeKinds: [{ kind: "text" }]
      };
    },
    async validateScript() { return { ok: true, receipt: validateReceipt() }; },
    async submitScript() { return { ok: true, receipt: submitReceipt() }; },
    ...overrides
  };
}

async function start(
  client: AgentCanvasClient,
  options: { scriptAvailable?: { available: boolean; reason?: string }; audit?: (event: AgentAuditEvent) => void } = {}
) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: {
      client,
      ...(options.scriptAvailable !== undefined ? { scriptAvailability: options.scriptAvailable } : {}),
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

async function rpc(base: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as { result?: unknown; error?: { message?: string } };
}

type ToolResult = { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type ToolMeta = { name: string; annotations?: Record<string, unknown>; inputSchema?: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }; outputSchema?: unknown };

async function listTools(base: string): Promise<ToolMeta[]> {
  const body = await rpc(base, "tools/list", {});
  return (body.result as { tools: ToolMeta[] }).tools;
}

async function callTool(base: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const body = await rpc(base, "tools/call", { name, arguments: args });
  return (body.result as ToolResult | undefined) ?? { content: [{ text: JSON.stringify(body) }], isError: true };
}

describe("脚本工具注册与严格 schema（任务 4.3）", () => {
  it("注册三项脚本工具并声明 annotations", async () => {
    const base = await start(scriptClient());
    const tools = await listTools(base);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      "get_canvas_script_api",
      "validate_canvas_script",
      "submit_canvas_script"
    ]));
    expect(byName.get("get_canvas_script_api")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(byName.get("validate_canvas_script")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // submit 可能删除，保守标记 destructive，同时幂等（同身份重试返回首次回执）。
    expect(byName.get("submit_canvas_script")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it("严格 input schema 只暴露语义字段，不暴露 nodeData/canonical type", async () => {
    const base = await start(scriptClient());
    const tools = await listTools(base);
    const submit = tools.find((tool) => tool.name === "submit_canvas_script")!;
    const properties = Object.keys(submit.inputSchema?.properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(["canvasId", "requestId", "version", "source"]));
    expect(properties).not.toContain("nodeData");
    expect(properties).not.toContain("type");
    expect(properties).not.toContain("principalId");
    // 提交凭证字段已移除：validate 与 submit 都不暴露 validationToken。
    const validate = tools.find((tool) => tool.name === "validate_canvas_script")!;
    expect(Object.keys(validate.inputSchema?.properties ?? {})).not.toContain("validationToken");
    expect(Object.keys(submit.inputSchema?.properties ?? {})).not.toContain("validationToken");
  });

  it("未知字段与未知版本在副作用前被拒绝", async () => {
    const base = await start(scriptClient());
    const unknownField = await callTool(base, "validate_canvas_script", {
      canvasId: CANVAS,
      requestId: "r1",
      version: VERSION,
      source: SOURCE,
      nodeData: { evil: true }
    });
    expect(unknownField.isError).toBe(true);

    const unknownVersion = await callTool(base, "validate_canvas_script", {
      canvasId: CANVAS,
      requestId: "r1",
      version: "woohaa-canvas-js-v99",
      source: SOURCE
    });
    expect(unknownVersion.isError).toBe(true);
  });
});

describe("脚本工具 structuredContent（任务 4.3）", () => {
  it("get_canvas_script_api 返回版本、签名与节点种类", async () => {
    const base = await start(scriptClient());
    const result = await callTool(base, "get_canvas_script_api", { canvasId: CANVAS });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ available: true, version: VERSION });
    expect(result.structuredContent?.apiNames).toContain("node");
    // 只读：无脚本执行、无画布写入。
  });

  it("能力不可用时明确 available:false 与原因", async () => {
    const base = await start(scriptClient({ async scriptCapability() { return { ok: true as const, available: false, reason: "隔离执行器未装配" }; } }));
    const result = await callTool(base, "get_canvas_script_api", { canvasId: CANVAS });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ available: false, reason: "隔离执行器未装配" });
  });

  it("MCP 未接入脚本能力面时返回 script-unavailable", async () => {
    const base = await start(scriptClient({ scriptCapability: undefined, validateScript: undefined, submitScript: undefined }));
    const result = await callTool(base, "get_canvas_script_api", { canvasId: CANVAS });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "script-unavailable" });
  });

  it("validate_canvas_script 转发预检结果，不调用 submit", async () => {
    const calls: string[] = [];
    const base = await start(scriptClient({
      async validateScript(input) { calls.push(`validate:${input.requestId}`); return { ok: true, receipt: validateReceipt() }; },
      async submitScript() { calls.push("submit"); return { ok: true, receipt: submitReceipt() }; }
    }));
    const result = await callTool(base, "validate_canvas_script", { canvasId: CANVAS, requestId: "r1", version: VERSION, source: SOURCE });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, basisRevision: 5 });
    expect(result.structuredContent).not.toHaveProperty("validationToken");
    expect(calls).toEqual(["validate:r1"]);
  });

  it("submit_canvas_script 返回首次回执并标注 duplicate", async () => {
    const base = await start(scriptClient({ async submitScript() { return { ok: true, receipt: submitReceipt({ duplicate: true }) }; } }));
    const result = await callTool(base, "submit_canvas_script", { canvasId: CANVAS, requestId: "req-1", version: VERSION, source: SOURCE });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, requestId: "req-1", revision: 6, duplicate: true });
    expect(result.content[0]?.text).toContain("首次回执");
  });

  it("阶段化错误映射为结构化 isError", async () => {
    const base = await start(scriptClient({
      async validateScript() {
        return { ok: false, error: { code: "script-runtime-error", stage: "compile", message: "语法错误", retryable: false, line: 3, column: 1 } };
      }
    }));
    const result = await callTool(base, "validate_canvas_script", { canvasId: CANVAS, requestId: "r1", version: VERSION, source: SOURCE });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: "script-runtime-error", stage: "compile", line: 3 });
  });
});

describe("capabilities.script 投影与推荐流程（任务 4.4）", () => {
  it("脚本可用时推荐脚本且不注册 JSON plan 提交", async () => {
    const base = await start(scriptClient(), { scriptAvailable: { available: true } });
    const result = await callTool(base, "get_canvas_capabilities", { canvasId: CANVAS });
    expect(result.structuredContent?.script).toMatchObject({
      available: true,
      version: VERSION,
      guideTool: "get_canvas_script_api",
      sourcePersisted: false
    });
    const flow = result.structuredContent?.recommendedFlow as string[];
    // 脚本可用时推荐流程走脚本入口（discover -> script -> run）。
    expect(flow).toEqual(expect.arrayContaining([
      "get_canvas_script_api",
      "validate_canvas_script",
      "submit_canvas_script"
    ]));
    expect(flow.indexOf("validate_canvas_script")).toBeLessThan(flow.indexOf("submit_canvas_script"));
    // tools/list 与推荐流程均不能再暴露 JSON plan 提交。
    const names = (await listTools(base)).map((tool) => tool.name);
    expect(names).not.toContain("apply_canvas_plan");
    expect(flow).not.toContain("apply_canvas_plan");
  });

  it("脚本不可用时明确 reason 并引导读取脚本能力，不回退 JSON 提交", async () => {
    const base = await start(scriptClient({
      async scriptCapability() { return { ok: true, available: false, reason: "本部署未启用" }; }
    }), { scriptAvailable: { available: true } });
    const result = await callTool(base, "get_canvas_capabilities", { canvasId: CANVAS });
    expect(result.structuredContent?.script).toMatchObject({ available: false, reason: "本部署未启用" });
    const flow = result.structuredContent?.recommendedFlow as string[];
    expect(flow).not.toContain("validate_canvas_script");
    expect(flow).toContain("get_canvas_script_api");
    expect(flow).not.toContain("validate_canvas_plan");
    expect(flow).not.toContain("apply_canvas_plan");
    const names = (await listTools(base)).map((tool) => tool.name);
    expect(names).not.toContain("apply_canvas_plan");
  });

  it("能力与脚本 API 同时返回同一个不可用原因，不接受静态可用声明", async () => {
    const base = await start(scriptClient({
      async scriptCapability() { return { ok: true, available: false, reason: "隔离执行器未装配" }; }
    }), { scriptAvailable: { available: true } });
    const caps = await callTool(base, "get_canvas_capabilities", { canvasId: CANVAS });
    const api = await callTool(base, "get_canvas_script_api", { canvasId: CANVAS });
    expect(caps.structuredContent?.script).toEqual(api.structuredContent);
    expect(api.structuredContent).toEqual({ available: false, reason: "隔离执行器未装配" });
    expect(caps.structuredContent?.recommendedFlow).not.toContain("submit_canvas_script");
  });

  it("领域拒绝能力查询时保留授权错误", async () => {
    const base = await start(scriptClient({
      async scriptCapability() { return { ok: false, code: "forbidden", message: "无画布权限" }; }
    }), { scriptAvailable: { available: true } });
    const result = await callTool(base, "get_canvas_capabilities", { canvasId: CANVAS });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "forbidden" });
  });

  it("不注册 orchestrate_canvas 兼容路径", async () => {
    const base = await start(scriptClient());
    const names = (await listTools(base)).map((tool) => tool.name);
    expect(names).not.toContain("orchestrate_canvas");
  });
});

describe("源码不外泄（任务 4.6）", () => {
  it("工具文本摘要与审计事件不含源码标记", async () => {
    const marker = "CANVAS_SCRIPT_SOURCE_MARKER_9f21";
    const events: AgentAuditEvent[] = [];
    const source = `const ${marker} = 1;\ncanvas.node("text", { key: "t", title: "场景" });`;
    const base = await start(scriptClient({
      async submitScript(input) {
        // 下游回执不含源码（只含 digest/refs/摘要）。
        expect(input.source).toContain(marker);
        return { ok: true, receipt: submitReceipt() };
      }
    }), { scriptAvailable: { available: true }, audit: (event) => events.push(event) });

    const result = await callTool(base, "submit_canvas_script", { canvasId: CANVAS, requestId: "req-marker", version: VERSION, source });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).not.toContain(marker);
    expect(JSON.stringify(result.structuredContent)).not.toContain(marker);
    expect(JSON.stringify(events)).not.toContain(marker);
  });
});
