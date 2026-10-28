import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../../extension/assistant/conversation.js";
import type { FilmSetConversionStatus } from "../film-set-conversion/types.js";
import { normalizeFilmSetRunFeedback as normalize } from "./film-set-feedback.js";

const input = { canvasId: "canvas", nodeId: "film", legacyTaskStatus: "processing" };
const execution = { canvasId: "canvas", targetNodeId: "film", conversationId: "conversation", turnRequestId: "candidate", attemptId: "attempt-1" };
const running: FilmSetConversionStatus = { status: "running", requestId: "conversion", sourceNodeId: "image", step: "generate-film-set", execution };
const completed: FilmSetConversionStatus = { status: "completed", requestId: "conversion", sourceNodeId: "image", targetNodeId: "film", commandId: "commit", execution };
function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return { requestId: "candidate", turnId: "turn", conversationId: "conversation", status: "running", action: "generate",
    stage: "running", target: { canvasId: "canvas", nodeId: "film", mode: "film-set" }, tools: [],
    createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:01Z", ...overrides };
}

describe("film set execution feedback", () => {
  it("unknown delivery overrides stale processing and a running candidate", () => {
    expect(normalize({ ...input, conversion: { ...running, status: "unknown" }, turns: [turn()] })).toMatchObject({ phase: "verifying" });
  });
  it("candidate completion does not settle delivery; save keeps operation identity", () => {
    const a = normalize({ ...input, conversion: running, turns: [turn({ status: "succeeded" })] });
    const b = normalize({ ...input, conversion: { ...running, step: "validate-and-save" } });
    expect(a?.phase).toBe("running");
    expect(b?.phase).toBe("committing");
    expect(b?.operationKey).toBe(a?.operationKey);
  });
  it("settled conversion suppresses its own candidate but permits a new independent modification", () => {
    expect(normalize({ ...input, conversion: completed, turns: [turn()] })).toBeNull();
    expect(normalize({ ...input, conversion: completed, turns: [turn(), turn({ requestId: "edit", action: "modify" })] }))
      .toMatchObject({ source: "agent", phase: "running", labelCode: "modifying" });
  });
  it("explicit delivery association also works before conversion stores its execution ref", () => {
    expect(normalize({ ...input, conversion: { ...completed, execution: undefined }, turns: [turn({ target: {
      canvasId: "canvas", nodeId: "film", mode: "film-set", delivery: { purpose: "film-set-conversion", domainRequestId: "conversion", attemptId: "attempt-1" }
    } })] })).toBeNull();
  });
  it.each(["queued", "committing", "unknown", "failed", "cancelled", "partial", "succeeded"] as const)("uses actual agent stage %s", status => {
    expect(normalize({ ...input, turns: [turn({ status })] })?.phase ?? null)
      .toBe(status === "queued" ? "queued" : status === "committing" ? "committing" : status === "unknown" ? "verifying" : null);
  });
  it("uses attempt identity and never merges independent targets of the same source", () => {
    const first = normalize({ ...input, conversion: running });
    const retry = normalize({ ...input, conversion: { ...running, execution: { ...execution, attemptId: "attempt-2" } } });
    const other = normalize({ ...input, nodeId: "film-2", conversion: { ...running, requestId: "conversion-2" } });
    expect(first?.operationKey).not.toBe(retry?.operationKey);
    expect(first?.operationKey).not.toBe(other?.operationKey);
  });
  it("terminal operation wins over duplicates and out-of-order busy", () => {
    const record = { canvasId: "canvas", nodeId: "film", operationId: "run", kind: "film-set" as const, owner: "server" as const,
      state: "running" as const, createdAt: "2026-10-22", updatedAt: "2026-10-22" };
    expect(normalize({ ...input, records: [record, { ...record, state: "failed" }, record] })).toBeNull();
  });
  it("terminal Agent turn wins over duplicate snapshots in either order", () => {
    const active = turn();
    const terminal = turn({ status: "succeeded" });
    expect(normalize({ ...input, turns: [active, terminal, active] })).toBeNull();
    expect(normalize({ ...input, turns: [terminal, active] })).toBeNull();
  });
  it("local pending never creates a running operation and rejection clears it", () => {
    expect(normalize({ canvasId: "canvas", nodeId: "film", pendingRequestId: "pending" })?.phase).toBe("submitting");
    expect(normalize({ canvasId: "canvas", nodeId: "film" })).toBeNull();
  });
  it("excludes turns of other nodes and read-only discussion", () => {
    expect(normalize({ canvasId: "canvas", nodeId: "film", turns: [turn({ action: "discuss" }), turn({ target: { canvasId: "canvas", nodeId: "elsewhere", mode: "film-set" } })] })).toBeNull();
  });
});
