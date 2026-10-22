import { describe, expect, it, vi } from "vitest";
import { RuntimeIssues, type RuntimeIssue } from "./runtime-issues.js";

const issue = (key: string): RuntimeIssue => ({ key, scope: "texture", operation: "upload",
  nodeId: key, message: "上传失败", detail: "Invalid texture", recoverable: true });

describe("RuntimeIssues", () => {
  it("相同问题只通知一次，监听器异常隔离，恢复只清除指定问题", () => {
    const store = new RuntimeIssues();
    store.subscribe(() => { throw new Error("observer"); });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() => store.report(issue("a"))).not.toThrow();
    const snapshot = store.getSnapshot();
    store.report(issue("a"));
    expect(store.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    store.report(issue("b"));
    store.clear("a");
    expect(store.getSnapshot().map(entry => entry.key)).toEqual(["b"]);
  });
  it("诊断有界且普通清理不能清除致命问题", () => {
    const store = new RuntimeIssues();
    store.report({ ...issue("trap"), recoverable: false });
    for (let id = 0; id < 100; id++) store.report(issue(String(id)));
    expect(store.getSnapshot()).toHaveLength(64);
    store.clear("trap");
    store.clearRecoverable();
    expect(store.getSnapshot().map(entry => entry.key)).toEqual(["trap"]);
  });
});
