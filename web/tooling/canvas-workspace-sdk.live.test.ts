/** Opt-in: real SDK model -> real MCP -> durable workspace -> real Node. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createToolGrantRegistry } from "../backend/src/ports/authoring-adapters.js";
import { randomInt, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { preparedTurnHash, type ApplicationToolGrant, type PreparedAgentRoleTurn } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord, ConnectionService } from "../services/agent-connections/src/index.js";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH } from "@woohaa3/mcp-service";
import { registerWorkspaceTools } from "../services/mcp-service/src/agent-authoring/workspace-tools.js";
import { startExecutorDaemon } from "../../packages/execution-runtime/src/daemon.js";
import { CanvasAgentWorkspaceService } from "../services/application-service/src/workspaces/service.js";
import { createSqliteAgentConversationStore } from "../services/application-service/src/repository/agent-conversation-repository.js";
import { createSdkAgentConversationAdapter } from "../extensions/sdk-agent/src/backend/sdk-agent-connections.js";
import { findSdkAgentAdapter, sdkEngineForAdapter } from "../extensions/sdk-agent/src/shared.js";

const enabled = process.env.WOOHAA_WORKSPACE_LIVE_SDK === "1";
it.skipIf(!enabled)("real Anthropic-compatible SDK turn executes a temporary script in its authorized canvas", async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY, endpoint = process.env.ANTHROPIC_BASE_URL, model = process.env.WOOHAA_WORKSPACE_LIVE_MODEL;
  if (!apiKey || !endpoint || !model) throw new Error("Set ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and WOOHAA_WORKSPACE_LIVE_MODEL for this opt-in acceptance test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-workspace-live-"));
  const identity = { owner: "workspace-acceptance", canvasId: randomUUID(), requestId: randomUUID() };
  const runtime = { socketPath: path.join(root, "rpc.sock"), token: randomUUID(), workspaceKey: "acceptance", executor: "", bridge: { socketPath: "unused", token: "", workspaceKey: "acceptance" } };
  const daemon = await startExecutorDaemon({ ...runtime, stateDir: path.join(root, "state"), canvasWorkspaceRoot: path.join(root, "workspaces") });
  const store = createSqliteAgentConversationStore({ path: path.join(root, "ledger.sqlite") });
  const workspace = new CanvasAgentWorkspaceService({ runtime, store, authorize: async ({ owner, canvasId }) => owner === identity.owner && canvasId === identity.canvasId });
  const grants = createToolGrantRegistry(), called: string[] = [];
  const handler = createModelMcpHttpHandler({
    toolGrant: {
      allowedTools: token => grants.verify(token)?.tools,
      resolve: token => grants.verify(token),
      authorize: input => grants.authorize(input)
    },
    registerTools: (server, { grant }) => registerWorkspaceTools(server, {
      grant, principalId: grant?.subject,
      workspace: async input => { called.push(input.tool); return workspace.tool(input); }
    })
  });
  const server = http.createServer((req, res) => { void handler.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const now = new Date().toISOString();
    store.createConversation({ conversationId: "conversation", owner: identity.owner, canvasId: identity.canvasId, adapterId: "anthropic-messages", title: "isolated acceptance", now });
    store.createTurn({ turnId: "turn", requestId: identity.requestId, conversationId: "conversation", owner: identity.owner, canvasId: identity.canvasId, action: "discuss", status: "running", stage: "running", inputHash: "acceptance", targetJson: "{}", intentJson: "{}", connectionId: null, connectionAdapterId: null, connectionConfigRevision: null, connectionCredentialEpoch: null, historySequence: null, createdAt: now, updatedAt: now });
    const prompt = "Read shared/input.json, an array of numbers, using workspace_read. Write a Node script sum.cjs into this turn's runs directory using workspace_write. The script must read ../../shared/input.json, calculate its sum, save the decimal sum to result.txt in its cwd, and print the sum. Run that script using workspace_execute command=node args=[sum.cjs]. Query the execution until exited, read result.txt using workspace_read, then reply with the sum. Use the provided workspace tools for each step; do not use built-in shell or pretend execution. This is an isolated local acceptance exercise.";
    const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = { schemaVersion: 1, roleRef: { namespacedId: "acceptance/reply", roleId: "reply", extensionId: "acceptance", revision: "1", descriptorDigest: "a".repeat(64), artifactId: "acceptance" }, messages: [{ role: "user", content: prompt }], tools: [], nativeCapabilities: [], output: { kind: "reply" }, inputDigest: "acceptance", contextDigest: "acceptance", attachmentDigests: [], target: { canvasId: identity.canvasId } };
    const prepared = await workspace.prepare(identity, { ...body, preparedHash: preparedTurnHash(body) }, true);
    store.updateTurn("turn", { preparedJson: JSON.stringify(prepared) }, now);
    store.recordTurnAuthority({ turnId: "turn", requestId: identity.requestId, conversationId: "conversation", owner: identity.owner, canvasId: identity.canvasId, action: "discuss", adapterId: "anthropic-messages", executor: null, connectionId: null, configRevision: null, credentialEpoch: null, targetJson: "{}", preparedHash: prepared.preparedHash, hostMethods: [], toolScope: prepared.tools, createdAt: now, expiresAt: null, revokedAt: null });
    const numbers = Array.from({ length: 17 }, () => randomInt(1000, 10000));
    const canvasDir = path.join(root, "workspaces", prepared.workspace!.directoryKey), runDir = path.join(canvasDir, "runs", prepared.workspace!.runKey);
    fs.writeFileSync(path.join(canvasDir, "shared/input.json"), JSON.stringify(numbers));
    const descriptor = findSdkAgentAdapter("anthropic-messages")!, engine = sdkEngineForAdapter(descriptor.adapterId)!;
    const baseUrl = endpoint.replace(/\/$/, "").replace(/(?:\/v1)?$/, "/v1");
    const record: ConnectionMetadataRecord = { owner: identity.owner, connectionId: "connection", adapterId: descriptor.adapterId, name: "isolated acceptance", baseUrl, runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, createdAt: now, updatedAt: now, runtimeVersion: `${engine.engine}@${engine.version}:1`, models: [model] };
    // Only connection metadata is ephemeral; the engine, API, MCP, authorization,
    // execution daemon, process and disk observations all use production paths.
    const service = { get: async () => record, list: async () => [record], readCredential: async () => ({ secret: apiKey }), credentialConfigured: async () => true, setRuntimeProbe: async () => {}, setStatus: async () => {}, resolveNativeBinding: async () => null, setNativeBinding: async () => {} } as unknown as ConnectionService;
    const adapter = createSdkAgentConversationAdapter(descriptor, {
      service, allowHttp: new URL(baseUrl).protocol === "http:", allowedHosts: [new URL(baseUrl).hostname],
      agentSdkDirs: { configDir: path.join(root, "engine-config"), workspaceDir: path.join(root, "engine-work") },
      mcpServerUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}${MODEL_MCP_HTTP_PATH}`,
      logger: event => { if (event.step || event.code) console.info(JSON.stringify({ trace: event.step ?? event.event, code: event.code })); },
      fetchImpl: async (url, init) => {
        console.info(JSON.stringify({ trace: "upstream-request", path: new URL(String(url)).pathname }));
        const response = await fetch(url, init);
        console.info(JSON.stringify({ trace: "upstream-response", status: response.status }));
        return response;
      },
      tools: {
        issue: async input => {
          if (input.delegation.subject !== identity.owner || input.workId !== identity.requestId || !(await workspace.allows(identity, input.tools ?? []))) throw new Error("Host rejected the requested workspace grant");
          const grant: ApplicationToolGrant = { token: randomUUID(), subject: identity.owner, canvasIds: [identity.canvasId], nodeIds: [], tools: [...prepared.tools], workId: identity.requestId };
          grants.issue(grant, identity.owner); return grant;
        },
        revoke: () => { grants.revoke(identity.requestId, identity.owner); }
      }
    });
    const outcome = await adapter.run({ ...identity, turnId: "turn", conversationId: "conversation", connection: { connectionId: record.connectionId, adapterId: record.adapterId, configRevision: 1, credentialEpoch: 1 }, intent: { action: "discuss", canvasId: identity.canvasId, prompt, model }, prepared, history: [], signal: AbortSignal.timeout(100000), emit: () => {} });
    expect(outcome.status, JSON.stringify({ status: outcome.status, error: outcome.error, called }).replaceAll(apiKey, "[redacted]")).toBe("succeeded");
    expect(called).toEqual(expect.arrayContaining(["workspace_read", "workspace_write", "workspace_execute", "workspace_query"]));
    const expected = String(numbers.reduce((sum, value) => sum + value, 0));
    expect(fs.readFileSync(path.join(runDir, "result.txt"), "utf8").trim()).toBe(expected);
    const state = JSON.parse(fs.readFileSync(path.join(root, "state/canvas-workspaces.json"), "utf8"));
    expect(Object.values(state.executions)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "exited", exitCode: 0 })]));
    console.info(JSON.stringify({ evidence: "real-sdk-workspace", model, tools: called, nodeExitCode: 0, resultVerified: true, contentReceipt: outcome.receipt ?? null }));
  } finally {
    grants.revoke(identity.requestId, identity.owner); await handler.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await daemon.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
