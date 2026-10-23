/**
 * Canvas run service 聚合节点单任务门禁测试
 * （change: 2026-10-12-unify-generation-history-strip，design D5）。
 *
 * 聚合节点（复合资产/片场）同一时间至多一个运行任务，由权威入口保证而非仅前端禁用。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, createMotionSnapshot, canonicalFilmSetFields, canonicalShotPreviewFields, shotPreviewNodeId, freezeShotImageReferences, shotImageReferenceAssetId, type FrozenShotImageReference, type ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRunService } from "./run-service.js";
import { CanvasRoom } from "../sync/index.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { withCanvasGroupScope } from "../agent-authoring/group-scope.js";

const NOW = "2026-10-12T00:00:00.000Z";
const CANVAS = "canvas-1";

describe("frozen image authorization at durable acceptance", () => {
  it.each(["unrelated", "source-version", "cached-mapping", "reconnect", "asset-delete", "kind"])("revalidates %s without changing the frozen provider image", async mode => {
    const canvas = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    const animation = createFilmSetSnapshot({ title: "Still", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 1, loop: false } });
    const original = animation.filmSetAnimations!.clips[0]!;
    animation.filmSetAnimations!.clips[0] = { ...original, kind: "static", bindings: [], timeline: { duration: 0, loop: false }, cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }) };
    const preview = shotPreviewNodeId("film", original.id);
    canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }, { id: preview, type: "film-set-shot-preview", position: { x: 0, y: 0 } }, { id: "n1", type: "image", position: { x: 0, y: 0 } });
    canvas.document.edges.push({ id: "reference", source: preview, target: "n1", data: { kind: "shot-image-reference", schemaVersion: 1 } } as never);
    canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
    canvas.nodeData[preview] = canonicalShotPreviewFields({ shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: original.id } }) as never;
    canvas.nodeData.n1 = { inputMapping: [{ sourceNodeId: preview, slotId: "image-slot", role: "shot_image_reference", sortKey: "0" }] } as never;
    const refs = freezeShotImageReferences(canvas, "n1", "#ffffff") as FrozenShotImageReference[], ref = refs[0]!;
    const assetId = shotImageReferenceAssetId(ref);
    canvas.assets.push({ id: assetId, title: "PNG", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW,
      metadata: { storageKey: "images/a.png", checksum: "a".repeat(64), contentType: "image/png", width: 1280, height: 720, background: "#ffffff", shotImageReference: ref } });
    const submitTask = vi.fn(async (_input: unknown) => undefined);
    const room = { exportCanvas: () => ({ ok: true, canvas }), submit: async (_input: unknown, options?: { authorize?: () => Promise<boolean> }) => {
      if (mode === "unrelated") canvas.document.nodes.push({ id: "other", type: "image", position: { x: 20, y: 20 } });
      if (mode === "source-version") { animation.filmSetAnimations!.clips[0]!.initialCamera.azimuth += 1; canvas.nodeData.film = canonicalFilmSetFields(animation) as never; }
      if (mode === "cached-mapping") canvas.nodeData.n1!.inputMapping![0]!.sourceAssetIds = [assetId];
      if (mode === "reconnect") canvas.nodeData.n1!.inputMapping![0]!.sourceNodeId = "different";
      if (mode === "asset-delete") canvas.assets = [];
      if (mode === "kind") canvas.nodeData.film = canonicalFilmSetFields({ ...animation, filmSetAnimations: { ...animation.filmSetAnimations!, clips: [original] } }) as never;
      return await options?.authorize?.() ? { ok: true, status: "committed", commandId: "begin" } : { ok: false, code: "command-forbidden", message: "input changed" };
    } };
    const service = new CanvasRunService({ resolveRoom: async () => room as never, taskClient: { submit: submitTask, cancel: vi.fn() } as never,
      resolveCatalog: async () => ({ available: true, defaultModels: {}, models: [{ providerId: "p", providerModelId: "m", modelKey: "m", modelType: "image", title: "M", interaction: { id: "generic-model", version: 1 }, inputSchema: {}, defaultInput: {}, taskTimeoutMs: 1000,
        bindings: [{ field: "images", semantic: "reference-image", roles: ["reference_image"], mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 2, valueFormat: "reference" }] }] }) });
    const result = await service.run({ canvasId: CANVAS, nodeId: "n1", runId: "run", jobId: "job", modelKey: "m", prompt: "image", parameters: {}, shotImageReferences: refs });
    const accepted = ["unrelated", "source-version", "cached-mapping"].includes(mode);
    expect(result.ok).toBe(accepted);
    if (accepted) expect(submitTask).toHaveBeenCalledWith(expect.objectContaining({ inputs: [expect.objectContaining({ assetId, role: "reference_image", storageKey: "images/a.png", mediaKind: "image" })] }));
    else expect(submitTask).not.toHaveBeenCalled();
  });
});

function fakeRoom(canvas: ServerCanvas): CanvasRoom {
  return {
    exportCanvas: () => ({ ok: true as const, canvas }),
    async submit() {
      return { ok: false as const, status: "rejected" as const, commandId: "x", code: "unused", message: "unused" };
    }
  } as unknown as CanvasRoom;
}

function canvasWithNode(type: string, data: Record<string, unknown> = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: "n1", type, position: { x: 0, y: 0 }, width: 248, height: 232 }]
    },
    nodeData: { n1: { title: "T", ...data } }
  } as ServerCanvas;
}

function serviceFor(canvas: ServerCanvas, onCatalog: () => void) {
  return new CanvasRunService({
    resolveRoom: async () => fakeRoom(canvas),
    taskClient: { submit: async () => undefined, cancel: async () => undefined } as never,
    resolveCatalog: async () => { onCatalog(); return { available: true, models: [], defaultModels: {} }; },
    isAggregateNode: (node) => node.type === "composite-asset",
    now: () => NOW
  });
}

describe("聚合节点单任务门禁（change: 2026-10-12）", () => {
  it("rejects outside nodes and hidden external mappings before catalog/provider work", async () => {
    const canvas = canvasWithNode("image");
    canvas.document.nodes.push({ id: "root", type: "group", position: { x: 0, y: 0 }, width: 800, height: 600 });
    let calls = 0;
    const service = serviceFor(canvas, () => { calls++; });
    const run = () => withCanvasGroupScope({ owner: "owner", canvasId: CANVAS, rootGroupId: "root", scopeEpoch: 0, valid: () => true }, () => service.run({ canvasId: CANVAS, nodeId: "n1", runId: "run", jobId: "job", modelKey: "missing", prompt: "scene", parameters: {} }));
    expect(await run()).toMatchObject({ ok: false, code: "group-scope-forbidden" });
    canvas.document.nodes[0]!.parentId = "root";
    canvas.nodeData.n1.inputMapping = [{ sourceNodeId: "outside", role: "image" }];
    expect(await run()).toMatchObject({ ok: false, code: "group-external-input" });
    expect(calls).toBe(0);
    delete canvas.nodeData.n1.inputMapping;
    expect(await run()).toMatchObject({ ok: false, code: "unknown-model" });
    expect(calls).toBe(1);
  });
  it("片场已有运行中任务时再次提交被权威拒绝", async () => {
    let catalogCalls = 0;
    const service = serviceFor(canvasWithNode("composite-asset", { taskStatus: "processing", activeRunId: "run-1" }), () => { catalogCalls += 1; });
    const outcome = await service.run({
      canvasId: CANVAS, nodeId: "n1", runId: "run-2", jobId: "job-2", modelKey: "m", prompt: "x", parameters: {}
    });
    expect(outcome).toMatchObject({ ok: false, code: "operation-in-progress" });
    // 门禁在解析目录/提交之前返回。
    expect(catalogCalls).toBe(0);
  });

  it("片场终态后允许再次提交（进入目录解析）", async () => {
    let catalogCalls = 0;
    const service = serviceFor(canvasWithNode("composite-asset", { taskStatus: "successed" }), () => { catalogCalls += 1; });
    const outcome = await service.run({
      canvasId: CANVAS, nodeId: "n1", runId: "run-2", jobId: "job-2", modelKey: "m", prompt: "x", parameters: {}
    });
    // 未命中门禁：继续到目录解析并因未知模型失败。
    expect(catalogCalls).toBe(1);
    expect(outcome).toMatchObject({ ok: false, code: "unknown-model" });
  });

  it("普通模型节点不受聚合门禁影响", async () => {
    let catalogCalls = 0;
    const service = serviceFor(canvasWithNode("model3d", { taskStatus: "processing" }), () => { catalogCalls += 1; });
    await service.run({
      canvasId: CANVAS, nodeId: "n1", runId: "run-2", jobId: "job-2", modelKey: "m", prompt: "x", parameters: {}
    });
    expect(catalogCalls).toBe(1);
  });
});

describe("提交阶段失败（change: 2026-10-21-record-submit-failures-as-terminal-state）", () => {
  /**
   * 真 room + 抛错的 task client：提交在 provider 调用前失败。
   *
   * `beforeThrow` 复现「提交还没返回，画布已经换了更新的 run」这种竞态。
   */
  async function setupSubmitFailure(message: string, beforeThrow?: (room: CanvasRoom) => Promise<void>) {
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    await room.initialize({
      canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "seed",
      baseRevision: 0,
      actorId: "test",
      commands: [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }]
    });
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient: {
        submit: async () => {
          await beforeThrow?.(room);
          throw new Error(message);
        },
        cancel: async () => undefined
      } as never,
      resolveCatalog: async () => ({
        available: true,
        models: [
          {
            modelKey: "m",
            providerId: "p",
            providerModelId: "m",
            modelType: "image",
            title: "M",
            interaction: { id: "generic-model", version: 1 },
            inputSchema: {},
            defaultInput: {},
            bindings: [],
            taskTimeoutMs: 1000
          }
        ],
        defaultModels: {}
      }),
      now: () => NOW
    });
    const outcome = await service.run({
      canvasId: CANVAS,
      nodeId: "n1",
      runId: "run-1",
      jobId: "job-run-1",
      modelKey: "m",
      prompt: "画一只猫",
      parameters: {}
    });
    return { outcome, room };
  }

  it("不再假装「已受理」：返回 ok:false 并带上真实原因", async () => {
    const { outcome } = await setupSubmitFailure("媒体对象不存在");
    expect(outcome).toMatchObject({ ok: false, code: "task-submit-failed", message: "媒体对象不存在" });
  });

  it("当场把 begin 写下的 processing 结算为 failed（不留进度）", async () => {
    const { room } = await setupSubmitFailure("媒体对象不存在");
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.nodeData.n1).toMatchObject({
      taskStatus: "failed",
      error: "媒体对象不存在",
      errorMessage: "媒体对象不存在",
      progress: 100
    });
    expect(exported.canvas.jobs).toHaveLength(1);
    expect(exported.canvas.jobs[0]).toMatchObject({ id: "job-run-1", status: "failed", error: "媒体对象不存在" });
  });

  it("更新的 run 接管后不覆盖新运行的状态（latest-run-wins）", async () => {
    const { outcome, room } = await setupSubmitFailure("媒体对象不存在", async (activeRoom) => {
      const exported = activeRoom.exportCanvas();
      if (!exported.ok) return;
      await activeRoom.submit({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId: CANVAS,
        commandId: "newer-run",
        baseRevision: exported.canvas.revision,
        actorId: "test",
        commands: [{ type: "nodeData.patch", nodeId: "n1", value: { activeRunId: "run-2", taskStatus: "processing" } }]
      });
    });
    expect(outcome).toMatchObject({ ok: false, code: "task-submit-failed" });
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.nodeData.n1.activeRunId).toBe("run-2");
    expect(exported.ok && exported.canvas.nodeData.n1.taskStatus).toBe("processing");
    expect(exported.ok && exported.canvas.jobs.some((job) => job.status === "failed")).toBe(false);
  });
});
