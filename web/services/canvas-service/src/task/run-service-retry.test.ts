import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type CanvasTaskCatalog,
  type CanvasTaskCatalogModel,
  type CanvasTaskInputBinding,
  type StoredAsset
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRunService } from "./run-service.js";
import { CanvasRoom } from "../sync/index.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";

const NOW = "2026-11-06T00:00:00.000Z";
const CANVAS = "canvas-retry";
const STORAGE_KEY = `sha256-${"a".repeat(64)}`;

const BINDINGS: CanvasTaskInputBinding[] = [
  {
    field: "referenceImages",
    semantic: "reference-image",
    roles: ["reference_image"],
    mediaKinds: ["image"],
    mediaTypes: ["image/png"],
    maxItems: 4,
    valueFormat: "url"
  }
];

const MODEL = {
  modelKey: "m",
  providerId: "p",
  providerModelId: "m",
  modelType: "image" as const,
  title: "M",
  interaction: { id: "generic-model", version: 1 },
  inputSchema: {},
  defaultInput: {},
  bindings: BINDINGS,
  taskTimeoutMs: 1000
};

const ASSET: StoredAsset = {
  id: "asset-a",
  title: "参考图片",
  mediaKind: "image",
  source: "generated",
  status: "ready",
  metadata: {
    storageKey: STORAGE_KEY,
    contentType: "image/png",
    size: 100,
    checksum: "a".repeat(64)
  },
  createdAt: NOW
};

async function roomWith(options: {
  legacyMetadata?: boolean;
  withAsset?: boolean;
  withEdge?: boolean;
} = {}): Promise<CanvasRoom> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({
    canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
    roomEpoch: "epoch-retry",
    createdAt: NOW
  });
  const commands: unknown[] = [
    { type: "node.add", node: { id: "src", type: "image", position: { x: 0, y: 0 } }, nodeData: { outputAssetId: "asset-a" } },
    {
      type: "node.add",
      node: { id: "target", type: "image", position: { x: 300, y: 0 } },
      nodeData: {
        taskKind: "image-generation",
        taskStatus: "idle",
        ...(options.legacyMetadata ? { referencePolicy: "identity-required" } : {}),
        inputMapping: [{ sourceNodeId: "src", role: "reference_image", slotId: "slot-a", sortKey: "0" }]
      }
    },
    ...(options.withAsset === false ? [] : [{ type: "asset.upsert", asset: ASSET }]),
    ...(options.withEdge === false ? [] : [{ type: "edge.add", edge: { id: "e1", source: "src", target: "target" } }])
  ];
  const submitted = await room.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "seed-retry",
    baseRevision: 0,
    actorId: "test",
    commands: commands as never
  });
  if (!submitted.ok) throw new Error(submitted.message);
  return room;
}

function service(room: CanvasRoom, submitted: Array<{ inputs: unknown[] }>, catalog: CanvasTaskCatalog) {
  return new CanvasRunService({
    resolveRoom: async () => room,
    taskClient: {
      submit: async (request: { inputs: unknown[] }) => {
        submitted.push(request);
      },
      cancel: async () => undefined
    } as never,
    resolveCatalog: async () => catalog,
    now: () => NOW
  });
}

function catalog(model: Partial<CanvasTaskCatalogModel> = {}): CanvasTaskCatalog {
  return { available: true, models: [{ ...MODEL, ...model }], defaultModels: {} };
}

async function run(serviceInstance: CanvasRunService) {
  return serviceInstance.run({
    canvasId: CANVAS,
    nodeId: "target",
    runId: "run-identity",
    jobId: "job-run-identity",
    modelKey: "m",
    prompt: "参考图片生成",
    parameters: {}
  });
}

describe("生成请求幂等重试", () => {
  it("旧节点遗留的身份参考字段不再阻止普通无参考图片提交", async () => {
    const room = await roomWith({ legacyMetadata: true, withEdge: false, withAsset: false });
    const submitted: Array<{ inputs: unknown[] }> = [];
    expect(await run(service(room, submitted, catalog()))).toMatchObject({ ok: true });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.inputs).toEqual([]);
  });

  it("acknowledges an accepted run after references change without resubmitting or replacing its frozen inputs", async () => {
    const room = await roomWith();
    const submitted: Array<{ inputs: unknown[] }> = [];
    const instance = service(room, submitted, catalog());
    expect(await run(instance)).toMatchObject({ ok: true });
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error(exported.message);
    const original = structuredClone(exported.canvas.jobs);
    expect((await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: CANVAS,
      commandId: "replace-reference-after-acceptance", baseRevision: exported.canvas.revision, actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "target", value: { inputMapping: [] } },
        { type: "edge.remove", edgeId: "e1" }]
    })).ok).toBe(true);
    // A retry does not depend on the latest catalog or input validity.
    expect(await run(service(room, submitted, { available: false, reason: "offline", models: [], defaultModels: {} })))
      .toMatchObject({ ok: true, workerTaskKey: "run-identity" });
    expect(submitted).toHaveLength(1);
    const after = room.exportCanvas();
    expect(after.ok && after.canvas.jobs).toEqual(original);
  });

  it("concurrent retries submit the durable run to Task only once", async () => {
    const room = await roomWith();
    const submitted: Array<{ inputs: unknown[] }> = [];
    const instance = service(room, submitted, catalog());
    const outcomes = await Promise.all([run(instance), run(instance)]);
    expect(outcomes.every(outcome => outcome.ok)).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(await instance.run({ canvasId: CANVAS, nodeId: "target", runId: "run-identity", jobId: "other-job",
      modelKey: "m", prompt: "changed", parameters: {} })).toMatchObject({ ok: false, code: "run-identity-conflict" });
    expect(submitted).toHaveLength(1);
  });

});
