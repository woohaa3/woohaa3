/**
 * Agent 回合 → 运行状态投影测试
 * （change: show-agent-turn-running-state-on-node）。
 */
import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "@woohaa3/contracts";
import { projectAgentTurnOperations } from "./agent-turn-projection.js";

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    requestId: "req-1",
    action: "generate",
    status: "running",
    stage: "running",
    target: { canvasId: "canvas-1", nodeId: "n1", mode: "model3d" },
    tools: [],
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:01.000Z",
    ...overrides
  };
}

function snapshot(active: ConversationTurn | null) {
  return {
    active: active ? { conversationId: active.conversationId, requestId: active.requestId, turn: active } : null
  };
}

describe("projectAgentTurnOperations", () => {
  it("非终态回合投影为执行中记录，身份来自 requestId", () => {
    expect(projectAgentTurnOperations(snapshot(turn()), "canvas-1")).toEqual([
      {
        operationId: "agent:req-1",
        canvasId: "canvas-1",
        nodeId: "n1",
        kind: "model",
        state: "running",
        owner: "server",
        createdAt: "2026-10-18T00:00:00.000Z",
        updatedAt: "2026-10-18T00:00:01.000Z"
      }
    ]);
    expect(projectAgentTurnOperations(snapshot(turn({ status: "queued" })), "canvas-1")[0]?.state).toBe("queued");
    expect(projectAgentTurnOperations(snapshot(turn({ status: "committing" })), "canvas-1")[0]?.state).toBe("running");
  });

  it("终态不产生运行记录，节点不会停在执行中", () => {
    for (const status of ["succeeded", "partial", "failed", "cancelled"] as const) {
      expect(projectAgentTurnOperations(snapshot(turn({ status })), "canvas-1")).toEqual([]);
    }
  });

  it("图片转 3D 的回合不将来源图片标记为生成中", () => {
    const target = { canvasId: "canvas-1", nodeId: "n1", mode: "model3d" as const, delivery: { purpose: "image-director-scene" as const, domainRequestId: "req-1", attemptId: "1" } };
    expect(projectAgentTurnOperations(snapshot(turn({ target })), "canvas-1")).toEqual([]);
    expect(projectAgentTurnOperations(snapshot(turn({ target: { ...target, nodeId: "director", delivery: { ...target.delivery, nodeId: "director" } } })), "canvas-1")).toMatchObject([{ nodeId: "director", state: "running" }]);
  });

  it("镜头回合使用镜头种类，其它画布或无节点目标不投影", () => {
    expect(projectAgentTurnOperations(snapshot(turn({ target: { canvasId: "canvas-1", nodeId: "n1", mode: "camera" } })), "canvas-1")[0]?.kind).toBe("camera");
    expect(projectAgentTurnOperations(snapshot(turn({ target: { canvasId: "other", nodeId: "n1" } })), "canvas-1")).toEqual([]);
    expect(projectAgentTurnOperations(snapshot(turn({ target: { canvasId: "canvas-1" } })), "canvas-1")).toEqual([]);
    expect(projectAgentTurnOperations(snapshot(null), "canvas-1")).toEqual([]);
  });
});

it("text activity uses the actual Canvas run identity, matching the eventual history source", () => {
  const projected = projectAgentTurnOperations(snapshot(turn({ runId: "text-run:real", target: { canvasId: "canvas-1", nodeId: "n1", mode: "text" } })), "canvas-1");
  expect(projected).toMatchObject([{ operationId: "text-run:real", kind: "text", state: "running" }]);
});
