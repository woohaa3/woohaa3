import { expect, it } from "vitest";
import type { ConversationTurn } from "@woohaa3/contracts";
import { RunStateStore } from "./store.js";

const turn: ConversationTurn = { conversationId: "conversation", turnId: "turn", requestId: "request", action: "modify", status: "running", stage: "running",
  target: { canvasId: "canvas", nodeId: "film", mode: "film-set" }, tools: [], createdAt: "2026-10-22", updatedAt: "2026-10-22" };
function setup(extensionId = "film-set") {
  const store = new RunStateStore({ canvasId: "canvas", nodeTypeOf: () => "composite-asset" });
  store.reconcileCanonical({ document: { nodes: [{ id: "film" }] }, nodeData: { film: { extensionId } } });
  return store;
}
it("shares feedback with both consumers and never revives a settled turn from stale input", () => {
  const store = setup();
  store.syncFilmSetTurns([turn]);
  expect(store.getNodeSummary("film")?.filmSetFeedback).toMatchObject({ phase: "running", labelCode: "modifying" });
  store.syncFilmSetTurns([{ ...turn, status: "succeeded" }]);
  store.syncFilmSetTurns([turn]);
  expect(store.getNodeSummary("film")?.filmSetFeedback).toBeNull();
  store.dispose();
});
it("gates scanning on trusted film set identity", () => {
  const store = setup("game-furnace");
  store.syncFilmSetTurns([turn]);
  expect(store.getNodeSummary("film")?.filmSetFeedback).toBeUndefined();
});
it("reconciles a failed conversion independently of legacy task protection", () => {
  const store = setup();
  store.reconcileCanonical({ document: { nodes: [{ id: "film" }] }, nodeData: { film: {
    extensionId: "film-set", activeRunId: "run", taskStatus: "processing",
    filmSetConversion: { status: "failed", code: "unknown-result", message: "无法确认转换结果", attempt: 1, retryable: true, requestId: "conversion", sourceNodeId: "image" }
  } } });
  expect(store.getNodeSummary("film")?.filmSetFeedback?.phase).toBe("failed");
  store.dispose();
});
it("pending is static, rejection clears it without operation or history writes", () => {
  const store = setup();
  store.syncFilmSetTurns([], { pending: { canvasId: "canvas", nodeId: "film", mode: "film-set", action: "generate", prompt: "test" } });
  expect(store.getNodeSummary("film")?.filmSetFeedback?.phase).toBe("submitting");
  expect(store.getSnapshot().records).toEqual([]);
  expect(store.isBusy("film")).toBe(false);
  store.syncFilmSetTurns([]);
  expect(store.getNodeSummary("film")?.filmSetFeedback).toBeNull();
});

it("repeated save retries need new execution evidence before scanning resumes", () => {
  const store = setup();
  const reconcile = (status: string, attemptId = "attempt-1") => store.reconcileCanonical({
    document: { nodes: [{ id: "film" }] }, nodeData: { film: { extensionId: "film-set", taskStatus: "processing",
      filmSetConversion: { status, requestId: "conversion", sourceNodeId: "image", step: "validate-and-save",
        ...(status === "failed" ? { code: "commit-failed", message: "Save failed", attempt: 1, retryable: true } : {}),
        execution: { canvasId: "canvas", targetNodeId: "film", conversationId: "conversation", turnRequestId: "request", attemptId } }
    } }
  });
  reconcile("failed");
  reconcile("running");
  expect(store.getNodeSummary("film")?.filmSetFeedback?.phase).toBe("failed");
  reconcile("running");
  expect(store.getNodeSummary("film")?.filmSetFeedback?.phase).toBe("failed");
  reconcile("running", "attempt-2");
  expect(store.getNodeSummary("film")?.filmSetFeedback?.phase).toBe("committing");
});
