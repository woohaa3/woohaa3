import { describe, expect, it, vi } from "vitest";
import { createPpserverProvider } from "../src/provider.js";

const UUID = "8f14e45f-ceea-467a-9f0b-1c1e2c3d4e5f";
const CATALOG = { templates: [{ modelId: UUID, templateId: UUID, kind: "image" as const, title: "Nano Banana Pro" }] };

/** 一条 `created` 事件就够：Provider 拿到 job id 后会主动掐掉流。 */
function sseStream(events: Array<{ type: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      }
      controller.close();
    }
  });
}

function harness(overrides: {
  status?: () => unknown;
  result?: () => unknown;
  createEvents?: Array<{ type: string; data: unknown }>;
  createStatus?: number;
} = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown; authorization?: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, ...(body === undefined ? {} : { body }), authorization: headers.get("authorization") });

    if (url.endsWith("/tasks/create_stream")) {
      const status = overrides.createStatus ?? 200;
      return new Response(sseStream(overrides.createEvents ?? [{ type: "created", data: { job_id: "job-1", status: "pending" } }]), {
        status,
        headers: { "content-type": "text/event-stream" }
      });
    }
    if (url.endsWith("/tasks/status")) return Response.json(overrides.status?.() ?? { status: "running", progress: 0.4 });
    if (url.endsWith("/tasks/result")) {
      return Response.json(overrides.result?.() ?? { raw: [{ url: "https://cdn.test/out.png" }], costMoney: 12 });
    }
    if (url.endsWith("/tasks/cancel")) return Response.json({ ok: true });
    // 宿主会按返回的地址把字节下回来（`imageResult` 自己下载），这里给一张真 PNG 头。
    if (url.startsWith("https://cdn.test/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }
    return new Response("missing", { status: 404 });
  });

  const provider = createPpserverProvider({
    accessToken: "token-1",
    baseUrl: "https://pp.test/ppserver/",
    catalog: CATALOG,
    tenantId: "tenant-1",
    fetch: fetchImpl as typeof fetch,
    pollIntervalMs: 1
  });
  return { provider, requests };
}

describe("ppserver Provider", () => {
  it("创建任务：SSE 只取 created，之后靠轮询", async () => {
    const { provider, requests } = harness();
    const model = provider.imageModel(UUID);
    const started = await model.doStart!({ prompt: "a cat" } as never);
    expect(started.operation).toEqual({ taskId: "job-1" });

    const created = requests.find((request) => request.url.endsWith("/tasks/create_stream"));
    expect(created?.body).toMatchObject({ templateId: UUID, tenantId: "tenant-1", payload: { prompt: "a cat" } });
    expect(created?.authorization).toBe("Bearer token-1");

    // 只发了 created 那条，没有去查 status —— 说明拿到 id 就返回了。
    expect(requests.filter((request) => request.url.endsWith("/tasks/status"))).toHaveLength(0);
  });

  it("状态进行中：给 pending + 进度，不取结果", async () => {
    const { provider, requests } = harness();
    const model = provider.imageModel(UUID);
    const status = await model.doStatus!({ operation: { taskId: "job-1" } } as never);
    expect(status).toMatchObject({ status: "pending", progress: 40 });
    expect(requests.some((request) => request.url.endsWith("/tasks/result"))).toBe(false);
  });

  it("成功：再取一次结果，把地址交给宿主", async () => {
    const { provider, requests } = harness({ status: () => ({ status: "succeeded" }) });
    const model = provider.imageModel(UUID);
    const status = await model.doStatus!({ operation: { taskId: "job-1" } } as never);
    expect(status.status).toBe("completed");
    expect(requests.map((request) => request.url)).toContain("https://pp.test/ppserver/tasks/result");
  });

  it("失败：带上服务端给的原因", async () => {
    const { provider } = harness({ status: () => ({ status: "failed", error: "额度不足" }) });
    const model = provider.imageModel(UUID);
    const status = await model.doStatus!({ operation: { taskId: "job-1" } } as never);
    expect(status).toMatchObject({ status: "error", error: "额度不足" });
  });

  it("取消走远端接口", async () => {
    const { provider, requests } = harness();
    const model = provider.imageModel(UUID);
    await model.doCancel?.({ operation: { taskId: "job-1" } } as never);
    expect(requests.some((request) => request.url.endsWith("/tasks/cancel"))).toBe(true);
  });

  it("创建接口 401 时报「令牌无效」，而不是裸状态码", async () => {
    const { provider } = harness({ createStatus: 401 });
    const model = provider.imageModel(UUID);
    await expect(model.doStart!({ prompt: "x" } as never)).rejects.toThrow(/访问令牌无效或已过期/);
  });

  it("创建接口 402 时报「积分不足」", async () => {
    const { provider } = harness({ createStatus: 402 });
    const model = provider.imageModel(UUID);
    await expect(model.doStart!({ prompt: "x" } as never)).rejects.toThrow(/积分不足/);
  });

  it("模型类型对不上直接拒绝，不把视频模板塞进图片面板", () => {
    const { provider } = harness();
    expect(() => provider.videoModel(UUID)).toThrow(/类型是 image/);
  });
});
