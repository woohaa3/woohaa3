/**
 * 画布任务投影器测试（任务 7.3–7.7）。
 *
 * 覆盖：成功/失败/取消各自产生正确 revision、latest-run-wins 丢弃旧 run 且记 receipt、
 * 重复通知与补偿扫描只投影一次、暂时失败可重试（不重跑 provider）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type StoredAsset, type WorldCaptureGenerationBinding } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "./room.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { CanvasTaskProjector,
  InMemoryProjectionReceiptStore,
  buildProjectionCommands,
  projectionCommandId,
  readExecutionRecord,
  type PptaskExecutionRecord } from "./task-projector.js";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-task";
const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

/** 建一个含 image 节点、activeRunId=run-1 的 room。 */
async function setupRoom(): Promise<{
  room: CanvasRoom;
  repository: InMemoryYjsDocumentRepository;
  projector: CanvasTaskProjector;
  receipts: InMemoryProjectionReceiptStore;
}> {
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
    actorId: "web",
    commands: [
      { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: "n1", value: { activeRunId: "run-1", taskStatus: "processing" } }
    ]
  });
  const receipts = new InMemoryProjectionReceiptStore();
  const projector = new CanvasTaskProjector({
    resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
    receipts,
    now: () => NOW
  });
  return { room, repository, projector, receipts };
}

function imageAsset(): StoredAsset {
  return {
    id: "asset-1",
    nodeId: "n1",
    title: "生成图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    url: `/api/media/${STORAGE_KEY}`,
    createdAt: NOW,
    metadata: { storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 }
  };
}

function record(overrides: Partial<PptaskExecutionRecord> = {}): PptaskExecutionRecord {
  return {
    taskKey: "run-1",
    status: "succeeded",
    canvasId: CANVAS,
    nodeId: "n1",
    runId: "run-1",
    jobId: "job-1",
    output: { mediaKind: "image", asset: imageAsset() },
    terminalAt: NOW,
    ...overrides
  };
}

describe("终态投影（任务 7.3 / 7.4）", () => {
  it("成功：assets + nodeData + job 在同一次提交", async () => {
    const { room, projector } = await setupRoom();
    const outcome = await projector.project(record());
    expect(outcome.status).toBe("projected");

    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.assets.map((asset) => asset.id)).toEqual(["asset-1"]);
    expect(exported.canvas.nodeData["n1"].outputAssetId).toBe("asset-1");
    expect(exported.canvas.jobs[0].status).toBe("success");
    // seed(1) + projection(1) = 2。
    expect(exported.canvas.revision).toBe(2);
  });

  it("终态投影保留已受理任务的取景绑定（T10）", async () => {
    const { room, projector } = await setupRoom();
    const key = {
      canvasId: CANVAS,
      cameraId: "camera-1",
      worldContentVersion: "world-1",
      cameraSettingsVersion: "camera-1-v1",
      bindingVersion: "binding-1",
      outputVersion: "output-1"
    };
    const worldCapture: WorldCaptureGenerationBinding = {
      version: "world-capture-generation-binding-v2",
      requestId: "capture-1",
      key,
      contentFingerprint: "0123456789abcdef",
      input: { key, mediaId: "generation-outputs/capture.png", checksum: CHECKSUM }
    };
    const seeded = room.exportCanvas();
    if (!seeded.ok) return;
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "seed-job",
      baseRevision: seeded.canvas.revision,
      actorId: "web",
      commands: [
        {
          type: "job.upsert",
          job: {
            id: "job-1",
            nodeId: "n1",
            taskId: "run-1",
            runId: "run-1",
            modelKey: "m",
            worldCapture,
            status: "running",
            updatedAt: NOW
          }
        }
      ]
    });

    const outcome = await projector.project(record());
    expect(outcome.status).toBe("projected");
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.jobs[0]).toMatchObject({ status: "success", worldCapture });
  });

  it("job 落盘模型身份：首次投影缺省、终态投影补上 modelKey（change: l0-generation-provenance）", async () => {
    const { room, projector } = await setupRoom();
    const before = room.exportCanvas();
    if (!before.ok) return;
    // begin 阶段还没有 job（由 run-service 写）；终态投影带上 Task 记录里的 modelKey。
    expect(before.canvas.jobs).toEqual([]);

    await projector.project(record({ modelKey: "litellm:gpt-image-2" }));
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.jobs).toHaveLength(1);
    expect(exported.canvas.jobs[0]).toMatchObject({
      id: "job-1",
      nodeId: "n1",
      taskId: "run-1",
      runId: "run-1",
      modelKey: "litellm:gpt-image-2"
    });
  });

  it("Task 记录缺 modelKey（旧记录）时不写该字段", async () => {
    const { room, projector } = await setupRoom();
    await projector.project(record());
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.jobs[0]?.modelKey).toBeUndefined();
  });

  it("文本结果直接写 nodeData，不创建媒体资产", async () => {
    const { room, projector } = await setupRoom();
    await projector.project(record({ output: { mediaKind: "text", text: "结果文本" } }));
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.assets).toEqual([]);
    expect(exported.canvas.nodeData["n1"].result).toEqual({ kind: "text", text: "结果文本" });
  });

  it("视频结果：主视频 + 海报资产 + posterAssetId + duration", async () => {
    const { room, projector } = await setupRoom();
    const videoAsset: StoredAsset = {
      id: "asset-video",
      nodeId: "n1",
      title: "视频",
      mediaKind: "video",
      source: "generated",
      status: "ready",
      url: `/api/media/generation-outputs/${"c".repeat(64)}.mp4`,
      createdAt: NOW,
      metadata: { storageKey: `generation-outputs/${"c".repeat(64)}.mp4`, checksum: "c".repeat(64), contentType: "video/mp4", size: 100 }
    };
    const posterAsset: StoredAsset = {
      id: "asset-video-poster",
      nodeId: "n1",
      title: "海报",
      mediaKind: "image",
      source: "generated",
      status: "ready",
      url: `/api/media/generation-outputs/${"d".repeat(64)}.png`,
      createdAt: NOW,
      metadata: { storageKey: `generation-outputs/${"d".repeat(64)}.png`, checksum: "d".repeat(64), contentType: "image/png", size: 10 }
    };
    const outcome = await projector.project(
      record({ output: { mediaKind: "video", asset: videoAsset, posterAsset, durationSeconds: 8 } })
    );
    expect(outcome.status).toBe("projected");
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.assets.map((asset) => asset.id).sort()).toEqual(["asset-video", "asset-video-poster"]);
    expect(exported.canvas.nodeData["n1"]).toMatchObject({
      outputAssetId: "asset-video",
      posterAssetId: "asset-video-poster",
      resourceKind: "video",
      durationSeconds: 8,
      taskStatus: "successed"
    });
  });

  it("音频结果：写入 audio 资产并记录 resourceKind", async () => {
    const { room, projector } = await setupRoom();
    const audioAsset: StoredAsset = {
      id: "asset-audio",
      nodeId: "n1",
      title: "音频",
      mediaKind: "audio",
      source: "generated",
      status: "ready",
      url: `/api/media/generation-outputs/${"e".repeat(64)}.mp3`,
      createdAt: NOW,
      metadata: { storageKey: `generation-outputs/${"e".repeat(64)}.mp3`, checksum: "e".repeat(64), contentType: "audio/mpeg", size: 20 }
    };
    const outcome = await projector.project(
      record({ output: { mediaKind: "audio", asset: audioAsset, durationSeconds: 12 } })
    );
    expect(outcome.status).toBe("projected");
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData["n1"]).toMatchObject({
      outputAssetId: "asset-audio",
      resourceKind: "audio",
      durationSeconds: 12,
      taskStatus: "successed"
    });
  });

  it("失败：保留原 outputAssetId、写安全错误", async () => {
    const { room, projector } = await setupRoom();
    // 先成功一次产生 asset。
    await projector.project(record());
    // 再让它进入新的 active run 并失败。
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "begin-2",
      baseRevision: room.currentRevision,
      actorId: "web",
      commands: [{ type: "nodeData.patch", nodeId: "n1", value: { activeRunId: "run-2", taskStatus: "processing" } }]
    });
    await projector.project(record({
      taskKey: "run-2",
      runId: "run-2",
      jobId: "job-2",
      status: "failed",
      error: "provider 失败",
      output: undefined,
      terminalAt: "2026-09-23T00:00:01.000Z"
    }));

    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData["n1"].outputAssetId).toBe("asset-1");
    expect(exported.canvas.nodeData["n1"].taskStatus).toBe("failed");
    expect(exported.canvas.jobs.at(-1)?.status).toBe("failed");
  });

  it("取消同样写终态且不产生资产", async () => {
    const { room, projector } = await setupRoom();
    await projector.project(record({ status: "cancelled", output: undefined, error: "用户取消" }));
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.nodeData["n1"].taskStatus).toBe("cancelled");
    expect(exported.canvas.assets).toEqual([]);
  });
});

describe("latest-run-wins（任务 7.7）", () => {
  it("旧 run 晚到被丢弃但记 receipt（不永久重试）", async () => {
    const { room, projector, receipts } = await setupRoom();
    // 节点 active run 推进到 run-2。
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "begin-2",
      baseRevision: room.currentRevision,
      actorId: "web",
      commands: [{ type: "nodeData.patch", nodeId: "n1", value: { activeRunId: "run-2" } }]
    });

    // run-1（旧）终态晚到。
    const outcome = await projector.project(record());
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(outcome.reason).toBe("stale-run");

    // 画布未被旧结果污染。
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.assets).toEqual([]);
    expect(exported.canvas.nodeData["n1"].outputAssetId).toBeUndefined();

    // receipt 已记录 → 再次投影直接 duplicate，不会重试。
    expect(receipts.size).toBe(1);
    const retry = await projector.project(record());
    expect(retry.status).toBe("duplicate");
  });

  it("节点已删除时跳过并记 receipt", async () => {
    const { room, projector, receipts } = await setupRoom();
    // 删除保护：先结束进行中任务，再删除节点（change: 2026-10-09，任务 1.2）。
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "finish",
      baseRevision: room.currentRevision,
      actorId: "web",
      commands: [{ type: "nodeData.patch", nodeId: "n1", value: { taskStatus: "cancelled" } }]
    });
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "remove",
      baseRevision: room.currentRevision,
      actorId: "web",
      commands: [{ type: "node.remove", nodeIds: ["n1"] }]
    });
    const outcome = await projector.project(record());
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(outcome.reason).toBe("unknown-node");
    expect(receipts.size).toBe(1);
  });
});

describe("历史登记与 latest-run-wins 解耦（任务 2.1）", () => {
  it("旧 run 成功终态先登记历史，再被 latest-run-wins 跳过当前节点", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    await room.initialize({
      canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      roomEpoch: "epoch-1",
      createdAt: NOW
    });
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: CANVAS, commandId: "seed", baseRevision: 0, actorId: "web",
      commands: [
        { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
        { type: "nodeData.patch", nodeId: "n1", value: { activeRunId: "run-2", taskStatus: "processing" } }
      ]
    });
    const registered: string[] = [];
    const projector = new CanvasTaskProjector({
      resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
      receipts: new InMemoryProjectionReceiptStore(),
      registerHistory: async (record) => { registered.push(`${record.runId}:${record.output?.mediaKind}`); },
      now: () => NOW
    });
    const outcome = await projector.project(record());
    expect(outcome.status).toBe("skipped");
    // 历史登记在 latest-run-wins 判定之前发生。
    expect(registered).toEqual(["run-1:image"]);
  });

  it("失败终态同样登记归档且与 latest-run-wins 解耦（change: 2026-10-12）", async () => {
    const { room } = await setupRoom();
    const failed: string[] = [];
    const projector = new CanvasTaskProjector({
      resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
      receipts: new InMemoryProjectionReceiptStore(),
      registerFailure: async (record) => { failed.push(`${record.runId}:${record.status}`); },
      now: () => NOW
    });
    const outcome = await projector.project(record({
      status: "cancelled",
      output: undefined,
      error: "用户取消"
    }));
    expect(outcome.status).toBe("projected");
    // 失败/取消归档在投影前登记。
    expect(failed).toEqual(["run-1:cancelled"]);
  });

  it("失败归档登记失败时不写 receipt，允许补偿重试", async () => {
    const { room } = await setupRoom();
    const receipts = new InMemoryProjectionReceiptStore();
    let calls = 0;
    const projector = new CanvasTaskProjector({
      resolveRoom: async (canvasId) => (canvasId === CANVAS ? room : null),
      receipts,
      registerFailure: async () => { calls += 1; throw new Error("store down"); },
      now: () => NOW
    });
    const outcome = await projector.project(record({ status: "failed", output: undefined, error: "x" }));
    expect(outcome.status).toBe("failed");
    expect(receipts.size).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("幂等与补偿（任务 7.5 / 7.6）", () => {
  it("重复通知只投影一次（同一 commandId）", async () => {
    const { room, projector, receipts } = await setupRoom();
    const first = await projector.project(record());
    const second = await projector.project(record());
    expect(first.status).toBe("projected");
    expect(second.status).toBe("duplicate");

    const exported = room.exportCanvas();
    if (!exported.ok) return;
    // revision 只增加一次（seed=1 → 2）。
    expect(exported.canvas.revision).toBe(2);
    expect(receipts.size).toBe(1);
  });

  it("projectionCommandId 由 taskKey + status + terminalAt 确定性生成", () => {
    const a = projectionCommandId({ taskKey: "run-1", status: "succeeded", terminalAt: NOW });
    const b = projectionCommandId({ taskKey: "run-1", status: "succeeded", terminalAt: NOW });
    const c = projectionCommandId({ taskKey: "run-1", status: "failed", terminalAt: NOW });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("补偿扫描 reconcile 汇总 projection/duplicate/skipped/failed", async () => {
    const { projector } = await setupRoom();
    const summary = await projector.reconcile([
      record(),
      record(),
      record({ taskKey: "run-x", runId: "run-x", status: "failed", output: undefined, terminalAt: "t2" })
    ]);
    expect(summary.projected).toBe(1);
    expect(summary.duplicate).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("暂时失败不记 receipt，允许补偿重试", async () => {
    const { room, projector, repository, receipts } = await setupRoom();
    // 注入一次提交失败。
    repository.failNextCommit(new Error("数据库暂时不可用"));
    const failed = await projector.project(record());
    expect(failed.status).toBe("failed");
    expect(receipts.size).toBe(0);

    // 补偿重试成功（同一 projectionId）。
    const retry = await projector.project(record());
    expect(retry.status).toBe("projected");
    void room;
  });

  it("room 不存在时返回 failed（不吞掉）", async () => {
    const { projector } = await setupRoom();
    const outcome = await projector.project(record({ canvasId: "missing-canvas" }));
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("room-not-found");
  });
});

describe("worker 记录解析（任务 7.2 / 7.3）", () => {
  it("完整 metadata 时解析成功", () => {
    const parsed = readExecutionRecord("run-1", {
      status: "succeeded",
      canvasId: CANVAS,
      nodeId: "n1",
      runId: "run-1",
      jobId: "job-1",
      output: { mediaKind: "text", text: "x" },
      updatedAt: NOW
    });
    expect(parsed?.taskKey).toBe("run-1");
    expect(parsed?.terminalAt).toBe(NOW);
    // worker 记录没带 modelKey：保持缺省，不猜测。
    expect(parsed?.modelKey).toBeUndefined();
  });

  it("worker 记录带 modelKey 时解析为溯源身份", () => {
    const parsed = readExecutionRecord("run-1", {
      status: "succeeded",
      canvasId: CANVAS,
      nodeId: "n1",
      runId: "run-1",
      jobId: "job-1",
      modelKey: "litellm:gpt-image-2",
      output: { mediaKind: "text", text: "x" },
      updatedAt: NOW
    });
    expect(parsed?.modelKey).toBe("litellm:gpt-image-2");
  });

  it("缺少业务关联字段时返回 null（不猜测）", () => {
    expect(readExecutionRecord("run-1", { status: "succeeded", canvasId: CANVAS })).toBeNull();
    expect(readExecutionRecord("run-1", { status: "unknown", canvasId: CANVAS, nodeId: "n", runId: "r", jobId: "j" })).toBeNull();
  });
});

describe("buildProjectionCommands 校验（任务 7.4）", () => {
  it("activeRunId 缺失时保守视为非当前 run", () => {
    const canvas = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    const built = buildProjectionCommands({
      record: record(),
      currentCanvas: {
        ...canvas,
        document: { ...canvas.document, nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }] },
        nodeData: { n1: { taskStatus: "processing" } }
      }
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("stale-run");
  });
});


describe("terminal archival when the authority room is unavailable", () => {
  it.each(["succeeded", "failed", "cancelled"] as const)("archives and settles %s before reporting a missing room", async status => {
    const calls: string[] = [];
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => null,
      receipts: new InMemoryProjectionReceiptStore(),
      registerHistory: async item => { calls.push(`history:${item.jobId}`); },
      registerFailure: async item => { calls.push(`failure:${item.jobId}`); },
      onSettled: item => { calls.push(`settled:${item.jobId}`); }
    });
    expect(await projector.project(record({ status }))).toMatchObject({ status: "failed", code: "room-not-found" });
    expect(calls).toEqual([`${status === "succeeded" ? "history" : "failure"}:job-1`, "settled:job-1"]);
  });

  it.each([
    { exportCode: "not-found", expectedCode: "canvas-not-found", permanent: true },
    { exportCode: "temporarily-unavailable", expectedCode: "canvas-unavailable", permanent: undefined }
  ])("archives and settles before reporting $expectedCode", async ({ exportCode, expectedCode, permanent }) => {
    const calls: string[] = [];
    const room = { exportCanvas: () => ({ ok: false, code: exportCode, message: "unreadable" }) } as unknown as CanvasRoom;
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => room,
      receipts: new InMemoryProjectionReceiptStore(),
      registerHistory: async () => { calls.push("history"); },
      onSettled: () => { calls.push("settled"); }
    });
    const outcome = await projector.project(record());
    expect(outcome).toMatchObject({ status: "failed", code: expectedCode });
    expect(outcome.status === "failed" ? outcome.permanent : undefined).toBe(permanent);
    expect(calls).toEqual(["history", "settled"]);
  });

  it.each(["resolve", "export"] as const)("archives and settles before rethrowing a %s error", async stage => {
    const calls: string[] = [];
    const error = new Error("authority temporarily unavailable");
    const room = { exportCanvas: () => { throw error; } } as unknown as CanvasRoom;
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => { if (stage === "resolve") throw error; return room; },
      receipts: new InMemoryProjectionReceiptStore(),
      registerHistory: async () => { calls.push("history"); },
      onSettled: () => { calls.push("settled"); }
    });
    await expect(projector.project(record())).rejects.toBe(error);
    expect(calls).toEqual(["history", "settled"]);
  });

  it("keeps a failed archive retryable before the missing-room result and does not settle it", async () => {
    let settled = false;
    const receipts = new InMemoryProjectionReceiptStore();
    const projector = new CanvasTaskProjector({
      resolveRoom: async () => null,
      receipts,
      registerHistory: async () => { throw new Error("history store unavailable"); },
      onSettled: () => { settled = true; }
    });
    expect(await projector.project(record())).toMatchObject({ status: "failed", code: "history-register-failed" });
    expect(settled).toBe(false);
    expect(receipts.size).toBe(0);
  });
});
