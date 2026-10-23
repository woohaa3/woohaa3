/**
 * 片场对象聚焦编辑会话测试
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 4.2/4.3/7.2）。
 *
 * 覆盖：模式切换、选择、beginEdit 暂停播放、一次 itemId 提交、取消恢复、删除、缩放、
 * 只读门禁、失效选择 reconcile。
 */
import { describe, expect, it } from "vitest";
import {
  createModelSnapshot,
  type FilmSetContent,
  type FilmSetItem,
  type FilmSetItemPatchOp
} from "@woohaa3/contracts";
import { FilmSetObjectSession } from "../src/authoring/browser/object-session.js";

function item(id: string): FilmSetItem {
  return {
    id,
    kind: "model",
    name: id,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model: createModelSnapshot({ modelScript: `scene.box({ id: "body" });`, modelScriptVersion: "woohaa-model-js-v2" })
  };
}

function harness(options: { writable?: boolean } = {}) {
  let content: FilmSetContent = { schemaVersion: 3, items: [item("a"), item("b")] };
  const submitted: Array<{ nodeId: string; itemId: string; op: FilmSetItemPatchOp }> = [];
  let paused = 0;
  const session = new FilmSetObjectSession({
    readContent: () => content,
    isWritable: () => options.writable ?? true,
    pausePlayback: () => {
      paused += 1;
    },
    submitItemOp: (input) => {
      submitted.push(input);
      return true;
    }
  });
  return {
    session,
    submitted,
    pauseCount: () => paused,
    setContent: (next: FilmSetContent) => {
      content = next;
    }
  };
}

describe("FilmSetObjectSession（任务 4.2–4.4）", () => {
  it("round-trip floating point drift does not create an undo entry", () => {
    const h = harness();
    h.session.enter("film"); h.session.select("a"); h.session.beginEdit();
    h.session.updatePreview({ offset: { x: 1e-12, y: 0, z: 0 }, scale: 1 + 1e-12, yaw: 1e-12 });
    h.session.endEdit();
    h.session.setSelectedScale(1);
    expect(h.submitted).toHaveLength(0);
  });

  it("changing tools cancels the preview while selection changes retain the local tool", () => {
    const h = harness();
    h.session.enter("film"); h.session.select("a"); h.session.beginEdit();
    h.session.setActive("x");
    h.session.updatePreview({ offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 });
    h.session.setTool("yaw");
    expect(h.session.getState().preview).toBeNull();
    expect(h.session.getState().feedback.active).toBeUndefined();
    h.session.select("b");
    expect(h.session.getState().tool).toBe("yaw");
    h.session.exit(); h.session.enter("film");
    expect(h.session.getState().tool).toBe("move");
    expect(h.submitted).toHaveLength(0);
  });

  it("进入片场即可选择稳定 itemId，无需切换模式", () => {
    const h = harness();
    h.session.enter("film");
    expect(h.session.getState().selectedItemId).toBeNull();
    h.session.select("a");
    expect(h.session.getState().selectedItemId).toBe("a");
    expect(h.session.selectedItem()?.id).toBe("a");
    expect(h.session.objects().map((entry) => entry.itemId)).toEqual(["a", "b"]);
  });

  it("beginEdit 先暂停播放；endEdit 提交一次 itemId 定位的 transform", () => {
    const h = harness();
    h.session.enter("film");
    h.session.select("a");
    expect(h.session.beginEdit()).toBe(true);
    expect(h.pauseCount()).toBe(1);
    h.session.updatePreview({ offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 });
    h.session.endEdit();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({ nodeId: "film", itemId: "a", op: { kind: "transform" } });
    expect(h.session.getState().preview).toBeNull();
  });

  it("取消丢弃 preview，不提交", () => {
    const h = harness();
    h.session.enter("film");
    h.session.select("a");
    h.session.beginEdit();
    h.session.updatePreview({ offset: { x: 9, y: 0, z: 0 }, scale: 1, yaw: 0 });
    h.session.cancelEdit();
    expect(h.submitted).toHaveLength(0);
    expect(h.session.getState().preview).toBeNull();
  });

  it("无净变化不提交", () => {
    const h = harness();
    h.session.enter("film");
    h.session.select("a");
    h.session.beginEdit();
    h.session.endEdit();
    expect(h.submitted).toHaveLength(0);
  });

  it("删除选中对象后清空选择；空片场保持可用", () => {
    const h = harness();
    h.session.enter("film");
    h.session.select("a");
    expect(h.session.deleteSelected()).toBe(true);
    expect(h.submitted.at(-1)?.op).toEqual({ kind: "delete" });
    expect(h.session.getState().selectedItemId).toBeNull();
    h.setContent({ schemaVersion: 3, items: [] });
    expect(h.session.objects()).toEqual([]);
  });

  it("只读时不建立编辑、不提交", () => {
    const h = harness({ writable: false });
    h.session.enter("film");
    h.session.select("a");
    expect(h.session.beginEdit()).toBe(false);
    expect(h.session.deleteSelected()).toBe(false);
    expect(h.submitted).toHaveLength(0);
  });

  it("reconcile 清理远端删除的选中项", () => {
    const h = harness();
    h.session.enter("film");
    h.session.select("a");
    h.setContent({ schemaVersion: 3, items: [item("b")] });
    h.session.reconcile();
    expect(h.session.getState().selectedItemId).toBeNull();
  });

  it("等比缩放提交 transform", () => {
    const h = harness();
    h.session.enter("film");
    h.session.select("a");
    expect(h.session.setSelectedScale(2)).toBe(true);
    expect(h.submitted.at(-1)?.op).toMatchObject({ kind: "transform", localTransform: { scale: 2 } });
  });
});

it("surfaces asynchronous rejection without writing the preview to canonical content", async () => {
  const content: FilmSetContent = { schemaVersion: 3, items: [item("a")] };
  let reject!: (value: { state: string; error: string | null }) => void;
  const settled = new Promise<{ state: string; error: string | null }>(resolve => { reject = resolve; });
  const session = new FilmSetObjectSession({ readContent: () => content, isWritable: () => true,
    submitItemOp: () => ({ ok: true, handle: { settled } }) });
  session.enter("film"); session.select("a"); session.beginEdit();
  session.updatePreview({ offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 }); session.endEdit();
  reject({ state: "rejected", error: "transform-conflict" }); await settled; await Promise.resolve();
  expect(session.getState().error).toBe("transform-conflict");
  expect(content.items[0].localTransform.offset.x).toBe(0);
});

it("ignores a late rejection after leaving and re-entering the same node", async () => {
  const content: FilmSetContent = { schemaVersion: 3, items: [item("a")] };
  let settle!: (value: { state: string; error: string | null }) => void;
  const settled = new Promise<{ state: string; error: string | null }>(resolve => { settle = resolve; });
  const session = new FilmSetObjectSession({ readContent: () => content, isWritable: () => true,
    submitItemOp: () => ({ ok: true, handle: { settled } }) });
  session.enter("film"); session.select("a"); session.beginEdit();
  session.updatePreview({ offset: { x: 3, y: 0, z: 0 }, scale: 1, yaw: 0 }); session.endEdit();
  session.exit(); session.enter("film"); session.select("a"); session.beginEdit();
  settle({ state: "rejected", error: "old-conflict" }); await settled; await Promise.resolve();
  expect(session.getState().error).toBeNull();
  expect(session.getState().preview).not.toBeNull();
});

it("cancels a drag when a remote transform replaces its frozen base", () => {
  const h = harness(); h.session.enter("film"); h.session.select("a"); h.session.beginEdit();
  const updated = item("a"); updated.localTransform.offset.x = 8;
  h.setContent({ schemaVersion: 3, items: [updated, item("b")] }); h.session.reconcile();
  h.session.endEdit();
  expect(h.session.getState().preview).toBeNull();
  expect(h.session.getState().error).toContain("已更新");
  expect(h.submitted).toHaveLength(0);
});

describe("FilmSetObjectSession 异步结算生命周期（任务 4.2/4.4）", () => {
  function asyncHarness() {
    const content: FilmSetContent = { schemaVersion: 3, items: [item("a"), item("b")] };
    const submitted: Array<{ itemId: string; op: FilmSetItemPatchOp; label: string }> = [];
    const resolvers: Array<(value: { state: string; error: string | null }) => void> = [];
    const session = new FilmSetObjectSession({
      readContent: () => content,
      isWritable: () => true,
      submitItemOp: (input) => {
        submitted.push(input);
        const settled = new Promise<{ state: string; error: string | null }>(resolve => { resolvers.push(resolve); });
        return { ok: true, handle: { settled } };
      }
    });
    return { session, submitted, content, settleLast: (value: { state: string; error: string | null }) => resolvers.at(-1)!(value), pendingCount: () => resolvers.length };
  }

  it("删除进入 pending，未结算前禁止同目标重复删除（长按/重复点击不连删）", async () => {
    const h = asyncHarness();
    h.session.enter("film"); h.session.select("a");
    expect(h.session.deleteSelected()).toBe(true);
    expect(h.session.getState().pendingItemId).toBe("a");
    // 同目标再次删除：直接返回 false，不再提交，pending 保持。
    expect(h.session.deleteSelected()).toBe(false);
    expect(h.submitted).toHaveLength(1);
    h.settleLast({ state: "committed", error: null }); await Promise.resolve(); await Promise.resolve();
    expect(h.session.getState().pendingItemId).toBeNull();
  });

  it("删除被 authoritative 拒绝时恢复最新有效选择，不写入旧场景", async () => {
    const h = asyncHarness();
    h.session.enter("film"); h.session.select("a");
    h.session.deleteSelected();
    expect(h.session.getState().selectedItemId).toBeNull();
    h.settleLast({ state: "rejected", error: "protected-edit-conflict" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.session.getState().pendingItemId).toBeNull();
    expect(h.session.getState().selectedItemId).toBe("a");
    expect(h.session.getState().error).toBe("protected-edit-conflict");
    // canonical 内容未被覆盖（仍有两项）。
    expect(h.content.items.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("reconcile 不为 pending 目标清空 invocation 身份", () => {
    const h = asyncHarness();
    h.session.enter("film"); h.session.select("a");
    h.session.deleteSelected();
    // 乐观移除 + 远端 working projection 已不含该对象：不因缺失清 pending 身份。
    h.session.reconcile();
    expect(h.session.getState().pendingItemId).toBe("a");
  });

  it("迟到回执在会话切换后不污染新 scope", async () => {
    const h = asyncHarness();
    h.session.enter("film"); h.session.select("a");
    h.session.deleteSelected();
    const stale = h.settleLast; // 旧调用的 settle 引用
    h.session.exit(); h.session.enter("film"); h.session.select("b");
    stale({ state: "rejected", error: "stale-conflict" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.session.getState().nodeId).toBe("film");
    expect(h.session.getState().selectedItemId).toBe("b");
    expect(h.session.getState().error).toBeNull();
    expect(h.session.getState().pendingItemId).toBeNull();
  });

  it("数值缩放 pending 期间不重复提交或开启预览，原回执仍可结算", async () => {
    const h = asyncHarness();
    h.session.enter("film"); h.session.select("a");
    expect(h.session.setSelectedScale(2)).toBe(true);
    expect(h.session.getState().pendingItemId).toBe("a");
    expect(h.session.setSelectedScale(3)).toBe(false);
    expect(h.session.beginEdit()).toBe(false);
    expect(h.session.getState().preview).toBeNull();
    expect(h.submitted).toHaveLength(1);
    h.settleLast({ state: "committed", error: null });
    await Promise.resolve();
    expect(h.session.getState().pendingItemId).toBeNull();
    expect(h.session.beginEdit()).toBe(true);
  });

  it("支持 Promise 形式回执并在 committed/rejected 时结算", async () => {
    const content: FilmSetContent = { schemaVersion: 3, items: [item("a")] };
    const outcomes: string[] = [];
    let resolve!: (value: { ok: boolean; reason?: string }) => void;
    const session = new FilmSetObjectSession({
      readContent: () => content,
      isWritable: () => true,
      submitItemOp: () => new Promise<{ ok: boolean; reason?: string }>(r => { resolve = r; })
    });
    session.subscribe(() => outcomes.push(session.getState().pendingItemId ?? "settled"));
    session.enter("film"); session.select("a");
    expect(session.deleteSelected()).toBe(true);
    expect(session.getState().pendingItemId).toBe("a");
    resolve({ ok: false, reason: "concurrent-edit-conflict" });
    await Promise.resolve(); await Promise.resolve();
    expect(session.getState().pendingItemId).toBeNull();
    expect(session.getState().error).toBe("concurrent-edit-conflict");
  });

  it("unknown settlement keeps the invocation blocked across selection changes", async () => {
    const h=asyncHarness();h.session.enter("film");h.session.select("a");
    h.session.setSelectedScale(2);h.session.select("b");
    h.settleLast({state:"unknown",error:null});await Promise.resolve();
    expect(h.session.getState().pendingItemId).toBe("a");
    expect(h.session.beginEdit()).toBe(false);expect(h.session.setSelectedScale(3)).toBe(false);
    expect(h.submitted).toHaveLength(1);
  });

  it("非布尔提交失败直接报错且不进入 pending", () => {
    const content: FilmSetContent = { schemaVersion: 3, items: [item("a")] };
    const session = new FilmSetObjectSession({
      readContent: () => content,
      isWritable: () => true,
      submitItemOp: () => ({ ok: false, reason: "planner-rejected" })
    });
    session.enter("film"); session.select("a");
    expect(session.deleteSelected()).toBe(false);
    expect(session.getState().pendingItemId).toBeNull();
    expect(session.getState().error).toBe("planner-rejected");
  });
});
