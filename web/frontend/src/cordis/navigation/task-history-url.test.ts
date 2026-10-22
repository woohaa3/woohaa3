/**
 * App Router Task History URL 编解码测试
 * （change: improve-task-history-experience，任务 3.5）。
 *
 * 验证类型化查询的解析/规范化、无效参数丢弃、同页 scope identity 复用。
 */
import { describe, expect, it } from "vitest";
import { AppRouterStore, locationToPath, resolvePageLocation } from "./app-router-store.js";

describe("Task History URL 编解码", () => {
  it("解析类型化查询并规范化无效值", () => {
    const location = resolvePageLocation(
      "/task-history",
      "?tab=failed&providerId=litellm&modelType=image&modelKey=litellm%3Am&canvasId=c1&nodeId=n1&taskKey=t1&from=2026-01-01T00%3A00%3A00Z&to=bogus&cursor=abc"
    );
    expect(location.page).toBe("task-history");
    expect(location.history).toMatchObject({
      tab: "failed",
      providerId: "litellm",
      modelType: "image",
      modelKey: "litellm:m",
      canvasId: "c1",
      nodeId: "n1",
      taskKey: "t1",
      from: "2026-01-01T00:00:00Z",
      cursor: "abc"
    });
    // 无效时间被丢弃。
    expect(location.history?.to).toBeUndefined();
  });

  it("无参/空查询解析为纯 task-history location", () => {
    expect(resolvePageLocation("/task-history", "")).toEqual({ page: "task-history" });
  });

  it("往返序列化稳定（tab=all 不写入）", () => {
    const path = locationToPath({
      page: "task-history",
      history: { tab: "all", providerId: "litellm", canvasId: "c1", nodeId: "n1", taskKey: "t1", source: "extension", extensionId: "sample-site" }
    });
    expect(path).toContain("/task-history?");
    expect(path).not.toContain("tab=all");
    const roundTrip = resolvePageLocation("/task-history", path.split("?")[1] ?? "");
    expect(roundTrip.history).toMatchObject({ providerId: "litellm", canvasId: "c1", taskKey: "t1", source: "extension", extensionId: "sample-site" });
  });

  it("task-history 的 canvasId/nodeId 是筛选而不是 Canvas 目标（不触发 scope 重建）", () => {
    const store = new AppRouterStore({ initialPathname: "/task-history", initialSearch: "" });
    const scopeBefore = store.currentScopeId();
    store.commit({ page: "task-history", history: { canvasId: "c1", nodeId: "n1" } });
    expect(store.currentScopeId()).toBe(scopeBefore);
  });

  it("Canvas location 仍按 canvasId 参与 scope identity", () => {
    const store = new AppRouterStore({ initialPathname: "/", initialSearch: "?canvasId=a" });
    const before = store.currentScopeId();
    store.commit({ page: "canvas", canvasId: "b" });
    expect(store.currentScopeId()).not.toBe(before);
  });

  it("pushState 写入包含查询的 URL", () => {
    const pushed: string[] = [];
    const store = new AppRouterStore({
      initialPathname: "/task-history",
      initialSearch: "",
      history: { pushState: (_data, _title, url) => pushed.push(url) }
    });
    store.navigate({ page: "task-history", history: { tab: "failed", taskKey: "t1" } });
    expect(pushed[0]).toContain("/task-history?");
    expect(pushed[0]).toContain("tab=failed");
    expect(pushed[0]).toContain("taskKey=t1");
  });
});
