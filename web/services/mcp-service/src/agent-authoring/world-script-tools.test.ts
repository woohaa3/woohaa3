import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assistantWorldToolsForScope, WORLD_RESOURCE_TOOLS } from "@woohaa3/contracts";
import type { ApplicationToolGrant, AssistantWorldContextView } from "@woohaa3/contracts";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH, listModelMcpToolNames } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { AssistantWorldToolClient } from "./world-tools.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

const emptyClient: AgentCanvasClient = {
  async listCanvases() { return { ok: true, canvases: [] }; },
  async getGraph() { return { ok: false, code: "unavailable", message: "unused" }; },
  async getChanges() { return { ok: false, code: "unavailable", message: "unused" }; },
  async applyPlan() { return { ok: false, code: "unavailable", message: "unused" }; }
} as AgentCanvasClient;

function contextView(overrides: Partial<AssistantWorldContextView> = {}): AssistantWorldContextView {
  return {
    version: "assistant-world-authority-v1", canvasId: "canvas-1", contextId: "ctx-1", runId: "run-1", epoch: 0,
    scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" },
    writable: [{ kind: "instance", instanceId: "instance-1", version: "model-v1" }], readOnly: [], objects: [], worldWritable: true,
    modelScripts: { "instance-1": "first\nsecond\nthird" }, resourceVersions: { "world_model_script:instance-1": "script-v1" },
    sceneModels: [{ instanceId: "instance-1", nodeId: "node-1", title: "Box", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }, localBounds: null }],
    ...overrides
  };
}

function grant(tools: readonly string[] = assistantWorldToolsForScope({ kind: "scene-area", areaId: "area-1" })): ApplicationToolGrant {
  return {
    token: "grant-token", canvasIds: ["canvas-1"], nodeIds: [], tools: [...tools], workId: "req-1", subject: "owner-1",
    world: { contextId: "ctx-1", completionId: "completion-1", runId: "run-1", epoch: 0, executionId: "exec-1", scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" } }
  };
}

async function start(world: AssistantWorldToolClient, issued: ApplicationToolGrant | null) {
  const handler = createModelMcpHttpHandler({
    agentAuthoring: { client: emptyClient, world, runAvailability: { available: false } },
    toolGrant: { allowedTools: token => token === issued?.token ? issued.tools : undefined, resolve: token => token === issued?.token ? issued : null, authorize: input => issued?.tools.includes(input.tool) ? { ok: true } : { ok: false, reason: "tool-not-allowed" } }
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function rpc(base: string, body: Record<string, unknown>, token: string) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}" : text;
  return JSON.parse(payload) as { error?: { code: number; message: string }; result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } };
}
const call = (base: string, name: string, args: Record<string, unknown>, token: string) => rpc(base, { method: "tools/call", params: { name, arguments: args } }, token);

describe("统一世界资源工具", () => {
  it("只暴露四个 edit 工具，脚本读写均走统一资源协议", async () => {
    const issued = grant();
    const writes: unknown[] = [];
    const base = await start({ read: () => ({ ok: true, view: contextView() }), async write(input) { writes.push(input); return { ok: true, canvasId: "canvas-1", commandId: "command", revision: 1, duplicate: false, noop: false, version: "script-v2" }; }, async complete() { return { ok: false, code: "not-ready", message: "unused" }; } }, issued);
    const names = listModelMcpToolNames({ agentAuthoring: { client: emptyClient, world: {} as AssistantWorldToolClient } });
    expect(names).toContain(WORLD_RESOURCE_TOOLS.modelScript);
    expect(names).not.toContain("edit_scene_area");
    expect(names).not.toContain("resize_scene_area");
    const read = await call(base, WORLD_RESOURCE_TOOLS.read, { operation: "get", resourceType: "world_model_script", target: { instanceId: "instance-1" }, lines: { start: 2, end: 2 } }, issued.token);
    expect(read.result?.structuredContent).toMatchObject({ ok: true, resource: { script: "second", totalLines: 3, version: "script-v1" } });
    const patch = await call(base, WORLD_RESOURCE_TOOLS.modelScript, { operation: "patch", operationId: "patch-1", target: { instanceId: "instance-1" }, expectedVersion: "script-v1", edits: [{ oldString: "red", newString: "blue" }] }, issued.token);
    expect(patch.result?.structuredContent).toMatchObject({ ok: true, version: "script-v2" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ operation: { kind: "edit-resource", edit: { resourceType: "world_model_script", operation: "patch" } } });
  });

  it("用统一资源查询返回脚本元数据，并拒绝范围外目标", async () => {
    const issued = grant();
    const base = await start({ read: () => ({ ok: true, view: contextView() }), async write() { throw new Error("read must not write"); }, async complete() { throw new Error("unused"); } }, issued);
    const metadata = await call(base, WORLD_RESOURCE_TOOLS.read, { operation: "get", resourceType: "world_model_script", target: { instanceId: "instance-1" }, includeSource: false }, issued.token);
    expect(metadata.result?.structuredContent?.resource).not.toHaveProperty("script");
    const outside = await call(base, WORLD_RESOURCE_TOOLS.read, { operation: "get", resourceType: "world_model_script", target: { instanceId: "foreign" } }, issued.token);
    expect(outside.result?.structuredContent).toMatchObject({ ok: false, code: "not-found" });
  });

  it("锁定大小策略由回合授权控制，范围工具不存在", async () => {
    const issued = grant();
    const base = await start({ read: () => ({ ok: true, view: contextView({ allowSceneAreaExpansion: false }) }), async write() { throw new Error("unused"); }, async complete() { throw new Error("unused"); } }, issued);
    const result = await call(base, "resize_scene_area", { expectedScopeVersion: "scope-1", bounds: { min: { u: 0, v: 0 }, max: { u: 2, v: 2 } } }, issued.token);
    expect(result.error?.code).toBe(-32602);
  });
});
