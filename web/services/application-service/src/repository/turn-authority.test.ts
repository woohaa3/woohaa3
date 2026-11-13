import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAgentConversationStore } from "./agent-conversation-repository.js";
import { decodeTurnAuthority, type TurnAuthorityRow } from "./agent-conversation-records.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-turn-authority-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const now = "2026-11-10T00:00:00.000Z";

function seed(store: ReturnType<typeof createSqliteAgentConversationStore>) {
  store.createConversation({ conversationId: "conv", owner: "alice", canvasId: "canvas", adapterId: "local-agent", title: "t", now });
  store.createTurn({
    turnId: "turn-1",
    conversationId: "conv",
    owner: "alice",
    canvasId: "canvas",
    requestId: "req-1",
    action: "modify",
    status: "running",
    stage: "running",
    inputHash: "hash",
    targetJson: JSON.stringify({ canvasId: "canvas", nodeId: "node" }),
    intentJson: "{}",
    connectionId: "connection-1",
    connectionAdapterId: "codex-appserver",
    connectionConfigRevision: 3,
    connectionCredentialEpoch: 2,
    historySequence: null,
    createdAt: now,
    updatedAt: now
  });
}

const authority = {
  turnId: "turn-1",
  requestId: "req-1",
  conversationId: "conv",
  owner: "alice",
  canvasId: "canvas",
  action: "modify",
  adapterId: "local-agent",
  executor: "local-agent",
  connectionId: "connection-1",
  configRevision: 3,
  credentialEpoch: 2,
  targetJson: JSON.stringify({ canvasId: "canvas", nodeId: "node" }),
  preparedHash: "prepared-hash",
  hostMethods: ["tools.issue", "tools.revoke"],
  toolScope: ["get_model_node", "submit_model_script"],
  createdAt: now,
  expiresAt: null,
  revokedAt: null
};

describe("turn authority store (task 2.1)", () => {
  it("survives a restart and keeps the frozen owner/connection scope", () => {
    const dir = tempDir();
    const first = createSqliteAgentConversationStore({ path: path.join(dir, "application.sqlite") });
    seed(first);
    expect(first.recordTurnAuthority(authority)).toBe(true);
    // 幂等：重复写入不覆盖首次冻结值。
    expect(first.recordTurnAuthority({ ...authority, owner: "mallory", toolScope: ["*"] })).toBe(false);
    first.close();

    const second = createSqliteAgentConversationStore({ path: path.join(dir, "application.sqlite") });
    expect(second.getTurnAuthority("turn-1")).toMatchObject({
      owner: "alice",
      configRevision: 3,
      credentialEpoch: 2,
      hostMethods: ["tools.issue", "tools.revoke"],
      toolScope: ["get_model_node", "submit_model_script"]
    });
    second.revokeTurnAuthority("turn-1", "2026-11-10T01:00:00.000Z");
    expect(second.getTurnAuthority("turn-1")?.revokedAt).toBe("2026-11-10T01:00:00.000Z");
    second.close();
  });

  it("rejects malformed authority rows instead of guessing defaults", () => {
    const row = {
      turn_id: "turn-1",
      request_id: "req-1",
      conversation_id: "conv",
      owner: "alice",
      canvas_id: "canvas",
      action: "modify",
      adapter_id: "local-agent",
      executor: null,
      connection_id: null,
      config_revision: null,
      credential_epoch: null,
      target_json: "{}",
      prepared_hash: null,
      host_methods_json: JSON.stringify(["tools.issue"]),
      tool_scope_json: JSON.stringify([1]),
      created_at: now,
      expires_at: null,
      revoked_at: null
    } satisfies TurnAuthorityRow;
    expect(() => decodeTurnAuthority(row)).toThrow(/toolScope/);
    expect(() => decodeTurnAuthority({ ...row, host_methods_json: "not-json" })).toThrow(/解码失败/);
  });

  it("consumes executor events exactly once per (turnId, cursor)", () => {
    const dir = tempDir();
    const store = createSqliteAgentConversationStore({ path: path.join(dir, "application.sqlite") });
    seed(store);
    expect(store.consumeExecutorEvent("turn-1", 1)).toBe(true);
    expect(store.consumeExecutorEvent("turn-1", 1)).toBe(false);
    expect(store.consumeExecutorEvent("turn-1", 2)).toBe(true);
    store.close();
  });

  it("allows exactly one adoption owner until the lease expires", () => {
    const dir = tempDir();
    const store = createSqliteAgentConversationStore({ path: path.join(dir, "application.sqlite") });
    seed(store);
    expect(store.claimAdoption("turn-1", "host-a", 2_000, now, 1_000)).toBe(true);
    expect(store.claimAdoption("turn-1", "host-b", 3_000, now, 1_500)).toBe(false);
    expect(store.renewAdoption("turn-1", "host-a", 4_000)).toBe(true);
    // 租约过期后下一宿主可以接管。
    expect(store.claimAdoption("turn-1", "host-b", 6_000, now, 5_000)).toBe(true);
    store.releaseAdoption("turn-1", "host-b");
    expect(store.getTurn("turn-1")?.adoptionOwner).toBeNull();
    store.close();
  });

  it("settles only once: updateTurnIfActive refuses terminal turns", () => {
    const dir = tempDir();
    const store = createSqliteAgentConversationStore({ path: path.join(dir, "application.sqlite") });
    seed(store);
    expect(store.updateTurnIfActive("turn-1", { status: "succeeded" }, now)).toBe(true);
    expect(store.updateTurnIfActive("turn-1", { status: "failed" }, now)).toBe(false);
    expect(store.getTurn("turn-1")?.status).toBe("succeeded");
    store.close();
  });
});
