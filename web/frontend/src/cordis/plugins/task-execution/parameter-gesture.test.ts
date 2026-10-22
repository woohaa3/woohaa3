/**
 * 参数手势记录与本地参数撤销测试（change: 2026-10-09-improve-canvas-workflow，任务 1.6）。
 */
import { describe, expect, it } from "vitest";
import { createParameterGestureRecorder } from "./parameter-gesture.js";
import { createModelDraftStore } from "./model-draft.js";
import { EditJournal } from "../../services/canvas-state/store/edit-journal.js";

describe("参数手势合并", () => {
  it("连续拖动滑块合并为一次手势，before 保持手势开始值", () => {
    const recorder = createParameterGestureRecorder();
    recorder.patch({ nodeId: "n1", modelKey: "m1", before: { steps: 10 }, values: { steps: 20 } });
    recorder.patch({ nodeId: "n1", modelKey: "m1", before: { steps: 10 }, values: { steps: 30 } });
    const gesture = recorder.end();
    expect(gesture).not.toBeNull();
    expect(gesture!.before).toEqual({ steps: 10 });
    expect(gesture!.after).toEqual({ steps: 30 });
  });

  it("无实际变化返回 null", () => {
    const recorder = createParameterGestureRecorder();
    recorder.patch({ nodeId: "n1", modelKey: "m1", before: { steps: 10 }, values: { steps: 10 } });
    expect(recorder.end()).toBeNull();
  });

  it("未开始手势 end 返回 null", () => {
    const recorder = createParameterGestureRecorder();
    expect(recorder.end()).toBeNull();
  });
});

describe("本地参数条目撤销不回退规范参数/任务", () => {
  it("撤销只恢复 {nodeId, modelKey} 分区并不同步提交命令", () => {
    const draftStore = createModelDraftStore();
    draftStore.patch("n1", "m1", { parameters: { steps: 10 } });
    const recorder = createParameterGestureRecorder();
    recorder.patch({ nodeId: "n1", modelKey: "m1", before: { steps: 10 }, values: { steps: 20 } });
    const gesture = recorder.end()!;
    draftStore.patch("n1", "m1", { parameters: gesture.after });

    const journal = new EditJournal({
      isWritable: () => true,
      hasNetChange: () => true,
      submitGuarded: () => ({ ok: true, settled: Promise.resolve({ ok: true, committed: true }) })
    });
    journal.recordParameter({
      label: "撤销参数修改",
      nodeId: "n1",
      modelKey: "m1",
      before: gesture.before,
      after: gesture.after
    });
    let applied: Record<string, unknown> | null = null;
    return journal.undo({
      apply: async (entry) => {
        if (entry.kind === "parameter") {
          applied = entry.before;
          draftStore.patch(entry.nodeId, entry.modelKey, { parameters: entry.before });
        }
        return { ok: true };
      }
    }).then((result) => {
      expect(result.ok).toBe(true);
      expect(applied).toEqual({ steps: 10 });
      expect(draftStore.get("n1", "m1").parameters).toEqual({ steps: 10 });
      // 其它分区不受影响
      expect(draftStore.get("n1", "m2").parameters).toEqual({});
    });
  });
});

describe("分区隔离", () => {
  it("不同 modelKey 分区互不影响", () => {
    const draftStore = createModelDraftStore();
    draftStore.patch("n1", "m1", { parameters: { steps: 10 } });
    draftStore.patch("n1", "m2", { parameters: { steps: 99 } });
    expect(draftStore.get("n1", "m1").parameters).toEqual({ steps: 10 });
    expect(draftStore.get("n1", "m2").parameters).toEqual({ steps: 99 });
  });

  it("节点删除后分区释放，撤销有可读原因", async () => {
    const draftStore = createModelDraftStore();
    draftStore.patch("n1", "m1", { parameters: { steps: 20 } });
    draftStore.clear("n1", "m1");
    // 分区已释放：撤销找不到目标
    const journal = new EditJournal({
      isWritable: () => true,
      hasNetChange: () => true,
      submitGuarded: () => ({ ok: true, settled: Promise.resolve({ ok: true, committed: true }) })
    });
    journal.recordParameter({ label: "撤销参数修改", nodeId: "n1", modelKey: "m1", before: { steps: 10 }, after: { steps: 20 } });
    const result = await journal.undo({
      apply: async () => ({ ok: false, reason: "参数记录所属草稿已不可用" })
    });
    expect(result.ok).toBe(false);
  });
});
