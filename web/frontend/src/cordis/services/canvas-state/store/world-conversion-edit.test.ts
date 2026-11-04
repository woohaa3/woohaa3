import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createCanvasEditService } from "./canvas-edit-service.js";
import type { CanvasRemoteService, CanvasSession } from "../../../contracts.js";

describe("world conversion journal", () => {
  it("rolls settled conversions and does not revive an evicted duplicate", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    const transform = { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 };
    const edit = { preconditions: [], operations: [] };
    const seen = new Set<string>();
    const remote = {
      prepareWorldConversion: async ({ nodeIds }: { nodeIds: string[] }) => ({ ok: true, canvasId: "c", sourceVersion: String(canvas.revision), nodes: nodeIds.map(nodeId => ({ nodeId, nodeVersion: "v" })) }),
      commitWorldConversion: async (input: { operationId: string; targets: Array<{ nodeId: string; instanceId: string; nodeVersion: string }> }) => {
        const target = input.targets[0]!;
        const duplicate = seen.has(input.operationId);
        seen.add(input.operationId);
        canvas.revision++;
        canvas.nodeData[target.nodeId] = { sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: target.instanceId, transform } } as never;
        return { ok: true, canvasId: "c", commandId: `world-conversion:${input.operationId}`, revision: canvas.revision, duplicate, receipt: { targets: [{ ...target, transform }], forward: edit, inverse: edit } };
      }
    } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session: { isWritable: () => true } as CanvasSession, getCanvas: () => canvas });
    for (let i = 0; i < 1001; i++) {
      expect((await service.convertWorld({ remote, canvasId: "c", operationId: `op${i}`, targets: [{ nodeId: `n${i}`, instanceId: `i${i}` }] })).ok).toBe(true);
    }
    expect(service.getSnapshot().size).toBe(100);
    expect((await service.convertWorld({ remote, canvasId: "c", operationId: "op0", targets: [{ nodeId: "n0", instanceId: "i0" }] })).ok).toBe(false);
    expect(service.getSnapshot().size).toBe(100);
  });
  it("recovers the original prepared intent after a lost response", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    const transform = { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 };
    const edit = { preconditions: [], operations: [] };
    const intents: unknown[] = [];
    let prepares = 0;
    const remote = {
      prepareWorldConversion: async () => { prepares++; return { ok: true, canvasId: "c", sourceVersion: "0", nodes: [{ nodeId: "n", nodeVersion: "v" }] }; },
      commitWorldConversion: async (intent: unknown) => {
        intents.push(intent);
        if (intents.length === 1) return { ok: false, code: "unavailable", message: "lost" };
        if (intents.length === 2) return { ok: false, code: "forbidden", message: "temporarily forbidden" };
        return { ok: true, canvasId: "c", commandId: "world-conversion:op", revision: 1, duplicate: true, receipt: { targets: [{ nodeId: "n", instanceId: "i", transform }], forward: edit, inverse: edit } };
      }
    } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session: { isWritable: () => true } as CanvasSession, getCanvas: () => canvas });
    const input = { remote, canvasId: "c", operationId: "op", targets: [{ nodeId: "n", instanceId: "i" }] };
    expect((await service.convertWorld(input)).ok).toBe(false);
    expect((await service.convertWorld(input)).ok).toBe(false);
    canvas.revision = 1;
    canvas.nodeData.n = { sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform } } as never;
    expect((await service.convertWorld(input)).ok).toBe(true);
    expect(prepares).toBe(1);
    expect(intents[1]).toEqual(intents[0]);
    expect(intents[2]).toEqual(intents[0]);
    expect(service.getSnapshot().size).toBe(1);
  });
  it("releases a confirmed intent when the canonical result no longer matches", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.revision = 1;
    let prepares = 0;
    const edit = { preconditions: [], operations: [] };
    const remote = {
      prepareWorldConversion: async () => { prepares++; return { ok: true, canvasId: "c", sourceVersion: "0", nodes: [{ nodeId: "n", nodeVersion: "v" }] }; },
      commitWorldConversion: async () => ({ ok: true, canvasId: "c", commandId: "world-conversion:op", revision: 1, duplicate: prepares > 1, receipt: { targets: [{ nodeId: "n", instanceId: "i" }], forward: edit, inverse: edit } })
    } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session: { isWritable: () => true } as CanvasSession, getCanvas: () => canvas });
    const input = { remote, canvasId: "c", operationId: "op", targets: [{ nodeId: "n", instanceId: "i" }] };
    expect((await service.convertWorld(input)).ok).toBe(false);
    expect((await service.convertWorld(input)).ok).toBe(false);
    expect(prepares).toBe(2);
    expect(service.getSnapshot().size).toBe(0);
  });
  it("does not exhaust a session after definite rejections", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    const remote = {
      prepareWorldConversion: async () => ({ ok: true, canvasId: "c", sourceVersion: "0", nodes: [{ nodeId: "n", nodeVersion: "v" }] }),
      commitWorldConversion: async () => ({ ok: false, code: "version-conflict", message: "conflict" })
    } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session: { isWritable: () => true } as CanvasSession, getCanvas: () => canvas });
    for (let i = 0; i < 1001; i++) {
      const result = await service.convertWorld({ remote, canvasId: "c", operationId: `failed${i}`, targets: [{ nodeId: "n", instanceId: "i" }] });
      expect(result).toEqual({ ok: false, reason: "conflict" });
    }
    expect(service.getSnapshot().size).toBe(0);
  });
  it("waits for the canonical result and adopts a retry only once", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    let writable = true;
    const session = { isWritable: () => writable } as CanvasSession;
    const transform = { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 };
    const edit = { preconditions: [], operations: [] };
    const receipt = { targets: [{ nodeId: "n", nodeVersion: "v", instanceId: "i", transform }], forward: edit, inverse: edit };
    let commits = 0;
    const remote = {
      prepareWorldConversion: async () => ({ ok: true, canvasId: "c", sourceVersion: "0", nodes: [{ nodeId: "n", nodeVersion: "v" }] }),
      commitWorldConversion: async () => { commits++; return { ok: true, canvasId: "c", commandId: "world-conversion:op", revision: 1, duplicate: commits > 1, receipt }; }
    } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session, getCanvas: () => canvas });
    const input = { remote, canvasId: "c", operationId: "op", targets: [{ nodeId: "n", instanceId: "i" }] };
    const pending = service.convertWorld(input);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(service.getSnapshot().size).toBe(0);
    expect((await service.convertWorld(input)).ok).toBe(false);
    canvas.revision = 1;
    canvas.nodeData.n = { sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform } } as never;
    expect((await pending).ok).toBe(true);
    expect((await service.convertWorld(input)).ok).toBe(true);
    expect(service.getSnapshot().size).toBe(1);
    expect(commits).toBe(2);
    writable = false;
    expect((await service.convertWorld(input)).ok).toBe(false);
  });

  it("does not adopt a response after page clear", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    let resolvePrepare!: (value: unknown) => void;
    const remote = { prepareWorldConversion: () => new Promise(resolve => { resolvePrepare = resolve; }) } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session: { isWritable: () => true } as CanvasSession, getCanvas: () => canvas });
    const pending = service.convertWorld({ remote, canvasId: "c", operationId: "op", targets: [{ nodeId: "n", instanceId: "i" }] });
    service.clear();
    resolvePrepare({ ok: true, canvasId: "c", sourceVersion: "0", nodes: [{ nodeId: "n", nodeVersion: "v" }] });
    expect((await pending).ok).toBe(false);
    expect(service.getSnapshot().size).toBe(0);
  });

  it.each(["reject", "throw", "mismatch"])("does not adopt %s responses", async (failure) => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    const remote = {
      prepareWorldConversion: async () => ({ ok: true, canvasId: "c", sourceVersion: "0", nodes: [{ nodeId: "n", nodeVersion: "v" }] }),
      commitWorldConversion: async () => {
        if (failure === "throw") throw Error("network");
        if (failure === "reject") return { ok: false, code: "conflict", message: "conflict" };
        return { ok: true, canvasId: "other", commandId: "world-conversion:op", revision: 1 };
      }
    } as unknown as CanvasRemoteService;
    const service = createCanvasEditService({ session: { isWritable: () => true } as CanvasSession, getCanvas: () => canvas });
    const result = await service.convertWorld({ remote, canvasId: "c", operationId: "op", targets: [{ nodeId: "n", instanceId: "i" }] });
    expect(result.ok).toBe(false);
    expect(service.getSnapshot().size).toBe(0);
    expect(service.getSnapshot().busy).toBe(false);
  });
});
