/**
 * 旧 `unknown` 读取期归一（change: 2026-10-28-settle-unconfirmed-results-as-failed，任务 1.2）。
 *
 * 契约类型不再声明 `unknown`，但旧数据/旧 payload 仍可能读到：解码与投影必须按 `failed`
 * 返回，并在缺少错误码时补 `result-unconfirmed`，不能把 `unknown` 继续下传成用户可见状态。
 */
import { describe, expect, it } from "vitest";
import {
  normalizeConversationStatus,
  normalizeConversationTurnStatus,
} from "@woohaa3/contracts";
import {
  conversationStatusFor,
  toSummary,
  toTurn,
} from "./agent-conversation-projection.js";
import type {
  AgentConversationStore,
  ConversationAdapterBinding,
  ConversationTurnRecord,
} from "../repository/agent-conversation-repository.js";

const store = { listTools: () => [] } as unknown as AgentConversationStore;

function turn(overrides: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    owner: "owner",
    canvasId: "canvas",
    requestId: "request-1",
    action: "generate",
    status: "unknown",
    stage: "unknown",
    inputHash: "hash",
    targetJson: JSON.stringify({
      mode: "text",
      canvasId: "canvas",
      nodeId: "node",
    }),
    intentJson: "{}",
    connectionId: null,
    connectionAdapterId: null,
    connectionConfigRevision: null,
    connectionCredentialEpoch: null,
    historySequence: null,
    roleRefJson: null,
    preparedJson: null,
    roleInputDigest: null,
    executorCursor: null,
    adoptionOwner: null,
    adoptionLeaseUntil: null,
    assistantText: null,
    runId: null,
    taskId: null,
    receiptJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<ConversationAdapterBinding> = {}): ConversationAdapterBinding {
  return {
    conversationId: "conv-1",
    owner: "owner",
    canvasId: "canvas",
    adapterId: "adapter",
    connectionId: null,
    title: "Conversation",
    status: "unknown",
    latestRequestId: "request-1",
    nodeId: "node",
    turnCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("legacy unknown normalization", () => {
  it("maps old turn/session statuses to failed without discarding receipts", () => {
    expect(normalizeConversationTurnStatus("unknown")).toBe("failed");
    expect(normalizeConversationStatus("unknown")).toBe("failed");
    expect(normalizeConversationTurnStatus("not-a-status")).toBeNull();
    expect(normalizeConversationStatus("not-a-status")).toBeNull();

    const projected = toTurn(store, turn());
    expect(projected).toMatchObject({
      status: "failed",
      stage: "failed",
      error: {
        code: "result-unconfirmed",
      },
    });
    expect(toSummary(binding()).status).toBe("failed");
    expect(conversationStatusFor(turn())).toBe("failed");
  });

  it("keeps an existing error code and receipt instead of overwriting evidence", () => {
    const projected = toTurn(
      store,
      turn({
        receiptJson: JSON.stringify({ kind: "canvas-group", actions: [] }),
        errorCode: "outcome-unknown",
        errorMessage: "外部工作日志无法确认",
      }),
    );
    expect(projected).toMatchObject({
      status: "failed",
      error: { code: "outcome-unknown", message: "外部工作日志无法确认" },
      receipt: { kind: "canvas-group", actions: [] },
    });
  });
});
