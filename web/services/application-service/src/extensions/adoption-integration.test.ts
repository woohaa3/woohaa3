/**
 * 后端重启接管集成回归（change: 2026-11-10-split-agent-runtime-lifecycle，任务 6.1）。
 *
 * 真实链路：独立 daemon 执行回合 → 旧宿主只消费到 cursor 1 后「退出」→ 新宿主重开同一
 * SQLite、`reconcileUnknown()` 按 turn authority 接管，从 cursor 继续到终态。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConversationAdapter, PreparedAgentRoleTurn } from "@woohaa3/contracts";
import { startExecutorDaemon } from "../../../../../packages/execution-runtime/src/daemon.js";
import { createExecutorClient } from "woohaa3-executor/client";
import { createSqliteAgentConversationStore } from "../repository/agent-conversation-repository.js";
import { createAgentConversationService } from "./agent-conversation-service.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createRuntimeConversationAdapter, runtimeTurnId } from "./agent-runtime-adapter.js";
import { testRoleRegistry } from "./test-role-registry.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-adoption-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const OWNER = "user-a";
const CANVAS = "canvas-1";
const REQUEST = "restart-request";

function prepared(): PreparedAgentRoleTurn {
  return {
    schemaVersion: 1,
    roleRef: { namespacedId: "test/discussion", roleId: "discussion", extensionId: "test", revision: "1", descriptorDigest: "d", artifactId: "a" },
    messages: [{ role: "user", content: "画一个模型" }],
    tools: [],
    nativeCapabilities: [],
    output: { kind: "reply" },
    inputDigest: "a",
    contextDigest: "b",
    attachmentDigests: [],
    target: { canvasId: CANVAS },
    preparedHash: "hash"
  };
}

function idleAdapter(): AgentConversationAdapter {
  return {
    id: "fake",
    capabilities: () => ({ discussion: true, targets: ["model3d"], tools: true, models: "remote" }),
    authorization: async () => "ready",
    models: async () => ({ models: [] }),
    async run() { throw new Error("inner adapter must not run"); }
  };
}

describe("backend restart adoption (task 6.1)", () => {
  it("continues an in-flight executor turn from the persisted cursor and settles once", async () => {
    const dir = tempDir();
    const daemon = await startExecutorDaemon({
      socketPath: path.join(dir, "executor.sock"),
      stateDir: dir,
      token: "daemon-token",
      workspaceKey: "workspace",
      defaultExecutor: "slow",
      executors: [{
        id: "slow",
        kind: "any",
        async run(_input, context) {
          context.emit("message", { role: "assistant", content: "before restart", delivery: "replace", streamId: "s1" });
          await new Promise((resolve) => setTimeout(resolve, 250));
          context.emit("stage", { stage: "writing" });
          context.emit("message", { role: "assistant", content: "after restart", delivery: "replace", streamId: "s2" });
          return { status: "succeeded", result: { outcome: { status: "succeeded", assistantText: "after restart", receipt: { commandId: "c-1" } } } };
        }
      }]
    });
    cleanups.push(() => daemon.close());
    const client = createExecutorClient({ socketPath: daemon.socketPath, token: "daemon-token", workspaceKey: "workspace" });
    const turnId = runtimeTurnId(OWNER, REQUEST);
    await client.runTurn({ turnId, requestId: REQUEST, kind: "agent", executor: "slow", prepared: prepared() });
    // 旧宿主在第一条消息之后退出（消费了 cursor 2，尚未读到终态）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const firstPage = await client.turnEvents(turnId, 0);
    const consumed = firstPage.events.find((event) => event.type === "message");
    expect(consumed).toBeTruthy();
    const consumedCursor = consumed!.cursor;

    const storePath = path.join(dir, "application.sqlite");
    const seed = createSqliteAgentConversationStore({ path: storePath });
    seed.createConversation({ conversationId: "conv-1", owner: OWNER, canvasId: CANVAS, adapterId: "fake", title: "t", now: "2026-11-10T00:00:00.000Z" });
    seed.createTurn({
      turnId: "conv-turn-1", conversationId: "conv-1", owner: OWNER, canvasId: CANVAS, requestId: REQUEST,
      action: "modify", status: "running", stage: "running", inputHash: "hash",
      targetJson: JSON.stringify({ canvasId: CANVAS, nodeId: "node-1" }), intentJson: JSON.stringify({ action: "modify", canvasId: CANVAS, nodeId: "node-1", prompt: "画一个模型", roleId: "test/discussion" }),
      connectionId: null, connectionAdapterId: null, connectionConfigRevision: null, connectionCredentialEpoch: null, historySequence: null,
      roleRefJson: JSON.stringify(prepared().roleRef), preparedJson: JSON.stringify(prepared()), roleInputDigest: prepared().inputDigest,
      createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z"
    });
    seed.updateTurn("conv-turn-1", { executorCursor: consumedCursor }, "2026-11-10T00:00:01.000Z");
    seed.recordTurnAuthority({
      turnId: "conv-turn-1", requestId: REQUEST, conversationId: "conv-1", owner: OWNER, canvasId: CANVAS, action: "modify",
      adapterId: "fake", executor: "local-agent", connectionId: null, configRevision: null, credentialEpoch: null,
      targetJson: JSON.stringify({ canvasId: CANVAS, nodeId: "node-1" }), preparedHash: "hash", hostMethods: [], toolScope: [],
      createdAt: "2026-11-10T00:00:00.000Z", expiresAt: null, revokedAt: null
    });
    seed.close();

    // 新宿主：重开同一库，按原 turnId 接管。
    const store = createSqliteAgentConversationStore({ path: storePath });
    cleanups.push(() => store.close());
    const adapter = createRuntimeConversationAdapter(idleAdapter(), {
      socketPath: daemon.socketPath, token: "daemon-token", workspaceKey: "workspace", executor: "slow",
      bridge: { socketPath: path.join(dir, "bridge.sock"), token: "bridge", workspaceKey: "workspace" }
    });
    const registry = createAgentAdapterRegistry({
      hasCapability: (id) => id === "agent-conversation-adapter:fake",
      resolveCapabilityOwner: (id) => (id === "agent-conversation-adapter:fake" ? { extensionId: "fake-ext", configVersion: 1, mode: "public" } : null),
      resolveCapability: (id) => (id === "agent-conversation-adapter:fake" ? adapter : undefined),
      snapshot: () => [{ extensionId: "fake-ext", capabilities: ["agent-conversation-adapter:fake"] }]
    });
    const service = createAgentConversationService({
      store, registry, agentRoles: testRoleRegistry(), now: () => "2026-11-10T00:00:02.000Z"
    });
    await service.reconcileUnknown();
    const query = service.queryTurn({ owner: OWNER, requestId: REQUEST });
    expect(query).toMatchObject({ ok: true, turn: { status: "succeeded", receipt: { commandId: "c-1" } } });
    if (!query.ok) return;
    expect(query.turn.executorCursor).toBeGreaterThanOrEqual(consumedCursor);
    const read = service.readConversation({ owner: OWNER, conversationId: "conv-1" });
    if (!read.ok) return;
    const assistant = read.snapshot.messages.filter((message) => message.role === "assistant");
    // cursor 1 是旧宿主已消费的消息；新宿主只补写 cursor 3，不重放历史。
    expect(assistant.map((message) => message.content)).toEqual(["after restart"]);
    expect((await client.listTurns()).turns).toHaveLength(1);
    // 终态只结算一次：再次核对不新增消息或事件。
    const before = store.maxEventSequence("conv-1");
    await service.reconcileUnknown();
    expect(store.maxEventSequence("conv-1")).toBe(before);
  });
});
