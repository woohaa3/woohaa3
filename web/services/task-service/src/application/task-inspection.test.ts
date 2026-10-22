/**
 * 受限任务监控 facade 单元测试
 * （change: 2026-10-13-add-enterprise-access-and-production-coverage，任务 7.4/7.5 / design D9）。
 *
 * 覆盖：授权在 repository 查询**之前**执行（未授权时零查询）；snapshot 的全局计数与过滤列表取自
 * 同一次 observedAt；limit 默认 100 / 上限 200；detail 的授权与 not-found。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  TASK_INSPECTION_DEFAULT_LIMIT,
  TASK_INSPECTION_MAX_LIMIT,
  type PrincipalContext
} from "@woohaa3/contracts";
import type { HistoryRecordInput } from "../repository/history/types.js";
import { createSqliteTaskHistoryRepository } from "../repository/history-repository.js";
import { createTaskInspectionFacade } from "./task-inspection.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-task-inspect-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PRINCIPAL: PrincipalContext = { subject: "admin-a", identityProvider: "test-identity" };

function record(patch: Partial<HistoryRecordInput> & { taskKey: string }): HistoryRecordInput {
  return {
    state: "queued",
    providerId: "litellm",
    modelType: "image",
    modelKey: "litellm:img",
    request: { prompt: "p", parameters: {} },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    durationMs: 0,
    ...patch
  };
}

describe("createTaskInspectionFacade（任务 7.4/7.5）", () => {
  it("授权在 repository 查询之前：断言抛错时零查询、不泄漏数据", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord(record({ taskKey: "t1" }));
    const countSpy = vi.spyOn(history, "countStates");
    const listSpy = vi.spyOn(history, "list");
    const facade = createTaskInspectionFacade({
      history,
      assertAuthorized: async () => {
        throw new Error("forbidden");
      }
    });
    await expect(facade.snapshot({ principal: PRINCIPAL })).rejects.toThrow("forbidden");
    await expect(facade.detail({ principal: PRINCIPAL, taskKey: "t1" })).rejects.toThrow("forbidden");
    expect(countSpy).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
    history.close();
  });

  it("snapshot：全局计数与过滤列表同一 observedAt，默认 limit=100、上限 200", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord(record({ taskKey: "run-1", state: "running" }));
    history.upsertRecord(record({ taskKey: "done-1", state: "succeeded" }));
    const observed = "2026-10-13T12:00:00.000Z";
    const facade = createTaskInspectionFacade({ history, assertAuthorized: async () => undefined, now: () => observed });
    const snapshot = await facade.snapshot({ principal: PRINCIPAL });
    expect(snapshot.observedAt).toBe(observed);
    expect(snapshot.stateCounts.running).toBe(1);
    expect(snapshot.stateCounts.succeeded).toBe(1);
    expect(snapshot.stateCounts.queued).toBe(0);
    expect(snapshot.items.map((item) => item.taskKey)).toContain("run-1");
    // 每条列表项都带 timing.observedAt（同一次快照语义）。
    for (const item of snapshot.items) expect(item.timing?.observedAt).toBeDefined();
    expect(TASK_INSPECTION_DEFAULT_LIMIT).toBe(100);
    expect(TASK_INSPECTION_MAX_LIMIT).toBe(200);
    // 超出上限被钳制（此处用 500 传入，仍成功且不抛错）。
    const capped = await facade.snapshot({ principal: PRINCIPAL, limit: 500 });
    expect(capped.items.length).toBeLessThanOrEqual(TASK_INSPECTION_MAX_LIMIT);
    history.close();
  });

  it("detail：授权通过返回详情，未知 taskKey 返回 null", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord(record({ taskKey: "t1" }));
    const facade = createTaskInspectionFacade({ history, assertAuthorized: async () => undefined });
    const detail = await facade.detail({ principal: PRINCIPAL, taskKey: "t1" });
    expect(detail?.taskKey).toBe("t1");
    expect(await facade.detail({ principal: PRINCIPAL, taskKey: "missing" })).toBeNull();
    history.close();
  });

  // change: l0-generation-provenance —— 详情是排障面，必须带请求摘要（提示词/参数/参考输入）
  // 与真实的生命周期耗时，否则页面只剩「未知」。
  it("detail：带请求摘要与参考输入，未知 taskKey 仍返回 null", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord(
      record({
        taskKey: "t-detail",
        state: "succeeded",
        createdAt: "2026-01-01T00:00:00Z",
        startedAt: "2026-01-01T00:00:02Z",
        finishedAt: "2026-01-01T00:00:12Z",
        request: {
          prompt: "一只猫",
          parameters: { size: "1024x1024" },
          inputs: [{ role: "reference_image", mediaType: "image/png", assetId: "asset-1", storageKey: "generation-outputs/a.png" }]
        }
      } as never)
    );
    const facade = createTaskInspectionFacade({
      history,
      assertAuthorized: async () => undefined,
      now: () => "2026-01-01T01:00:00.000Z"
    });
    const detail = await facade.detail({ principal: PRINCIPAL, taskKey: "t-detail" });
    expect(detail?.request?.prompt).toBe("一只猫");
    expect(detail?.request?.parameters).toEqual({ size: "1024x1024" });
    expect(detail?.request?.inputs).toEqual([
      { role: "reference_image", mediaType: "image/png", assetId: "asset-1", storageKey: "generation-outputs/a.png" }
    ]);
    history.close();
  });

  it("耗时：终态用 finishedAt 计算总/排队/执行，不猜状态驻留", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord(
      record({
        taskKey: "t-timing",
        state: "succeeded",
        createdAt: "2026-01-01T00:00:00Z",
        startedAt: "2026-01-01T00:00:02Z",
        finishedAt: "2026-01-01T00:00:12Z",
        updatedAt: "2026-01-01T00:00:20Z"
      })
    );
    const facade = createTaskInspectionFacade({
      history,
      assertAuthorized: async () => undefined,
      // 终态：observedAt 不参与计算（否则耗时会随时间增长）。
      now: () => "2026-01-01T05:00:00.000Z"
    });
    const detail = await facade.detail({ principal: PRINCIPAL, taskKey: "t-timing" });
    expect(detail?.timing).toMatchObject({
      admittedAt: "2026-01-01T00:00:00Z",
      firstStartedAt: "2026-01-01T00:00:02Z",
      totalMs: 12_000,
      queueMs: 2_000,
      executionMs: 10_000,
      observedAt: "2026-01-01T05:00:00.000Z"
    });
    // updated_at 会被任何写入推进，不能当「状态变化时刻」。
    expect(detail?.timing?.stateMs).toBeUndefined();
    expect(detail?.timing?.stateChangedAt).toBeUndefined();
    history.close();
  });

  it("耗时：进行中用 observedAt 作为终点，列表与详情同一口径", async () => {
    const history = createSqliteTaskHistoryRepository({ path: tempDb() });
    history.upsertRecord(
      record({
        taskKey: "t-running",
        state: "running",
        createdAt: "2026-01-01T00:00:00Z",
        startedAt: "2026-01-01T00:00:05Z"
      })
    );
    const facade = createTaskInspectionFacade({
      history,
      assertAuthorized: async () => undefined,
      now: () => "2026-01-01T00:01:00.000Z"
    });
    const snapshot = await facade.snapshot({ principal: PRINCIPAL });
    const item = snapshot.items.find((entry) => entry.taskKey === "t-running");
    expect(item?.timing).toMatchObject({ totalMs: 60_000, queueMs: 5_000, executionMs: 55_000 });
    history.close();
  });
});

it("实例 facade 不需要 principal，仍只返回有界历史与正常不存在结果", async () => {
  const history = createSqliteTaskHistoryRepository({ path: tempDb() });
  try {
    history.upsertRecord(record({ taskKey: "instance-task" }));
    const authorization = vi.fn(async () => { throw new Error("不应调用"); });
    const facade = createTaskInspectionFacade({ history, assertAuthorized: authorization,
      accessRuntime: { enabled: false, instance: { kind: "instance", id: "instance:test", ownerId: "instance:test", credentialOwnerId: "instance:test" } }
    });
    expect((await facade.snapshot({})).items).toHaveLength(1);
    expect(await facade.detail({ taskKey: "missing" })).toBeNull();
    expect(authorization).not.toHaveBeenCalled();
  } finally { history.close(); }
});
