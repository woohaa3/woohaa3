/** Opt-in: real provider -> real Claude harness -> native tools in the canvas cwd. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { preparedTurnHash, type PreparedAgentRoleTurn } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord, ConnectionService } from "../services/agent-connections/src/index.js";
import { CanvasWorkspaces } from "../../packages/execution-runtime/src/canvas-workspaces.js";
import { createSdkAgentConversationAdapter } from "../extensions/sdk-agent/src/backend/sdk-agent-connections.js";
import { findSdkAgentAdapter, sdkEngineForAdapter } from "../extensions/sdk-agent/src/shared.js";

const enabled = process.env.WOOHAA_WORKSPACE_LIVE_SDK === "1";
it.skipIf(!enabled)("real Claude discussion computes with native file/shell tools without workspace MCP", async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY, endpoint = process.env.ANTHROPIC_BASE_URL, model = process.env.WOOHAA_WORKSPACE_LIVE_MODEL;
  if (!apiKey || !endpoint || !model) throw new Error("Set ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL and WOOHAA_WORKSPACE_LIVE_MODEL");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-native-live-"));
  const identity = { owner: "acceptance", canvasId: randomUUID(), requestId: randomUUID() };
  const workspaces = new CanvasWorkspaces({ stateDir: path.join(root, "state"), defaultRoot: path.join(root, "workspaces"), profileKey: "acceptance" });
  const handle = await workspaces.acquire(identity), native = workspaces.attachHarness(handle);
  try {
    const output = `runs/${handle.runKey}/result.txt`;
    const prompt = `Use your built-in file and shell tools to read shared/input.json, create and execute a Node script that computes the sum, and write the decimal sum to ${output}. Reply with the sum after execution.`;
    const body: Omit<PreparedAgentRoleTurn, "preparedHash"> = { schemaVersion: 1, workspace: handle, roleRef: { namespacedId: "acceptance/reply", roleId: "reply", extensionId: "acceptance", revision: "1", descriptorDigest: "a".repeat(64), artifactId: "acceptance" }, messages: [{ role: "user", content: prompt }], tools: [], nativeCapabilities: [], output: { kind: "reply" }, inputDigest: "acceptance", contextDigest: "acceptance", attachmentDigests: [], target: { canvasId: identity.canvasId } };
    const prepared = { ...body, preparedHash: preparedTurnHash(body) };
    const numbers = Array.from({ length: 17 }, () => randomInt(1000, 10000));
    fs.writeFileSync(path.join(native.cwd, "shared/input.json"), JSON.stringify(numbers));
    const descriptor = findSdkAgentAdapter("anthropic-messages")!, engine = sdkEngineForAdapter(descriptor.adapterId)!;
    const baseUrl = endpoint.replace(/\/$/, "").replace(/(?:\/v1)?$/, "/v1"), now = new Date().toISOString();
    const record: ConnectionMetadataRecord = { owner: identity.owner, connectionId: "connection", adapterId: descriptor.adapterId, name: "acceptance", baseUrl, runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, createdAt: now, updatedAt: now, runtimeVersion: `${engine.engine}@${engine.version}:1`, models: [model] };
    const service = { get: async () => record, list: async () => [record], readCredential: async () => ({ secret: apiKey }), credentialConfigured: async () => true, setRuntimeProbe: async () => {}, setStatus: async () => {}, resolveNativeBinding: async () => null, setNativeBinding: async () => {} } as unknown as ConnectionService;
    const adapter = createSdkAgentConversationAdapter(descriptor, { workspace: native, service, allowHttp: new URL(baseUrl).protocol === "http:", allowedHosts: [new URL(baseUrl).hostname], agentSdkDirs: { configDir: path.join(root, "private-config"), workspaceDir: path.join(root, "private-work") } });
    const outcome = await adapter.run({ ...identity, turnId: "turn", conversationId: "conversation", connection: { connectionId: record.connectionId, adapterId: record.adapterId, configRevision: 1, credentialEpoch: 1 }, intent: { action: "discuss", canvasId: identity.canvasId, prompt, model }, prepared, history: [], signal: AbortSignal.timeout(100000), emit: () => {} });
    expect(outcome.status, JSON.stringify(outcome.error)).toBe("succeeded");
    expect(fs.readFileSync(path.join(native.cwd, output), "utf8").trim()).toBe(String(numbers.reduce((sum, n) => sum + n, 0)));
    expect(outcome.receipt).toBeUndefined();
  } finally { native.release(); await workspaces.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
