import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdapterRunInput,
  AgentConnectionView,
  AgentConversationAdapter,
  AgentConversationAdapterEvent,
  PreparedAgentRoleTurn
} from "@woohaa3/contracts";
import { createExecutorClient } from "woohaa3-executor/client";
import { startExecutorDaemon } from "../../../../../packages/execution-runtime/src/daemon.js";
import { createRuntimeConversationAdapter as wrapRuntimeAdapter, readRuntimeGeneratedImages, runtimeTurnId } from "./agent-runtime-adapter.js";

function createRuntimeConversationAdapter(adapter: AgentConversationAdapter, options: Parameters<typeof wrapRuntimeAdapter>[1]) {
  return wrapRuntimeAdapter(adapter, options, { getConnection: async () => ({
    connectionId: "connection", adapterId: "local-agent", name: "test", runCategory: "local-appserver", authMode: "local-login",
    configRevision: 1, credentialEpoch: 1, models: []
  } as unknown as AgentConnectionView) });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-runtime-adapter-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function prepared(): PreparedAgentRoleTurn {
  return {
    schemaVersion: 1,
    roleRef: { namespacedId: "test/local-agent", roleId: "local-agent", extensionId: "test", revision: "1", descriptorDigest: "d", artifactId: "a" },
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    nativeCapabilities: [],
    output: { kind: "reply" },
    inputDigest: "a",
    contextDigest: "b",
    attachmentDigests: [],
    target: { canvasId: "c" },
    preparedHash: "hash"
  };
}

function runInput(emitted: AgentConversationAdapterEvent[]): AgentAdapterRunInput {
  return {
    owner: "owner",
    canvasId: "canvas",
    conversationId: "conversation",
    turnId: "turn",
    requestId: "request",
    intent: { action: "discuss", canvasId: "canvas", prompt: "hello" },
    connection: { connectionId: "connection", adapterId: "local-agent", configRevision: 1, credentialEpoch: 1 },
    prepared: prepared(),
    history: [],
    signal: new AbortController().signal,
    emit: (event) => emitted.push(event)
  };
}

function adapter(fallback = vi.fn(async () => ({ status: "succeeded" as const }))): AgentConversationAdapter {
  return {
    id: "local-agent",
    capabilities: () => ({ discussion: true, targets: ["model3d"], tools: true, models: "remote" }),
    authorization: async () => "ready",
    models: async () => ({ models: [] }),
    run: fallback
  };
}

describe("宿主 runtime adapter", () => {
  it("走 daemon turn.run 并把事件回放到会话", async () => {
    const stateDir = tempDir();
    const daemon = await startExecutorDaemon({
      socketPath: path.join(stateDir, "executor.sock"),
      stateDir,
      token: "token",
      workspaceKey: "workspace",
      defaultExecutor: "echo",
      executors: [{
        id: "echo",
        kind: "any",
        async run(_input, context) {
          context.emit("message", { type: "message", role: "assistant", content: "from daemon" });
          return { status: "succeeded", result: { outcome: { status: "succeeded", assistantText: "from daemon" } } };
        }
      }]
    });
    cleanups.push(() => daemon.close());
    const emitted: AgentConversationAdapterEvent[] = [];
    const fallback = vi.fn(async () => ({ status: "succeeded" as const }));
    const wrapped = createRuntimeConversationAdapter(adapter(fallback), {
      socketPath: daemon.socketPath,
      token: "token",
      workspaceKey: "workspace",
      executor: "echo",
      bridge: { socketPath: path.join(stateDir, "bridge.sock"), token: "bridge", workspaceKey: "workspace" }
    });
    const outcome = await wrapped.run(runInput(emitted));
    expect(outcome).toMatchObject({ status: "succeeded", assistantText: "from daemon" });
    expect(emitted).toEqual(expect.arrayContaining([expect.objectContaining({ type: "message", content: "from daemon" })]));
    expect(fallback).not.toHaveBeenCalled();
  });

  it("daemon 不可用时明确失败，禁止调用原 adapter", async () => {
    const emitted: AgentConversationAdapterEvent[] = [];
    const fallback = vi.fn(async () => ({ status: "succeeded" as const, assistantText: "fallback" }));
    const wrapped = createRuntimeConversationAdapter(adapter(fallback), {
      socketPath: path.join(tempDir(), "missing.sock"),
      token: "token",
      workspaceKey: "workspace",
      executor: "echo",
      bridge: { socketPath: "/missing", token: "b", workspaceKey: "workspace" }
    });
    const outcome = await wrapped.run(runInput(emitted));
    expect(outcome).toMatchObject({ status: "failed", error: { code: "runtime-error" } });
    expect(fallback).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});


describe("daemon execution identities and artifacts", () => {
  it("separates candidate attempts, owner identities, and recovers exact outcomes", async () => {
    const stateDir = tempDir();
    const daemon = await startExecutorDaemon({
      socketPath: path.join(stateDir, "executor.sock"), stateDir, token: "token", workspaceKey: "workspace",
      executors: [{ id: "fake", kind: "any", async run(input, context) {
        context.emit("generated-image", { savedPath: "/codex/generated_images/1.png", codexHome: "/codex" });
        return { status: "succeeded", result: { outcome: { status: "succeeded", assistantText: input.requestId } } };
      } }]
    });
    cleanups.push(() => daemon.close());
    const options = { socketPath: daemon.socketPath, token: "token", workspaceKey: "workspace", executor: "fake", bridge: { socketPath: "/unused", token: "bridge", workspaceKey: "workspace" } };
    const original = adapter();
    const wrapped = createRuntimeConversationAdapter(original, options);
    const first = runInput([]);
    expect(await wrapped.run(first)).toMatchObject({ status: "succeeded", assistantText: first.requestId });
    expect(await wrapped.run({ ...first, requestId: "request:2" })).toMatchObject({ status: "succeeded", assistantText: "request:2" });
    // A fresh wrapper has no process-local lookup table.
    expect(await createRuntimeConversationAdapter(original, options).query!({ owner: first.owner, requestId: first.requestId })).toMatchObject({ status: "succeeded" });
    expect(await wrapped.query!({ owner: "another-owner", requestId: first.requestId })).toBeNull();
    expect(await readRuntimeGeneratedImages(options, first.owner, first.requestId)).toEqual({ codexHome: "/codex", paths: ["/codex/generated_images/1.png"] });
  });

  it.each(["cancel", "abort"])("%s interrupts only the exact execution", async (method) => {
    const stateDir = tempDir();
    const daemon = await startExecutorDaemon({
      socketPath: path.join(stateDir, "executor.sock"), stateDir, token: "token", workspaceKey: "workspace",
      executors: [{ id: "fake", kind: "any", async run(_input, context) {
        await new Promise<void>(resolve => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); });
        return { status: "succeeded", result: { outcome: { status: "succeeded", receipt: { committed: true } } } };
      } }]
    });
    cleanups.push(() => daemon.close());
    const options = { socketPath: daemon.socketPath, token: "token", workspaceKey: "workspace", executor: "fake", bridge: { socketPath: "/unused", token: "bridge", workspaceKey: "workspace" } };
    const wrapped = createRuntimeConversationAdapter(adapter(), options);
    const client = createExecutorClient(options);
    const controller = new AbortController();
    const first = { ...runInput([]), signal: controller.signal };
    const running = wrapped.run(first);
    const other = { ...runInput([]), requestId: "other" };
    const otherRunning = wrapped.run(other);
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await client.queryTurn(runtimeTurnId(first.owner, first.requestId))) && (await client.queryTurn(runtimeTurnId(other.owner, other.requestId)))) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (method === "abort") controller.abort();
      else await wrapped.cancel!({ owner: first.owner, requestId: first.requestId });
      expect(await running).toMatchObject({ status: "cancelled", receipt: { committed: true } });
      expect(await wrapped.query!({ owner: first.owner, requestId: first.requestId })).toMatchObject({ status: "cancelled", receipt: { committed: true } });
      expect(await client.queryTurn(runtimeTurnId(first.owner, first.requestId))).toMatchObject({ status: "cancelled" });
      expect(await client.queryTurn(runtimeTurnId(other.owner, other.requestId))).toMatchObject({ status: "running" });
    } finally {
      await wrapped.cancel!({ owner: other.owner, requestId: other.requestId });
      await otherRunning;
    }
  });

  it("does not synthesize a missing connection or contact the daemon", async () => {
    const options = { socketPath: "/missing", token: "token", workspaceKey: "workspace", executor: "fake", bridge: { socketPath: "/missing", token: "bridge", workspaceKey: "workspace" } };
    const original = adapter();
    const getConnection = vi.fn(async () => null);
    expect(await wrapRuntimeAdapter(original, options, { getConnection }).run(runInput([]))).toMatchObject({ status: "failed", error: { code: "connection-unavailable" } });
    expect(getConnection).toHaveBeenCalledWith({ owner: "owner", connectionId: "connection" });
    expect(original.run).not.toHaveBeenCalled();
  });

  it("missing configuration or prepared role never calls the original adapter", async () => {
    const original = adapter();
    const wrapped = createRuntimeConversationAdapter(original, undefined);
    expect(await wrapped.run(runInput([]))).toMatchObject({ status: "failed", error: { code: "runtime-unavailable" } });
    expect(await wrapped.run({ ...runInput([]), prepared: undefined })).toMatchObject({ status: "failed", error: { code: "role-not-found" } });
    expect(original.run).not.toHaveBeenCalled();
  });
});
