/**
 * 组创作重启回归（change: 2026-10-28-settle-unconfirmed-results-as-failed，任务 6.1）。
 *
 * 真实链路：SQLite 会话 ledger + 真实 group-effects + Canvas 运行证据。
 * 覆盖：
 * - 执行中重启后按子 run 证据核对，仍活动时先撤销匹配 run 再结算 `failed`；
 * - 失败是终态，同 requestId 幂等返回原回合，显式新意图建立新回合；
 * - 失败组记录按终态参与「清除已结束」（由 task-activity store 用例覆盖，见 tasks.md）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type AgentAdapterRunInput,
  type AgentAdapterRunOutcome,
  type AgentConversationAdapter,
} from "@woohaa3/contracts";
import type { CanvasService } from "@woohaa3/canvas-service";
import { createAgentAdapterRegistry } from "../../../services/application-service/src/extensions/agent-adapter-registry.js";
import { createAgentConversationService } from "../../../services/application-service/src/extensions/agent-conversation-service.js";
import { createSqliteAgentConversationStore } from "../../../services/application-service/src/repository/agent-conversation-repository.js";
import { createGroupEffects } from "./group-effects.js";
import { createToolGrantRegistry } from "./authoring-adapters.js";

const directories: string[] = [];
const stores: Array<ReturnType<typeof createSqliteAgentConversationStore>> = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeRegistry(adapter: AgentConversationAdapter) {
  const capability = "agent-conversation-adapter:fake";
  return createAgentAdapterRegistry({
    hasCapability: (id) => id === capability,
    resolveCapabilityOwner: (id) =>
      id === capability
        ? { extensionId: "fake-ext", configVersion: 1, mode: "public" }
        : null,
    resolveCapability: (id) => (id === capability ? adapter : undefined),
    snapshot: () => [
      { extensionId: "fake-ext", capabilities: [capability] },
    ],
  });
}

describe("group creation restart recovery", () => {
  it("revokes the matched child run and settles failed, then a new intent starts a new turn", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "group-restart-"));
    directories.push(directory);
    const store = createSqliteAgentConversationStore({
      path: path.join(directory, "ledger.sqlite"),
    });
    stores.push(store);

    const runs: AgentAdapterRunInput[] = [];
    const adapter: AgentConversationAdapter = {
      id: "fake",
      capabilities: () => ({
        discussion: true,
        targets: ["canvas-group"],
        tools: true,
        models: "remote",
      }),
      authorization: async () => "ready",
      models: async () => ({ models: [{ id: "model", label: "Model" }] }),
      run: async (input) => {
        runs.push(input);
        // 模拟进程被重启：本轮没有任何回执就永远停在这里。
        return await new Promise<AgentAdapterRunOutcome>(() => undefined);
      },
      query: async () => null,
      cancel: async () => undefined,
    };

    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "now");
    canvas.document.nodes.push({
      id: "node",
      type: "image",
      parentId: "root",
      position: { x: 0, y: 0 },
    });
    canvas.nodeData.node = { activeRunId: "run", taskStatus: "processing" };
    canvas.jobs = [
      {
        id: "job",
        nodeId: "node",
        runId: "run",
        taskId: "task",
        status: "running",
        updatedAt: "now",
      },
    ];
    const cancel = vi.fn(async () => {
      // 真实 runService 会把被撤销的子 run 结算为终态；这里只需证明它不再是活动证据。
      canvas.jobs[0]!.status = "failed";
      return { ok: true };
    });
    const canvasService = {
      sync: {
        registry: {
          resolve: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }),
        },
      },
      runService: { cancel },
    } as unknown as CanvasService;
    const effects = createGroupEffects(canvasService, createToolGrantRegistry());
    const options = {
      store,
      registry: fakeRegistry(adapter),
      groupScopeEpoch: () => 1,
      groupEffects: effects,
    };
    const service = createAgentConversationService(options);
    const created = service.createConversation({
      owner: "owner",
      canvasId: "canvas",
      nodeId: "root",
      adapterId: "fake",
    });
    if (!created.ok) throw new Error(created.error.message);
    const conversationId = created.conversation.conversationId;
    const entry = {
      action: "generate" as const,
      mode: "canvas-group" as const,
      canvasId: "canvas",
      nodeId: "root",
      prompt: "build",
      model: "model",
    };
    const accepted = service.acceptTurn({
      owner: "owner",
      conversationId,
      requestId: "request-1",
      entry,
    });
    if (!accepted.ok) throw new Error(accepted.error.message);
    void service.dispatchTurn(accepted.turn.turnId);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    service.recordGroupAction({
      owner: "owner",
      requestId: "request-1",
      action: { canvasId: "canvas", nodeId: "node", runId: "run", jobId: "job" },
    });

    // 重启：同一持久 ledger 上的新进程没有在途 dispatch，只能读证据。
    const restarted = createAgentConversationService(options);
    const reconciled = await restarted.reconcileUnknown();
    expect(reconciled).toHaveLength(1);
    expect(cancel).toHaveBeenCalledWith({
      canvasId: "canvas",
      nodeId: "node",
      runId: "run",
    });
    expect(canvas.jobs[0]!.status).toBe("failed");
    const settled = restarted.queryTurn({
      owner: "owner",
      requestId: "request-1",
    });
    expect(settled).toMatchObject({
      ok: true,
      turn: {
        status: "failed",
        error: { code: "result-unconfirmed" },
        receipt: { kind: "canvas-group" },
      },
    });

    // 失败是终态：同一 requestId 仍返回原回合，不会自动重推理。
    expect(
      restarted.acceptTurn({
        owner: "owner",
        conversationId,
        requestId: "request-1",
        entry,
      }),
    ).toMatchObject({ ok: true, reused: true, turn: { status: "failed" } });
    expect(runs).toHaveLength(1);

    // 显式新意图建立新回合，旧回合保持失败。
    const next = restarted.acceptTurn({
      owner: "owner",
      conversationId,
      requestId: "request-2",
      entry,
    });
    expect(next).toMatchObject({
      ok: true,
      reused: false,
      turn: { status: "queued" },
    });
    if (!next.ok) return;
    expect(next.turn.turnId).not.toBe(accepted.turn.turnId);
    expect(
      restarted.queryTurn({ owner: "owner", requestId: "request-1" }),
    ).toMatchObject({ ok: true, turn: { status: "failed" } });
  });
});
