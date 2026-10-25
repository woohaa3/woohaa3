import { describe, expect, it, vi } from "vitest";
import { createAgentFilmSetConversionProvider } from "./agent-film-set-conversion.js";
import { createFilmSetConversionProviderSet, filmSetConversionAssistantKey, createEmptyWoohaa3ServerCanvas, type AgentAdapterRunInput, type AgentAdapterRunOutcome, type AgentConnectionView, type FilmSetConversionGenerationInput } from "@woohaa3/contracts";
import type { AgentAdapterRegistryHost } from "@woohaa3/application-service";

function fixture() {
  const connection = { connectionId: "local-codex", adapterId: "codex-appserver", configRevision: 2, credentialEpoch: 3, authMode: "local-login", ready: true, models: [] } as unknown as AgentConnectionView;
  const run = vi.fn<(input: AgentAdapterRunInput) => Promise<AgentAdapterRunOutcome>>(async () => ({ status: "succeeded", assistantText: '```json\n{"filmSetContent":{"items":[]}}\n```' }));
  const getConnection = vi.fn(async ({ owner }: { owner: string }) => owner === "instance-owner" ? connection : null);
  const values: Record<string, unknown> = {
    "agent-connection-provider:local": { id: "local", listConnections: async () => [connection], getConnection },
    "agent-conversation-adapter:codex-appserver": { id: "codex-appserver", capabilities: () => ({ discussion: true, targets: ["film-set"], tools: true, models: "remote" }), authorization: async () => "ready", models: async () => ({ models: [{ id: "vision", label: "Vision", reasoningEfforts: ["high"] }] }), run }
  };
  const host: AgentAdapterRegistryHost = { snapshot: () => [{ extensionId: "local", capabilities: Object.keys(values) }], hasCapability: id => id in values, resolveCapability: id => values[id], resolveCapabilityOwner: () => ({ extensionId: "local", configVersion: 1, mode: "public" }) };
  const provider = createAgentFilmSetConversionProvider({ host: () => host, accessRuntime: { enabled: false, instance: { kind: "instance", id: "instance", ownerId: "instance-owner", credentialOwnerId: "local:instance" } } });
  const bytes = new Uint8Array([1, 2, 3]);
  const readAsset = vi.fn(async () => ({ bytes, contentType: "image/png" }));
  const modelKey = filmSetConversionAssistantKey({ connection });
  const set = createFilmSetConversionProviderSet([provider]);
  const generate = set.createGenerator({ media: { readAsset } })!;
  const input = { canvasId: "canvas", requestId: "request", frozenSource: { kind: "image", assetId: "asset" }, title: "参考图", settings: { modelKey, instruction: "还原建筑" }, modelKey, canvas: createEmptyWoohaa3ServerCanvas("canvas", "now"), media: { storageKey: "source-image", contentType: "image/png" }, signal: new AbortController().signal,
    // This legacy cookie owner must never select another user's assistant connection.
    ownerId: "local:legacy-oauth", subject: "untrusted-in-local-mode" } as FilmSetConversionGenerationInput;
  return { connection, run, readAsset, bytes, set, generate, input, values, host };
}

describe("转片场复用助手连接", () => {
  it("动态助手选择不依赖旧模型列表，默认模型传真实图片且不开工具", async () => {
    const f = fixture();
    expect(f.set.listModels()).toEqual([]);
    expect(f.set.resolveCapabilities({ modelKey: f.input.modelKey, sourceKind: "image" })).not.toBeNull();
    expect(await f.generate(f.input)).toMatchObject({ ok: true });
    expect(f.readAsset).toHaveBeenCalledWith("source-image", "canvas");
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]).toEqual([expect.objectContaining({ owner: "instance-owner", connection: expect.objectContaining({ connectionId: "local-codex", configRevision: 2, credentialEpoch: 3 }), history: [], images: [expect.objectContaining({ bytes: f.bytes, contentType: "image/png" })], intent: expect.objectContaining({ action: "discuss", prompt: expect.stringContaining("还原建筑") }) })]);
    expect(f.run.mock.calls[0]![0].intent).not.toHaveProperty("model");
  });
  it("明确的模型与 Variant 交给同一个助手", async () => {
    const f = fixture();
    f.input.modelKey = filmSetConversionAssistantKey({ connection: f.connection, model: "vision", reasoningEffort: "high" });
    expect(await f.generate(f.input)).toMatchObject({ ok: true });
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ intent: expect.objectContaining({ model: "vision", reasoningEffort: "high" }) }));
  });
  it.each(["owner", "revision", "disabled", "model"])("%s 失效时不读取图片、不调用其他助手", async mode => {
    const f = fixture();
    if (mode === "owner") f.connection.connectionId = "not-owned";
    if (mode === "revision") f.connection.configRevision++;
    if (mode === "disabled") delete f.values["agent-conversation-adapter:codex-appserver"];
    if (mode === "model") f.input.modelKey = filmSetConversionAssistantKey({ connection: f.connection, model: "removed" });
    expect(await f.generate(f.input)).toMatchObject({ ok: false });
    expect(f.readAsset).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("跨用户解析连接时使用可信主体", async () => {
    const f = fixture();
    const provider = createAgentFilmSetConversionProvider({ host: () => f.host, accessRuntime: { enabled: true } });
    expect(await provider.createGenerator({ media: { readAsset: f.readAsset } })!(f.input)).toMatchObject({ ok: false });
    expect(f.run).not.toHaveBeenCalled();
  });
});
