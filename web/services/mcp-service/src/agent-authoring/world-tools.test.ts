import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationToolGrant, WorldAnimationScript } from "@woohaa3/contracts";
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
    tools: ["get_world_context", "create_world_model", "set_scene_animation_script", "resize_scene_area", "create_world_camera", "set_world_camera", "complete_world_camera"],
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
  return JSON.parse(payload) as { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } };
}

describe("assistant world MCP tools", () => {
  it("awaits current animation reads without widening the scoped tool catalog", async () => {
    const animationScript: WorldAnimationScript = {
      script: 'motion.instance.tween("actor-1", { property: "rotation", startTime: 0, endTime: 5, from: [0, 0, 0], to: [0, 90, 0], easing: "easeOut" });',
      scriptLanguage: "javascript",
      scriptVersion: "woohaa-world-animation-js-v1",
      revision: 1,
      sourceHash: "hash-script",
      duration: 5,
      loop: true
    };
    const reads: unknown[] = [];
    const world: AssistantWorldToolClient = {
      async read(input) {
        await Promise.resolve();
        reads.push(input);
        return { ok: true, view: {
          version: "assistant-world-authority-v1", canvasId: "canvas-1", contextId: "ctx-1", runId: "run-1", epoch: 0,
          scope: { scope: { kind: "scene-area", areaId: "area-1" }, scopeVersion: "scope-1" },
          writable: [{ kind: "instance", instanceId: "actor-1", version: "actor-v1" }], readOnly: [], objects: [],
          worldWritable: true, sceneArea: { nodeId: "area-node", revision: 7, scopeVersion: "scope-1", animationScript }
        } };
      },
      async write() { throw new Error("Read must not write"); },
      async complete() { throw new Error("Read must not complete"); }
    };
    const issued = grant();
    const base = await start(world, issued);
    const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    const raw = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw.split("\n").filter(line => line.startsWith("data:")).at(-1)!.slice(5).trim()
      : raw;
    const catalog = JSON.parse(json) as { result: { tools: Array<{ name: string }> } };
    expect(catalog.result.tools.map(tool => tool.name).sort()).toEqual([...issued.tools].sort());
    const result = await callTool(base, "get_world_context", {}, issued.token);
    expect(result.result?.structuredContent).toMatchObject({ ok: true, sceneArea: { nodeId: "area-node", revision: 7, animationScript } });
    const text = result.result?.content?.find(item => item.type === "text")?.text ?? "";
    expect(JSON.parse(text.slice(text.indexOf("\n") + 1)).sceneArea.animationScript).toEqual(animationScript);
    expect(reads).toEqual([{ canvasId: "canvas-1", contextId: "ctx-1" }]);
  });

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
    const animated = await callTool(base, "set_scene_animation_script", {
      duration: 4,
      loop: false,
      script: 'motion.instance.tween("instance-new", { property: "rotation", startTime: 0, endTime: 4, from: [0, 0, 0], to: [90, 0, 0], easing: "easeIn" });'
    }, token.token);
    expect(animated.result?.structuredContent).toMatchObject({ ok: true });
    expect((calls[1] as { operation: { kind: string } }).operation.kind).toBe("set-scene-animation-script");
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
    expect(calls).toHaveLength(2);
  });

  it("turns lookAt into an exact unit quaternion and forwards partial camera patches", async () => {
    const calls: Array<import("@woohaa3/contracts").AssistantWorldWriteInput> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write(input) {
        calls.push(input);
        return {
          ok: true,
          canvasId: "canvas-1",
          commandId: "cmd-camera",
          revision: 3,
          duplicate: false,
          noop: false,
          cameraId: "camera-1",
          settingsVersion: "camera-v2",
          version: "camera-v2",
          view: { forward: { u: 0, v: 1, h: 0 }, groundIntersection: { u: 10, v: 5 } }
        };
      },
      async complete() {
        return { ok: true, duplicate: false, settingsVersion: "camera-v2", completionId: "completion-1" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const created = await callTool(base, "create_world_camera", {
      settings: {
        position: { u: 10, v: 0, h: 1 },
        lookAt: { u: 12, v: 0, h: 1 },
        projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 500 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: null
      }
    }, token.token);
    expect(created.result?.isError).toBeFalsy();
    const createdOperation = calls[0]?.operation;
    if (createdOperation?.kind !== "create-world-camera") throw new Error("missing create operation");
    expect(createdOperation.settings).not.toHaveProperty("lookAt");
    const norm = createdOperation.settings.rotation.reduce((sum, value) => sum + value * value, 0);
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
    expect(createdOperation.settings.rotation[2]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(createdOperation.settings.rotation[3]).toBeCloseTo(Math.SQRT1_2, 9);
    // The result hands back where the lens points so the caller can check framing.
    expect(created.result?.content?.[0]?.text).toContain("朝向 (u,v,h)=(0, 1, 0)");
    expect(created.result?.content?.[0]?.text).toContain("地面落点 (u,v)=(10, 5)");

    const adjusted = await callTool(base, "set_world_camera", {
      cameraId: "camera-1",
      expectedSettingsVersion: "camera-v1",
      settings: { position: { u: 11, v: 0, h: 0.5 } }
    }, token.token);
    expect(adjusted.result?.isError).toBeFalsy();
    const adjustedOperation = calls[1]?.operation;
    if (adjustedOperation?.kind !== "set-world-camera") throw new Error("missing set operation");
    expect(adjustedOperation.settings).toEqual({ position: { u: 11, v: 0, h: 0.5 } });
  });

  it("resizes the director area through the dedicated range tool", async () => {
    const calls: Array<import("@woohaa3/contracts").AssistantWorldWriteInput> = [];
    const world: AssistantWorldToolClient = {
      read: () => ({ ok: false, code: "not-issued", message: "not used" }),
      async write(input) {
        calls.push(input);
        return {
          ok: true,
          canvasId: "canvas-1",
          commandId: "cmd-area",
          revision: 4,
          duplicate: false,
          noop: false,
          version: "area-scope-2"
        };
      },
      async complete() {
        return { ok: false, code: "not-issued", message: "not used" };
      }
    };
    const token = grant();
    const base = await start(world, token);
    const bounds = { min: { u: -50, v: -50 }, max: { u: 190, v: 190 } };
    const result = await callTool(base, "resize_scene_area", { expectedScopeVersion: "scope-1", bounds }, token.token);
    expect(result.result?.isError).toBeFalsy();
    expect(calls[0]?.operation).toMatchObject({ kind: "resize-scene-area", expectedScopeVersion: "scope-1", bounds });

    const unordered = await callTool(base, "resize_scene_area", {
      expectedScopeVersion: "scope-1",
      bounds: { min: { u: 5, v: 5 }, max: { u: 0, v: 0 } }
    }, token.token);
    expect(unordered.result?.isError).toBe(true);
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
