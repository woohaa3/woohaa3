import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createCanvasEditService } from "./canvas-edit-service.js";
import type { CanvasRemoteService, CanvasSession } from "../../../contracts.js";

describe("world conversion journal", () => {
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
