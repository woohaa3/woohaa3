/**
 * 身份参考策略的权威提交门禁与快照
 * （change: 2026-11-06-require-identity-reference，任务 2.2 / 2.3）。
 *
 * 使用真实 CanvasRoom：断言阻止发生在 durable begin 之前，参考快照固定
 * assetId / sourceNodeId / slotId / order，并把同一组稳定身份交给 Task。
 */
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
const CANVAS = "canvas-identity";
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
  referencePolicy: "identity-required" as const,
  taskTimeoutMs: 1000
};

const ASSET: StoredAsset = {
  id: "asset-a",
  title: "角色参考",
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
  policy?: "optional" | "identity-required";
  withAsset?: boolean;
  withEdge?: boolean;
} = {}): Promise<CanvasRoom> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({
    canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
    roomEpoch: "epoch-identity",
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
        ...(options.policy ? { referencePolicy: options.policy } : {}),
        inputMapping: [{ sourceNodeId: "src", role: "reference_image", slotId: "slot-a", sortKey: "0" }]
      }
    },
    ...(options.withAsset === false ? [] : [{ type: "asset.upsert", asset: ASSET }]),
    ...(options.withEdge === false ? [] : [{ type: "edge.add", edge: { id: "e1", source: "src", target: "target" } }])
  ];
  const submitted = await room.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "seed-identity",
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
    prompt: "N07 同一短黑发女性近景",
    parameters: {}
  });
}

describe("身份参考策略", () => {
  it("identity-required 且没有参考时在任何 durable 写入前拒绝", async () => {
    const room = await roomWith({ policy: "identity-required", withEdge: false, withAsset: false });
    const submitted: Array<{ inputs: unknown[] }> = [];
    const outcome = await run(service(room, submitted, catalog()));

    expect(outcome).toMatchObject({ ok: false, code: "identity-reference-required" });
    expect(submitted).toHaveLength(0);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.jobs).toHaveLength(0);
    expect(exported.canvas.nodeData.target?.taskStatus).toBe("idle");
  });

  it("参考被删除/失效时拒绝并要求重新选择，不退化为无参考生成", async () => {
    const room = await roomWith({ policy: "identity-required", withAsset: false });
    const submitted: Array<{ inputs: unknown[] }> = [];
    const outcome = await run(service(room, submitted, catalog()));

    expect(outcome).toMatchObject({ ok: false, code: "identity-reference-invalid" });
    expect(outcome.ok ? "" : outcome.message).toContain("重新选择");
    expect(submitted).toHaveLength(0);
  });

  it("ready 参考提交时固定 assetId、来源节点、slot 与顺序", async () => {
    const room = await roomWith({ policy: "identity-required" });
    const submitted: Array<{ inputs: unknown[] }> = [];
    const outcome = await run(service(room, submitted, catalog()));

    expect(outcome).toMatchObject({ ok: true });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.inputs).toEqual([
      expect.objectContaining({
        assetId: "asset-a",
        role: "reference_image",
        sourceNodeId: "src",
        slotId: "slot-a",
        order: 0
      })
    ]);

    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const job = exported.canvas.jobs.find((entry) => entry.id === "job-run-identity");
    expect(job?.references).toEqual([
      expect.objectContaining({
        assetId: "asset-a",
        sourceNodeId: "src",
        slotId: "slot-a",
        order: 0
      })
    ]);
  });

  it("optional 任务无参考仍可提交", async () => {
    const room = await roomWith({ policy: "optional", withEdge: false, withAsset: false });
    const submitted: Array<{ inputs: unknown[] }> = [];
    const outcome = await run(service(room, submitted, catalog({ referencePolicy: "optional" })));

    expect(outcome).toMatchObject({ ok: true });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.inputs).toEqual([]);
  });

  it("模型声明 identity-required 同样生效（节点未显式设置）", async () => {
    const room = await roomWith({ withEdge: false, withAsset: false });
    const submitted: Array<{ inputs: unknown[] }> = [];
    const outcome = await run(service(room, submitted, catalog()));

    expect(outcome).toMatchObject({ ok: false, code: "identity-reference-required" });
    expect(submitted).toHaveLength(0);
  });
});
