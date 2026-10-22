import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createModel3DNodeData,
  model3DNodeDataFields,
  MODEL_SCRIPT_BATCH_LIMITS,
  type ModelScriptBatchRequest,
  type CanvasNodeData,
} from "@woohaa3/contracts";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { SqliteYjsRepository } from "../storage/sqlite/yjs.js";
import type { YjsDocumentRepository } from "../sync/yjs-repository.js";
import { ModelMcpService } from "./service.js";

const NOW = "2026-10-16T00:00:00.000Z";
const SOURCE = 'scene.box({id:"body",size:[1,2,1]});';
const context = { principalId: "owner" };
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
async function fixture(
  repository: YjsDocumentRepository = new InMemoryYjsDocumentRepository(),
) {
  const room = new CanvasRoom({
    canvasId: "batch",
    repository,
    now: () => NOW,
  });
  closes.push(() => room.dispose());
  const canvas = createEmptyWoohaa3ServerCanvas("batch", NOW);
  canvas.document.nodes = ["a", "b"].map((id, i) => ({
    id,
    type: "model3d",
    position: { x: i * 400, y: 0 },
  }));
  for (const id of ["a", "b"])
    canvas.nodeData[id] = model3DNodeDataFields(
      createModel3DNodeData({
        title: id,
        model: {
          modelScript: SOURCE,
          modelScriptVersion: "woohaa-model-js-v2",
        },
      }),
    ) as CanvasNodeData;
  await room.initialize({ canvas, roomEpoch: "epoch", createdAt: NOW });
  const history = vi.fn();
  const service = new ModelMcpService({
    resolveRoom: async () => room,
    registerModelHistory: history,
    now: () => NOW,
  });
  const read = await service.getModelNodes({
    canvasId: "batch",
    nodeIds: ["a", "b"],
  });
  if (!read.ok) throw Error(read.message);
  const request: ModelScriptBatchRequest = {
    canvasId: "batch",
    requestId: "kit",
    commonSource: 'const color="#43c7ba";',
    items: read.nodes.map((node) => ({
      nodeId: node.nodeId,
      source: 'scene.box({id:"body",size:[2,3,1],color});',
      expectedModelContentHash: node.modelContentVersion!.contentHash,
      expectedCamerasHash: node.camerasHash,
      cameras: [
        {
          id: "top",
          name: "俯视",
          order: 0,
          azimuth: 0,
          elevation: Math.PI / 2,
          distance: 100,
          aspect: "1:1",
        },
      ],
    })),
  };
  return { room, service, request, history, read };
}
function exported(room: CanvasRoom) {
  const state = room.exportCanvas();
  if (!state.ok) throw Error(state.message);
  return state.canvas;
}

describe("batch model authoring", () => {
  it("reads one snapshot without source by default; preflight and a single commit save independent scripts and cameras", async () => {
    const { room, service, request, history, read } = await fixture();
    expect(read.nodes.every((node) => !("source" in node))).toBe(true);
    const before = exported(room);
    const validation = await service.validateScripts(request, context);
    expect(validation).toMatchObject({
      ok: true,
      validatedOnly: true,
      revision: before.revision,
    });
    expect(exported(room)).toEqual(before);
    const saved = await service.submitScripts(request, context);
    expect(saved).toMatchObject({
      ok: true,
      validatedOnly: false,
      duplicate: false,
      revision: before.revision + 1,
    });
    if (!saved.ok || !validation.ok) throw Error("expected success");
    expect(saved.nodes).toEqual(validation.nodes);
    expect(saved.nodes[0]).toMatchObject({
      validation: "passed",
      cameraCount: 1,
      geometry: { min: [-1, -1.5, -0.5], max: [1, 1.5, 0.5] },
    });
    for (const item of request.items)
      expect(exported(room).nodeData[item.nodeId]).toMatchObject({
        modelScript: request.commonSource + "\n" + item.source,
        modelCameras: item.cameras,
      });
    expect(history).toHaveBeenCalledTimes(2);
    const full = await service.getModelNodes({
      canvasId: "batch",
      nodeIds: ["b", "a"],
      includeSource: true,
    });
    expect(full).toMatchObject({
      ok: true,
      nodes: [
        {
          nodeId: "b",
          source: request.commonSource + "\n" + request.items[1].source,
        },
        { nodeId: "a" },
      ],
    });
  });
  it("reports all invalid scripts with indices and writes nothing", async () => {
    const { room, service, request } = await fixture();
    const before = exported(room);
    request.items[0].source = "scene.box(this is invalid";
    request.items[1].source = "scene.unknown();";
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: false,
      code: "model-batch-invalid",
      errors: [
        { index: 0, nodeId: "a" },
        { index: 1, nodeId: "b" },
      ],
    });
    expect(exported(room)).toEqual(before);
  });
  it("rejects a stale camera or model without writing any other item", async () => {
    const { room, service, request } = await fixture();
    const before = exported(room);
    const staleCamera = structuredClone(request);
    staleCamera.items[1].expectedCamerasHash = "stale";
    expect(await service.submitScripts(staleCamera, context)).toMatchObject({
      ok: false,
      code: "stale-cameras",
      errors: [{ index: 1, nodeId: "b" }],
    });
    request.items[1].expectedModelContentHash = "stale";
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: false,
      code: "stale-source",
    });
    expect(exported(room)).toEqual(before);
  });
  it("preserves omitted cameras and rejects replacement without a camera precondition", async () => {
    const { service, request } = await fixture();
    delete request.items[0].expectedCamerasHash;
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: false,
      code: "malformed-request",
    });
    delete request.items[0].cameras;
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: true,
      nodes: [{ cameraCount: 0 }, { cameraCount: 1 }],
    });
  });
  it("handles concurrent identical retries once and rejects changed content under the same request ID", async () => {
    const { room, service, request, history } = await fixture();
    const before = exported(room).revision;
    const results = await Promise.all([
      service.submitScripts(request, context),
      service.submitScripts(request, context),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && result.duplicate),
    ).toHaveLength(1);
    expect(exported(room).revision).toBe(before + 1);
    expect(history).toHaveBeenCalledTimes(2);
    request.items[0].source += "\n// changed";
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: false,
      code: "request-id-reused",
    });
  });
  it("allows only one competing batch based on the same model versions", async () => {
    const { service, request } = await fixture();
    const other = structuredClone(request);
    other.requestId = "other";
    other.items[0].source = 'scene.sphere({id:"body",radius:1});';
    const results = await Promise.all([
      service.submitScripts(request, context),
      service.submitScripts(other, context),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      code: "stale-source",
    });
  });
  it("rechecks authorization after executing scripts and before duplicate receipts", async () => {
    const { room, service, request } = await fixture();
    const before = exported(room);
    let calls = 0;
    expect(
      await service.submitScripts(request, {
        principalId: "owner",
        authorize: async () => ++calls === 1,
      }),
    ).toMatchObject({ ok: false, code: "write-forbidden" });
    expect(exported(room)).toEqual(before);
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: true,
    });
    expect(
      await service.submitScripts(request, {
        principalId: "owner",
        authorize: async () => false,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("rolls back a storage failure and permits retry", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const { room, service, request } = await fixture(repository);
    const before = exported(room);
    repository.failNextCommit(Error("injected failure"));
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: false,
      code: "storage-failed",
    });
    expect(exported(room)).toEqual(before);
    expect(repository.commandCount("batch")).toBe(0);
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: true,
    });
  });
  it("keeps frozen summaries through edits, checkpoint compaction, and a SQLite restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa-model-batch-"));
    closes.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = path.join(dir, "canvas.sqlite");
    const repo = new SqliteYjsRepository({ path: db });
    closes.push(() => repo.close());
    const { room, service, request } = await fixture(repo);
    const first = await service.submitScripts(request, context);
    if (!first.ok) throw Error(first.message);
    await service.submitScript({
      canvasId: "batch",
      nodeId: "a",
      requestId: "edit",
      source: 'scene.box({id:"new",size:[4,4,4]});',
    });
    expect((await room.lookupCommand(first.commandId))?.modelBatch).toEqual({
      submissionHash: expect.any(String),
      nodes: first.nodes,
    });
    expect(
      JSON.stringify((await room.lookupCommand(first.commandId))?.modelBatch),
    ).not.toContain("scene.box");
    await room.compact();
    room.dispose();
    repo.close();
    const restartedRepo = new SqliteYjsRepository({ path: db });
    closes.push(() => restartedRepo.close());
    const restartedRoom = new CanvasRoom({
      canvasId: "batch",
      repository: restartedRepo,
    });
    closes.push(() => restartedRoom.dispose());
    expect(await restartedRoom.load()).toMatchObject({ ok: true });
    const retry = await new ModelMcpService({
      resolveRoom: async () => restartedRoom,
    }).submitScripts(request, context);
    expect(retry).toEqual({ ...first, duplicate: true });
  });
  it("rejects duplicate targets, unknown fields, expanded source overflow and invalid node kinds", async () => {
    const { room, service, request } = await fixture();
    const before = exported(room);
    expect(
      await service.submitScripts(
        { ...request, items: [request.items[0], request.items[0]] },
        context,
      ),
    ).toMatchObject({ ok: false, code: "malformed-request" });
    expect(
      await service.submitScripts(
        { ...request, unknown: true } as never,
        context,
      ),
    ).toMatchObject({ ok: false, code: "malformed-request" });
    expect(
      await service.submitScripts(
        {
          ...request,
          commonSource: "x".repeat(190_000),
          items: Array.from({ length: 6 }, (_, i) => ({
            nodeId: "n" + i,
            source: "x",
          })),
        },
        context,
      ),
    ).toMatchObject({ ok: false, code: "limit-exceeded" });
    expect(
      await service.getModelNodes({
        canvasId: "batch",
        nodeIds: Array.from(
          { length: MODEL_SCRIPT_BATCH_LIMITS.maxNodes + 1 },
          (_, i) => "n" + i,
        ),
      }),
    ).toMatchObject({ ok: false });
    request.items[1].nodeId = "missing";
    expect(await service.submitScripts(request, context)).toMatchObject({
      ok: false,
      code: "unknown-node",
      errors: [{ index: 1 }],
    });
    expect(exported(room)).toEqual(before);
  });
});
