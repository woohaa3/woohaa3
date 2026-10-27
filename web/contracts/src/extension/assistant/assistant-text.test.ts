import { describe, expect, it } from "vitest";
import {
  decodeAssistantTextRequest,
  decodeAssistantTextCandidate,
} from "./assistant-text.js";
import { decodeAcceptTurnRequest } from "./conversation-codec.js";
const request = {
  requestId: "r",
  conversationId: "c",
  canvasId: "cv",
  nodeId: "n",
  connection: {
    connectionId: "conn",
    adapterId: "a",
    configRevision: 1,
    credentialEpoch: 1,
  },
  model: "m",
  prompt: "write",
};
describe("assistant text public boundary", () => {
  it("accepts explicit assistant identity, never provider keys", () => {
    expect(decodeAssistantTextRequest(request).ok).toBe(true);
    expect(
      decodeAssistantTextRequest({ ...request, modelKey: "provider:language" })
        .ok,
    ).toBe(false);
    expect(
      decodeAssistantTextRequest({ ...request, connection: undefined }).ok,
    ).toBe(false);
  });
  it.each(["owner", "delivery", "candidate", "runId"])(
    "rejects forged %s",
    (key) => {
      expect(
        decodeAssistantTextRequest({ ...request, [key]: "forged" }).ok,
      ).toBe(false);
      expect(
        decodeAcceptTurnRequest({
          requestId: "r",
          entry: {
            action: "generate",
            mode: "text",
            canvasId: "cv",
            nodeId: "n",
            prompt: "write",
            [key]: "forged",
          },
        }).ok,
      ).toBe(false);
    },
  );
  it("rejects mismatched targets and preserves Markdown verbatim", () => {
    expect(
      decodeAcceptTurnRequest({
        requestId: "r",
        entry: {
          action: "generate",
          mode: "text",
          canvasId: "cv",
          nodeId: "n",
          clipId: "clip",
          prompt: "write",
        },
      }).ok,
    ).toBe(false);
    const text = "\n# Heading\n\n```ts\nconst n = 1;\n```\n";
    expect(decodeAssistantTextCandidate({ text })).toEqual({
      ok: true,
      value: { text },
    });
    for (const value of [
      { text: "  \n" },
      { summary: "done" },
      { text: "body", explanation: "extra" },
      "body",
      { text: 12 },
    ])
      expect(decodeAssistantTextCandidate(value).ok).toBe(false);
  });
});
