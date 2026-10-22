/**
 * 历史页纯状态/合并测试（change: improve-task-history-experience，任务 3.3）。
 */
import { describe, expect, it } from "vitest";
import type { TaskExecutionSummary } from "@woohaa3/contracts";
import {
  EMPTY_HISTORY_FILTERS,
  addBufferedTaskKeys,
  adjacentTaskKeys,
  mergeHistoryRecord,
  recordMatchesFilters,
  tabToStates
} from "./history-state.js";

function summary(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskKey: "t1",
    state: "running",
    providerId: "litellm",
    modelType: "image",
    canvasId: "c1",
    nodeId: "n1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    recordRevision: 1,
    ...overrides
  };
}

describe("history-state", () => {
  it("tab→states 映射：active 覆盖进行中三态", () => {
    expect(tabToStates("all")).toBeUndefined();
    expect(tabToStates("active")).toEqual(["queued", "pending", "running"]);
    expect(tabToStates("failed")).toEqual(["failed"]);
  });

  it("记录匹配完整筛选谓词", () => {
    const record = summary();
    expect(recordMatchesFilters(record, { ...EMPTY_HISTORY_FILTERS, canvasId: "c1" })).toBe(true);
    expect(recordMatchesFilters(record, { ...EMPTY_HISTORY_FILTERS, canvasId: "other" })).toBe(false);
    expect(recordMatchesFilters(record, { ...EMPTY_HISTORY_FILTERS, from: "2026-02-01T00:00:00Z" })).toBe(false);
  });

  it("来源筛选：plugin/canvas/unknown，旧记录按 unknown 处理", () => {
    const legacy = summary();
    const plugin = summary({ source: "extension", extensionId: "sample-site" });
    const canvas = summary({ source: "canvas" });
    expect(recordMatchesFilters(plugin, { ...EMPTY_HISTORY_FILTERS, source: "extension" })).toBe(true);
    expect(recordMatchesFilters(canvas, { ...EMPTY_HISTORY_FILTERS, source: "extension" })).toBe(false);
    expect(recordMatchesFilters(legacy, { ...EMPTY_HISTORY_FILTERS, source: "unknown" })).toBe(true);
    expect(recordMatchesFilters(legacy, { ...EMPTY_HISTORY_FILTERS, source: "canvas" })).toBe(false);
    expect(recordMatchesFilters(plugin, { ...EMPTY_HISTORY_FILTERS, extensionId: "sample-site" })).toBe(true);
    expect(recordMatchesFilters(plugin, { ...EMPTY_HISTORY_FILTERS, extensionId: "other" })).toBe(false);
  });

  it("按较新 revision 原位更新，乱序/重复不回退", () => {
    const rows = [summary({ recordRevision: 5, state: "running" })];
    const newer = summary({ recordRevision: 6, state: "succeeded" });
    expect(mergeHistoryRecord(rows, newer, EMPTY_HISTORY_FILTERS).rows[0]!.state).toBe("succeeded");
    // 旧/相等 revision 不覆盖。
    const older = summary({ recordRevision: 4, state: "failed" });
    expect(mergeHistoryRecord(rows, older, EMPTY_HISTORY_FILTERS).rows[0]!.state).toBe("running");
    const same = summary({ recordRevision: 5, state: "failed" });
    expect(mergeHistoryRecord(rows, same, EMPTY_HISTORY_FILTERS).rows[0]!.state).toBe("running");
  });

  it("未展示且匹配的记录标记为新任务；不匹配的忽略", () => {
    const matching = mergeHistoryRecord([], summary(), EMPTY_HISTORY_FILTERS);
    expect(matching.isNew).toBe(true);
    const nonMatching = mergeHistoryRecord([], summary({ canvasId: "c2" }), { ...EMPTY_HISTORY_FILTERS, canvasId: "c1" });
    expect(nonMatching.isNew).toBe(false);
  });

  it("已展示记录离开查询条件时保留为 unmatched 占位", () => {
    const rows = [summary({ recordRevision: 1, canvasId: "c1" })];
    const moved = summary({ recordRevision: 2, canvasId: "c2" });
    const result = mergeHistoryRecord(rows, moved, { ...EMPTY_HISTORY_FILTERS, canvasId: "c1" });
    expect(result.rows[0]!.unmatched).toBe(true);
    expect(result.isNew).toBe(false);
  });

  it("新任务缓冲去重，计数只代表缓冲", () => {
    expect(addBufferedTaskKeys(["a"], "b")).toEqual(["a", "b"]);
    expect(addBufferedTaskKeys(["a"], "a")).toEqual(["a"]);
  });

  it("相邻记录只在当前页内成立", () => {
    const rows = [summary({ taskKey: "a" }), summary({ taskKey: "b" }), summary({ taskKey: "c" })];
    expect(adjacentTaskKeys(rows, "b")).toEqual({ previous: "a", next: "c" });
    expect(adjacentTaskKeys(rows, "a")).toEqual({ next: "b" });
    expect(adjacentTaskKeys(rows, "missing")).toEqual({});
  });
});
