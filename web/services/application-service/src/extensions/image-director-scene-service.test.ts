import { describe, expect, it, vi } from "vitest";
import { preparedTurnHash } from "@woohaa3/contracts";
import { ImageDirectorSceneService } from "./image-director-scene-service.js";

function roleRegistry() {
  return {
    prepare: () => {
      const base = {
        schemaVersion: 1 as const,
        roleRef: { namespacedId: "standard-agent-roles/scene-director", roleId: "scene-director", extensionId: "standard-agent-roles", revision: "1", descriptorDigest: "d".repeat(64), artifactId: "test@1" },
        messages: [{ role: "system" as const, content: "scene" }, { role: "user" as const, content: "build" }],
        tools: ["get_world_context", "create_world_model", "create_world_camera"],
        nativeCapabilities: [],
        output: { kind: "tool-receipts" as const },
        inputDigest: "a".repeat(64),
        contextDigest: "b".repeat(64),
        attachmentDigests: [],
        target: { canvasId: "canvas", nodeId: "area", mode: "world" as const, worldScope: { kind: "scene-area" as const, areaId: "area-id" } }
      };
      return { ok: true as const, turn: { ...base, preparedHash: preparedTurnHash(base) } };
    },
    resolve: () => null,
    disposeExtension: () => undefined,
    list: () => [],
    listForExtension: () => [],
    availability: () => ({ available: true }),
    matchesFrozen: () => false,
    register: () => { throw new Error("unused"); },
    onUnregistered: () => () => undefined,
    forExtension: () => { throw new Error("unused"); }
  };
}

const binding = { connectionId: "connection", adapterId: "adapter", configRevision: 1, credentialEpoch: 1 };
const request = { requestId: "request", sourceNodeId: "image", connectionId: "connection", model: "model", variant: null, instructions: "根据图片重建场景" };
const entry = { roleId: "standard-agent-roles/scene-director", action: "generate" as const, canvasId: "canvas", nodeId: "image", connectionId: "connection", model: "model", prompt: request.instructions };
const source = { sourceNodeId: "image", assetId: "asset", contentVersion: "v", checksum: "hash", mimeType: "image/png", width: 4, height: 3 };

function harness(run: ReturnType<typeof vi.fn>) {
  let record: any = null;
  let finished: Promise<unknown> | undefined;
  const store = { get: () => record, insert: (value: any) => ({ record: record = value, reused: false }), save: (value: any) => { record = value; } };
  const conversations = {
    catalog: async () => ({ ok: true, models: [{ id: "model" }] }),
    recordPrepared: () => ({ ok: true }),
    acceptDeliveryTurn: () => ({ ok: true, reused: false, conversation: {}, turn: { turnId: "turn" } }),
    dispatchDeliveryTurn: (_id: string, execute: (context: unknown) => Promise<unknown>) => { finished = execute({ signal: new AbortController().signal, history: [], emit: () => {} }); return finished; }
  };
  const finalize = vi.fn(async () => ({ ok: true, receipt: { operationId: "operation", source, areaNodeId: "area", modelNodeIds: ["model-1"] }, revision: 2, duplicate: false }));
  const canvas = {
    prepare: async () => ({ source, bytes: Uint8Array.from([1, 2, 3]), nodeIds: ["image"] }),
    reserve: async () => ({ nodeId: "area", areaId: "area-id", scopeVersion: "scope", bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } } }),
    finalize,
    settleReservation: async () => undefined,
    lookup: async () => ({ ok: false, code: "receipt-not-found", message: "none" })
  };
  const connections = { getConnection: async () => ({ ...binding, ready: true, capabilities: { tools: true, targets: ["world"], textDelivery: { imageInput: true, maxImages: 1 } }, models: [{ id: "model" }] }) };
  const registry = { resolve: () => ({ ok: true, handle: { adapter: { run }, capabilities: { tools: true, targets: ["world"] } } }) };
  const service = new ImageDirectorSceneService({ store, conversations, canvas, connections, registry, agentRoles: roleRegistry() } as never);
  return { service, finalize, get record() { return record; }, get finished() { return finished; } };
}

describe("image director orchestration", () => {
  it("reserves an empty director area, runs the scene-director tools with the image, then finalizes", async () => {
    const run = vi.fn(async (_input: unknown) => ({ status: "succeeded" as const }));
    const h = harness(run);
    const accepted = await h.service.accept({ owner: "owner", canvasId: "canvas", conversationId: "conversation", request, connection: binding, entry } as never);
    expect(accepted.ok).toBe(true);
    await h.finished;
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]![0] as any;
    expect(input.images[0].bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(input.prepared.output.kind).toBe("tool-receipts");
    expect(input.intent).toMatchObject({ action: "generate", mode: "world", nodeId: "area", worldScope: { kind: "scene-area", areaId: "area-id" } });
    expect(input.candidate).toBeUndefined();
    expect(h.finalize).toHaveBeenCalledWith(expect.objectContaining({ reservation: expect.objectContaining({ nodeId: "area" }), beforeNodeIds: ["image"] }));
    expect(h.record.stage).toBe("delivered");
  });

  it("reconciles the finalize receipt before treating an interrupted run as failed", async () => {
    const receipt = { operationId: "operation", source, areaNodeId: "area", modelNodeIds: ["model-1"] };
    const reconcileDeliveryTurn = vi.fn();
    let record: any = { owner: "owner", canvasId: "canvas", request, stage: "failed" };
    const service = new ImageDirectorSceneService({ store: { get: () => record, save: (value: unknown) => { record = value; } }, canvas: { lookup: async () => ({ ok: true, receipt, revision: 5 }) }, conversations: { reconcileDeliveryTurn }, connections: {}, registry: {} } as never);
    expect(await service.reconcile("owner", "canvas", "request")).toMatchObject({ stage: "delivered", receipt, revision: 5 });
    expect(reconcileDeliveryTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: { status: "succeeded", receipt } }));
  });

  it("stops only the persisted child attempt on recovery and never reruns it", async () => {
    let record: any = { owner: "owner", canvasId: "canvas", request, stage: "generating", activeAttemptId: "1", connection: binding, entry };
    const cancel = vi.fn(async () => {}), run = vi.fn();
    const service = new ImageDirectorSceneService({ store: { get: () => record, save: (value: unknown) => { record = value; } }, canvas: { lookup: async () => ({ ok: false, code: "receipt-not-found", message: "none" }), settleReservation: async () => undefined }, conversations: { cancelTurn: vi.fn() }, connections: {}, registry: { resolve: () => ({ ok: true, handle: { adapter: { cancel, run } } }) }, agentRoles: roleRegistry() } as never);
    expect(await service.reconcile("owner", "canvas", "request")).toMatchObject({ stage: "failed" });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ owner: "owner", requestId: "request:1", candidateContext: expect.objectContaining({ canvasId: "canvas", conversationId: "request:1" }) }));
    expect(run).not.toHaveBeenCalled();
  });
});
