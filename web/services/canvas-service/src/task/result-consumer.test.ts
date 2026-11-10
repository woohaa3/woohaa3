/**
 * 任务结果补偿消费的失败重试（修复：投影失败不推进水位）。
 *
 * 真实缺陷：重启后终态补写完成，但 consumer 启动时 canvas room 尚未装载 → 投影失败；
 * 旧实现把 cursor 推到全局高水位，失败记录在本进程内再也不会被读到，画布节点永久 processing。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasCommand, type TaskExecutionDetail } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { createTaskResultConsumer, PROJECTION_RETRY_BASE_MS } from "./result-consumer.js";
import { CanvasTaskProjector, InMemoryProjectionReceiptStore, type ProjectionOutcome, type ProjectionReceiptStore } from "../sync/index.js";
import type { CanvasTaskClient } from "../clients/task-client.js";

function historyRecord(revision: number): TaskExecutionDetail {
  return {
    taskKey: "run-1",
    state: "succeeded",
    providerId: "tokenhub",
    modelType: "image",
    result: { mediaKind: "text", text: "done" },
    canvasId: "canvas-1",
    nodeId: "node-1",
    runId: "run-1",
    createdAt: "2026-10-20T10:57:52.202Z",
    updatedAt: "2026-10-20T10:58:16.126Z",
    finishedAt: "2026-10-20T10:58:16.126Z",
    durationMs: 24_000,
    recordRevision: revision,
    events: []
  };
}

function harness(outcomes: ProjectionOutcome[], items: TaskExecutionDetail[]) {
  const projections: string[] = [];
  const afterCalls: number[] = [];
  const projector = {
    async project(record: { taskKey: string }) {
      projections.push(record.taskKey);
      return outcomes.shift() ?? { status: "duplicate", revision: -1 };
    }
  } as unknown as CanvasTaskProjector;
  const taskClient = {
    async history(query: { after?: number; limit?: number }) {
      const after = query.after ?? 0;
      afterCalls.push(after);
      return { items: items.filter((item) => item.recordRevision > after), cursor: 10 };
    }
  } as unknown as CanvasTaskClient;
  const events: Array<Record<string, unknown>> = [];
  const consumer = createTaskResultConsumer({
    projector,
    taskClient,
    receipts: {} as ProjectionReceiptStore,
    logger: (event) => events.push(event)
  });
  return { consumer, projections, afterCalls, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTaskResultConsumer 补偿重试", () => {
  it("投影失败不推进水位，按退避重试并在成功后推进", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    const h = harness(
      [
        { status: "failed", code: "room-not-found", message: "room 不存在" },
        { status: "projected", revision: 1, noop: false }
      ],
      [historyRecord(5)]
    );

    expect((await h.consumer.reconcileOnce()).failed).toBe(1);
    // 退避未到期：本轮跳过，但水位仍停在失败记录之前。
    expect((await h.consumer.reconcileOnce()).skipped).toBe(1);
    expect(h.projections).toHaveLength(1);
    expect(h.afterCalls).toEqual([0, 4]);

    // 退避到期后重试成功。
    vi.advanceTimersByTime(PROJECTION_RETRY_BASE_MS);
    expect(await h.consumer.reconcileOnce()).toMatchObject({ projected: 1, failed: 0 });
    expect(h.projections).toHaveLength(2);

    // 成功后水位推进到快照高水位。
    await h.consumer.reconcileOnce();
    expect(h.afterCalls.at(-1)).toBe(10);
  });

  it("持续失败时按指数退避，避免每次轮询都打 room", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    const h = harness(
      [
        { status: "failed", code: "room-not-found", message: "room 不存在" },
        { status: "failed", code: "room-not-found", message: "room 不存在" }
      ],
      [historyRecord(5)]
    );

    expect((await h.consumer.reconcileOnce()).failed).toBe(1);
    // 5s 前不再尝试。
    expect((await h.consumer.reconcileOnce()).skipped).toBe(1);
    expect(h.projections).toHaveLength(1);
    // 5s 后第二次尝试（首轮退避 5s）。
    vi.advanceTimersByTime(PROJECTION_RETRY_BASE_MS);
    expect((await h.consumer.reconcileOnce()).failed).toBe(1);
    // 第二轮退避 10s：5s 时仍不应重试。
    vi.advanceTimersByTime(PROJECTION_RETRY_BASE_MS);
    expect((await h.consumer.reconcileOnce()).skipped).toBe(1);
    expect(h.projections).toHaveLength(2);
    // 再走 5s（累计 10s）后重试。
    vi.advanceTimersByTime(PROJECTION_RETRY_BASE_MS);
    await h.consumer.reconcileOnce();
    expect(h.projections).toHaveLength(3);
  });

  it("commandId 已被 room 用过（本进程之外已投影）按 duplicate 处理，不再重试", async () => {
    const h = harness(
      [{ status: "failed", code: "command-id-reused", message: "相同 commandId 使用了不同 payload" }],
      [historyRecord(5)]
    );
    const summary = await h.consumer.reconcileOnce();
    expect(summary).toMatchObject({ projected: 0, duplicate: 1, failed: 0 });
    // 水位推进到快照高水位：不会反复重试已投影过的终态。
    await h.consumer.reconcileOnce();
    expect(h.afterCalls.at(-1)).toBe(10);
    expect(h.projections).toHaveLength(1);
  });

  it("画布已删除（permanent）直接放弃：不重试、不逐条刷日志", async () => {
    const h = harness(
      [{ status: "failed", code: "canvas-not-found", message: "not-found: Yjs 文档 canvas-1 不存在", permanent: true }],
      [historyRecord(5)]
    );

    const first = await h.consumer.reconcileOnce();
    expect(first).toMatchObject({ dropped: 1, failed: 0 });
    // 水位推进到快照高水位：同一条记录不会被反复读取/重试。
    const second = await h.consumer.reconcileOnce();
    expect(second).toMatchObject({ dropped: 0, failed: 0, skipped: 0 });
    expect(h.afterCalls.at(-1)).toBe(10);
    expect(h.projections).toHaveLength(1);

    // 只留汇总行 + 样本，不再一条任务打一行。
    expect(h.events.filter((event) => event.event === "task-projection-failed")).toHaveLength(0);
    const summary = h.events.find((event) => event.event === "task-reconcile");
    expect(summary).toMatchObject({ dropped: 1, failed: 0 });
    expect((summary?.droppedSamples as unknown[]).length).toBe(1);
  });

  it("非终态记录不参与补偿", async () => {
    const h = harness([], [{ ...historyRecord(5), state: "running" }]);
    const summary = await h.consumer.reconcileOnce();
    expect(summary).toMatchObject({ projected: 0, failed: 0 });
    expect(h.projections).toHaveLength(0);
  });

  // 回归（2026-11-10 现场）：二进制任务成功但历史只剩 `{ mediaKind: "image" }` 占位
  // （没装配 Media 的宿主按原样投影）。旧实现把它当成可投影的「成功」，投影器再兜底成
  // 「成功 + 空文本」，画布节点于是永久空白。现在这类记录根本不进投影，也不写 receipt，
  // 等真实媒体落库（revision 变大）后被重新读到。
  it("成功但缺稳定媒体身份的记录不进入投影", async () => {
    const h = harness(
      [{ status: "projected", revision: 1, noop: false }],
      [{ ...historyRecord(5), result: { mediaKind: "image" } }]
    );
    const summary = await h.consumer.reconcileOnce();
    expect(summary).toMatchObject({ projected: 0, failed: 0, skipped: 0 });
    expect(h.projections).toHaveLength(0);
    // 水位照常推进：这不是可重试的投影失败。
    await h.consumer.reconcileOnce();
    expect(h.afterCalls.at(-1)).toBe(10);
  });

  it("文本成功结果仍正常投影（不受媒体身份门禁影响）", async () => {
    const h = harness(
      [{ status: "projected", revision: 1, noop: false }],
      [{ ...historyRecord(5), modelType: "language", result: { mediaKind: "text", text: "done" } }]
    );
    expect(await h.consumer.reconcileOnce()).toMatchObject({ projected: 1 });
    expect(h.projections).toEqual(["run-1"]);
  });
});

// Exercise the actual history consumer, authority room and projector together:
// Task's safe history has no jobId; the accepted job must remain authoritative.
describe("Task history preserves the accepted job identity", () => {
  const canvasId = "canvas-1";
  const now = "2026-10-20T10:57:52.202Z";

  async function acceptedRoom(jobId: string | null) {
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({ canvasId, repository, now: () => now });
    await room.initialize({ canvas: createEmptyWoohaa3ServerCanvas(canvasId, now), roomEpoch: "epoch-1", createdAt: now });
    const commands: CanvasCommand[] = [
      { type: "node.add", node: { id: "node-1", type: "image", position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: "node-1", value: { activeRunId: "run-1", taskStatus: "processing" } }
    ];
    if (jobId) commands.push({ type: "job.upsert", job: {
      id: jobId, nodeId: "node-1", runId: "run-1", taskId: "run-1", status: "running", updatedAt: now
    } });
    expect((await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId,
      commandId: "accepted-run", baseRevision: 0, actorId: "canvas-run-service", commands })).ok).toBe(true);
    return { room, repository };
  }

  function published(room: CanvasRoom) {
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error(exported.message);
    return exported.canvas;
  }

  function realConsumer(room: CanvasRoom, item = historyRecord(5)) {
    const archived: string[] = [];
    const projector = new CanvasTaskProjector({
      resolveRoom: async id => id === canvasId ? room : null,
      receipts: new InMemoryProjectionReceiptStore(),
      registerHistory: async record => { archived.push(record.jobId); },
      registerFailure: async record => { archived.push(record.jobId); },
      now: () => now
    });
    const taskClient = { history: async ({ after = 0 }: { after?: number }) => ({
      items: item.recordRevision > after ? [item] : [], cursor: item.recordRevision
    }) } as unknown as CanvasTaskClient;
    return { consumer: createTaskResultConsumer({ projector, taskClient,
      receipts: new InMemoryProjectionReceiptStore() }), archived };
  }

  it.each(["custom-job-1", "agent-job-1", "job-run-1"])("settles %s without creating another job", async jobId => {
    const { room } = await acceptedRoom(jobId);
    const { consumer, archived } = realConsumer(room);
    expect(await consumer.reconcileOnce()).toMatchObject({ projected: 1, failed: 0 });
    expect(published(room).jobs).toEqual([expect.objectContaining({ id: jobId, status: "success", runId: "run-1", taskId: "run-1" })]);
    expect(archived).toEqual([jobId]);
    expect(published(room).nodeData["node-1"].taskStatus).toBe("successed");
  });

  it.each(["failed", "cancelled"] as const)("settles the original job for a %s terminal result", async state => {
    const { room } = await acceptedRoom("custom-job-1");
    const { consumer, archived } = realConsumer(room, { ...historyRecord(5), state, result: undefined, error: { message: "stopped" } });
    expect(await consumer.reconcileOnce()).toMatchObject({ projected: 1, failed: 0 });
    expect(published(room).jobs).toEqual([expect.objectContaining({ id: "custom-job-1", status: "failed", error: "stopped" })]);
    expect(archived).toEqual(["custom-job-1"]);
    expect(published(room).nodeData["node-1"].taskStatus).toBe(state);
  });

  it("recovers a nondefault accepted job after a room and consumer restart, without reexecuting Task", async () => {
    const { room, repository } = await acceptedRoom("custom-job-1");
    room.dispose();
    const recovered = new CanvasRoom({ canvasId, repository, now: () => now });
    expect(await recovered.load()).toEqual({ ok: true });
    const { consumer } = realConsumer(recovered);
    expect(await consumer.reconcileOnce()).toMatchObject({ projected: 1, failed: 0 });
    const revision = published(recovered).revision;
    recovered.dispose();
    const again = new CanvasRoom({ canvasId, repository, now: () => now });
    expect(await again.load()).toEqual({ ok: true });
    expect(await realConsumer(again).consumer.reconcileOnce()).toMatchObject({ duplicate: 1, failed: 0 });
    expect(published(again).revision).toBe(revision);
    expect(published(again).jobs).toEqual([expect.objectContaining({ id: "custom-job-1", status: "success" })]);
  });

  async function beginNewer(room: CanvasRoom) {
    expect((await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId,
      commandId: "newer-run", baseRevision: room.currentRevision, actorId: "canvas-run-service", commands: [
        { type: "nodeData.patch", nodeId: "node-1", value: { activeRunId: "run-2", taskStatus: "processing", result: { kind: "text", text: "newer draft" } } },
        { type: "job.upsert", job: { id: "newer-job-2", nodeId: "node-1", runId: "run-2", taskId: "run-2", status: "running", updatedAt: now } }
      ] })).ok).toBe(true);
  }

  function expectLateSettlement(room: CanvasRoom) {
    expect(published(room).jobs).toHaveLength(2);
    expect(published(room).jobs.find(job => job.id === "custom-job-1")?.status).toBe("success");
    expect(published(room).jobs.find(job => job.id === "newer-job-2")?.status).toBe("running");
    expect(published(room).nodeData["node-1"]).toMatchObject({ activeRunId: "run-2", taskStatus: "processing", result: { kind: "text", text: "newer draft" } });
  }

  it("archives and settles a late run's accepted job without touching a newer run", async () => {
    const { room } = await acceptedRoom("custom-job-1");
    await beginNewer(room);
    const { consumer, archived } = realConsumer(room);
    expect(await consumer.reconcileOnce()).toMatchObject({ skipped: 1, failed: 0 });
    expectLateSettlement(room);
    expect(archived).toEqual(["custom-job-1"]);
  });

  it("retains the original job when a newer begin wins the authority transaction race", async () => {
    const { room } = await acceptedRoom("custom-job-1");
    const submitDerived = room.submitDerived.bind(room);
    vi.spyOn(room, "submitDerived").mockImplementationOnce(async input => {
      await beginNewer(room);
      return submitDerived(input);
    });
    const { consumer, archived } = realConsumer(room);
    expect(await consumer.reconcileOnce()).toMatchObject({ skipped: 1, failed: 0 });
    expectLateSettlement(room);
    expect(archived.every(jobId => jobId === "custom-job-1")).toBe(true);
  });

  it("keeps legacy history recovery when no accepted durable job is present", async () => {
    const { room } = await acceptedRoom(null);
    expect(await realConsumer(room).consumer.reconcileOnce()).toMatchObject({ projected: 1, failed: 0 });
    expect(published(room).jobs).toEqual([expect.objectContaining({ id: "job-run-1", status: "success" })]);
  });
});
