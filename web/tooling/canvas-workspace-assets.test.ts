/** Real daemon -> workspace authorization -> media import -> local asset storage. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { preparedTurnHash, type MediaMetadata, type PreparedAgentRoleTurn } from "@woohaa3/contracts";
import { createMediaService } from "@woohaa3/media-service";
import { startExecutorDaemon } from "../../packages/execution-runtime/src/daemon.js";
import { CanvasAgentWorkspaceService } from "../services/application-service/src/workspaces/service.js";
import { createSqliteAgentConversationStore } from "../services/application-service/src/repository/agent-conversation-repository.js";
import { createLocalBackend } from "../extensions/local-storage/src/backend.js";
import { createStorageRegistry } from "../backend/src/host/core/storage.js";
import { createMediaStorageFromStorage } from "../backend/src/ports/media-storage.js";

it("an explicitly imported media asset survives cleanup of its real workspace source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-workspace-assets-"));
  const runtime = { socketPath: path.join(root, "rpc.sock"), token: "token", workspaceKey: "profile", executor: "", bridge: { socketPath: "unused", token: "", workspaceKey: "profile" } };
  const daemon = await startExecutorDaemon({ ...runtime, stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "workspaces") });
  const store = createSqliteAgentConversationStore({ path: path.join(root, "ledger.sqlite") });
  const storage = createStorageRegistry({ settings: { primary: () => "local" } });
  storage.register(createLocalBackend({ root: path.join(root, "assets") }));
  const media = createMediaService({ storage: createMediaStorageFromStorage(storage, undefined), env: {} });
  const service = new CanvasAgentWorkspaceService({ runtime, store, authorize: async () => true, importArtifact: input => media.port().importBytes(input) });
  try {
    const identity = { owner: "owner", canvasId: "canvas", requestId: "request" }, now = new Date().toISOString();
    store.createConversation({ conversationId: "conversation", owner: identity.owner, canvasId: identity.canvasId, adapterId: "test", title: "test", now });
    store.createTurn({ turnId: "turn", requestId: identity.requestId, conversationId: "conversation", owner: identity.owner, canvasId: identity.canvasId, action: "discuss", status: "running", stage: "running", inputHash: "input", targetJson: "{}", intentJson: "{}", connectionId: null, connectionAdapterId: null, connectionConfigRevision: null, connectionCredentialEpoch: null, historySequence: null, createdAt: now, updatedAt: now });
    const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = { schemaVersion: 1, roleRef: { namespacedId: "test/reply", roleId: "reply", extensionId: "test", revision: "1", descriptorDigest: "digest", artifactId: "test" }, messages: [{ role: "user", content: "生成图片" }], tools: [], nativeCapabilities: [], output: { kind: "reply" }, inputDigest: "input", contextDigest: "context", attachmentDigests: [], target: { canvasId: "canvas" } };
    const prepared = await service.prepare(identity, { ...body, preparedHash: preparedTurnHash(body) }, true);
    store.updateTurn("turn", { preparedJson: JSON.stringify(prepared) }, now);
    store.recordTurnAuthority({ turnId: "turn", requestId: identity.requestId, conversationId: "conversation", owner: identity.owner, canvasId: identity.canvasId, action: "discuss", adapterId: "test", executor: null, connectionId: null, configRevision: null, credentialEpoch: null, targetJson: "{}", preparedHash: prepared.preparedHash, hostMethods: [], toolScope: prepared.tools, createdAt: now, expiresAt: null, revokedAt: null });
    const grant = { token: "trusted-grant", subject: identity.owner, workId: identity.requestId, canvasIds: [identity.canvasId], nodeIds: [], tools: prepared.tools };
    const tool = (name: string, args: Record<string, unknown>) => service.tool({ tool: name, arguments: args, grant, principalId: identity.owner });
    const runPath = `runs/${prepared.workspace!.runKey}/pixel.png`;
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=", "base64");
    // Actual Node writes a binary file into its assigned default cwd.
    const execution = await tool("workspace_execute", { operationId: "image", command: "node", args: ["-e", `require('fs').writeFileSync('pixel.png',Buffer.from('${bytes.toString("base64")}', 'base64'))`] }) as { executionId: string };
    let terminal = false;
    for (let i = 0; i < 100; i++) {
      const result = await tool("workspace_query", { executionId: execution.executionId }) as { execution: { status: string } };
      if (result.execution.status === "exited") { terminal = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(terminal).toBe(true);
    const asset = await tool("workspace_import", { path: runPath, contentType: "image/png" }) as MediaMetadata;
    expect(asset.storageKey).toMatch(/^generation-outputs\/[a-f0-9]{64}\.png$/); expect(asset.storageKey).not.toContain(prepared.workspace!.runKey);
    store.updateTurn("turn", { status: "succeeded" }, now); await service.reconcile();
    expect((await service.clean(identity)).removed).toContain(prepared.workspace!.runKey);
    expect(fs.existsSync(path.join(root, "workspaces", prepared.workspace!.directoryKey, runPath))).toBe(false);
    // New storage/media instances read the content-addressed bytes after source deletion.
    const reopened = createLocalBackend({ root: path.join(root, "assets") });
    expect(Buffer.from((await reopened.get(`media/${asset.storageKey}`)).bytes)).toEqual(bytes);
    expect(await media.port().verify(asset.storageKey, { contentType: "image/png", checksum: asset.checksum, size: bytes.length }, identity)).toMatchObject({ exists: true });
  } finally { await media.close(); store.close(); await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
