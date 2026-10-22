/**
 * 分组横条动作描述与结果摘要存储测试
 * （change: 2026-10-16-add-group-selection-toolbar，任务 2.2/2.3/4.1 / design D1/D4/D6）。
 */
import { describe, expect, it } from "vitest";
import { GroupRunSummaryStore, GROUP_BULK_ACTION_ID, resolveGroupBulkDescriptor } from "./group-run-actions.js";

const PREVIEW = { groupId: "g", count: 3, skipped: [], enabled: true };
const SUMMARY = { groupId: "g", accepted: ["a"], skipped: [{ nodeId: "b", reason: "缺提示词" }], failed: [] };

describe("resolveGroupBulkDescriptor（任务 2.2）", () => {
  it("贡献 ID 稳定", () => {
    expect(GROUP_BULK_ACTION_ID).toBe("group-bulk-run");
  });

  it("预览可用时显示「批量执行 · N」并使用主动作 tone", () => {
    const descriptor = resolveGroupBulkDescriptor({ preview: PREVIEW, submitting: false });
    expect(descriptor).toMatchObject({ label: "批量执行 · 3", enabled: true, tone: "primary" });
    expect(descriptor.summary).toBeUndefined();
  });

  it("提交中显示「提交中」并禁用", () => {
    const descriptor = resolveGroupBulkDescriptor({ preview: PREVIEW, submitting: true });
    expect(descriptor).toMatchObject({ label: "提交中", enabled: false });
    expect(descriptor.reason).toBe("提交中");
  });

  it("预览不可用时保持「批量执行」文案并把原因写入 summary", () => {
    const descriptor = resolveGroupBulkDescriptor({
      preview: { groupId: "g", count: 0, skipped: [], enabled: false, reason: "成员均在运行中" },
      submitting: false
    });
    expect(descriptor).toMatchObject({ label: "批量执行", enabled: false, reason: "成员均在运行中", summary: "成员均在运行中" });
  });

  it("能力缺失时禁用并给出原因", () => {
    const descriptor = resolveGroupBulkDescriptor({ preview: null, submitting: false });
    expect(descriptor.enabled).toBe(false);
    expect(descriptor.reason).toBe("分组执行能力不可用");
  });
});

describe("GroupRunSummaryStore（任务 4.1）", () => {
  it("记录一批结果并通知订阅", () => {
    const store = new GroupRunSummaryStore();
    let count = 0;
    const off = store.subscribe(() => { count += 1; });
    store.show({ canvasId: "c1", summary: SUMMARY });
    expect(count).toBe(1);
    expect(store.getState()).toMatchObject({ canvasId: "c1", summary: SUMMARY, dismissed: false });
    off();
  });

  it("同画布内新批替换旧摘要", () => {
    const store = new GroupRunSummaryStore();
    store.show({ canvasId: "c1", summary: SUMMARY });
    const next = { groupId: "h", accepted: ["x"], skipped: [], failed: [] };
    store.show({ canvasId: "c1", summary: next });
    expect(store.getState()?.summary).toBe(next);
  });

  it("不同画布写入时丢弃旧摘要（不跨画布误报）", () => {
    const store = new GroupRunSummaryStore();
    store.show({ canvasId: "c1", summary: SUMMARY });
    const other = { groupId: "h", accepted: [], skipped: [], failed: [] };
    store.show({ canvasId: "c2", summary: other });
    expect(store.getState()?.canvasId).toBe("c2");
  });

  it("syncCanvas 在画布切换时清理", () => {
    const store = new GroupRunSummaryStore();
    store.show({ canvasId: "c1", summary: SUMMARY });
    store.syncCanvas("c1");
    expect(store.getState()).not.toBeNull();
    store.syncCanvas("c2");
    expect(store.getState()).toBeNull();
  });

  it("dismiss 隐藏摘要但保留原始记录；未关闭时可读取", () => {
    const store = new GroupRunSummaryStore();
    store.show({ canvasId: "c1", summary: SUMMARY });
    expect(store.getState()).not.toBeNull();
    store.dismiss();
    expect(store.getState()).toBeNull();
    expect(store.getRaw()?.dismissed).toBe(true);
  });

  it("dispose 清空摘要与订阅", () => {
    const store = new GroupRunSummaryStore();
    let count = 0;
    store.subscribe(() => { count += 1; });
    store.show({ canvasId: "c1", summary: SUMMARY });
    store.dispose();
    expect(store.getState()).toBeNull();
    const after = count;
    store.show({ canvasId: "c1", summary: SUMMARY });
    expect(count).toBe(after);
  });
});
