import { describe, expect, it, vi } from "vitest";
import { access, readFile } from "node:fs/promises";
import { createEmptyWoohaa3ServerCanvas, createFilmSetConversionProviderSet, type AgentConversationAdapter, type FilmSetConversionGenerationInput } from "@woohaa3/contracts";
import { createAssistantFilmSetConversionProvider, withAgentImageFiles } from "./candidate-generation.js";

function fixture(id = "local") {
  const run = vi.fn<AgentConversationAdapter["run"]>(async () => ({ status: "succeeded", assistantText: '```json\n{"items":[],"clips":[]}\n```' }));
  const adapter: AgentConversationAdapter = { id, run, capabilities: () => ({ discussion: true, tools: true, targets: [], models: "remote" }), authorization: async () => "ready", models: async () => ({ models: [] }) };
  const readAsset = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }));
  const readVideoFrames = vi.fn(async () => [{ timestampSeconds: 3, bytes: new Uint8Array([4]), contentType: "image/jpeg" }, { timestampSeconds: 13, bytes: new Uint8Array([5]), contentType: "image/jpeg" }]);
  const provider = createAssistantFilmSetConversionProvider(adapter);
  const set = createFilmSetConversionProviderSet([provider]);
  const input: FilmSetConversionGenerationInput = { subject: "owner", canvasId: "canvas", requestId: "conversion:parent:1:candidate:0", title: "source",
    modelKey: `${id}:vision`, settings: { connection: { connectionId: "connection", adapterId: id, configRevision: 2, credentialEpoch: 3 } },
    frozenSource: { nodeId: "source", kind: "image", contentHash: "hash" }, media: { storageKey: "real-media", contentType: "image/png" },
    canvas: createEmptyWoohaa3ServerCanvas("canvas", "now"), signal: new AbortController().signal };
  return { run, provider, set, input, readAsset, readVideoFrames, generate: set.createGenerator({ media: { readAsset, readVideoFrames } })! };
}

describe("assistant candidate execution", () => {
  it.each(["codex-appserver", "opencode-server", "codebuddy-server", "openai-responses", "anthropic-messages", "deepseek-chat", "gemini-agent-adk"])("%s routes explicit owner models without a global model catalog", async id => {
    const f = fixture(id);
    expect(f.set.listModels()).toEqual([]);
    expect(f.set.resolveCapabilities({ modelKey: `${id}:vision`, sourceKind: "video" })?.capabilities.input.maxImages).toBe(12);
    expect(f.set.resolveCapabilities({ modelKey: "other:vision", sourceKind: "image" })).toBeNull();
    expect(await f.generate(f.input)).toMatchObject({ ok: true, candidate: { filmSetContent: { items: [] } } });
    expect(f.readAsset).toHaveBeenCalledWith("real-media", "canvas");
    const call = f.run.mock.calls[0]![0];
    expect(call).toMatchObject({ owner: "owner", connection: f.input.settings.connection, intent: { action: "discuss", model: "vision" }, history: [], candidate: { images: [{ bytes: new Uint8Array([1,2,3]), contentType: "image/png" }], outputSchema: { type: "object" } } });
    expect(call.intent.nodeId).toBeUndefined();
    expect(call.requestId).toBe(f.input.requestId);
  });
  it("passes the full selected video range and actual timestamped frames, with isolated repair context", async () => {
    const f = fixture();
    f.input.frozenSource = { ...f.input.frozenSource, kind: "video", range: { startSeconds: 3, endSeconds: 13 }, durationSeconds: 20 };
    expect(await f.generate(f.input)).toMatchObject({ ok: true });
    expect(f.readAsset).not.toHaveBeenCalled();
    expect(f.readVideoFrames).toHaveBeenCalledWith({ storageKey: "real-media", range: { startSeconds: 3, endSeconds: 13 }, durationSeconds: 20, maxFrames: 12, canvasId: "canvas" });
    expect(f.run.mock.calls[0]![0].candidate?.images).toHaveLength(2);
    expect(f.run.mock.calls[0]![0].intent.prompt).toContain("13");
    await f.generate({ ...f.input, requestId: "conversion:parent:1:candidate:1" });
    expect(f.run.mock.calls[1]![0].conversationId).not.toBe(f.run.mock.calls[0]![0].conversationId);
  });
  it("rejects missing binding, malformed JSON, media budgets and cancellation without a text fallback", async () => {
    const f = fixture();
    expect(await f.generate({ ...f.input, settings: {} })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(f.run).not.toHaveBeenCalled();
    f.run.mockResolvedValue({ status: "succeeded", assistantText: "not json" });
    expect(await f.generate(f.input)).toMatchObject({ ok: false, code: "candidate-invalid" });
    f.readVideoFrames.mockRejectedValue(new Error("frame budget exceeded"));
    expect(await f.generate({ ...f.input, frozenSource: { ...f.input.frozenSource, kind: "video" } })).toMatchObject({ ok: false, code: "budget-exceeded" });
    const signal = AbortSignal.abort();
    expect(await f.generate({ ...f.input, signal })).toMatchObject({ ok: false, code: "cancelled" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("replacement providers do not reuse disposed generators", async () => {
    const f = fixture(); let providers = [f.provider];
    const set = createFilmSetConversionProviderSet(() => providers);
    const generate = set.createGenerator({ media: { readAsset: f.readAsset } })!;
    await generate(f.input);
    const replacement = fixture(); providers = [replacement.provider];
    await generate(f.input);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(replacement.run).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("temporary native image files are removed after failure=%s", async fail => {
    let file = "";
    const operation = withAgentImageFiles([{ bytes: new Uint8Array([7,8]), contentType: "image/png" }], async files => {
      file = files[0]!; expect([...await readFile(file)]).toEqual([7,8]);
      if (fail) throw new Error("stopped");
    });
    if (fail) await expect(operation).rejects.toThrow("stopped"); else await operation;
    await expect(access(file)).rejects.toThrow();
  });
});
