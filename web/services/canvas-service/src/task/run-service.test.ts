/**
 * Canvas run service 聚合节点单任务门禁测试
 * （change: 2026-10-12-unify-generation-history-strip，design D5）。
 *
 * 聚合节点（composite-asset）同一时间至多一个运行任务，由权威入口保证而非仅前端禁用。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRunService } from "./run-service.js";
import { CanvasRoom } from "../sync/index.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";

const NOW = "2026-10-12T00:00:00.000Z";
const CANVAS = "canvas-1";

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
  it("聚合节点已有运行中任务时再次提交被权威拒绝", async () => {
    let catalogCalls = 0;
    const service = serviceFor(canvasWithNode("composite-asset", { taskStatus: "processing", activeRunId: "run-1" }), () => { catalogCalls += 1; });
    const outcome = await service.run({
      canvasId: CANVAS, nodeId: "n1", runId: "run-2", jobId: "job-2", modelKey: "m", prompt: "x", parameters: {}
    });
    expect(outcome).toMatchObject({ ok: false, code: "operation-in-progress" });
    // 门禁在解析目录/提交之前返回。
    expect(catalogCalls).toBe(0);
  });

  it("聚合节点终态后允许再次提交（进入目录解析）", async () => {
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

/**
 * 视频参数 schema 权威复验（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * N05 / N09：绕过 UI 的非法请求必须在创建 provider 任务前被拒绝，并且不得写 begin / job。
 */
describe("视频参数 schema 权威复验", () => {
  const AGNES_SCHEMA = {
    type: "object",
    required: ["prompt", "aspectRatio", "resolution", "durationSeconds"],
    properties: {
      prompt: { type: "string", title: "提示词" },
      aspectRatio: { type: "string", title: "比例", enum: ["16:9", "9:16", "1:1"] },
      resolution: { type: "string", title: "分辨率", enum: ["720p", "1080p", "2k"] },
      durationSeconds: { type: "number", title: "时长", minimum: 5, maximum: 12, unit: "秒" }
    }
  };

  async function setup(input: {
    parameters: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    defaultInput?: Record<string, unknown>;
  }) {
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
      commands: [{ type: "node.add", node: { id: "n1", type: "video", position: { x: 0, y: 0 } } }]
    });
    const submitted: Array<Record<string, unknown>> = [];
    const service = new CanvasRunService({
      resolveRoom: async () => room,
      taskClient: {
        submit: async (request: Record<string, unknown>) => { submitted.push(request); },
        cancel: async () => undefined
      } as never,
      resolveCatalog: async () => ({
        available: true,
        models: [
          {
            modelKey: "test:agnes",
            providerId: "test",
            providerModelId: "agnes-video-2.5",
            modelType: "video",
            title: "Agnes",
            interaction: { id: "generic-model", version: 1 },
            inputSchema: input.inputSchema ?? AGNES_SCHEMA,
            defaultInput: input.defaultInput ?? {},
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
      jobId: "job-1",
      modelKey: "test:agnes",
      prompt: "一段动画",
      parameters: input.parameters
    });
    const exported = room.exportCanvas();
    return { outcome, submitted, canvas: exported.ok ? exported.canvas : null };
  }

  it("缺 aspectRatio 时拒绝且不创建 provider 任务", async () => {
    const { outcome, submitted, canvas } = await setup({
      parameters: { resolution: "720p", durationSeconds: 5 }
    });
    expect(outcome).toMatchObject({ ok: false, code: "missing-parameter" });
    expect(outcome.ok ? "" : outcome.message).toContain("aspectRatio");
    expect(submitted).toHaveLength(0);
    // 没有写 begin：节点没有 activeRunId / processing，也没有 job。
    expect(canvas?.nodeData.n1?.activeRunId).toBeUndefined();
    expect(canvas?.nodeData.n1?.taskStatus).toBeUndefined();
    expect(canvas?.jobs).toHaveLength(0);
  });

  it("时长越界时返回稳定 invalid-parameter", async () => {
    const { outcome, submitted } = await setup({
      parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 13 }
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid-parameter" });
    expect(outcome.ok ? "" : outcome.message).toContain("时长不能大于 12秒");
    expect(submitted).toHaveLength(0);
  });

  it("缺 resolution 时拒绝", async () => {
    const { outcome, submitted } = await setup({
      parameters: { aspectRatio: "16:9", durationSeconds: 5 }
    });
    expect(outcome).toMatchObject({ ok: false, code: "missing-parameter" });
    expect(submitted).toHaveLength(0);
  });

  it("合法请求把模型默认值并入提交快照", async () => {
    const { outcome, submitted } = await setup({
      parameters: { aspectRatio: "9:16" },
      defaultInput: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 }
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.parameters).toMatchObject({
      model: "test:agnes",
      aspectRatio: "9:16",
      resolution: "720p",
      durationSeconds: 5
    });
  });

  it("视频模型没有参数 schema 时显式拒绝", async () => {
    const { outcome, submitted } = await setup({
      parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 5 },
      inputSchema: {}
    });
    expect(outcome).toMatchObject({ ok: false, code: "invalid-parameter" });
    expect(outcome.ok ? "" : outcome.message).toContain("没有声明参数 schema");
    expect(submitted).toHaveLength(0);
  });
});
