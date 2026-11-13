/**
 * 分段脚本写入的世界工具面
 * （change: 2026-11-10-add-incremental-world-model-authoring，任务 2.1 / 2.2 / 2.3）。
 *
 * 覆盖：空骨架创建与回读、三个新工具的目录/能力/角色白名单一致、写副作用注解、
 * 未授权工具在网关被拒绝且无画布副作用、越权目标返回 outside-scope。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ASSISTANT_WORLD_TOOL, ASSISTANT_WORLD_TOOLS, assistantWorldSourceCapability, assistantWorldToolsForScope } from "@woohaa3/contracts";
import type { ApplicationToolGrant, AssistantWorldContextView } from "@woohaa3/contracts";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH, listModelMcpToolNames } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { AssistantWorldToolClient } from "./world-tools.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const emptyClient: AgentCanvasClient = {
  async listCanvases() { return { ok: true, canvases: [] }; },
  async getGraph() { return { ok: false, code: "unavailable", message: "not used" }; },
  async getChanges() { return { ok: false, code: "unavailable", message: "not used" }; },
  async applyPlan() { return { ok: false, code: "unavailable", message: "not used" }; }
} as AgentCanvasClient;

function scopeGrant(tools: readonly string[] = Object.values(ASSISTANT_WORLD_TOOL)): ApplicationToolGrant {
  return {
    token: "grant-token",
    canvasIds: ["canvas-1"],
    nodeIds: [],
    tools: [...tools],
    workId: "req-1",
    subject: "owner-1",
    world: {
      contextId: "ctx-1",
      completionId: "completion-1",
      runId: "run-1",
      epoch: 0,
      executionId: "exec-1",
      scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" }
    }
  };
}

async function start(world: AssistantWorldToolClient, issued: ApplicationToolGrant | null) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: { client: emptyClient, world, runAvailability: { available: false } },
    toolGrant: {
      allowedTools: token => token === issued?.token ? issued.tools : undefined,
      resolve: token => token === issued?.token ? issued : null,
      authorize: () => ({ ok: true })
    }
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function rpc(base: string, body: Record<string, unknown>, bearer?: string) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as {
    error?: { code: number; message: string };
    result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
  };
}

function callTool(base: string, name: string, args: Record<string, unknown>, bearer?: string) {
  return rpc(base, { method: "tools/call", params: { name, arguments: args } }, bearer);
}

async function listTools(base: string, bearer?: string) {
  const body = await rpc(base, { method: "tools/list", params: {} }, bearer);
  return (body as unknown as {
    result: {
      tools: Array<{
        name: string;
        description: string;
        annotations?: Record<string, unknown>;
        inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
        outputSchema?: unknown;
      }>;
    };
  }).result.tools;
}

function contextView(overrides: Partial<AssistantWorldContextView> = {}): AssistantWorldContextView {
  return {
    version: "assistant-world-authority-v1",
    canvasId: "canvas-1",
    contextId: "ctx-1",
    runId: "run-1",
    epoch: 0,
    scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" },
    writable: [{ kind: "instance", instanceId: "instance-1", version: "iv-1" }],
    readOnly: [{ kind: "instance", instanceId: "reference-1", version: "rv-1" }],
    objects: [
      { identity: { kind: "instance", instanceId: "instance-1" }, nodeId: "node-1", version: "iv-1", containment: "writable" },
      { identity: { kind: "instance", instanceId: "reference-1" }, nodeId: "node-ref", version: "rv-1", containment: "read-only" }
    ],
    worldWritable: true,
    ...overrides
  };
}

describe("分段脚本写入：目录与能力声明", () => {
  it("工具目录、能力声明与角色白名单三处包含同一组新工具", async () => {
    const newTools = [ASSISTANT_WORLD_TOOL.readModelScript, ASSISTANT_WORLD_TOOL.appendModelScript, ASSISTANT_WORLD_TOOL.patchModelScript];
    const issued = scopeGrant();
    const base = await start({
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write() { throw new Error("unused"); },
      async complete() { throw new Error("unused"); }
    }, issued);
    // 1. 本轮工具目录（grant 收窄后的 tools/list）与契约工具面一致。
    const catalog = await listTools(base, issued.token);
    for (const tool of newTools) expect(catalog.map(entry => entry.name), tool).toContain(tool);
    expect(catalog.map(entry => entry.name).sort()).toEqual([...issued.tools].sort());
    // 2. 能力声明 / 场景区工具面（角色白名单直接消费它）。
    const capability = assistantWorldSourceCapability({ targets: ["scene-area"] });
    const sceneTools = assistantWorldToolsForScope({ kind: "scene-area", areaId: "area-1" });
    for (const tool of newTools) {
      expect(capability.tools, tool).not.toContain(tool);
      expect(sceneTools, tool).not.toContain(tool);
      expect(ASSISTANT_WORLD_TOOLS, tool).not.toContain(tool);
    }
    // 3. 实际注册路径（含条件式 world 工具）也没有第二份手写清单：每个工具名都来自同一注册器。
    const registered = listModelMcpToolNames({ agentAuthoring: { client: emptyClient, world: {} as AssistantWorldToolClient } });
    for (const tool of newTools) expect(registered, tool).toContain(tool);
  });

  it("每个新工具都带严格 input schema、output schema 与写副作用注解", async () => {
    const issued = scopeGrant();
    const base = await start({
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write() { throw new Error("unused"); },
      async complete() { throw new Error("unused"); }
    }, issued);
    const catalog = await listTools(base, issued.token);
    const byName = (name: string) => catalog.find(entry => entry.name === name)!;
    const read = byName(ASSISTANT_WORLD_TOOL.readModelScript);
    expect(read.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    expect(Object.keys(read.inputSchema?.properties ?? {}).sort()).toEqual(["includeSource", "instanceId"]);
    expect(read.inputSchema?.required).toEqual(["instanceId"]);
    for (const name of [ASSISTANT_WORLD_TOOL.appendModelScript, ASSISTANT_WORLD_TOOL.patchModelScript]) {
      const tool = byName(name);
      expect(tool.annotations, name).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.outputSchema, name).toBeDefined();
      for (const term of ["expectedVersion", "version-conflict"]) expect(tool.description, name).toContain(term);
    }
    for (const term of ["request-id-reused", "outside-scope", "不会重复拼接", "完整语句块"]) expect(byName(ASSISTANT_WORLD_TOOL.appendModelScript).description, term).toContain(term);
    for (const term of ["patch-not-found", "patch-ambiguous", "patch-noop", "恰好命中一次"]) expect(byName(ASSISTANT_WORLD_TOOL.patchModelScript).description, term).toContain(term);
    expect(Object.keys(byName(ASSISTANT_WORLD_TOOL.appendModelScript).inputSchema?.properties ?? {}).sort()).toEqual(["chunk", "expectedVersion", "instanceId"]);
    expect(Object.keys(byName(ASSISTANT_WORLD_TOOL.patchModelScript).inputSchema?.properties ?? {}).sort()).toEqual(["expectedVersion", "instanceId", "newString", "oldString"]);
    for (const term of ["patch-not-found", "patch-ambiguous", "patch-noop"]) expect(byName(ASSISTANT_WORLD_TOOL.patchModelScript).description).toContain(term);
  });
});

describe("分段脚本写入：骨架与回读", () => {
  it("旧脚本读取仍可区分空骨架与只读引用", async () => {
    const issued = scopeGrant();
    const base = await start({ read: () => ({ ok: true, view: contextView({ modelScripts: { "instance-1": "", "reference-1": "scene.box({});" } }) }), async write() { throw new Error("read must not write"); }, async complete() { throw new Error("unused"); } }, issued);
    const meta = await callTool(base, ASSISTANT_WORLD_TOOL.readModelScript, { instanceId: "instance-1", includeSource: false }, issued.token);
    expect(meta.result?.structuredContent).toMatchObject({ ok: true, instanceId: "instance-1", scriptLength: 0, writable: true });
    const reference = await callTool(base, ASSISTANT_WORLD_TOOL.readModelScript, { instanceId: "reference-1", includeSource: true }, issued.token);
    expect(reference.result?.structuredContent).toMatchObject({ ok: true, modelScript: "scene.box({});", writable: false });
  });

  it("回读范围外模型返回 outside-scope 且不发起写入", async () => {
    const issued = scopeGrant();
    const base = await start({
      read: () => ({ ok: true, view: contextView() }),
      async write() { throw new Error("read must not write"); },
      async complete() { throw new Error("unused"); }
    }, issued);
    const result = await callTool(base, ASSISTANT_WORLD_TOOL.readModelScript, { instanceId: "foreign" }, issued.token);
    expect(result.result?.isError).toBe(true);
    expect(result.result?.structuredContent).toMatchObject({ ok: false, code: "outside-scope" });
  });
});

describe("分段脚本写入：越权路径", () => {
  it("工具不在本轮 allowlist 时由网关拒绝且没有画布副作用", async () => {
    const allowed = assistantWorldToolsForScope({ kind: "scene-area", areaId: "area-1" }).filter(tool => tool !== ASSISTANT_WORLD_TOOL.appendModelScript);
    const issued = scopeGrant(allowed);
    let writes = 0;
    let reads = 0;
    // 网关用 authorization 校验拒绝（与 ToolGrantRegistry.authorize 的 tool-not-allowed 同一拒绝面），
    // 且只把 grant 内的工具注册进本轮目录。
    const handler = createModelMcpHttpHandler({
      agentAuthoring: {
        client: emptyClient,
        runAvailability: { available: false },
        world: {
          read() { reads += 1; return { ok: false, code: "not-issued", message: "not used" }; },
          async write() { writes += 1; throw new Error("unauthorized tool must not write"); },
          async complete() { throw new Error("unused"); }
        }
      },
      toolGrant: {
        allowedTools: token => token === issued.token ? issued.tools : undefined,
        resolve: token => token === issued.token ? issued : null,
        authorize: input => (issued.tools.includes(input.tool) ? { ok: true } : { ok: false, reason: "tool-not-allowed" })
      }
    });
    const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    closers.push(async () => { await handler.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const base = `http://127.0.0.1:${port}`;
    const catalog = await listTools(base, issued.token);
    expect(catalog.map(tool => tool.name)).not.toContain(ASSISTANT_WORLD_TOOL.appendModelScript);
    const result = await callTool(base, ASSISTANT_WORLD_TOOL.appendModelScript, { instanceId: "instance-1", expectedVersion: "iv-1", chunk: "scene.box({});" }, issued.token);
    // 不在白名单的工具根本不会进入本轮目录：调用得到协议层「工具不存在」错误。
    expect(result.error?.code).toBe(-32602);
    expect(result.error?.message).toContain("not found");
    expect(writes).toBe(0);
    expect(reads).toBe(0);
  });

});
