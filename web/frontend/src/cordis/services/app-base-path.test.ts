/**
 * 前端挂载路径解析器测试
 * （change: 2026-10-15-support-configurable-app-base-path，design D3/D5）。
 *
 * 验证：逻辑路径 → 公开 URL 只加一次前缀；公开路径 → 逻辑路径只剥一次；公开 fetch 只映射
 * 站内根相对路径，完整 URL/Request 原样透传。不感知运行期变化（部署上下文只读）。
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appBasePathPrefixValue,
  appPublicUrl,
  currentAppBasePath,
  getAppPublicFetch,
  setAppBasePathForTesting,
  stripAppLocationPathname
} from "./app-base-path.js";

afterEach(() => setAppBasePathForTesting("/"));

describe("前端挂载路径解析器", () => {
  it("默认根挂载是恒等映射", () => {
    setAppBasePathForTesting("/");
    expect(currentAppBasePath()).toBe("/");
    expect(appPublicUrl("/api/x")).toBe("/api/x");
    expect(appBasePathPrefixValue()).toBe("");
    expect(stripAppLocationPathname("/task-history")).toBe("/task-history");
  });

  it("多级挂载加一次前缀、剥一次前缀", () => {
    setAppBasePathForTesting("/tools/woohaa");
    expect(currentAppBasePath()).toBe("/tools/woohaa/");
    expect(appPublicUrl("/api/media/k")).toBe("/tools/woohaa/api/media/k");
    expect(appBasePathPrefixValue()).toBe("/tools/woohaa");
    expect(stripAppLocationPathname("/tools/woohaa/task-history")).toBe("/task-history");
    // 相似前缀不是子路径，剥离失败时原样返回（路由不会误判）。
    expect(stripAppLocationPathname("/tools/woohaa-other/x")).toBe("/tools/woohaa-other/x");
  });

  it("非法挂载值退回根（不抛错）", () => {
    setAppBasePathForTesting("https://host/app");
    expect(currentAppBasePath()).toBe("/");
  });

  it("公开 fetch 只映射站内根相对路径", async () => {
    setAppBasePathForTesting("/canvas/");
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : String(input));
      return new Response("ok");
    }) as unknown as typeof globalThis.fetch;
    try {
      const fetchImpl = getAppPublicFetch();
      await fetchImpl("/api/canvases");
      await fetchImpl("https://external.example/x");
      expect(calls).toEqual(["/canvas/api/canvases", "https://external.example/x"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
