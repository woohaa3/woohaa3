/**
 * 图片 / 视频节点「用户停止 → 改提示词 → 重新生成」领域回归
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 3.3）。
 *
 * 使用真实 Yjs CanvasRoom + CanvasRunService + CanvasTaskProjector，覆盖：
 * - 停止只发取消请求，不伪造节点终态；
 * - 重新生成以新 run 接管 `activeRunId` 与 job；
 * - 旧 run 的迟到成功只登记历史并结算自己的 job，不覆盖节点输出或媒体 provenance；
 * - 新 run 成功后节点输出、job 与资产 provenance 都指向最新尝试。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  type CanvasTaskCatalog,
  type CanvasTaskModelType,
  type StoredAsset
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import {
  CanvasTaskProjector,
  InMemoryProjectionReceiptStore,
  type PptaskExecutionRecord
} from "../sync/task-projector.js";
import { CanvasRunService } from "./run-service.js";

const NOW = "2026-10-28T00:00:00.000Z";
const CANVAS = "canvas-skill-regeneration";
const NODE = "node-1";
const CHECKSUM_OLD = "a".repeat(64);
const CHECKSUM_NEW = "b".repeat(64);

function catalogFor(modelType: CanvasTaskModelType): CanvasTaskCatalog {
  return {
    available: true,
    defaultModels: {},
    models: [
      {
        providerId: "provider",
        providerModelId: `model-${modelType}`,
        modelKey: "m",
        modelType,
        title: "M",
        interaction: { id: "generic-model", version: 1 },
        inputSchema: {},
        defaultInput: {},
        taskTimeoutMs: 1_000,
        bindings: []
      }
    ]
  };
}

async function setup(type: "image" | "video") {
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
    commands: [
      { type: "node.add", node: { id: NODE, type, position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: NODE, value: { prompt: "旧提示词", panelPrompt: "旧提示词" } }
    ]
  });

  const submitted: string[] = [];
  const cancelled: string[] = [];
  const runService = new CanvasRunService({
    resolveRoom: async () => room,
    taskClient: {
      submit: async (input: { runId: string }) => { submitted.push(input.runId); },
      cancel: async (taskKey: string) => { cancelled.push(taskKey); }
    } as never,
    resolveCatalog: async () => catalogFor(type),
    now: () => NOW
  });

  const history: PptaskExecutionRecord[] = [];
  const projector = new CanvasTaskProjector({
    resolveRoom: async () => room,
    receipts: new InMemoryProjectionReceiptStore(),
    registerHistory: async (record) => { history.push(record); },
    registerFailure: async () => undefined,
    now: () => NOW
  });
  return { room, runService, projector, submitted, cancelled, history };
}

function asset(runId: string, mediaKind: "image" | "video", checksum: string, id: string): StoredAsset {
  return {
    id,
    nodeId: NODE,
    title: `${mediaKind} ${runId}`,
    mediaKind,
    source: "generated",
    status: "ready",
    url: `/api/media/${runId}`,
    createdAt: NOW,
    provenance: { runId, taskNodeId: NODE },
    metadata: {
      storageKey: `sha256-${checksum}`,
      checksum,
      size: 4,
      contentType: mediaKind === "image" ? "image/png" : "video/mp4"
    }
  };
}

function record(
  type: "image" | "video",
  runId: string,
  jobId: string,
  terminalAt: string,
  checksum: string
): PptaskExecutionRecord {
  const outputAsset = asset(runId, type, checksum, `asset-${runId}`);
  return {
    taskKey: runId,
    status: "succeeded",
    canvasId: CANVAS,
    nodeId: NODE,
    runId,
    jobId,
    modelKey: "m",
    output: {
      mediaKind: type,
      asset: outputAsset,
      ...(type === "video" ? { posterAsset: asset(`${runId}-poster`, "image", checksum, `poster-${runId}`) } : {})
    },
    terminalAt
  };
}

describe.each(["image", "video"] as const)("%s 节点停止后改词重生成", (type) => {
  it("节点 activeRunId、job 与媒体 provenance 始终指向最新有效尝试", async () => {
    const h = await setup(type);
    // 1) 旧尝试被受理：节点 active run 是 run-1。
    expect(await h.runService.run({
      canvasId: CANVAS, nodeId: NODE, runId: "run-1", jobId: "job-1", modelKey: "m", prompt: "旧提示词", parameters: {}
    })).toMatchObject({ ok: true, runId: "run-1" });
    let exported = h.room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.nodeData[NODE]).toMatchObject({ activeRunId: "run-1", taskStatus: "processing" });

    // 2) 用户停止：只请求取消，不伪造节点终态。
    expect(await h.runService.cancel({ canvasId: CANVAS, nodeId: NODE, runId: "run-1" })).toMatchObject({ ok: true, state: "cancel-requested" });
    expect(h.cancelled).toEqual(["run-1"]);
    exported = h.room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData[NODE]).toMatchObject({ activeRunId: "run-1", taskStatus: "processing" });

    // 3) 改提示词重新生成：新的 run 立即接管节点与 job。
    expect(await h.runService.run({
      canvasId: CANVAS, nodeId: NODE, runId: "run-2", jobId: "job-2", modelKey: "m", prompt: "新提示词", parameters: {}
    })).toMatchObject({ ok: true, runId: "run-2" });
    exported = h.room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData[NODE]).toMatchObject({ activeRunId: "run-2", taskStatus: "processing", prompt: "新提示词" });
    expect(exported.canvas.jobs.map((job) => [job.runId, job.status])).toEqual([["run-1", "running"], ["run-2", "running"]]);

    // 4) 旧 run 迟到成功：只登记历史、结算自己的 job，不碰节点输出。
    expect(await h.projector.project(record(type, "run-1", "job-1", "2026-10-28T00:00:05Z", CHECKSUM_OLD)))
      .toMatchObject({ status: "skipped", reason: "stale-run" });
    exported = h.room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData[NODE]).toMatchObject({ activeRunId: "run-2", taskStatus: "processing" });
    expect(exported.canvas.nodeData[NODE]?.outputAssetId).toBeUndefined();
    expect(exported.canvas.assets.map((entry) => entry.id)).not.toContain("asset-run-1");
    expect(exported.canvas.jobs.map((job) => [job.runId, job.status])).toEqual([["run-1", "success"], ["run-2", "running"]]);

    // 5) 新 run 成功：节点输出与媒体 provenance 指向 run-2。
    expect(await h.projector.project(record(type, "run-2", "job-2", "2026-10-28T00:00:09Z", CHECKSUM_NEW)))
      .toMatchObject({ status: "projected" });
    exported = h.room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData[NODE]).toMatchObject({
      activeRunId: "run-2",
      taskStatus: "successed",
      outputAssetId: "asset-run-2",
      resourceKind: type,
      progress: 100,
      ...(type === "video" ? { posterAssetId: "poster-run-2" } : {})
    });
    const output = exported.canvas.assets.find((entry) => entry.id === "asset-run-2");
    expect(output?.provenance?.runId).toBe("run-2");
    expect(output?.metadata).toMatchObject({ checksum: CHECKSUM_NEW });
    if (type === "video") {
      expect(exported.canvas.assets.find((entry) => entry.id === "poster-run-2")?.provenance?.runId).toBe("run-2-poster");
      expect(exported.canvas.assets.some((entry) => entry.id === "poster-run-1")).toBe(false);
    }
    expect(exported.canvas.jobs.map((job) => [job.runId, job.status])).toEqual([["run-1", "success"], ["run-2", "success"]]);
    // 任务历史保留两次尝试，当前节点只采用最新版本。
    expect(h.history.map((entry) => entry.runId)).toEqual(["run-1", "run-2"]);
    expect(h.history.map((entry) => entry.output?.asset?.id)).toEqual(["asset-run-1", "asset-run-2"]);
    // 重新生成没有重复提交旧 Provider 请求：两次 run 各提交一次。
    expect(h.submitted).toEqual(["run-1", "run-2"]);
  });
});
