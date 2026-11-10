import { buildTestPreparedTurn } from "@woohaa3/test-fixtures-agent-role-turns";
import { describe, expect, it, vi } from "vitest";
import { createChatGptConversationAdapter } from "./conversation-adapter.js";

describe("OAuth structured candidate", () => {
  it("passes image bytes and schema through the discussion path without write tools", async () => {
    const converse = vi.fn(async (_input: unknown) => ({ ok: true as const, text: "{}" }));
    const adapter = createChatGptConversationAdapter({ service: { enabled: true, converse } as never });
    const bytes = Uint8Array.from([1, 2, 3]);
    const schema = { type: "object" };
    const result = await adapter.run({ owner: "owner", canvasId: "canvas", conversationId: "conversation", turnId: "turn", requestId: "request", prepared: buildTestPreparedTurn({ requestId: "request", target: { canvasId: "canvas" }, prompt: "create", tools: [], output: { kind: "candidate", schema } }), intent: { action: "discuss", canvasId: "canvas", model: "model", prompt: "create" }, candidate: { images: [{ bytes, contentType: "image/png" }], outputSchema: schema }, history: [], signal: new AbortController().signal, emit: () => {} });
    expect(result.status).toBe("succeeded");
    expect(converse).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining({ bytes, mimeType: "image/png" })], outputSchema: schema }));
    expect(converse.mock.calls[0]![0]).not.toHaveProperty("mcp");
    await expect(adapter.cancel!({ owner: "owner", requestId: "request", candidateContext: { canvasId: "canvas", conversationId: "conversation", connection: { connectionId: "c", adapterId: "chatgpt", configRevision: 1, credentialEpoch: 1 }, intent: { action: "discuss", canvasId: "canvas", prompt: "create" } } })).rejects.toThrow("无法确认");
  });
});
