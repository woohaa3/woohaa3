import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, createFilmSetConversionProviderSet,
  type AgentConversationAdapter, type AgentConnectionProvider, type AgentConnectionView, type FilmSetConversionProvider } from "@woohaa3/contracts";
import { createAssistantFilmSetConversionProvider, type ConnectionService, type ConnectionMetadataRecord } from "../../../services/agent-connections/src/index.js";
import { createLocalAgentConversationAdapter } from "../../../extensions/local-agent/src/backend/local-agent-connections.js";
import { LOCAL_AGENT_ADAPTERS } from "../../../extensions/local-agent/src/shared.js";
import type { ProcessManager } from "../../../extensions/local-agent/src/backend/process-manager.js";
import { createSdkAgentConversationAdapter } from "../../../extensions/sdk-agent/src/backend/sdk-agent-connections.js";
import { findSdkAgentAdapter } from "../../../extensions/sdk-agent/src/shared.js";
import { createChatGptFilmSetConversionGenerator } from "../../../extensions/oauth-agent/src/backend/conversion.js";
import type { CodexAdapter } from "../../../extensions/oauth-agent/src/backend/codex-adapter.js";
import { createAgentConversationService } from "../../../services/application-service/src/extensions/agent-conversation-service.js";
import { createAgentAdapterRegistry } from "../../../services/application-service/src/extensions/agent-adapter-registry.js";
import { createAgentConnectionRegistry } from "../../../services/application-service/src/extensions/agent-connection-registry.js";
import { createSqliteAgentConversationStore } from "../../../services/application-service/src/repository/agent-conversation-repository.js";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/index.js";
import { SqliteFilmSetConversionRegistry } from "../../../services/canvas-service/src/storage/sqlite/film-set-conversion.js";
import { FilmSetConversionService } from "../../../extensions/film-set/src/authoring/backend/film-set-conversion.js";
import { createAssistantDeliveryPort } from "./assistant-delivery.js";

it.each(["oauth", "local", "sdk"].flatMap(channel => ["image", "video"].flatMap(kind => [false, true].map(repair => [channel, kind, repair] as const))))("%s %s repair=%s enters the parent ledger, validates native candidate and commits the same target", async (channel, kind, repair) => {
  const root = mkdtempSync(path.join(tmpdir(), "assistant-channel-"));
  const store = createSqliteAgentConversationStore({ path: path.join(root, "ledger.sqlite") });
  const records = new SqliteFilmSetConversionRegistry({ path: path.join(root, "domain.sqlite") });
  let wallNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  try {
    const adapterId = channel === "local" ? "codex-appserver" : channel === "sdk" ? "openai-responses" : "chatgpt";
    const record: ConnectionMetadataRecord = { owner: "owner", connectionId: "connection", adapterId, configRevision: 1, credentialEpoch: 1,
      name: "Test", authMode: "api-key", runCategory: "agent-sdk", createdAt: "now", updatedAt: "now", models: ["vision"], runtimeVersion: "codex-agent-sdk@0.161.0:1" };
    record.lastStatus = { transport: { state: "ready", checkedAt: null }, credential: { state: "ready", checkedAt: null }, modelAccess: { state: "ready", checkedAt: null }, tools: { state: "ready", checkedAt: null } };
    const privateConnections = { get: async (owner: string) => owner === "owner" ? record : null, list: async () => [record],
      credentialConfigured: async () => true, readCredential: async () => ({ secret: "fixture-only" }), setStatus: vi.fn(), setRuntimeProbe: vi.fn(),
      resolveNativeBinding: vi.fn(), setNativeBinding: vi.fn() } as unknown as ConnectionService;
    const snapshot = createFilmSetSnapshot({ title: "Scene", timeline: { duration: 0, loop: false }, model: { modelScript: "scene.box({ id: 'body', size: [1, 2, 1] });", modelScriptVersion: "woohaa-model-js-v2" } });
    const raw = JSON.stringify({ items: snapshot.filmSetContent.items, clips: snapshot.filmSetAnimations!.clips, sceneCamera: snapshot.sceneCamera });
    const nativeInputs: unknown[] = [];
    const response = () => repair && nativeInputs.length === 1 ? '{"items":[],"clips":[]}' : raw;
    let adapter: AgentConversationAdapter;
    if (channel === "local") {
      const processManager = { ensure: async () => ({ workDir: root, configDir: root, stdio: null, loopbackUrl: null }), stop: vi.fn() } as unknown as ProcessManager;
      adapter = createLocalAgentConversationAdapter(LOCAL_AGENT_ADAPTERS[0]!, { service: privateConnections, processManager, argsFor: () => [], transports: {
        [adapterId]: { id: "codex-appserver", probe: async () => ({ ok: true }), run: async input => { nativeInputs.push(input); wallNow += 30 * 60_000; input.onEvent({ type: "message", role: "assistant", content: response() }); return { ok: true, outcome: { status: "succeeded", assistantText: response() } }; } }
      } });
    } else if (channel === "sdk") {
      adapter = createSdkAgentConversationAdapter(findSdkAgentAdapter(adapterId)!, { service: privateConnections, allowHttp: false, transports: {
        "codex-agent-sdk": { run: async input => { nativeInputs.push(input); wallNow += 30 * 60_000; input.onEvent({ type: "text-delta", text: response() }); return { ok: true, assistantText: response(), toolCalls: [], finishReason: "stop" }; } }
      } });
    } else adapter = { id: adapterId, capabilities: () => ({ discussion: true, tools: true, targets: ["film-set"], models: "remote" }), authorization: async () => "ready", models: async () => ({ models: [{ id: "vision", label: "Vision" }] }), run: vi.fn() };
    const readAsset = vi.fn(async () => ({ bytes: new Uint8Array([1,2]), contentType: "image/png" }));
    const readVideoFrames = vi.fn(async () => [0, 10].map(timestampSeconds => ({ timestampSeconds, bytes: new Uint8Array([timestampSeconds + 1]), contentType: "image/jpeg" })));
    const media = { readAsset, readVideoFrames };
    const nativeProvider = createAssistantFilmSetConversionProvider(adapter);
    const provider: FilmSetConversionProvider = channel === "oauth" ? { ...nativeProvider, createGenerator: () => createChatGptFilmSetConversionGenerator({ media, ownerId: "owner", model: "vision", codex: { run: async (input: Parameters<CodexAdapter["run"]>[0]) => { nativeInputs.push(input); wallNow += 30 * 60_000; return { finalResponse: response() }; } } as unknown as CodexAdapter }) } : nativeProvider;
    const view: AgentConnectionView = { connectionId: "connection", adapterId, extensionId: "test", name: "Assistant", runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, credentialConfigured: true, ready: true,
      capabilities: { discussion: true, tools: true, imageInput: false, structuredResult: false, cancel: true, resume: true },
      models: [{ id: "vision", label: "Vision", source: "user-provided", accountAuthorized: false }],
      status: { transport: { state: "ready", checkedAt: null }, credential: { state: "ready", checkedAt: null }, modelAccess: { state: "ready", checkedAt: null }, tools: { state: "ready", checkedAt: null } } };
    const connectionProvider: AgentConnectionProvider = { id: "test", listConnections: async ({ owner }) => owner === "owner" ? [view] : [], getConnection: async ({ owner }) => owner === "owner" ? view : null };
    const capabilities: Record<string, unknown> = { [`agent-conversation-adapter:${adapterId}`]: adapter, "agent-connection-provider:test": connectionProvider };
    const host = { hasCapability: (id: string) => id in capabilities, resolveCapability: (id: string) => capabilities[id], resolveCapabilityOwner: () => ({ extensionId: "test", configVersion: 1, mode: "public" as const }), snapshot: () => [{ extensionId: "test", capabilities: Object.keys(capabilities) }] };
    const conversations = createAgentConversationService({ store, registry: createAgentAdapterRegistry(host), connections: createAgentConnectionRegistry(host) });
    const room = new CanvasRoom({ canvasId: "canvas", repository: new InMemoryYjsDocumentRepository() });
    const base = createEmptyWoohaa3ServerCanvas("canvas", "now");
    await room.initialize({ canvas: { ...base, document: { ...base.document, nodes: [{ id: "source", type: kind, position: { x: 0, y: 0 } }] }, nodeData: { source: { outputAssetId: "asset" } }, assets: [{ id: "asset", title: "Source", mediaKind: kind as "image" | "video", source: "uploaded", status: "ready", createdAt: "now", metadata: { storageKey: "bytes", checksum: "original", width: 100, height: 100, durationSeconds: 10, contentType: kind === "image" ? "image/png" : "video/mp4" } }] }, roomEpoch: "epoch", createdAt: "now" });
    const providers = createFilmSetConversionProviderSet([provider]);
    const domain = new FilmSetConversionService({ registry: records, resolveRoom: async () => room, generator: providers.createGenerator({ media })!,
      resolveModelCapabilities: async input => providers.resolveCapabilities(input) ?? undefined, execution: createAssistantDeliveryPort(() => conversations, () => [provider]) });
    const request = { canvasId: "canvas", requestId: "create", sourceNodeId: "source", sourceKind: kind as "image" | "video", targetNodeId: "target", subject: "owner", settings: { modelKey: `${adapterId}:vision`, connection: { connectionId: "connection", adapterId, configRevision: 1, credentialEpoch: 1 } } };
    const accepted = await domain.submit(request); expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true }); await domain.whenSettled();
    expect(await domain.status({ canvasId: "canvas", requestId: "create" })).toMatchObject({ ok: true, status: { status: "completed", targetNodeId: "target" } });
    const query = conversations.queryTurn({ owner: "owner", requestId: "conversion:create:1" });
    expect(query).toMatchObject({ ok: true, turn: { status: "succeeded", receipt: { commandId: "film-set-conversion:canvas:create" } } });
    expect(query.ok && query.snapshot.messages.some(message => message.role === "assistant" && message.content === raw)).toBe(true);
    expect(nativeInputs).toHaveLength(repair ? 2 : 1);
    expect((nativeInputs[0] as { images: unknown[] }).images).toHaveLength(kind === "image" ? 1 : 2);
    expect(privateConnections.resolveNativeBinding).not.toHaveBeenCalled();
    expect(privateConnections.setNativeBinding).not.toHaveBeenCalled();
    await domain.status({ canvasId: "canvas", requestId: "create" });
    if (query.ok) conversations.readConversation({ owner: "owner", conversationId: query.conversation.conversationId });
    expect(nativeInputs).toHaveLength(repair ? 2 : 1);
  } finally { clock.mockRestore(); records.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
