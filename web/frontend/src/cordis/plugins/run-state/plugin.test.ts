/**
 * run-state 插件与 Agent 会话读模型的真实装配测试
 * （change: show-agent-turn-running-state-on-node）。
 *
 * 覆盖真实 Cordis scope：install 阶段提供 `agentConversationService`，随后启动 run-state 插件，
 * 断言 Agent 回合确实进入 `runState` 读模型（节点执行中呈现的上游），并且回合终态后熄灭。
 * 单测只覆盖纯函数与 store；这里补上"插件是否真的连上服务"这一层，避免改动看似生效但未接线。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ConversationTurn } from "@woohaa3/contracts";
import { startFrontendScope } from "../../kernel.js";
import type { AgentConversationSnapshotView } from "../../contract/agent-conversation.js";
import { RUN_STATE_SERVICE, type RunStateService } from "../service-keys.js";
import { runStateExtension } from "./plugin.js";

const CANVAS = "canvas-1";

function turn(status: ConversationTurn["status"]): ConversationTurn {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    requestId: "req-1",
    action: "generate",
    status,
    stage: status,
    target: { canvasId: CANVAS, nodeId: "n1", mode: "model3d" },
    tools: [],
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:01.000Z"
  };
}

/** 最小会话服务替身：只提供 run-state 需要读取的读模型与订阅。 */
function fakeConversation() {
  let snapshot: AgentConversationSnapshotView = {
    conversations: [],
    active: null,
    detail: null,
    mcp: null,
    loading: false,
    error: null,
    contextRevision: 0
  };
  const listeners = new Set<() => void>();
  return {
    service: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      queryTurn: async () => ({ ok: false as const, code: "fixture", error: "fixture" })
    },
    publish(active: ConversationTurn | null) {
      snapshot = {
        ...snapshot,
        active: active ? { conversationId: active.conversationId, requestId: active.requestId, turn: active } : null
      };
      for (const listener of listeners) listener();
    }
  };
}

describe("run-state 插件接线 Agent 回合", () => {
  it("提交后节点在 runState 读模型里执行中，回合终态后熄灭", async () => {
    const conversation = fakeConversation();
    const runtime = await startFrontendScope(new Context(), {
      install: (ctx) => {
        ctx.provide("agentConversationService" as never, conversation.service as never);
      },
      plugins: [
        { id: "run-state", required: true, plugin: runStateExtension({ canvasId: CANVAS }) }
      ]
    });
    try {
      const runState = runtime.ctx.get(RUN_STATE_SERVICE) as RunStateService;
      expect(runState).toBeDefined();
      expect(runState.getNodeSummary(CANVAS, "n1")).toBeNull();

      // 提交 → 会话读模型出现运行中回合。
      conversation.publish(turn("running"));
      expect(runState.isBusy(CANVAS, "n1")).toBe(true);
      expect(runState.getNodeSummary(CANVAS, "n1")?.active).toMatchObject({
        operationId: "agent:req-1",
        kind: "model",
        state: "running"
      });

      // 终态 → 投影为空，节点不再执行中。
      conversation.publish(turn("succeeded"));
      expect(runState.isBusy(CANVAS, "n1")).toBe(false);
      expect(runState.getNodeSummary(CANVAS, "n1")).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("服务未装配时启动不失败，也不产生 Agent 运行态", async () => {
    const runtime = await startFrontendScope(new Context(), {
      install: () => undefined,
      plugins: [
        { id: "run-state", required: true, plugin: runStateExtension({ canvasId: CANVAS }) }
      ]
    });
    try {
      expect(runtime.status().phase).toBe("ready");
      const runState = runtime.ctx.get(RUN_STATE_SERVICE) as RunStateService;
      expect(runState.snapshot().records).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
});
