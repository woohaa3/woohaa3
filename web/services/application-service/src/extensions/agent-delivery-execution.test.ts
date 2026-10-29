import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationAdapter } from "@woohaa3/contracts";
import { createSqliteAgentConversationStore } from "../repository/agent-conversation-repository.js";
import { createAgentAdapterRegistry } from "./agent-adapter-registry.js";
import { createAgentConversationService } from "./agent-conversation-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "assistant-delivery-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let store = createSqliteAgentConversationStore({ path: path.join(directory, "ledger.sqlite") });
  cleanup.push(() => store.close());
  const run = vi.fn(async () => ({ status: "succeeded" as const }));
  const query = vi.fn(async () => ({ status: "succeeded" as const }));
  const adapter: AgentConversationAdapter = { id: "fake", capabilities: () => ({ discussion: true, tools: true, models: "none", targets: ["film-set"] }),
    authorization: async () => "ready", models: async () => ({ models: [] }), run, query };
  const registry = createAgentAdapterRegistry({ hasCapability: () => true,
    resolveCapabilityOwner: () => ({ extensionId: "fake", configVersion: 1, mode: "public" }),
    resolveCapability: () => adapter, snapshot: () => [{ extensionId: "fake", capabilities: ["agent-conversation-adapter:fake"] }] });
  const service = createAgentConversationService({ store, registry, maxMessageChars: 64 });
  const created = service.createConversation({ owner: "owner", canvasId: "canvas", nodeId: "target", adapterId: "fake" });
  if (!created.ok) throw new Error(created.error.message);
  const input = { owner: "owner", conversationId: created.conversation.conversationId, requestId: "conversion:request:1",
    entry: { action: "generate" as const, canvasId: "canvas", nodeId: "target", mode: "film-set" as const, prompt: "Build from the source image" },
    delivery: { purpose: "film-set-conversion" as const, domainRequestId: "request", attemptId: "attempt-1" } };
  const accepted = service.acceptDeliveryTurn(input);
  if (!accepted.ok) throw new Error(accepted.error.message);
  return { service, store, registry, run, query, input, accepted,
    reopen() { store.close(); store = createSqliteAgentConversationStore({ path: path.join(directory, "ledger.sqlite") }); return store; } };
}

describe("trusted candidate delivery on the conversation ledger", () => {
  it("accepts durably before dispatch, deduplicates and waits for the domain receipt", async () => {
    const f = fixture();
    let finish!: () => void;
    const delivery = vi.fn(async ({ emit }: Parameters<Parameters<typeof f.service.dispatchDeliveryTurn>[1]>[0]) => {
      expect(f.store.getTurn(f.accepted.turn.turnId)?.status).toBe("running");
      emit({ type: "message", role: "assistant", content: "Candidate response", streamId: "candidate-0", delivery: "replace" });
      emit({ type: "stage", stage: "validate-and-save", detail: "Validating candidate" });
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "succeeded" as const, receipt: { commandId: "durable-command", targetNodeId: "target" } };
    });
    expect(f.store.listMessages(f.input.conversationId, 200)[0]?.role).toBe("user");
    expect(f.service.acceptDeliveryTurn(f.input)).toMatchObject({ ok: true, reused: true });
    await f.service.dispatchTurn(f.accepted.turn.turnId);
    expect(f.run).not.toHaveBeenCalled();
    const running = f.service.dispatchDeliveryTurn(f.accepted.turn.turnId, delivery);
    const duplicate = f.service.dispatchDeliveryTurn(f.accepted.turn.turnId, delivery);
    await Promise.resolve();
    const read = f.service.readConversation({ owner: "owner", conversationId: f.input.conversationId });
    expect(read).toMatchObject({ ok: true, snapshot: { turns: [{ status: "running", stage: "validate-and-save", target: { delivery: f.input.delivery } }] } });
    if (read.ok) {
      expect(read.snapshot.messages.map(message => message.content)).toContain("Candidate response");
      expect(read.snapshot.turns[0]?.tools).toEqual([]);
    }
    finish();
    await Promise.all([running, duplicate]);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(f.service.queryTurn({ owner: "owner", requestId: f.input.requestId })).toMatchObject({ ok: true, turn: { status: "succeeded", receipt: { commandId: "durable-command" } } });
    expect(f.service.acceptDeliveryTurn({ ...f.input, delivery: { ...f.input.delivery, attemptId: "different" } }).ok).toBe(false);
  });

  it("does not let an adapter candidate result settle a restarted parent", async () => {
    const f = fixture();
    const restarted = createAgentConversationService({ store: f.reopen(), registry: f.registry });
    await restarted.reconcileUnknown();
    await restarted.dispatchTurn(f.accepted.turn.turnId);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    // Candidate delivery 由领域 reconciler 按原请求结算；本层不擅自判失败。
    expect(restarted.queryTurn({ owner: "owner", requestId: f.input.requestId })).toMatchObject({ ok: true, turn: { status: "queued" } });
    expect(restarted.readConversation({ owner: "other", conversationId: f.input.conversationId }).ok).toBe(false);
    expect(restarted.cancelTurn({ owner: "owner", requestId: f.input.requestId }).ok).toBe(true);
    expect(restarted.queryTurn({ owner: "owner", requestId: f.input.requestId })).toMatchObject({ ok: true, turn: { status: "cancelled" } });
  });
});
