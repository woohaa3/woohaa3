import { expect, it, vi } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type AgentConnectionView,
} from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import { resolveTextSubmission } from "./text-submission.js";
import { assistantInputController } from "./controller.js";
import {
  assistantSelectionMemory,
  rememberAssistantPreference,
} from "./selection.js";
import { agentDirectory } from "./directory.js";

async function fixture(existing = false) {
  const scope = crypto.randomUUID();
  const connection = {
    connectionId: "global",
    adapterId: "adapter",
    configRevision: 1,
    credentialEpoch: 0,
    ready: true,
    capabilities: { textDelivery: { imageInput: false, maxImages: 0 } },
    models: [{ id: "model", reasoningEfforts: ["high"] }],
  } as unknown as AgentConnectionView;
  const own = { ...connection, connectionId: "own" };
  const service = {
    getDataScopeId: () => scope,
    getSnapshot: () => ({ contextRevision: 1, turnsByRequest: {} }),
    listConnections: vi.fn(async () => ({
      ok: true,
      value: [connection, own],
    })),
    catalog: vi.fn(async () => ({
      ok: true,
      value: { models: [], capabilities: {} },
    })),
    findConversationForTarget: vi.fn(async () => ({
      ok: true,
      value: {
        conversation: existing ? { conversationId: "conversation" } : null,
      },
    })),
    readConversation: vi.fn(async () => ({
      ok: true,
      value: {
        conversation: { connectionId: "own" },
        turns: [
          {
            target: {
              connectionId: "own",
              model: "model",
              reasoningEffort: "high",
            },
          },
        ],
      },
    })),
  } as unknown as AgentConversationService;
  const canvas = createEmptyWoohaa3ServerCanvas("canvas");
  rememberAssistantPreference(scope, {
    sourceId: "adapter",
    connectionId: "global",
    model: "model",
  });
  const ready = vi.fn();
  expect(resolveTextSubmission(service, canvas, "text", ready).eligible).toBe(
    false,
  );
  await vi.waitFor(() => expect(ready).toHaveBeenCalled());
  return { service, scope, canvas, connection };
}

it("batch text uses global preference only for new targets and preserves existing target context and draft", async () => {
  for (const existing of [false, true]) {
    const f = await fixture(existing);
    const controller = assistantInputController(f.service, {
      dataScopeId: f.scope,
      canvasId: f.canvas.id,
      nodeId: "text",
      purpose: "text",
    });
    controller.edit({ prompt: "unsubmitted draft" });
    const result = resolveTextSubmission(f.service, f.canvas, "text");
    expect(result).toMatchObject({
      eligible: true,
      input: {
        connectionId: existing ? "own" : "global",
        entry: { mode: "text", model: "model", prompt: "unsubmitted draft" },
      },
    });
    expect(f.service.readConversation).toHaveBeenCalledTimes(existing ? 1 : 0);
  }
});

it("batch text rejects stale selection and capability removal without silently choosing another assistant", async () => {
  const f = await fixture();
  assistantSelectionMemory(f.service, f.scope).set(`${f.canvas.id}:text`, {
    sourceId: "adapter",
    connectionId: "removed",
  });
  expect(resolveTextSubmission(f.service, f.canvas, "text").eligible).toBe(
    false,
  );
  assistantSelectionMemory(f.service, f.scope).delete(`${f.canvas.id}:text`);
  delete f.connection.capabilities.textDelivery;
  agentDirectory(f.service, f.scope).invalidate();
  const ready = vi.fn();
  expect(
    resolveTextSubmission(f.service, f.canvas, "text", ready).eligible,
  ).toBe(false);
  await vi.waitFor(() => expect(ready).toHaveBeenCalled());
  expect(resolveTextSubmission(f.service, f.canvas, "text")).toMatchObject({
    eligible: false,
    reason: "所选助手未提供文本交付能力",
  });
});
