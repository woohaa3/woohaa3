/**
 * 任务结果补偿消费的失败重试（修复：投影失败不推进水位）。
 *
 * 真实缺陷：重启后终态补写完成，但 consumer 启动时 canvas room 尚未装载 → 投影失败；
 * 旧实现把 cursor 推到全局高水位，失败记录在本进程内再也不会被读到，画布节点永久 processing。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutionDetail } from "@woohaa3/contracts";
import { createTaskResultConsumer, PROJECTION_RETRY_BASE_MS } from "./result-consumer.js";
import type { CanvasTaskProjector, ProjectionOutcome, ProjectionReceiptStore } from "../sync/index.js";
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
  const consumer = createTaskResultConsumer({
    projector,
    taskClient,
    receipts: {} as ProjectionReceiptStore,
    logger: () => undefined
  });
  return { consumer, projections, afterCalls };
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

  it("非终态记录不参与补偿", async () => {
    const h = harness([], [{ ...historyRecord(5), state: "running" }]);
    const summary = await h.consumer.reconcileOnce();
    expect(summary).toMatchObject({ projected: 0, failed: 0 });
    expect(h.projections).toHaveLength(0);
  });
});
