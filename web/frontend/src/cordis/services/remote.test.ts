/**
 * 三大 remote adapter 测试（change: adopt-frontend-cordis-plugin-runtime，design D4）。
 *
 * 覆盖：Canvas run/cancel/model report 与 socket 路径、Task catalog/history 解析与订阅、
 * Media 上传/URL 构造/受控校验；均可用 fake fetch/transport 驱动，不需要真实服务。
 */
import { describe, expect, it } from "vitest";
import { SESSION_CHANNEL, encodeSessionFrame } from "@woohaa3/contracts/canvas-yjs";
import { createCanvasRemote } from "./canvas-remote.js";
import { createTaskRemote } from "./task-remote.js";
import { createMediaRemote, isAllowedMediaUrl, parseUploadResponse } from "./media-remote.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("canvasRemote", () => {
  it("run 进入 Canvas runs 路径并解析 runId/jobId", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const remote = createCanvasRemote({
      canvasId: "canvas-a",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        return jsonResponse({ ok: true, runId: "run-1", jobId: "job-1" }, 202);
      }) as unknown as typeof fetch
    });
    const result = await remote.run({ nodeId: "n", runId: "run-1", jobId: "job-1", modelKey: "m", prompt: "p", parameters: {} });
    expect(result).toEqual({ ok: true, runId: "run-1", jobId: "job-1" });
    expect(calls[0].url).toBe("/api/canvases/canvas-a/runs");
  });

  it("run/cancel 不附加本地管理员令牌，只走同源会话", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const remote = createCanvasRemote({
      canvasId: "canvas-a",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return jsonResponse({ ok: true, runId: "run-1", jobId: "job-1" }, 202);
      }) as unknown as typeof fetch
    });
    await remote.run({ nodeId: "n", runId: "run-1", jobId: "job-1", modelKey: "m", prompt: "p", parameters: {} });
    await remote.cancel({ nodeId: "n", runId: "run-1" });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/canvases/canvas-a/runs",
      "/api/canvases/canvas-a/runs/cancel"
    ]);
    for (const call of calls) expect(call.headers.has("x-woohaa3-admin-token")).toBe(false);
  });

  it("cancel 使用 /cancel 后缀且错误信息安全", async () => {
    const urls: string[] = [];
    const remote = createCanvasRemote({
      canvasId: "canvas-a",
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return jsonResponse({ ok: false, message: "任务目录不可用" }, 503);
      }) as unknown as typeof fetch
    });
    const result = await remote.cancel({ nodeId: "n", runId: "r" });
    expect(urls[0]).toBe("/api/canvases/canvas-a/runs/cancel");
    expect(result).toEqual({ ok: false, error: "任务目录不可用" });
  });

  it("reportModelScript 发往 model-mcp report 路径", async () => {
    const urls: string[] = [];
    const remote = createCanvasRemote({
      canvasId: "c",
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch
    });
    await remote.reportModelScript({ canvasId: "c", nodeId: "n", status: "ok" });
    expect(urls[0]).toBe("/api/model-mcp/scripts/report");
  });

  it("片段目录方法走 /api/prompt-snippets 并映射稳定错误码", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const remote = createCanvasRemote({
      canvasId: "c",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        if (String(url).includes("/missing")) return jsonResponse({ code: "SNIPPET_NOT_FOUND", message: "不存在" }, 404);
        if (String(url).startsWith("/api/prompt-snippets/tags")) return jsonResponse({ items: [] });
        return jsonResponse({ items: [], nextCursor: null, total: 0 });
      }) as unknown as typeof fetch
    });

    const list = await remote.listSnippets({ query: "猫", filter: "tag", tagId: "t1", limit: 10 });
    expect(list.ok).toBe(true);
    expect(calls[0].url).toContain("/api/prompt-snippets?");
    expect(calls[0].url).toContain("query=");
    expect(calls[0].url).toContain("filter=tag");

    const missing = await remote.getSnippet("missing");
    expect(missing).toMatchObject({ ok: false, code: "SNIPPET_NOT_FOUND" });

    const tagList = await remote.listSnippetTags();
    expect(tagList.ok).toBe(true);
  });

  it("画布级历史方法走节点历史 base path 并拼接查询参数", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const remote = createCanvasRemote({
      canvasId: "c",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        if (String(url).includes("/missing")) return jsonResponse({ code: "NODE_HISTORY_NOT_FOUND", message: "不存在" }, 404);
        return jsonResponse({ items: [], nextCursor: "cur", total: 0, kindCounts: { text: 0, image: 0, video: 0, audio: 0, model: 0 } });
      }) as unknown as typeof fetch
    });

    const page = await remote.listCanvasHistory({ canvasId: "c1", limit: 20, kind: "image" });
    expect(page.ok).toBe(true);
    expect(calls[0].url).toContain("/api/canvas-node-history/c1?");
    expect(calls[0].url).toContain("limit=20");
    expect(calls[0].url).toContain("kind=image");
    expect(calls[0].url).not.toContain("/c1/");

    const withCursor = await remote.listCanvasHistory({ canvasId: "c1", cursor: "abc" });
    expect(withCursor.ok).toBe(true);
    expect(calls[1].url).toContain("cursor=abc");

    // 稳定错误码透传。
    const missing = await remote.listCanvasHistory({ canvasId: "missing" });
    expect(missing).toMatchObject({ ok: false, code: "NODE_HISTORY_NOT_FOUND" });
  });

  it("同类型节点合并走 merge 动作段并保留稳定错误码", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const remote = createCanvasRemote({
      canvasId: "c",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        if (String(url).includes("/blocked/")) {
          return jsonResponse({ code: "NODE_HISTORY_CONFLICT", message: "节点开始了新的生成" }, 409);
        }
        return jsonResponse({
          ok: true, targetNodeId: "target", sourceNodeId: "source", revision: 7,
          copied: 2, duplicates: 1, evicted: 0, alreadyMerged: false
        });
      }) as unknown as typeof fetch
    });

    const merged = await remote.mergeNodeHistory({
      canvasId: "c1",
      targetNodeId: "target",
      sourceNodeId: "source",
      operationId: "op-1",
      expectedSourceCurrentIdentity: "text:abc"
    });
    expect(merged).toEqual({
      ok: true,
      value: {
        targetNodeId: "target", sourceNodeId: "source", revision: 7,
        copied: 2, duplicates: 1, evicted: 0, alreadyMerged: false
      }
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/canvas-node-history/c1/target/merge");
    expect(calls[0]?.body).toEqual({
      sourceNodeId: "source",
      operationId: "op-1",
      expectedSourceCurrentIdentity: "text:abc"
    });

    const conflict = await remote.mergeNodeHistory({
      canvasId: "c1", targetNodeId: "blocked", sourceNodeId: "source", operationId: "op-2"
    });
    expect(conflict).toMatchObject({ ok: false, code: "NODE_HISTORY_CONFLICT" });
  });

  it("片段目录 401/503 映射为 unauthorized/unavailable", async () => {
    const unauthorized = createCanvasRemote({
      canvasId: "c",
      fetchImpl: (async () => jsonResponse({ code: "REPOSITORY_FAILURE" }, 401)) as unknown as typeof fetch
    });
    expect(await unauthorized.listSnippets()).toMatchObject({ ok: false, code: "unauthorized" });
    const unavailable = createCanvasRemote({
      canvasId: "c",
      fetchImpl: (async () => jsonResponse({}, 503)) as unknown as typeof fetch
    });
    expect(await unavailable.listSnippets()).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("openCanvasSession 只创建一个物理 WebSocket 并暴露 canvas-yjs 通道", () => {
    const sockets: string[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = 1;
      binaryType = "";
      private listeners = new Map<string, Set<(event: never) => void>>();
      constructor(public url: string) {
        sockets.push(url);
      }
      send() {}
      close() {}
      addEventListener(type: string, handler: (event: never) => void) {
        const set = this.listeners.get(type) ?? new Set();
        set.add(handler);
        this.listeners.set(type, set);
        // 立即触发 open，模拟连接就绪。
        if (type === "open") handler(undefined as never);
      }
      removeEventListener(type: string, handler: (event: never) => void) {
        this.listeners.get(type)?.delete(handler);
      }
    }
    const remote = createCanvasRemote({
      canvasId: "canvas-a",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      location: { protocol: "https:", host: "example.test" }
    });
    const yjsA = remote.openCanvasSession("canvas-a", "epoch-1");
    const yjsB = remote.openCanvasSession("canvas-a", "epoch-1");
    // 同源、版本化、带 roomEpoch；只创建一个物理 socket（两次调用共享）。
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toContain("wss://example.test/api/canvases/canvas-a/sync");
    expect(sockets[0]).toContain("sessionProtocolVersion=1");
    expect(sockets[0]).toContain("roomEpoch=epoch-1");
    expect(yjsA.isOpen?.()).toBe(true);
    expect(yjsB.isOpen?.()).toBe(true);
  });

  it("reconnectCanvasSession 立即重建未就绪的物理连接，已 open 时空操作", () => {
    const sockets: ManualWebSocket[] = [];
    class ManualWebSocket {
      static OPEN = 1;
      readyState = 0;
      binaryType = "";
      closedWith: { code?: number; reason?: string } | null = null;
      private listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(public url: string) {
        sockets.push(this);
      }
      send() {}
      close(code?: number, reason?: string) {
        this.closedWith = { code, reason };
        this.readyState = 3;
        this.emit("close", { code, reason });
      }
      addEventListener(type: string, handler: (event: unknown) => void) {
        const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
        set.add(handler);
        this.listeners.set(type, set);
      }
      removeEventListener(type: string, handler: (event: unknown) => void) {
        this.listeners.get(type)?.delete(handler);
      }
      emit(type: string, payload: unknown) {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler(payload);
      }
      /** 模拟服务端确认连接建立（open 由真实 WebSocket 异步触发）。 */
      open() {
        this.readyState = 1;
        this.emit("open", undefined);
      }
    }

    const remote = createCanvasRemote({
      canvasId: "canvas-a",
      webSocketImpl: ManualWebSocket as unknown as typeof WebSocket,
      location: { protocol: "https:", host: "example.test" },
      transport: { schedule: () => () => undefined }
    });

    // 从未建立过 transport：空操作，不抛错也不创建 socket。
    remote.reconnectCanvasSession();
    expect(sockets).toHaveLength(0);

    const yjs = remote.openCanvasSession("canvas-a", null);
    const received: Uint8Array[] = [];
    yjs.onMessage((data) => received.push(data));
    expect(sockets).toHaveLength(1);

    // 尚未 open（首次连接还在路上）：关闭旧 socket 并立即重建，不等退避。
    remote.reconnectCanvasSession();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closedWith).toEqual({ code: 1000, reason: "client-reconnect" });

    // 通道订阅者没有被 dispose：新连接 open 后继续收到消息。
    sockets[1]!.open();
    expect(yjs.isOpen?.()).toBe(true);
    sockets[1]!.emit("message", { data: encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, new Uint8Array([7])) });
    expect(received).toHaveLength(1);

    // 已 open 时是空操作：不叠加第二条物理连接。
    remote.reconnectCanvasSession();
    expect(sockets).toHaveLength(2);
    expect(yjs.isOpen?.()).toBe(true);

    remote.closeCanvasSession();
    expect(sockets[1]!.closedWith).toEqual({ code: 1000, reason: "client-dispose" });
  });

  it("taskActivityChanges 走有限 /changes 接口", async () => {
    const urls: string[] = [];
    const remote = createCanvasRemote({
      canvasId: "canvas-a",
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return jsonResponse({ items: [], cursor: 4 });
      }) as unknown as typeof fetch
    });
    const result = await remote.taskActivityChanges({ canvasId: "canvas-a", after: 3, limit: 20 });
    expect(result.ok).toBe(true);
    expect(urls[0]).toBe("/api/canvas-task-activity/canvas-a/changes?after=3&limit=20");
  });
});

describe("taskRemote", () => {
  it("旧后端 503 中的完整目录是配置状态，普通 503 和鉴权失败仍是加载失败", async () => {
    const missing = { available: false, reason: "请配置 Provider API Key", models: [], defaultModels: {} };
    const remote = createTaskRemote({ fetchImpl: (async () => jsonResponse(missing, 503)) as typeof fetch });
    expect(await remote.fetchCatalog()).toEqual(missing);
    for (const [body, status] of [[{ message: "服务暂不可用" }, 503], [missing, 401]] as const) {
      const failed = createTaskRemote({ fetchImpl: (async () => jsonResponse(body, status)) as typeof fetch });
      await expect(failed.fetchCatalog()).rejects.toThrow();
    }
  });

  it("fetchCatalog 解析模型与不可用状态", async () => {
    const remote = createTaskRemote({
      fetchImpl: (async () =>
        jsonResponse({
          available: false,
          reason: "缺少 key",
          models: [],
          defaultModels: {}
        })) as unknown as typeof fetch
    });
    const catalog = await remote.fetchCatalog();
    expect(catalog).toEqual({ available: false, reason: "缺少 key", models: [], defaultModels: {} });
  });

  it("history list 构造筛选与 cursor，detail 返回稳定错误码", async () => {
    let requested = "";
    const remote = createTaskRemote({
      fetchImpl: (async (url: string) => {
        requested = String(url);
        if (String(url).includes("missing")) return jsonResponse({ message: "不存在", code: "task-not-found" }, 404);
        return jsonResponse({ items: [], watermark: 3 });
      }) as unknown as typeof fetch
    });
    const history = remote.createHistory();
    await history.list({ states: ["running"], limit: 20, cursor: "abc" });
    expect(requested).toContain("/api/pptask/history?");
    expect(requested).toContain("states=running");
    const missing = await history.detail("missing");
    expect(missing).toEqual({ ok: false, code: "task-not-found", message: "不存在" });
  });

  it("history subscribe 增量解析真实 NDJSON 并推进 cursor，dispose 后停止", async () => {
    const record = {
      taskKey: "t1",
      state: "running",
      providerId: "litellm",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      recordRevision: 5
    };
    const remote = createTaskRemote({
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/changes")) return jsonResponse({ messages: [], cursor: 5, hasMore: false });
        return new Response(`${JSON.stringify({ record, cursor: 5 })}\n`, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" }
        });
      }) as unknown as typeof fetch
    });
    const received: Array<{ key: string; cursor: number }> = [];
    const history = remote.createHistory();
    const unsubscribe = history.subscribe({
      cursor: 0,
      onRecord: (summary, cursor) => received.push({ key: summary.taskKey, cursor })
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    unsubscribe();
    expect(received).toEqual([{ key: "t1", cursor: 5 }]);
  });
});

describe("mediaRemote", () => {
  it("upload 解析受控 metadata，失败返回稳定错误", async () => {
    const remote = createMediaRemote({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        void init;
        if (String(url) === "/api/media/bad") return jsonResponse({ message: "太大" }, 413);
        return jsonResponse({ storageKey: "sha256-x", checksum: "abc", contentType: "image/png", size: 4 });
      }) as unknown as typeof fetch
    });
    const file = new File(["x"], "a.png", { type: "image/png" });
    const ok = await remote.upload({ file });
    expect(ok.ok && ok.media.url).toBe("/api/media/sha256-x");
  });

  it("upload 上报进度（0..100）", async () => {
    const remote = createMediaRemote({
      uploadImpl: async (input) => {
        input.onProgress?.(25);
        input.onProgress?.(80);
        return {
          status: 201,
          ok: true,
          body: { storageKey: "sha256-x", checksum: "abc", contentType: "image/png", size: 4 }
        };
      }
    });
    const seen: number[] = [];
    const result = await remote.upload({
      file: new File(["x"], "a.png", { type: "image/png" }),
      onProgress: (percent) => seen.push(percent)
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([25, 80]);
  });

  it("upload 传输失败返回稳定错误", async () => {
    const remote = createMediaRemote({
      uploadImpl: async () => {
        throw new Error("network");
      }
    });
    const result = await remote.upload({ file: new File(["x"], "a.png", { type: "image/png" }) });
    expect(result).toMatchObject({ ok: false });
  });

  it("urlFor 与受控 URL 校验", () => {
    const remote = createMediaRemote({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    expect(remote.urlFor("sha256-x")).toBe("/api/media/sha256-x");
    expect(remote.isAllowedUrl("/api/media/abc")).toBe(true);
    // 带画布提示的受控形态仍是合规站内引用（持久化格式不变，提示只加在渲染出口）。
    expect(remote.isAllowedUrl("/api/media/abc?canvas=canvas-1")).toBe(true);
    expect(remote.isAllowedUrl("https://evil/x")).toBe(false);
    expect(remote.isAllowedUrl("blob:http://x/1")).toBe(false);
  });

  it("urlFor 只在已知画布上下文追加 canvas 提示（编码；无画布字节级不变）", () => {
    const remote = createMediaRemote({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    expect(remote.urlFor("sha256-x", "canvas-1")).toBe("/api/media/sha256-x?canvas=canvas-1");
    expect(remote.urlFor("generation-outputs/a/b.png", "画布 1")).toBe(
      "/api/media/generation-outputs/a/b.png?canvas=%E7%94%BB%E5%B8%83%201"
    );
    expect(remote.urlFor("sha256-x", "")).toBe("/api/media/sha256-x");
  });

  it("resolveCanonicalUrl 的 canvas 提示只作用于本次渲染地址", () => {
    const remote = createMediaRemote({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    expect(remote.resolveCanonicalUrl({ url: "/api/media/sha256-x" })).toBe("/api/media/sha256-x");
    expect(remote.resolveCanonicalUrl({ url: "/api/media/sha256-x" }, "canvas-1")).toBe(
      "/api/media/sha256-x?canvas=canvas-1"
    );
    expect(remote.resolveCanonicalUrl({ url: "https://evil/x" }, "canvas-1")).toBeNull();
  });

  it("资产只登记 storageKey 时按存储身份派生读取地址（存量镜头参考视频）", () => {
    const remote = createMediaRemote({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch });
    const legacy = { status: "ready", mediaKind: "video", metadata: { storageKey: "sha256-x" } };
    expect(remote.resolveCanonicalUrl(legacy)).toBe("/api/media/sha256-x");
    expect(remote.resolveCanonicalUrl(legacy, "canvas-1")).toBe("/api/media/sha256-x?canvas=canvas-1");
    // 显式登记了不可控地址时仍拒绝，不回退到存储身份。
    expect(remote.resolveCanonicalUrl({ ...legacy, url: "https://evil/x" }, "canvas-1")).toBeNull();
    // 存储身份本身不合法时不派生地址。
    expect(remote.resolveCanonicalUrl({ metadata: { storageKey: "../../etc/passwd" } })).toBeNull();
    expect(remote.resolveCanonicalUrl({ metadata: { storageKey: "/api/media/x" } })).toBeNull();
    expect(remote.resolveCanonicalUrl({ metadata: {} })).toBeNull();
  });

  it("upload 请求目标的画布提示：POST /api/media?canvas=<id>；工程上传同样带", async () => {
    const urls: string[] = [];
    const remote = createMediaRemote({
      uploadImpl: async (input) => {
        urls.push(input.url);
        return { status: 201, ok: true, body: { storageKey: "sha256-x", checksum: "abc", contentType: "image/png", size: 4 } };
      }
    });
    const png = new File(["x"], "a.png", { type: "image/png" });
    expect((await remote.upload({ file: png })).ok).toBe(true);
    expect((await remote.upload({ file: png, canvasId: "canvas-1" })).ok).toBe(true);
    const project = new File(["x"], "p.pcraft", { type: "application/vnd.fixture-project" });
    expect((await remote.upload({ file: project, canvasId: "canvas-1" })).ok).toBe(true);
    expect(urls).toEqual([
      "/api/media",
      "/api/media?canvas=canvas-1",
      "/api/media-projects?canvas=canvas-1"
    ]);
  });

  it("拒绝缺字段的上传响应", () => {
    expect(parseUploadResponse(null)).toBeNull();
    expect(parseUploadResponse({ storageKey: "sha256-x" })).toBeNull();
    expect(isAllowedMediaUrl("//cdn/x")).toBe(false);
  });
});

 it("保留服务端 motion 模型目录", async () => {
 const remote=createTaskRemote({fetchImpl:(async()=>jsonResponse({available:true,models:[{modelKey:"remote-server:kimodo-soma",providerId:"remote-server",providerModelId:"kimodo-soma",modelType:"motion",interaction:{id:"generic-model",version:1}}],defaultModels:{}})) as typeof fetch});
 const catalog=await remote.fetchCatalog();
 expect(catalog.models).toHaveLength(1);
 expect(catalog.models[0]?.modelType).toBe("motion");
 });
