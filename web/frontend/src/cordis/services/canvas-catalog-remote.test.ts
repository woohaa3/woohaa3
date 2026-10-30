/**
 * Canvas Catalog remote adapter 测试
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 2.2 / 2.4）。
 *
 * 覆盖：分页/创建请求形状、稳定错误码透传、malformed 响应、detail 摘要派生，
 * 以及本地单实例不附加管理员令牌、只走同源会话。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasCatalogRemote } from "./canvas-catalog-remote.js";

afterEach(() => vi.useRealTimers());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fetchOnce(body: unknown, status = 200): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("createCanvasCatalogRemote", () => {
  it("list 发送 offset/limit 并解码分页", async () => {
    const { impl, calls } = fetchOnce({
      items: [{ id: "a", title: "A", revision: 1, updatedAt: "t", createdAt: "t", nodeCount: 0, assetCount: 0 }],
      total: 1,
      offset: 0,
      limit: 20
    });
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    const result = await remote.list({ offset: 0, limit: 20 });
    expect(result).toMatchObject({ ok: true, total: 1 });
    expect(calls[0]!.url).toContain("/api/canvases?offset=0&limit=20");
  });

  it("create 返回 canvasId/revision/title", async () => {
    const { impl } = fetchOnce({ canvas: { id: "new", title: "新" }, revision: 1 });
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    const result = await remote.create({ title: "新" });
    expect(result).toEqual({ ok: true, canvasId: "new", revision: 1, title: "新" });
  });

  it("get 从完整画布派生摘要（含 nodeCount/assetCount）", async () => {
    const { impl } = fetchOnce({
      canvas: {
        id: "a",
        title: "A",
        revision: 3,
        updatedAt: "t",
        document: { nodes: [{ id: "n1" }] },
        assets: [{ id: "asset1" }]
      }
    });
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    const result = await remote.get("a");
    expect(result).toMatchObject({ ok: true, summary: { id: "a", revision: 3, nodeCount: 1, assetCount: 1 } });
  });

  it("delete 发送 expectedRevision 查询参数，204 视为成功", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    expect(await remote.delete("a b", 7)).toEqual({ ok: true });
    expect(calls).toEqual([{ url: "/api/canvases/a%20b?expectedRevision=7", method: "DELETE" }]);
  });

  it("delete 透传版本冲突与无权限的稳定 code", async () => {
    const conflict = createCanvasCatalogRemote({
      fetchImpl: fetchOnce({ code: "REVISION_CONFLICT", message: "画布 revision 已变化" }, 409).impl
    });
    expect(await conflict.delete("a", 1)).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    const forbidden = createCanvasCatalogRemote({
      fetchImpl: fetchOnce({ code: "FORBIDDEN", message: "只有画布作者能删除这张画布" }, 403).impl
    });
    expect(await forbidden.delete("a", 1)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("HTTP 错误透传稳定 code", async () => {
    const { impl } = fetchOnce({ code: "CANVAS_NOT_FOUND", message: "不存在" }, 404);
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    const result = await remote.get("missing");
    expect(result).toMatchObject({ ok: false, code: "CANVAS_NOT_FOUND", error: "不存在" });
  });

  it("malformed 响应返回 malformed-response", async () => {
    const { impl } = fetchOnce({ items: [{ id: "a" }], total: 1, offset: 0, limit: 20 });
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    const result = await remote.list({ offset: 0, limit: 20 });
    expect(result).toMatchObject({ ok: false, code: "malformed-response" });
  });

  it("网络失败返回 unavailable", async () => {
    vi.useFakeTimers();
    const impl = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    const pending = remote.list({ offset: 0, limit: 20 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("热重载期间的断连和 502 自动恢复，不改变分页或请求身份", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({ items: [], total: 0, offset: 0, limit: 20 }));
    const pending = createCanvasCatalogRemote({ fetchImpl }).list({ offset: 0, limit: 20 });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: true, total: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([url]) => url === "/api/canvases?offset=0&limit=20")).toBe(true);
  });

  it("持续 503 有界重试后返回真实错误，创建请求不会自动重发", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json({ code: "upstream-unavailable" }, 503));
    const remote = createCanvasCatalogRemote({ fetchImpl });
    const pending = remote.list({ offset: 0, limit: 20 });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: false, code: "upstream-unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    fetchImpl.mockClear();
    expect(await remote.create({ title: "新画布" })).toMatchObject({ ok: false, code: "upstream-unavailable" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("list/get/create 都不附加管理员令牌，只走同源会话", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      if (url.includes("offset=")) return json({ items: [], total: 0, offset: 0, limit: 20 });
      if (url === "/api/canvases") return json({ canvas: { id: "new", title: "新" }, revision: 1 });
      return json({ canvas: { id: "a", title: "A", revision: 1, document: { nodes: [] }, assets: [] } });
    }) as typeof fetch;

    const remote = createCanvasCatalogRemote({ fetchImpl: impl });
    await remote.list({ offset: 0, limit: 20 });
    await remote.get("a");
    await remote.create({ title: "新" });

    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST"]);
    for (const call of calls) {
      expect(call.headers.has("x-woohaa3-admin-token")).toBe(false);
    }
    expect(calls.some((call) => call.url === "/api/dev-admin")).toBe(false);
  });
});
