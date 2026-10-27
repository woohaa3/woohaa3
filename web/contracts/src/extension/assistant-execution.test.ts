import { describe, expect, it } from "vitest";
import { assistantExecutionKey, decodeAssistantExecutionRef } from "./assistant-execution.js";
import { decodeAcceptTurnRequest } from "./conversation-codec.js";
import { isAgentAdapterCapabilities } from "./conversation.js";

describe("assistant execution identity", () => {
  it("keeps candidate bytes host-only and checks optional delivery capability shape", () => {
    const result = decodeAcceptTurnRequest({ requestId: "request", candidate: { images: ["private"] }, entry: { action: "discuss", canvasId: "canvas", prompt: "Question", candidate: { images: ["private"] } } });
    expect(result.ok).toBe(false);
    const caps = { discussion: true, tools: true, models: "remote", targets: [] };
    expect(isAgentAdapterCapabilities(caps)).toBe(true);
    expect(isAgentAdapterCapabilities({ ...caps, candidateGeneration: { imageInput: true, maxImages: 12 } })).toBe(true);
    for (const maxImages of [0, -1, 1.5, "12"]) expect(isAgentAdapterCapabilities({ ...caps, candidateGeneration: { imageInput: true, maxImages } })).toBe(false);
  });
  const ref = { canvasId: "canvas", targetNodeId: "node", conversationId: "conversation", turnRequestId: "request" };
  it("reads legacy references without optional domain and attempt links", () => {
    expect(decodeAssistantExecutionRef(ref, "canvas")).toEqual({ ok: true, value: ref });
  });
  it("rejects canvas confusion and caller-supplied private authority", () => {
    expect(decodeAssistantExecutionRef(ref, "other").ok).toBe(false);
    for (const key of ["owner", "grant", "runner", "credentialEpoch"]) {
      expect(decodeAssistantExecutionRef({ ...ref, [key]: "private" }, "canvas").ok).toBe(false);
    }
  });
  it("keeps turns and attempts independent", () => {
    expect(assistantExecutionKey(ref)).not.toBe(assistantExecutionKey({ ...ref, turnRequestId: "other" }));
    expect(assistantExecutionKey(ref)).not.toBe(assistantExecutionKey({ ...ref, attemptId: "retry" }));
  });
  it("decodes a public frozen connection assertion without accepting private fields", () => {
    const connection = { connectionId: "connection", adapterId: "adapter", configRevision: 2, credentialEpoch: 3 };
    const entry = { action: "discuss", canvasId: "canvas", prompt: "Question", connection };
    expect(decodeAcceptTurnRequest({ requestId: "request", entry })).toMatchObject({ ok: true, value: { entry: { connection } } });
    expect(decodeAcceptTurnRequest({ requestId: "request", entry: { ...entry, connection: { ...connection, token: "secret" } } }).ok).toBe(false);
  });
});
