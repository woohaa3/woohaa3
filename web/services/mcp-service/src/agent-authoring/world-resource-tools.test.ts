/**
 * 分段脚本写入的世界工具面
 * （change: 2026-11-10-add-incremental-world-model-authoring，任务 2.1 / 2.2 / 2.3）。
 *
 * 覆盖：空骨架创建与回读、三个新工具的目录/能力/角色白名单一致、写副作用注解、
 * 未授权工具在网关被拒绝且无画布副作用、越权目标返回 outside-scope。
 */
import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { ASSISTANT_WORLD_TOOLS, assistantWorldToolsForScope, WORLD_RESOURCE_TOOLS } from "@woohaa3/contracts";
import type { ApplicationToolGrant, AssistantWorldContextView } from "@woohaa3/contracts";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
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

function scopeGrant(tools: readonly string[] = assistantWorldToolsForScope({ kind: "scene-area", areaId: "area-1" })): ApplicationToolGrant {
  return {
    token: "grant-token",
    canvasIds: ["canvas-1"],
    nodeIds: [],
    tools: [...tools, "get_model_api"],
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
        inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
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


it('advertises the current tool catalog, excludes legacy names, validates operation branches before dispatch', async () => {
  const issued = scopeGrant();
  const writes: unknown[] = [];
  const base = await start({ read: async () => ({ ok: true, view: contextView() }), write: async input => {
    writes.push(input); return { ok: true, canvasId: 'canvas-1', commandId: 'command', revision: 1, duplicate: false, noop: false, version: 'v2' };
  }, complete: async () => ({ ok: false, code: 'not-ready', message: 'not used' }) }, issued);
  const catalog = await listTools(base, issued.token);
  expect(catalog.map(tool => tool.name).sort()).toEqual([...ASSISTANT_WORLD_TOOLS, 'get_model_api'].sort());
  for (const tool of catalog) expect(tool.inputSchema?.type, tool.name).toBe('object');
  const valid = await callTool(base, WORLD_RESOURCE_TOOLS.modelScript, {
    operation: 'patch', operationId: 'patch', target: { instanceId: 'instance-1' }, expectedVersion: 'v1', edits: [{ oldString: 'red', newString: 'blue' }]
  }, issued.token);
  expect(valid.result?.structuredContent).toMatchObject({ ok: true, version: 'v2' });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ contextId: 'ctx-1', operation: { kind: 'edit-resource', edit: { resourceType: 'world_model_script', operation: 'patch' } } });
  await callTool(base, WORLD_RESOURCE_TOOLS.modelScript, { operation: 'patch', operationId: 'bad', target: { instanceId: 'instance-1' }, expectedVersion: 'v1', chunk: 'wrong field' }, issued.token);
  await callTool(base, WORLD_RESOURCE_TOOLS.model, { operation: 'delete', operationId: 'bad-delete', target: { instanceId: 'instance-1' }, expectedVersion: 'v1', patch: { title: 'not allowed' } }, issued.token);
  expect(writes).toHaveLength(1);
});

it('queries exact source lines and metadata without leaking source through the summary', async () => {
  const issued = scopeGrant();
  const base = await start({ read: async () => ({ ok: true, view: contextView({ modelScripts: { 'instance-1': 'first\nsecond\nthird' }, sceneModels: [{ instanceId: 'instance-1', nodeId: 'model', title: 'Box', transform: { version: 'shared-world-v1', position: { u: 0, v: 0, h: 0 }, rotation: [0,0,0,1], scale: 1 }, localBounds: null }], resourceVersions: { 'world_model_script:instance-1': 'script-v1' } }) }),
    write: async () => ({ ok: false, code: 'not-ready', message: 'not used' }), complete: async () => ({ ok: false, code: 'not-ready', message: 'not used' }) }, issued);
  const lines = await callTool(base, WORLD_RESOURCE_TOOLS.read, { operation: 'get', resourceType: 'world_model_script', target: { instanceId: 'instance-1' }, lines: { start: 2, end: 2 } }, issued.token);
  expect(lines.result?.structuredContent).toMatchObject({ ok: true, resource: { script: 'second', totalLines: 3, version: 'script-v1' } });
  const metadata = await callTool(base, WORLD_RESOURCE_TOOLS.read, { operation: 'get', resourceType: 'world_model_script', target: { instanceId: 'instance-1' }, includeSource: false }, issued.token);
  expect(metadata.result?.structuredContent?.resource).not.toHaveProperty('script');
  const summary = await callTool(base, 'get_world_context', {}, issued.token);
  expect(summary.result?.structuredContent).not.toHaveProperty('modelScripts');
});

it('narrows camera-only schema and denies lifecycle/root writes', async () => {
  const issued = scopeGrant(assistantWorldToolsForScope({ kind: 'world-camera', cameraId: 'camera-1' }));
  issued.world!.scope = { scope: { kind: 'world-camera', cameraId: 'camera-1' }, scopeVersion: 'v1' };
  issued.tools = [...assistantWorldToolsForScope({ kind: 'world-camera', cameraId: 'camera-1' })];
  let writes = 0;
  const base = await start({ read: async () => ({ ok: true, view: contextView() }), write: async () => { writes++; return { ok: false, code: 'not-ready', message: 'unused' }; }, complete: async () => ({ ok: false, code: 'not-ready', message: 'unused' }) }, issued);
  const catalog = await listTools(base, issued.token);
  expect(catalog.map(tool => tool.name).sort()).toEqual(['get_world_context','read_world_resource','edit_world_camera'].sort());
  await callTool(base, WORLD_RESOURCE_TOOLS.camera, { operation: 'delete', operationId: 'delete', target: { cameraId: 'camera-1' }, expectedVersion: 'v1' }, issued.token);
  expect(writes).toBe(0);
});
