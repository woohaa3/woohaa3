import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startExecutorDaemon } from "woohaa3-executor/daemon";
import { createExecutorClient } from "woohaa3-executor/client";
import { createSqliteAgentConversationStore } from "../repository/agent-conversation-repository.js";
import { CanvasAgentWorkspaceService } from "./service.js";
import { CANVAS_WORKSPACE_TOOLS, decodePreparedAgentRoleTurn, preparedTurnHash, type PreparedAgentRoleTurn, type ApplicationToolGrant } from "@woohaa3/contracts";

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
  const imported: unknown[] = [];
  const service = new CanvasAgentWorkspaceService({ runtime, store, authorize: async () => allowed, importArtifact: async input => { imported.push(input); return { storageKey: "sha256-result", checksum: "result", size: Buffer.from(input.bytesBase64, "base64").length, contentType: input.contentType }; } });
  const identity = { owner: "alice", canvasId: "canvas", requestId: "request" };
  const authorize = async () => {
    const p = await service.prepare(identity, prepared(), true);
    store.updateTurn("turn", { preparedJson: JSON.stringify(p) }, now);
    store.recordTurnAuthority({ turnId: "turn", requestId: "request", conversationId: "conversation", owner: "alice", canvasId: "canvas", action: "discuss", adapterId: "test", executor: null, connectionId: null, configRevision: null, credentialEpoch: null, targetJson: "{}", preparedHash: p.preparedHash, hostMethods: [], toolScope: p.tools, createdAt: now, expiresAt: null, revokedAt: null });
    return p;
  };
  const grant: ApplicationToolGrant = { token: "test", subject: "alice", workId: "request", canvasIds: ["canvas"], nodeIds: [], tools: [...CANVAS_WORKSPACE_TOOLS] };
  const tool = (name: string, args: Record<string, unknown>, override: Partial<ApplicationToolGrant> = {}) => service.tool({ tool: name, arguments: args, grant: { ...grant, ...override }, principalId: "alice" });
  return { root, runtime, service, store, identity, tool, authorize, imported,
    restart: async () => {
      await daemon.close();
      daemon = await startExecutorDaemon({ ...runtime, stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "files") });
    }, permission: (value: boolean) => { allowed = value; } };
}

describe("host canvas workspace authority with real daemon and SQLite ledger", () => {
  it("freezes a verifiable discussion handle and auxiliary tools even for roles without content tools", async () => {
    const f = await fixture(), p = await f.authorize();
    expect(p.tools).toEqual(CANVAS_WORKSPACE_TOOLS);
    expect(decodePreparedAgentRoleTurn(p)).toMatchObject({ ok: true });
    expect(p.workspace).toMatchObject(f.identity);
    expect(p.messages.at(-1)?.content).toContain(`runs/${p.workspace!.runKey}`);
    expect(JSON.stringify(p)).not.toContain(f.root);
    await f.tool("workspace_write", { path: "shared/value", content: "real file" });
    expect(await f.tool("workspace_read", { path: "shared/value" })).toMatchObject({ content: "real file" });
    const forged = { ...p, workspace: { ...p.workspace, canvasId: "another" } };
    expect(decodePreparedAgentRoleTurn(forged)).toMatchObject({ ok: false });
  });
  it("rejects owner, work, canvas, tool and permission escalation before file effects", async () => {
    const f = await fixture(); await f.authorize();
    for (const grant of [{ subject: "bob" }, { workId: "other" }, { canvasIds: ["elsewhere"] }, { canvasIds: ["canvas", "other"] }, { tools: [] }]) await expect(f.tool("workspace_write", { path: "shared/no", content: "forbidden" }, grant)).rejects.toHaveProperty("code", "workspace-forbidden");
    f.permission(false);
    await expect(f.tool("workspace_write", { path: "shared/no", content: "forbidden" })).rejects.toHaveProperty("code", "workspace-forbidden");
    expect((await f.service.prepare({ ...f.identity, requestId: "readonly" }, prepared(), true)).workspace).toBeUndefined();
    expect((await f.service.prepare({ ...f.identity, requestId: "no-tools" }, prepared(), false)).workspace).toBeUndefined();
    f.permission(true); f.store.revokeTurnAuthority("turn", new Date().toISOString());
    await expect(f.tool("workspace_write", { path: "shared/no", content: "forbidden" })).rejects.toHaveProperty("code", "workspace-forbidden");
  });
  it("web daemon rejects auxiliary capabilities even if a host client asks for them", async () => {
    const f = await fixture(false);
    await expect(f.authorize()).rejects.toHaveProperty("code", "workspace-unavailable");
    const client = createExecutorClient(f.runtime);
    await expect(client.call("workspace.settings")).rejects.toHaveProperty("code", "workspace-unavailable");
  });
  it("settles durable terminal leases after detach, and imports bytes through the asset port", async () => {
    const f = await fixture(); await f.authorize();
    await f.tool("workspace_write", { path: "shared/output.txt", content: "asset bytes" });
    expect(await f.tool("workspace_import", { path: "shared/output.txt", contentType: "text/plain" })).toMatchObject({ storageKey: "sha256-result" });
    expect(f.imported).toEqual([{ canvasId: "canvas", bytesBase64: Buffer.from("asset bytes").toString("base64"), contentType: "text/plain" }]);
    f.store.updateTurn("turn", { status: "succeeded" }, new Date().toISOString());
    // No in-memory settle hook is used: reconcile reads the durable ledger.
    await f.service.reconcile();
    await expect(f.tool("workspace_write", { path: "shared/late", content: "no" })).rejects.toHaveProperty("code", "workspace-forbidden");
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
  await f.tool("workspace_write", { path: "shared/restored", content: "authorized" });
});
