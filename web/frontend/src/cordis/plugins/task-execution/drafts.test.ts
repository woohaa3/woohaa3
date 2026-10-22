/**
 * 按节点隔离的草稿测试（任务 3.4）。
 *
 * 草稿只允许保存**未提交**的输入；任务状态绝不出现在这里。
 */
import { describe, expect, it } from "vitest";
import { NodeDraftStore } from "./drafts.js";

function store() {
  return new NodeDraftStore();
}

describe("NodeDraftStore", () => {
  it("按 nodeId 隔离：改动一个节点不影响另一个", () => {
    const drafts = store();
    drafts.patch("a", { prompt: "A 的提示词" });
    drafts.patch("b", { prompt: "B 的提示词" });
    expect(drafts.get("a")?.prompt).toBe("A 的提示词");
    expect(drafts.get("b")?.prompt).toBe("B 的提示词");
  });

  it("切走再切回保留草稿（同一个 store 实例）", () => {
    const drafts = store();
    drafts.patch("a", { prompt: "还没提交的内容", parameters: { model: "m", ratio: "1:1" } });
    // 切到 b 再切回 a 只是读不同的 key，草稿不会丢。
    expect(drafts.get("b")).toBeUndefined();
    expect(drafts.get("a")).toEqual({
      prompt: "还没提交的内容",
      parameters: { model: "m", ratio: "1:1" }
    });
  });

  it("undefined 不会擦掉已有 prompt（面板只回调变更字段）", () => {
    const drafts = store();
    drafts.patch("a", { prompt: "已输入" });
    drafts.patch("a", { parameters: { model: "m" } });
    expect(drafts.get("a")?.prompt).toBe("已输入");
    expect(drafts.get("a")?.parameters).toEqual({ model: "m" });
  });

  it("返回稳定引用（useSyncExternalStore 的前提）", () => {
    const drafts = store();
    drafts.patch("a", { prompt: "x" });
    expect(drafts.get("a")).toBe(drafts.get("a"));
  });

  it("prune 清掉已删除节点的草稿，保留仍存在的节点", () => {
    const drafts = store();
    drafts.patch("a", { prompt: "A" });
    drafts.patch("b", { prompt: "B" });
    drafts.prune(new Set(["a"]));
    expect(drafts.get("a")?.prompt).toBe("A");
    expect(drafts.get("b")).toBeUndefined();
  });

  it("applySnapshot 把提交快照留在面板上", () => {
    const drafts = store();
    drafts.applySnapshot("a", {
      prompt: "提交的提示词",
      model: "gpt-image-2",
      parameters: { model: "gpt-image-2", resolution: "2K" }
    });
    expect(drafts.get("a")).toEqual({
      prompt: "提交的提示词",
      parameters: { model: "gpt-image-2", resolution: "2K" }
    });
  });

  it("订阅者收到变更通知，取消订阅后不再收到", () => {
    const drafts = store();
    let count = 0;
    const unsubscribe = drafts.subscribe(() => {
      count += 1;
    });
    drafts.patch("a", { prompt: "x" });
    expect(count).toBe(1);
    unsubscribe();
    drafts.patch("a", { prompt: "y" });
    expect(count).toBe(1);
  });

  it("clearAll 清空全部草稿", () => {
    const drafts = store();
    drafts.patch("a", { prompt: "A" });
    drafts.patch("b", { prompt: "B" });
    drafts.clearAll();
    expect(drafts.get("a")).toBeUndefined();
    expect(drafts.get("b")).toBeUndefined();
  });
});
