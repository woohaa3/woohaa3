import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { proxyTaskRequest, registerPpserverProxy } from "../src/routes.js";

/**
 * 同源转发的测试。
 *
 * 这是整个扩展里唯一的信任边界：浏览器端拿不到令牌，靠这条路由借宿主的凭据花钱。
 * 所以重点不在「能转发」，而在**转发的限制**——白名单、租户不被覆盖、认证器、
 * 以及流式转发出错时不能把响应挂死。
 */

const ORIGIN = "https://pp.test/ppserver";

/** 最小可用的 IncomingMessage：`readBody` 只依赖这几个事件。 */
function makeReq(url: string, method = "GET", body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  return Object.assign(stream, { url, method }) as unknown as IncomingMessage;
}

/** 记录写出的内容，`headersSent` 在 `writeHead` 之后置真（与真实行为一致）。 */
function makeRes() {
  const chunks: Buffer[] = [];
  const state = {
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    destroyed: false,
    headersSent: false
  };
  const res = {
    get headersSent() { return state.headersSent; },
    writeHead(status: number, headers: Record<string, string>) {
      if (state.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      state.status = status;
      state.headers = headers;
      state.headersSent = true;
      return res;
    },
    write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      state.body = Buffer.concat(chunks).toString("utf8");
      state.ended = true;
      return res;
    },
    destroy() { state.destroyed = true; return res; },
    on() { return res; }
  };
  return { res: res as unknown as ServerResponse, state };
}

function captureFetch(payload: unknown = { ok: true }, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(typeof init?.body === "string" ? { body: init.body } : {})
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("转发：路径白名单", () => {
  it("只转发五条已知端点", async () => {
    const { fetchImpl, calls } = captureFetch();
    const result = await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/create", "POST", "{}"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1"
    });
    expect(result).toMatchObject({ status: 404 });
    // 关键：**一个请求都没发出去**，否则白名单形同虚设。
    expect(calls).toHaveLength(0);
  });

  it("`/tasks/create` 明确不在白名单里（线上 404）", async () => {
    const { fetchImpl } = captureFetch();
    const result = await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/create_stream", "POST", "{}"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1"
    });
    expect("response" in result).toBe(true);
  });

  it("目标 origin 固定取配置，前端改不了", async () => {
    const { fetchImpl, calls } = captureFetch();
    await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/status?next=https://evil.test/steal", "GET"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1"
    });
    expect(calls[0]?.url.startsWith(`${ORIGIN}/tasks/status`)).toBe(true);
  });
});

describe("转发：请求改写", () => {
  it("补上 Authorization，并保留查询串", async () => {
    const { fetchImpl, calls } = captureFetch();
    await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/describe?templateId=abc", "GET"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1"
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer jwt-1");
    expect(calls[0]?.url).toContain("templateId=abc");
  });

  it("没有令牌时不发空的 Authorization 头", async () => {
    const { fetchImpl, calls } = captureFetch();
    await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/status", "GET"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: ""
    });
    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("body 缺 tenantId 时补上配置里的租户", async () => {
    const { fetchImpl, calls } = captureFetch();
    await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/create_stream", "POST", JSON.stringify({ taskId: "t" })),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1",
      tenantId: "tenant-1"
    });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ taskId: "t", tenantId: "tenant-1" });
  });

  it("**前端自己带了 tenantId 时不覆盖**", async () => {
    const { fetchImpl, calls } = captureFetch();
    await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/create_stream", "POST", JSON.stringify({ tenantId: "tenant-front" })),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1",
      tenantId: "tenant-1"
    });
    expect(JSON.parse(calls[0]!.body!).tenantId).toBe("tenant-front");
  });

  it("body 不是 JSON 时原样透传，不假装能改", async () => {
    const { fetchImpl, calls } = captureFetch();
    await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/create_stream", "POST", "not json"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1",
      tenantId: "tenant-1"
    });
    expect(calls[0]!.body).toBe("not json");
  });

  it("GET 不读 body —— 否则会一直等一个不会来的 end", async () => {
    const { fetchImpl, calls } = captureFetch();
    const result = await proxyTaskRequest({
      req: makeReq("/api/ppserver/tasks/status", "GET"),
      fetchImpl,
      origin: ORIGIN,
      accessToken: "jwt-1",
      tenantId: "tenant-1"
    });
    expect("response" in result).toBe(true);
    expect(calls[0]?.body).toBeUndefined();
  });
});

/** 把 `ctx.effect` 直接执行，拿到路由处理函数。 */
function installProxy(options: {
  accessToken: () => string | Promise<string>;
  tenantId?: () => string;
  authenticator?: (req: IncomingMessage) => Promise<unknown | null>;
  fetchImpl: typeof globalThis.fetch;
}) {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | undefined;
  const ctx = {
    effect: (fn: () => unknown) => { fn(); },
    gateway: { route: (_order: number, fn: typeof handler) => { handler = fn; return () => undefined; } },
    access: options.authenticator ? { authenticator: options.authenticator } : {}
  };
  registerPpserverProxy(ctx as never, {
    baseUrl: ORIGIN,
    accessToken: options.accessToken,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    fetchImpl: options.fetchImpl
  });
  if (!handler) throw new Error("路由没有注册");
  return handler;
}

describe("注册路由：认证与令牌", () => {
  it("不属于本前缀的请求交还给其它路由（返回 false）", async () => {
    const { fetchImpl } = captureFetch();
    const handler = installProxy({ accessToken: () => "jwt-1", fetchImpl });
    const { res } = makeRes();
    const handled = await handler(makeReq("/api/other/thing"), res);
    expect(handled).toBe(false);
  });

  it("有认证器且未登录时返回 401，不产生任何上游请求", async () => {
    const { fetchImpl, calls } = captureFetch();
    const handler = installProxy({
      accessToken: () => "jwt-1",
      authenticator: async () => null,
      fetchImpl
    });
    const { res, state } = makeRes();
    await handler(makeReq("/api/ppserver/tasks/status"), res);
    expect(state.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("认证器抛错按未登录处理", async () => {
    const { fetchImpl, calls } = captureFetch();
    const handler = installProxy({
      accessToken: () => "jwt-1",
      authenticator: async () => { throw new Error("boom"); },
      fetchImpl
    });
    const { res, state } = makeRes();
    await handler(makeReq("/api/ppserver/tasks/status"), res);
    expect(state.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("认证器通过后正常转发", async () => {
    const { fetchImpl, calls } = captureFetch({ status: "running" });
    const handler = installProxy({
      accessToken: () => "jwt-1",
      authenticator: async () => ({ id: "u1" }),
      fetchImpl
    });
    const { res, state } = makeRes();
    await handler(makeReq("/api/ppserver/tasks/status"), res);
    expect(state.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("没有认证器时按本机可信放行", async () => {
    const { fetchImpl, calls } = captureFetch({ status: "running" });
    const handler = installProxy({ accessToken: () => "jwt-1", fetchImpl });
    const { res, state } = makeRes();
    await handler(makeReq("/api/ppserver/tasks/status"), res);
    expect(state.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("**每次请求现取令牌**：续期后下一次请求就用新值", async () => {
    const { fetchImpl, calls } = captureFetch({ status: "running" });
    let token = "stale";
    const handler = installProxy({ accessToken: async () => token, fetchImpl });

    await handler(makeReq("/api/ppserver/tasks/status"), makeRes().res);
    token = "renewed";
    await handler(makeReq("/api/ppserver/tasks/status"), makeRes().res);

    // 固定成构造时的值，第二条仍然会是 "stale" —— 这正是自动续期失效的方式。
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer stale");
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer renewed");
  });

  it("租户被改写进每条 POST", async () => {
    const { fetchImpl, calls } = captureFetch();
    const handler = installProxy({
      accessToken: () => "jwt-1",
      tenantId: () => "tenant-1",
      fetchImpl
    });
    await handler(makeReq("/api/ppserver/tasks/create_stream", "POST", JSON.stringify({ taskId: "t" })), makeRes().res);
    expect(JSON.parse(calls[0]!.body!).tenantId).toBe("tenant-1");
  });
});

describe("注册路由：响应与失败", () => {
  it("流式响应逐块转发，而不是攒成整包", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: created\ndata: {}\n\n"));
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      }
    });
    const fetchImpl = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })) as unknown as typeof fetch;

    const handler = installProxy({ accessToken: () => "jwt-1", fetchImpl });
    const { res, state } = makeRes();
    await handler(makeReq("/api/ppserver/tasks/create_stream", "POST", "{}"), res);

    expect(state.status).toBe(200);
    expect(state.body).toContain("event: created");
    expect(state.body).toContain("event: done");
  });

  it("上游断开时直接断开连接，不重复 writeHead", async () => {
    // 先吐一块，再抛错：此时响应头已经发出去了。
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("upstream reset"));
      }
    });
    const fetchImpl = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })) as unknown as typeof fetch;

    const handler = installProxy({ accessToken: () => "jwt-1", fetchImpl });
    const { res, state } = makeRes();
    // 旧实现在这里会抛 ERR_HTTP_HEADERS_SENT，让请求永远挂住。
    await expect(handler(makeReq("/api/ppserver/tasks/create_stream", "POST", "{}"), res)).resolves.toBe(true);
    expect(state.destroyed).toBe(true);
  });

  it("头还没发出去时用 502 报错", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const handler = installProxy({ accessToken: () => "jwt-1", fetchImpl });
    const { res, state } = makeRes();
    await handler(makeReq("/api/ppserver/tasks/status"), res);
    expect(state.status).toBe(502);
    expect(state.body).toContain("ECONNREFUSED");
  });
});
