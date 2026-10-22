/**
 * App Router 通用 extension page URL 编解码测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/8.1/9.4 / design D10）。
 *
 * 宿主只认识 canvas、分支核心页（task-history/settings）与**通用** extension page：路径/查询
 * 编解码来自页面自身声明。本测试验证纯解析、旧路径 redirect、核心页优先与同页 scope identity 复用。
 */
import { describe, expect, it } from "vitest";
import { AppRouterStore, locationToPath, resolveAppRoute, resolvePageLocation } from "./app-router-store.js";
import { createAppPageRegistry } from "../extension-entry/app-pages.js";
import { createFakeExtensionPageEntry } from "../test-support/app-pages.js";

const registry = createAppPageRegistry([
  createFakeExtensionPageEntry({
    extensionId: "fake-monitor",
    pageId: "fake-monitor",
    path: "/admin/fake",
    legacyRedirectPaths: ["/fake-legacy"],
    queryKeys: ["state", "canvasId", "nodeId", "taskKey"]
  }).entry
]);

describe("通用 extension page URL 编解码", () => {
  it("解析已登记路径与类型化查询；未知参数被规范化丢弃", () => {
    const resolution = resolveAppRoute(
      "/admin/fake",
      "?state=failed&canvasId=c1&nodeId=n1&taskKey=t1&bogus=x&empty=",
      registry
    );
    expect(resolution.location).toEqual({
      page: "extension",
      extensionPageId: "fake-monitor",
      query: { state: "failed", canvasId: "c1", nodeId: "n1", taskKey: "t1" }
    });
    expect(resolution.legacyRedirectPath).toBeUndefined();
  });

  it("尾斜杠规范化后仍命中同一页面", () => {
    expect(resolvePageLocation("/admin/fake/", "", registry)).toEqual({
      page: "extension",
      extensionPageId: "fake-monitor"
    });
  });

  it("旧路径解析为受保护 redirect，指向规范页面且保留白名单查询", () => {
    const resolution = resolveAppRoute("/fake-legacy", "?state=failed&bogus=x", registry);
    expect(resolution.location).toEqual({
      page: "extension",
      extensionPageId: "fake-monitor",
      query: { state: "failed" }
    });
    expect(resolution.legacyRedirectPath).toBe("/fake-legacy");
  });

  it("分支核心页优先于 extension registry：设置兼容入口与任务历史页不被遮蔽", () => {
    // 扩展的旧路径 redirect 不得把 `/task-history`、`/settings` 从核心语义抢走
    // （change: 2026-10-17-move-settings-into-canvas-dialog：`/settings` 是 Canvas 兼容入口）。
    const shadowing = createAppPageRegistry([
      createFakeExtensionPageEntry({
        extensionId: "shadow",
        pageId: "shadow",
        path: "/admin/shadow",
        legacyRedirectPaths: ["/task-history", "/settings"]
      }).entry
    ]);
    expect(resolvePageLocation("/settings", "", shadowing)).toEqual({ page: "canvas", openSettings: true });
    expect(resolvePageLocation("/settings/", "", shadowing)).toEqual({ page: "canvas", openSettings: true });
    expect(resolveAppRoute("/settings", "", shadowing).legacyRedirectPath).toBe("/settings");
    expect(resolvePageLocation("/task-history", "?tab=all", shadowing)).toEqual({
      page: "task-history",
      history: { tab: "all" }
    });
  });

  it("未注册路径沿用分支既有 Canvas 回退（不回退成不可用页）", () => {
    expect(resolvePageLocation("/not-registered", "", registry)).toEqual({ page: "canvas" });
  });

  it("根路径解析为 Canvas，不进入 extension 分支", () => {
    expect(resolvePageLocation("/", "?canvasId=c1&nodeId=n1", registry)).toEqual({
      page: "canvas",
      canvasId: "c1",
      nodeId: "n1"
    });
  });

  it("往返序列化稳定（空查询不写入 `?`）", () => {
    expect(locationToPath({ page: "extension", extensionPageId: "fake-monitor" }, registry)).toBe("/admin/fake");
    const withQuery = locationToPath(
      { page: "extension", extensionPageId: "fake-monitor", query: { state: "failed", taskKey: "t1" } },
      registry
    );
    expect(withQuery).toContain("/admin/fake?");
    const roundTrip = resolvePageLocation("/admin/fake", withQuery.split("?")[1] ?? "", registry);
    expect(roundTrip).toEqual({
      page: "extension",
      extensionPageId: "fake-monitor",
      query: { state: "failed", taskKey: "t1" }
    });
  });

  it("未注册 pageId 序列化回退 `/`（不产生悬空路径）", () => {
    expect(locationToPath({ page: "extension", extensionPageId: "missing" }, registry)).toBe("/");
  });

  it("extension page 的 canvasId/nodeId 是筛选而不是 Canvas 目标（不触发 scope 重建）", () => {
    const store = new AppRouterStore({ initialPathname: "/admin/fake", initialSearch: "", appPages: registry });
    const scopeBefore = store.currentScopeId();
    store.commit({ page: "extension", extensionPageId: "fake-monitor", query: { canvasId: "c1", nodeId: "n1" } });
    expect(store.currentScopeId()).toBe(scopeBefore);
  });

  it("不同 extension pageId 触发新的 scope identity", () => {
    const twoPages = createAppPageRegistry([
      createFakeExtensionPageEntry({ extensionId: "a", pageId: "a", path: "/a" }).entry,
      createFakeExtensionPageEntry({ extensionId: "b", pageId: "b", path: "/b" }).entry
    ]);
    const store = new AppRouterStore({ initialPathname: "/a", initialSearch: "", appPages: twoPages });
    const before = store.currentScopeId();
    store.commit({ page: "extension", extensionPageId: "b" });
    expect(store.currentScopeId()).not.toBe(before);
  });

  it("Canvas location 仍按 canvasId 参与 scope identity", () => {
    const store = new AppRouterStore({ initialPathname: "/", initialSearch: "?canvasId=a" });
    const before = store.currentScopeId();
    store.commit({ page: "canvas", canvasId: "b" });
    expect(store.currentScopeId()).not.toBe(before);
  });

  it("pushState 写入包含查询的规范 URL", () => {
    const pushed: string[] = [];
    const store = new AppRouterStore({
      initialPathname: "/admin/fake",
      initialSearch: "",
      appPages: registry,
      history: { pushState: (_data, _title, url) => pushed.push(url) }
    });
    store.navigate({ page: "extension", extensionPageId: "fake-monitor", query: { state: "failed", taskKey: "t1" } });
    expect(pushed[0]).toContain("/admin/fake?");
    expect(pushed[0]).toContain("state=failed");
    expect(pushed[0]).toContain("taskKey=t1");
  });
});
