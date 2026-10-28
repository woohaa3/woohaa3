import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionView, CanvasCreationPort, CanvasCreationRequest } from "@woohaa3/contracts";
import { CanvasCreationStore } from "../repository/canvas-creation-store.js";
import { CanvasCreationService } from "./canvas-creation-service.js";
import type { AgentConversationService } from "./agent-conversation-service.js";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";

const directories: string[] = [];
const stores: CanvasCreationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch {} } for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa-canvas-create-")); directories.push(dir);
  const dbPath = path.join(dir, "creation.sqlite");
  const store = new CanvasCreationStore(dbPath); stores.push(store);
  const input: CanvasCreationRequest = { requestId: "r1", canvasId: "c1", prompt: "建立故事画布", position: { x: 100, y: 200 }, connection: { connectionId: "connection", adapterId: "test", configRevision: 1, credentialEpoch: 1 }, model: "real-model" };
  const connection = { ...input.connection, ready: true, authMode: "api-key", capabilities: { tools: true }, models: [{ id: "real-model", label: "Real model" }] } as unknown as AgentConnectionView;
  let root: { exists: boolean; revision?: number; scopeEpoch: number } = { exists: false, scopeEpoch: 0 };
  const canvas: CanvasCreationPort = {
    capabilities: vi.fn(async () => ({ ready: true })),
    lookupRoot: vi.fn(async () => ({ ...root })),
    ensureRoot: vi.fn(async () => { root = { exists: true, revision: 1, scopeEpoch: 0 }; return { revision: 1, scopeEpoch: 0 }; })
  };
  let turn: unknown;
  const conversations = {
    catalog: vi.fn(async () => ({ ok: true, models: connection.models, authState: "ready", capabilities: { targets: ["canvas-group"], tools: true } })),
    findConversationForTarget: vi.fn(() => ({ conversation: null })),
    createConversation: vi.fn((_input: { nodeId: string }) => ({ ok: true, conversation: { conversationId: "conv" } })),
    acceptTurn: vi.fn((_input: { conversationId: string; requestId: string }) => {
      expect(root.exists).toBe(true);
      turn = { ok: true, conversation: { conversationId: "conv" }, turn: { turnId: "turn" } };
      return { ...turn as object, reused: false };
    }),
    queryTurn: vi.fn(() => turn ?? { ok: false }),
    dispatchTurn: vi.fn(async () => undefined)
  };
  const dependencies = { store, conversations: conversations as unknown as AgentConversationService, canvas, connections: { getConnection: async ({ owner }: { owner: string }) => owner === "owner" ? connection : null } as unknown as AgentConnectionRegistry, preflight: async () => true, discoverTools: async () => ({ ready: true, tools: ["get_canvas_graph", "get_canvas_script_api", "validate_canvas_script", "submit_canvas_script", "run_canvas_node", "get_node_output"].map(name => ({ name })) }) };
  return { store, dbPath, input, dependencies, conversations, canvas, service: new CanvasCreationService(dependencies), removeRoot: () => { root.exists = false; } };
}
describe("durable canvas creations", () => {
  it("accepts another group on the same canvas while the first root is still being prepared", async () => {
    const s = setup();
    const roots = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(s.canvas.lookupRoot).mockImplementation(async input => ({ exists: roots.has(input.rootGroupId), scopeEpoch: 0 }));
    vi.mocked(s.canvas.ensureRoot).mockImplementation(async input => {
      if (input.position.x === s.input.position.x) await gate;
      roots.add(input.rootGroupId);
      return { revision: 1, scopeEpoch: 0 };
    });
    s.conversations.createConversation.mockImplementation((input: { nodeId: string }) => ({ ok: true, conversation: { conversationId: input.nodeId } }) as never);
    s.conversations.acceptTurn.mockImplementation((input: { conversationId: string; requestId: string }) => ({ ok: true, reused: false, conversation: { conversationId: input.conversationId }, turn: { turnId: input.requestId } }) as never);
    const a = s.service.accept("owner", s.input);
    const b = await s.service.accept("owner", { ...s.input, requestId: "r2", position: { x: 800, y: 200 } });
    expect(b.stage).toBe("accepted");
    release();
    const first = await a;
    expect(first.stage).toBe("accepted");
    expect(first.rootGroupId).not.toBe(b.rootGroupId);
    expect(first.conversationId).not.toBe(b.conversationId);
    expect(first.turnId).not.toBe(b.turnId);
    expect(s.conversations.dispatchTurn).toHaveBeenCalledTimes(2);
  });
  it("queries wait for an in-flight acceptance without overwriting its phase", async () => {
    const s = setup();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = vi.mocked(s.canvas.ensureRoot).getMockImplementation()!;
    vi.mocked(s.canvas.ensureRoot).mockImplementationOnce(async input => { await blocked; return original(input); });
    const accept = s.service.accept("owner", s.input);
    const read = s.service.query("owner", s.input.requestId);
    release();
    expect((await accept).stage).toBe("accepted");
    expect((await read)?.stage).toBe("accepted");
    expect(s.store.get("owner", s.input.requestId)?.view.stage).toBe("accepted");
    expect(s.conversations.dispatchTurn).toHaveBeenCalledOnce();
  });
  it("concurrent retries create root before first turn, accepting and dispatching exactly once", async () => {
    const s = setup();
    const results = await Promise.all([s.service.accept("owner", s.input), s.service.accept("owner", s.input)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]!.stage).toBe("accepted");
    expect(s.canvas.ensureRoot).toHaveBeenCalledTimes(1); expect(s.conversations.acceptTurn).toHaveBeenCalledTimes(1); expect(s.conversations.dispatchTurn).toHaveBeenCalledTimes(1);
    await s.service.accept("owner", s.input);
    expect(s.conversations.dispatchTurn).toHaveBeenCalledTimes(1);
    await expect(s.service.accept("owner", { ...s.input, prompt: "different" })).rejects.toMatchObject({ code: "request-id-reused" });
  });
  it("checks real tool discovery, connection revision, capability and write access before root or ledger", async () => {
    const s = setup();
    for (const override of [
      { discoverTools: async () => ({ ready: true, tools: [] }) },
      { preflight: async () => false },
      { connections: { getConnection: async () => null } as unknown as AgentConnectionRegistry }
    ]) {
      await expect(new CanvasCreationService({ ...s.dependencies, ...override }).accept("owner", s.input)).rejects.toBeDefined();
      expect(s.store.get("owner", "r1")).toBeNull();
    }
    expect(s.canvas.ensureRoot).not.toHaveBeenCalled();
  });
  it("reopens SQLite and queries stages without redispatching inference or recreating a deleted root", async () => {
    const s = setup(); const created = await s.service.accept("owner", s.input);
    s.store.close(); stores.splice(stores.indexOf(s.store), 1);
    const reopened = new CanvasCreationStore(s.dbPath); stores.push(reopened);
    expect(reopened.invalidate(s.input.canvasId, created.rootGroupId)).toBe(1);
    expect(reopened.epoch(s.input.canvasId, created.rootGroupId)).toBe(1);
    const service = new CanvasCreationService({ ...s.dependencies, store: reopened });
    expect((await service.query("owner", "r1"))?.rootGroupId).toBe(created.rootGroupId);
    expect(await service.query("other-owner", "r1")).toBeNull();
    expect(reopened.list("owner", "other-canvas")).toEqual([]);
    s.removeRoot();
    // Even if Canvas has compacted the command receipt, durable creation evidence
    // must prevent an explicit retry from resurrecting a deleted target.
    vi.mocked(s.canvas.lookupRoot).mockResolvedValue({ exists: false, scopeEpoch: 1 });
    expect((await service.accept("owner", s.input)).error?.code).toBe("group-target-missing");
    expect((await service.query("owner", "r1"))?.error?.code).toBe("group-target-missing");
    expect((await service.retry("owner", "r1")).error?.code).toBe("group-target-missing");
    expect(s.canvas.ensureRoot).toHaveBeenCalledTimes(1); expect(s.conversations.dispatchTurn).toHaveBeenCalledTimes(1);
  });
  it("retains a failed empty root and retries the same first-turn identity", async () => {
    const s = setup();
    s.conversations.acceptTurn.mockImplementationOnce(() => ({ ok: false, error: { code: "budget-exceeded", message: "try later" } }) as never);
    const failed = await s.service.accept("owner", s.input);
    expect(failed.stage).toBe("failed"); expect(failed.rootRevision).toBe(1);
    const accepted = await s.service.retry("owner", "r1");
    expect(accepted.stage).toBe("accepted"); expect(accepted.rootGroupId).toBe(failed.rootGroupId); expect(accepted.turnRequestId).toBe(failed.turnRequestId);
    expect(s.canvas.ensureRoot).toHaveBeenCalledTimes(1); expect(s.conversations.dispatchTurn).toHaveBeenCalledTimes(1);
  });
  it("recovers root-commit response loss by its command receipt without creating another root", async () => {
    const s = setup();
    const original = vi.mocked(s.canvas.ensureRoot).getMockImplementation()!;
    vi.mocked(s.canvas.ensureRoot).mockImplementationOnce(async input => { await original(input); throw new Error("response lost after root commit"); });
    const failed = await s.service.accept("owner", s.input);
    expect(failed.stage).toBe("failed");
    expect(s.conversations.acceptTurn).not.toHaveBeenCalled();
    const read = await s.service.query("owner", s.input.requestId);
    expect(read?.rootRevision).toBe(1);
    expect(s.conversations.dispatchTurn).not.toHaveBeenCalled();
    expect((await s.service.retry("owner", s.input.requestId)).rootGroupId).toBe(failed.rootGroupId);
    expect(s.canvas.ensureRoot).toHaveBeenCalledOnce();
    expect(s.conversations.dispatchTurn).toHaveBeenCalledOnce();
  });
  it("reads all durable interruption stages without redispatch and preserves epoch across reopen", async () => {
    const s = setup();
    const accepted = await s.service.accept("owner", s.input);
    const record = s.store.get("owner", s.input.requestId)!;
    s.conversations.dispatchTurn.mockClear();
    for (const stage of ["preparing", "root-created", "failed"] as const) {
      s.store.save({ ...record, view: { ...accepted, stage, turnId: undefined } });
      expect((await s.service.query("owner", s.input.requestId))?.turnId).toBe("turn");
    }
    s.store.invalidate(s.input.canvasId, accepted.rootGroupId);
    s.store.close(); stores.splice(stores.indexOf(s.store), 1);
    const reopened = new CanvasCreationStore(s.dbPath); stores.push(reopened);
    expect(reopened.epoch(s.input.canvasId, accepted.rootGroupId)).toBe(1);
    expect(s.conversations.dispatchTurn).not.toHaveBeenCalled();
    expect(s.canvas.ensureRoot).toHaveBeenCalledOnce();
  });
  it("accepts a local-login connection whose account evidence can only arrive during execution", async () => {
    const s = setup();
    const connection = {
      ...s.input.connection,
      ready: false,
      authMode: "local-login",
      capabilities: { tools: true },
      models: []
    } as unknown as AgentConnectionView;
    const conversations = {
      ...s.conversations,
      catalog: vi.fn(async () => ({
        ok: true as const,
        models: [],
        authState: "disconnected" as const,
        capabilities: { targets: ["canvas-group"], tools: true }
      }))
    };
    const service = new CanvasCreationService({
      ...s.dependencies,
      connections: {
        getConnection: async ({ owner }: { owner: string }) =>
          owner === "owner" ? connection : null
      } as unknown as AgentConnectionRegistry,
      conversations: conversations as unknown as AgentConversationService
    });
    const input = { ...s.input };
    delete input.model;
    const view = await service.accept("owner", input);
    expect(view.stage).toBe("accepted");
    expect(s.conversations.dispatchTurn).toHaveBeenCalledOnce();
  });
  it("still rejects a non-local-login connection until its readiness is verified", async () => {
    const s = setup();
    const connection = {
      ...s.input.connection,
      ready: false,
      authMode: "api-key",
      capabilities: { tools: true },
      models: [{ id: "real-model", label: "Real model" }]
    } as unknown as AgentConnectionView;
    const service = new CanvasCreationService({
      ...s.dependencies,
      connections: {
        getConnection: async () => connection
      } as unknown as AgentConnectionRegistry
    });
    await expect(service.accept("owner", s.input)).rejects.toMatchObject({
      code: "connection-unavailable"
    });
    expect(s.store.get("owner", "r1")).toBeNull();
  });
});
