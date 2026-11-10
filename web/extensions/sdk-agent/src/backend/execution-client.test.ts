import { describe, expect, it, vi } from "vitest";
import type { AgentAdapterRunInput, ApplicationExtensionExecutorFacade } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord, ConnectionService } from "@woohaa3/agent-connections";
import { buildTestPreparedTurn } from "@woohaa3/test-fixtures-agent-role-turns";
import { findSdkAgentAdapter } from "../shared.js";
import { createSdkAgentConversationAdapter } from "./execution-client.js";

describe("SDK executor host authority", () => {
  it("binds credentials, tools and native sessions to the trusted turn and revokes tools on completion", async () => {
    const record: ConnectionMetadataRecord = { owner: "owner", connectionId: "connection", adapterId: "openai-responses", name: "API", runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, createdAt: "now", updatedAt: "now" };
    const service = { get: vi.fn(async () => record), readCredential: vi.fn(async () => ({ secret: "private-key" })), setNativeBinding: vi.fn() } as unknown as ConnectionService;
    const tools = { issue: vi.fn(async () => ({ token: "grant", canvasIds: ["canvas"], nodeIds: ["node"], tools: ["get_world_context"], workId: "request" })), revoke: vi.fn() };
    const prepared = buildTestPreparedTurn({ requestId: "request", target: { canvasId: "canvas", nodeId: "node", mode: "model3d" }, prompt: "modify", tools: ["get_world_context"] });
    const input: AgentAdapterRunInput = { owner: "owner", conversationId: "conversation", canvasId: "canvas", requestId: "request", turnId: "turn",
      connection: { connectionId: "connection", adapterId: "openai-responses", configRevision: 1, credentialEpoch: 1 }, history: [],
      intent: { action: "modify", canvasId: "canvas", nodeId: "node", mode: "model3d", prompt: "modify", model: "fixture" }, prepared,
      signal: new AbortController().signal, emit: vi.fn() };
    const executor: ApplicationExtensionExecutorFacade = {
      query: vi.fn(), cancel: vi.fn(),
      async run(request) {
        expect(JSON.stringify(request.payload)).not.toContain("private-key");
        expect(request).toMatchObject({ executor: "sdk-agent", owner: "owner", requestId: "request", prepared });
        expect(await request.hostCall!("connection.credential", [{ owner: "attacker", connectionId: "foreign" }])).toEqual({ secret: "private-key" });
        expect(service.readCredential).toHaveBeenCalledWith({ owner: "owner", connectionId: "connection", purpose: "model-api-key" });
        await request.hostCall!("tools.issue", [{ delegation: { subject: "attacker" }, canvasId: "foreign", nodeId: "foreign", tools: ["delete_canvas"] }]);
        expect(tools.issue).toHaveBeenCalledWith(expect.objectContaining({ delegation: { subject: "owner", authLevel: "authenticated" }, canvasId: "canvas", nodeId: "node", workId: "request", tools: prepared.tools }));
        await request.hostCall!("connection.native.set", [{ credentialEpoch: 99, conversationId: "foreign", threadId: "thread" }]);
        expect(service.setNativeBinding).toHaveBeenCalledWith(expect.objectContaining({ owner: "owner", connectionId: "connection", native: expect.objectContaining({ credentialEpoch: 1, conversationId: "conversation" }) }));
        await expect(request.hostCall!("host.arbitrary", [])).rejects.toThrow("Unknown SDK host method");
        record.credentialEpoch++;
        await expect(request.hostCall!("connection.credential", [])).rejects.toThrow("authorization changed");
        return { status: "succeeded", result: { outcome: { status: "succeeded", assistantText: "done" } } };
      }
    };
    const adapter = createSdkAgentConversationAdapter(findSdkAgentAdapter("openai-responses")!, { service, tools, executor, allowHttp: false });
    expect(await adapter.run(input)).toMatchObject({ status: "succeeded", assistantText: "done" });
    expect(tools.revoke).toHaveBeenCalledWith("request", { subject: "owner", authLevel: "authenticated" });
  });

  it("refuses execution when the independent runtime is absent", async () => {
    const service = {} as ConnectionService;
    const adapter = createSdkAgentConversationAdapter(findSdkAgentAdapter("openai-responses")!, { service, allowHttp: false });
    expect(await adapter.run({} as AgentAdapterRunInput)).toMatchObject({ status: "failed", error: { code: "runtime-unavailable" } });
  });

  it("preserves the daemon cancellation and committed receipt when a late result succeeds", async () => {
    const executor: ApplicationExtensionExecutorFacade = { run: vi.fn(), cancel: vi.fn(), query: vi.fn(async () => ({ status: "cancelled" as const, result: { outcome: { status: "succeeded", receipt: { committed: true } } } })) };
    const adapter = createSdkAgentConversationAdapter(findSdkAgentAdapter("openai-responses")!, { service: {} as ConnectionService, executor, allowHttp: false });
    expect(await adapter.query!({ owner: "owner", requestId: "request" })).toMatchObject({ status: "cancelled", receipt: { committed: true } });
  });
});
