import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startExecutorDaemon } from "woohaa3-executor/daemon";
import { createExecutorClient } from "woohaa3-executor/client";
import { createSqliteAgentConversationStore } from "../repository/agent-conversation-repository.js";
import { CanvasAgentWorkspaceService } from "./service.js";
import { decodePreparedAgentRoleTurn, preparedTurnHash, type PreparedAgentRoleTurn } from "@woohaa3/contracts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function prepared(): PreparedAgentRoleTurn {
  const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = {
    schemaVersion: 1,
    roleRef: { namespacedId: "test/discussion", extensionId: "test", roleId: "discussion", revision: "1", descriptorDigest: "a".repeat(64), artifactId: "test" },
    messages: [{ role: "user", content: "计算" }], tools: [], nativeCapabilities: [], output: { kind: "reply" },
    inputDigest: "input", contextDigest: "context", attachmentDigests: [], target: { canvasId: "canvas" }
  };
  return { ...body, preparedHash: preparedTurnHash(body) };
}
async function fixture(desktop = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-host-")); cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { socketPath: path.join(root, "rpc.sock"), token: "token", workspaceKey: "profile", executor: "", bridge: { socketPath: "unused", token: "", workspaceKey: "profile" } };
  let daemon = await startExecutorDaemon({ ...runtime, stateDir: path.join(root, "state"), ...(desktop ? { canvasWorkspaceRoot: path.join(root, "files") } : {}) }); cleanups.push(() => daemon.close());
  const storePath = path.join(root, "turns.sqlite");
  const store = createSqliteAgentConversationStore({ path: storePath }); cleanups.push(() => store.close());
  const now = new Date().toISOString();
  store.createConversation({ conversationId: "conversation", owner: "alice", canvasId: "canvas", adapterId: "test", title: "test", now });
  store.createTurn({ turnId: "turn", requestId: "request", conversationId: "conversation", owner: "alice", canvasId: "canvas", action: "discuss", status: "running", stage: "running", inputHash: "input", targetJson: "{}", intentJson: "{}", connectionId: null, connectionAdapterId: null, connectionConfigRevision: null, connectionCredentialEpoch: null, historySequence: null, createdAt: now, updatedAt: now });
  let allowed = true;
  const service = new CanvasAgentWorkspaceService({ runtime, store, authorize: async () => allowed });
  const identity = { owner: "alice", canvasId: "canvas", requestId: "request" };
  const authorize = async () => {
    const p = await service.prepare(identity, prepared(), true);
    store.updateTurn("turn", { preparedJson: JSON.stringify(p) }, now);
    store.recordTurnAuthority({ turnId: "turn", requestId: "request", conversationId: "conversation", owner: "alice", canvasId: "canvas", action: "discuss", adapterId: "test", executor: null, connectionId: null, configRevision: null, credentialEpoch: null, targetJson: "{}", preparedHash: p.preparedHash, hostMethods: [], toolScope: p.tools, createdAt: now, expiresAt: null, revokedAt: null });
    return p;
  };
  return { root, runtime, service, store, identity, authorize,
    restart: async () => {
      await daemon.close();
      daemon = await startExecutorDaemon({ ...runtime, stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "files") });
    }, permission: (value: boolean) => { allowed = value; } };
}

describe("host canvas workspace authority with real daemon and SQLite ledger", () => {
  it("freezes a verifiable cwd handle without adding tools to a discussion role", async () => {
    const f = await fixture(), p = await f.authorize();
    expect(p.tools).toEqual([]);
    expect(decodePreparedAgentRoleTurn(p)).toMatchObject({ ok: true });
    expect(p.workspace).toMatchObject(f.identity);
    expect(p.messages.at(-1)?.content).toContain(`runs/${p.workspace!.runKey}`);
    expect(JSON.stringify(p)).not.toContain(f.root);
    const forged = { ...p, workspace: { ...p.workspace, canvasId: "another" } };
    expect(decodePreparedAgentRoleTurn(forged)).toMatchObject({ ok: false });
  });
  it("provisions only for writable canvases and native workspace harnesses", async () => {
    const f = await fixture();
    f.permission(false);
    expect((await f.service.prepare(f.identity, prepared(), true)).workspace).toBeUndefined();
    f.permission(true);
    expect((await f.service.prepare(f.identity, prepared(), false)).workspace).toBeUndefined();
    const p = await f.authorize();
    await expect(f.service.prepare({ ...f.identity, owner: "bob" }, p, true)).rejects.toHaveProperty("code", "workspace-forbidden");
  });
  it("web daemon rejects auxiliary capabilities even if a host client asks for them", async () => {
    const f = await fixture(false);
    await expect(f.authorize()).rejects.toHaveProperty("code", "workspace-unavailable");
    const client = createExecutorClient(f.runtime);
    await expect(client.call("workspace.settings")).rejects.toHaveProperty("code", "workspace-unavailable");
  });
  it("settles durable terminal leases after detach so roots can migrate", async () => {
    const f = await fixture(); await f.authorize();
    f.store.updateTurn("turn", { status: "succeeded" }, new Date().toISOString());
    // No in-memory settle hook is used: reconcile reads the durable ledger.
    await f.service.reconcile();
    await expect(createExecutorClient(f.runtime).call("workspace.lookup", f.identity)).rejects.toHaveProperty("code", "workspace-forbidden");
    const migration = await f.service.migrate({ operationId: "move", targetPath: path.join(f.root, "moved"), expectedRootRevision: 1 });
    expect(migration.phase).not.toBe("failed");
    for (let i = 0; i < 100; i++) { if ((await f.service.settings()).migration?.phase === "completed") break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect((await f.service.settings()).rootRevision).toBe(2);
  });
});


it("reconciles an unknown lease only with the matching frozen authority and current permission", async () => {
  const f = await fixture(), p = await f.authorize(), client = createExecutorClient(f.runtime);
  await f.restart();
  const status = async () => (await client.call<Array<{ status: string }>>("workspace.leases"))[0]!.status;
  expect(await status()).toBe("unknown");
  f.store.updateTurn("turn", { preparedJson: JSON.stringify({ ...p, messages: [{ role: "user", content: "tampered" }] }) }, new Date().toISOString());
  await f.service.reconcile(); expect(await status()).toBe("unknown");
  f.store.updateTurn("turn", { preparedJson: JSON.stringify(p) }, new Date().toISOString());
  f.permission(false); await f.service.reconcile(); expect(await status()).toBe("unknown");
  f.permission(true); await f.service.reconcile(); expect(await status()).toBe("active");
  expect(await client.call("workspace.lookup", f.identity)).toEqual(p.workspace);
});
