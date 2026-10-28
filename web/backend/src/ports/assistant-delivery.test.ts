import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, readFilmSetConversionNodeStatus,
  type AgentConversationAdapter, type FilmSetConversionProvider, type FilmSetConversionGenerator, type CanvasNodeData } from "@woohaa3/contracts";
import { createAgentConversationService } from "../../../services/application-service/src/extensions/agent-conversation-service.js";
import { createAgentAdapterRegistry } from "../../../services/application-service/src/extensions/agent-adapter-registry.js";
import { createAgentConnectionRegistry } from "../../../services/application-service/src/extensions/agent-connection-registry.js";
import { candidateAssistantDirectory } from "../../../services/application-service/src/extensions/agent-candidate-directory.js";
import { createSqliteAgentConversationStore } from "../../../services/application-service/src/repository/agent-conversation-repository.js";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/index.js";
import { SqliteFilmSetConversionRegistry } from "../../../services/canvas-service/src/storage/sqlite/film-set-conversion.js";
import { FilmSetConversionService } from "../../../extensions/film-set/src/authoring/backend/film-set-conversion.js";
import { createAssistantDeliveryPort } from "./assistant-delivery.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
const caps = { structuredCandidateOutput: true, input: { imageInput: true, maxImages: 8, videoInput: false, maxFrames: 0, maxDurationSeconds: 0 } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function candidate() {
  const snapshot = createFilmSetSnapshot({ title: "Scene", timeline: { duration: 0, loop: false },
    model: { modelScript: "scene.box({ id: 'body', size: [1, 2, 1] });", modelScriptVersion: "woohaa-model-js-v2" } });
  return { filmSetContent: snapshot.filmSetContent, filmSetAnimations: snapshot.filmSetAnimations, sceneCamera: snapshot.sceneCamera };
}
async function fixture(generator: FilmSetConversionGenerator, options: { generationTimeoutMs?: number; submitBudgetMs?: number; authorize?: () => Promise<boolean>; candidateOnly?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "delivery-integration-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = path.join(directory, "ledger.sqlite");
  let store = createSqliteAgentConversationStore({ path: ledgerPath });
  cleanup.push(() => store.close());
  const run = vi.fn(async () => ({ status: "failed" as const }));
  const adapter: AgentConversationAdapter = { id: "agent", capabilities: () => ({ discussion: true, tools: true, models: "none", targets: ["film-set"] }),
    authorization: async () => "ready", models: async () => ({ models: [] }), run };
  const provider: FilmSetConversionProvider = { providerId: "vision", assistantAdapterId: "agent", listModels: () => options.candidateOnly ? [{ modelKey: "vision:model", assistant: { adapterId: "agent", model: "model" }, label: "Vision model", supports: ["image"], capabilities: caps }] : [],
    resolveCapabilities: () => ({ modelKey: "vision:model", capabilities: caps }), createGenerator: () => generator };
  const registryHost = candidateAssistantDirectory({ hasCapability: () => !options.candidateOnly,
    resolveCapabilityOwner: () => ({ extensionId: "test", configVersion: 1, mode: "public" }),
    resolveCapability: () => adapter, snapshot: () => options.candidateOnly ? [] : [{ extensionId: "test", capabilities: ["agent-conversation-adapter:agent"] }] }, () => [provider]);
  const registry = createAgentAdapterRegistry(registryHost);
  const connections = options.candidateOnly ? createAgentConnectionRegistry(registryHost) : undefined;
  let conversations = createAgentConversationService({ store, registry, connections });
  const execution = createAssistantDeliveryPort(() => conversations, () => [provider]);
  const room = new CanvasRoom({ canvasId: "canvas", repository: new InMemoryYjsDocumentRepository() });
  const base = createEmptyWoohaa3ServerCanvas("canvas", new Date().toISOString());
  await room.initialize({ canvas: { ...base, document: { ...base.document, nodes: [{ id: "image", type: "image", position: { x: 0, y: 0 } }] },
    nodeData: { image: { outputAssetId: "asset" } as CanvasNodeData }, assets: [{ id: "asset", title: "Image", mediaKind: "image", source: "uploaded", status: "ready", createdAt: "2026-10-21T00:00:00.000Z",
      metadata: { checksum: "original-image", width: 100, height: 100, storageKey: "image-bytes", contentType: "image/png" } }] }, roomEpoch: "epoch", createdAt: "2026-10-21T00:00:00.000Z" });
  const domainPath = path.join(directory, "domain.sqlite");
  let records = new SqliteFilmSetConversionRegistry({ path: domainPath });
  cleanup.push(() => records.close());
  const createDomain = () => new FilmSetConversionService({ registry: records, resolveRoom: async () => room, generator, execution, ...options,
    resolveModelCapabilities: async () => ({ modelKey: "vision:model", capabilities: caps }) });
  const domain = createDomain();
  const request = (id = "a") => ({ canvasId: "canvas", requestId: id, sourceNodeId: "image", sourceKind: "image" as const, targetNodeId: `target-${id}`, subject: "owner", settings: { modelKey: "vision:model", instruction: "Build the scene" } });
  return { domain, records: () => records, room, request, run, connections, conversations: () => conversations,
    reopen() { store.close(); records.close(); store = createSqliteAgentConversationStore({ path: ledgerPath }); records = new SqliteFilmSetConversionRegistry({ path: domainPath });
      conversations = createAgentConversationService({ store, registry, connections }); return createDomain(); } };
}

describe("conversion delivery through the real ledger and Canvas authority", () => {
  it.each([false, true])("keeps long generation and its full stream until cancel=%s", async cancel => {
    const gate = deferred();
    const text = "scene-data-".repeat(3000);
    let signal!: AbortSignal;
    const f = await fixture(async input => {
      signal = input.signal;
      input.emit?.({ type: "message", role: "assistant", content: text.slice(0, 9000), delivery: "append" });
      input.emit?.({ type: "message", role: "assistant", content: text.slice(9000), delivery: "append" });
      await gate.promise;
      return { ok: true, candidate: candidate() };
    });
    vi.useFakeTimers();
    try {
      const submitted = f.domain.submit(f.request());
      await vi.advanceTimersByTimeAsync(20_000);
      await submitted;
      await vi.waitFor(() => expect(signal).toBeDefined());
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const read = f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" });
      expect(read).toMatchObject({ ok: true, turn: { status: "running" } });
      if (!read.ok) throw new Error("missing parent");
      expect(read.snapshot.messages.filter(message => message.role === "assistant")).toMatchObject([{ content: text, truncated: false }]);
      expect(signal.aborted).toBe(false);
      if (cancel) await f.domain.cancel({ canvasId: "canvas", requestId: "a" });
      gate.resolve();
      await f.domain.whenSettled();
      expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: cancel ? "cancelled" : "succeeded" } });
      if (!cancel) {
        const canvas = f.room.exportCanvas();
        expect(canvas.ok && readFilmSetConversionNodeStatus(canvas.canvas.nodeData["target-a"])).toMatchObject({ status: "completed" });
      }
    } finally { gate.resolve(); vi.useRealTimers(); }
  });

  it.each(["canvas-response", "registry-projection"])("keeps durable success when %s is lost", async failure => {
    const generate = vi.fn(async () => ({ ok: true as const, candidate: candidate() }));
    const f = await fixture(generate);
    if (failure === "canvas-response") {
      const submit = f.room.submitDerived.bind(f.room);
      f.room.submitDerived = async input => { const result = await submit(input); if (input.commandId === "film-set-conversion:canvas:a") throw new Error("response lost after commit"); return result; };
    } else {
      const put = f.records().put.bind(f.records());
      f.records().put = async record => { if (record.state === "completed") throw new Error("projection unavailable"); await put(record); };
    }
    await f.domain.submit(f.request()); await f.domain.whenSettled();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "succeeded", receipt: { commandId: "film-set-conversion:canvas:a" } } });
    const reopened = f.reopen();
    expect(await reopened.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "completed" } });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("settles an accepted parent if persisting its domain link fails before dispatch", async () => {
    const generate = vi.fn(async () => ({ ok: true as const, candidate: candidate() }));
    const f = await fixture(generate);
    const put = f.records().put.bind(f.records());
    let interrupt = true;
    f.records().put = async record => { if (interrupt && record.execution) { interrupt = false; throw new Error("link write interrupted"); } await put(record); };
    await f.domain.submit(f.request()); await f.domain.whenSettled();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "failed" } });
    expect((await f.records().get("canvas", "a"))?.execution?.turnRequestId).toBe("conversion:a:1");
    expect(generate).not.toHaveBeenCalled();
  });
  it("reopens accepted SQLite records without dispatch and reconciles a detail-side stop", async () => {
    const generate = vi.fn(async () => ({ ok: true as const, candidate: candidate() }));
    const f = await fixture(generate);
    const created = f.conversations().createConversation({ owner: "owner", canvasId: "canvas", nodeId: "target-a", adapterId: "agent" });
    if (!created.ok) throw new Error(created.error.message);
    const accepted = f.conversations().acceptDeliveryTurn({ owner: "owner", conversationId: created.conversation.conversationId, requestId: "conversion:a:1",
      entry: { action: "generate", canvasId: "canvas", nodeId: "target-a", mode: "film-set", prompt: "Create" },
      delivery: { purpose: "film-set-conversion", domainRequestId: "a", attemptId: "1" } });
    expect(accepted.ok).toBe(true);
    await f.records().put({ canvasId: "canvas", requestId: "a", sourceNodeId: "image", targetNodeId: "target-a", sourceKind: "image", subject: "owner",
      inputHash: "input", frozenSource: { nodeId: "image", kind: "image", contentHash: "frozen" }, title: "Image", settings: {}, step: "prepare-source", state: "running", attempt: 1,
      execution: { canvasId: "canvas", targetNodeId: "target-a", conversationId: created.conversation.conversationId, turnRequestId: "conversion:a:1", domainRequestId: "a", attemptId: "1" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const reopened = f.reopen();
    expect(await reopened.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "failed", code: "unknown-result" } });
    expect(f.conversations().cancelTurn({ owner: "owner", requestId: "conversion:a:1" })).toEqual({ ok: true });
    expect(await reopened.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "failed" } });
    expect((await f.records().get("canvas", "a"))?.state).toBe("failed");
    expect(generate).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("preserves registered candidate-only providers in the common directory without enabling ordinary writes", async () => {
    const generate = vi.fn(async () => ({ ok: true as const, candidate: candidate() }));
    const f = await fixture(generate, { candidateOnly: true });
    const connection = (await f.connections!.listConnections({ owner: "owner" }))[0]!;
    expect(connection.connectionId).toBe("candidate:vision");
    await f.domain.submit({ ...f.request(), settings: { ...f.request().settings, connection: { connectionId: connection.connectionId, adapterId: connection.adapterId, configRevision: connection.configRevision, credentialEpoch: connection.credentialEpoch } } }); await f.domain.whenSettled();
    const query = f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" });
    expect(query).toMatchObject({ ok: true, turn: { status: "succeeded", connection: { connectionId: "candidate:vision" } } });
    if (!query.ok) throw new Error("missing delivery");
    expect(f.conversations().acceptTurn({ owner: "owner", conversationId: query.conversation.conversationId, requestId: "ordinary",
      entry: { action: "modify", canvasId: "canvas", nodeId: "target-a", mode: "film-set", prompt: "modify" } })).toMatchObject({ ok: false, error: { code: "capability-unsupported" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("settles an upstream hard timeout even when inference ignores abort, and discards its late output", async () => {
    const gate = deferred();
    const f = await fixture(async () => { await gate.promise; return { ok: true, candidate: candidate() }; }, { generationTimeoutMs: 50 });
    await f.domain.submit(f.request());
    await f.domain.whenSettled();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "failed" } });
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(await f.domain.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "failed" } });
  });

  it("rechecks revoked write permission after inference and preserves the empty target", async () => {
    let allowed = true;
    const f = await fixture(async () => { allowed = false; return { ok: true, candidate: candidate() }; }, { authorize: async () => allowed });
    await f.domain.submit(f.request()); await f.domain.whenSettled();
    expect(await f.domain.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "failed", code: "unauthorized" } });
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "failed" } });
  });
  it("returns accepted before inference finishes, exposes real messages and waits for the commit receipt", async () => {
    const gate = deferred();
    const generate = vi.fn(async (input: Parameters<FilmSetConversionGenerator>[0]) => {
      input.emit?.({ type: "message", role: "assistant", content: "Actual candidate response", streamId: input.requestId, delivery: "replace" });
      await gate.promise;
      return { ok: true as const, candidate: candidate() };
    });
    const f = await fixture(generate, { submitBudgetMs: 1000 });
    const accepted = await f.domain.submit(f.request());
    expect(accepted).toMatchObject({ ok: true, status: { status: "running", execution: { domainRequestId: "a", turnRequestId: "conversion:a:1" } } });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const query = f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" });
    expect(query).toMatchObject({ ok: true, turn: { status: "running" } });
    if (!query.ok) throw new Error("missing parent");
    const detail = f.conversations().readConversation({ owner: "owner", conversationId: query.conversation.conversationId });
    expect(detail.ok && detail.snapshot.messages.map(message => message.content)).toContain("Actual candidate response");
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.domain.submit(f.request())).toMatchObject({ ok: true });
    expect(generate).toHaveBeenCalledOnce();
    gate.resolve(); await f.domain.whenSettled();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "succeeded", receipt: { commandId: "film-set-conversion:canvas:a" } } });
    const canvas = f.room.exportCanvas();
    expect(canvas.ok && readFilmSetConversionNodeStatus(canvas.canvas.nodeData["target-a"])).toMatchObject({ status: "completed", execution: { turnRequestId: "conversion:a:1" } });
    const reopened = f.reopen();
    expect(await reopened.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "completed" } });
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "succeeded" } });
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(["image", "second-image"])("keeps parents independent with B sourced from %s, stops only A and rejects its late candidate", async sourceNodeId => {
    const gates = [deferred(), deferred()];
    const generate = vi.fn(async (input: Parameters<FilmSetConversionGenerator>[0]) => {
      await gates[input.requestId.includes(":a:") ? 0 : 1]!.promise;
      return { ok: true as const, candidate: candidate() };
    });
    const f = await fixture(generate);
    if (sourceNodeId !== "image") {
      await f.room.submitDerived({ commandId: "second-source", derive: canvas => ({ ok: true, batch: {
        protocolVersion: 1, canvasId: "canvas", commandId: "second-source", actorId: "test", baseRevision: canvas.revision,
        commands: [{ type: "node.add", node: { id: sourceNodeId, type: "image", position: { x: 800, y: 0 } }, nodeData: { outputAssetId: "asset" } }],
      } }) });
    }
    await Promise.all([f.domain.submit(f.request("a")), f.domain.submit({ ...f.request("b"), sourceNodeId })]);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(f.conversations().cancelTurn({ owner: "owner", requestId: "conversion:a:1" })).toEqual({ ok: true });
    gates[1]!.resolve(); gates[0]!.resolve(); await f.domain.whenSettled();
    expect(await f.domain.status({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "cancelled" } });
    expect(await f.domain.status({ canvasId: "canvas", requestId: "b" })).toMatchObject({ ok: true, status: { status: "completed" } });
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "cancelled" } });
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:b:1" })).toMatchObject({ ok: true, turn: { status: "succeeded" } });
    expect(f.conversations().queryTurn({ owner: "another-owner", requestId: "conversion:b:1" }).ok).toBe(false);
  });
  it("retains the failed parent and retries a saved candidate without another inference", async () => {
    const generate = vi.fn(async () => ({ ok: true as const, candidate: candidate() }));
    const f = await fixture(generate);
    const submit = f.room.submitDerived.bind(f.room);
    let refuse = true;
    f.room.submitDerived = input => input.commandId === "film-set-conversion:canvas:a" && refuse
      ? Promise.resolve({ ok: false as const, status: "failed" as const, commandId: input.commandId, code: "storage-unavailable", message: "Save unavailable" }) : submit(input);
    await f.domain.submit(f.request()); await f.domain.whenSettled();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "failed" } });
    expect((await f.records().get("canvas", "a"))?.candidate).toBeTruthy();
    refuse = false;
    await f.domain.retry({ canvasId: "canvas", requestId: "a" }); await f.domain.whenSettled();
    expect(generate).toHaveBeenCalledOnce();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "failed" } });
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1:save:1" })).toMatchObject({ ok: true, turn: { status: "succeeded", receipt: { commandId: "film-set-conversion:canvas:a" } } });
  });

  it("waits for an admitted Canvas transaction when cancellation races its receipt", async () => {
    const f = await fixture(async () => ({ ok: true, candidate: candidate() }));
    const submit = f.room.submitDerived.bind(f.room);
    const entered = deferred(); const receipt = deferred();
    f.room.submitDerived = async input => {
      const result = await submit(input);
      if (input.commandId === "film-set-conversion:canvas:a") { entered.resolve(); await receipt.promise; }
      return result;
    };
    await f.domain.submit(f.request()); await entered.promise;
    f.conversations().cancelTurn({ owner: "owner", requestId: "conversion:a:1" });
    receipt.resolve(); await f.domain.whenSettled();
    expect(f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" })).toMatchObject({ ok: true, turn: { status: "succeeded" } });
    expect(await f.domain.cancel({ canvasId: "canvas", requestId: "a" })).toMatchObject({ ok: true, status: { status: "completed" } });
  });

  it("associates bounded repairs with independent child requests and preserves diagnostics", async () => {
    const generate = vi.fn(async (input: Parameters<FilmSetConversionGenerator>[0]) => ({ ok: true as const, candidate: input.repair ? candidate() : {} }));
    const f = await fixture(generate);
    await f.domain.submit(f.request()); await f.domain.whenSettled();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.map(([input]) => input.requestId)).toEqual(["conversion:a:1:candidate:0", "conversion:a:1:candidate:1"]);
    expect(generate.mock.calls[1]![0].repair?.message).toBeTruthy();
    const turn = f.conversations().queryTurn({ owner: "owner", requestId: "conversion:a:1" });
    if (!turn.ok) throw new Error("missing parent");
    const detail = f.conversations().readConversation({ owner: "owner", conversationId: turn.conversation.conversationId });
    expect(detail.ok && detail.snapshot.events.some(event => JSON.stringify(event).includes("repair-candidate"))).toBe(true);
    expect(turn.turn.tools).toEqual([]);
    expect((await f.domain.submit({ ...f.request(), targetNodeId: "other-target" })).ok).toBe(false);
    expect((await f.domain.submit({ ...f.request(), subject: "another-owner" })).ok).toBe(false);
  });

});
