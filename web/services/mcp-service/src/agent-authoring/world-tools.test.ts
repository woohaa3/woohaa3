import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationToolGrant } from "@woohaa3/contracts";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "../model-mcp/mcp-http.js";
import type { AgentCanvasClient } from "../downstream/agent-canvas-client.js";
import type { AssistantWorldToolClient } from "./world-tools.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function baseClient(): AgentCanvasClient {
  return {
    async listCanvases() { return { ok: true, canvases: [] }; },
    async getGraph() { return { ok: false, code: "unavailable", message: "not used" }; },
    async getChanges() { return { ok: false, code: "unavailable", message: "not used" }; },
    async applyPlan() { return { ok: false, code: "unavailable", message: "not used" }; },
    async runNode() { return { ok: false, code: "unavailable", message: "not used" }; },
    async getRun() { return { ok: false, code: "unavailable", message: "not used" }; },
    async cancelRun() { return { ok: false, code: "unavailable", message: "not used" }; },
    async getOutput() { return { ok: false, code: "unavailable", message: "not used" }; }
  } as AgentCanvasClient;
}

function grant(): ApplicationToolGrant {
  return {
    token: "grant-token",
    canvasIds: ["canvas-1"],
    nodeIds: [],
    tools: ["get_world_context", "create_world_model", "set_world_camera", "complete_world_camera"],
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
    agentAuthoring: {
      client: baseClient(),
      world,
      runAvailability: { available: false }
    },
    toolGrant: {
      allowedTools: token => token === issued?.token ? issued.tools : undefined,
      resolve: token => token === issued?.token ? issued : null,
      authorize: () => ({ ok: true })
    }
  });
  const server = http.createServer((req, res) => void handler.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => { await handler.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${port}`;
}

async function callTool(base: string, name: string, args: Record<string, unknown>, bearer?: string) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } };
}

describe("assistant world MCP tools", () => {
  it("derives the context from the host grant and rejects model-supplied context", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({
        ok: true,
        view: {
          version: "assistant-world-authority-v1",
          canvasId: "canvas-1",
          contextId: "ctx-1",
          runId: "run-1",
          epoch: 0,
          scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" },
          writable: [],
          readOnly: [],
          objects: [],
          worldWritable: true
        }
      }),
      async write(input) {
        calls.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          canvasId: "canvas-1",
          commandId: "cmd-1",
          revision: 2,
          duplicate: false,
          noop: false,
          instanceId: input.operation.kind === "create-model" ? "instance-new" : undefined
        };
      },
      async complete() {
        return { ok: true, duplicate: false, settingsVersion: "cv-2", completionId: "completion-1" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const context = await callTool(base, "get_world_context", {}, token.token);
    expect(context.result?.structuredContent).toMatchObject({ ok: true, canvasId: "canvas-1", contextId: "ctx-1" });
    const created = await callTool(base, "create_world_model", {
      nodeId: "node-new",
      modelScript: "scene.box({});",
      transform: {
        version: "shared-world-v1",
        position: { u: 1, v: 1, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    }, token.token);
    expect(created.result?.structuredContent).toMatchObject({ ok: true, instanceId: "instance-new" });
    expect(calls[0]).toMatchObject({ contextId: "ctx-1" });
    const smuggled = await callTool(base, "create_world_model", {
      contextId: "ctx-other",
      nodeId: "node-new",
      modelScript: "scene.box({});",
      transform: {
        version: "shared-world-v1",
        position: { u: 1, v: 1, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    }, token.token);
    expect(smuggled.result?.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not expose or execute world writes without a host grant", async () => {
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not issued" }),
      async write() { return { ok: false, code: "not-issued", message: "not issued" }; },
      async complete() { return { ok: false, code: "not-issued", message: "not issued" }; }
    };
    const base = await start(world, null);
    const result = await callTool(base, "get_world_context", {});
    expect(result.result?.isError).toBe(true);
    expect(result.result?.structuredContent).toMatchObject({ ok: false, code: "capability-unsupported" });
  });
});
