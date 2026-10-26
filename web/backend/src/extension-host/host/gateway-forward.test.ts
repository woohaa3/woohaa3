import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EXTENSION_HOST_METHODS, type PrincipalContext } from "@woohaa3/contracts";
import type { RpcEndpoint } from "../rpc/index.js";
import { createGatewayForwarder, type GatewayForwarder } from "./gateway-forward.js";
import { createRpcPair } from "./rpc-pair.test-support.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(forwarder: GatewayForwarder): Promise<string> {
  const server = http.createServer((req, res) => {
    void forwarder.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("downstream");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 子进程侧最小 gateway 分发：回显方法、路径、请求头与请求体。 */
function echoChild(child: RpcEndpoint, options: { handled?: boolean } = {}) {
  child.handle(EXTENSION_HOST_METHODS.gatewayRequest, async (params) => {
    const request = params as { method: string; url: string; headers: Record<string, string>; principal: unknown; bodyStreamId?: string; requestId: string };
    if (options.handled === false) return { handled: false };
    let body = "";
    if (request.bodyStreamId) for await (const chunk of child.streams.take(request.bodyStreamId)) body += Buffer.from(chunk).toString("utf8");
    const out = child.streams.open("gateway.response");
    void out.write(Buffer.from(JSON.stringify({ method: request.method, url: request.url, headers: request.headers, principal: request.principal, body }))).then(() => out.end());
    return { handled: true, status: 201, headers: { "content-type": "application/json", "set-cookie": "evil=1" }, bodyStreamId: out.streamId };
  });
}

const principal: PrincipalContext = { subject: "alice", identityProvider: "test", displayName: "Alice", sessionId: "secret-session" };

describe("Gateway 转发", () => {
  it("命中前缀：过滤凭据头、附 principal 摘要、请求体与响应体流往返；子进程不能设置 set-cookie", async () => {
    const { host, child } = createRpcPair();
    echoChild(child);
    const forwarder = createGatewayForwarder({ extensionId: "fx", target: () => host, authenticate: async () => principal });
    forwarder.addRoute({ routeId: "r1", prefix: "/api/extensions/fx/" });
    const base = await serve(forwarder);
    const response = await fetch(`${base}/api/extensions/fx/models/refresh?x=1`, {
      method: "POST",
      headers: { cookie: "sid=1", authorization: "Bearer t", "x-custom": "ok" },
      body: "payload"
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();
    const echoed = await response.json();
    expect(echoed).toMatchObject({ method: "POST", url: "/api/extensions/fx/models/refresh?x=1", body: "payload", principal: { subject: "alice", identityProvider: "test", displayName: "Alice" } });
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers.authorization).toBeUndefined();
    expect(echoed.headers["x-custom"]).toBe("ok");
    expect(echoed.principal.sessionId).toBeUndefined();
  });

  it("未命中前缀、方法不允许或子进程回 handled:false：交给下游", async () => {
    const { host, child } = createRpcPair();
    echoChild(child, { handled: false });
    const forwarder = createGatewayForwarder({ extensionId: "fx", target: () => host });
    forwarder.addRoute({ routeId: "r1", prefix: "/api/extensions/fx", methods: ["GET"] });
    const base = await serve(forwarder);
    expect(await (await fetch(`${base}/api/other`)).text()).toBe("downstream");
    expect(await (await fetch(`${base}/api/extensions/fx-other`)).text()).toBe("downstream");
    expect((await fetch(`${base}/api/extensions/fx/a`, { method: "DELETE" })).status).toBe(404);
    expect(await (await fetch(`${base}/api/extensions/fx/a`)).text()).toBe("downstream");
  });

  it("实例不可用或调用中崩溃：命中路由返回 503 extension-unavailable", async () => {
    let target: RpcEndpoint | null = null;
    const forwarder = createGatewayForwarder({ extensionId: "fx", target: () => target });
    forwarder.addRoute({ routeId: "r1", prefix: "/api/extensions/fx/" });
    const base = await serve(forwarder);
    const offline = await fetch(`${base}/api/extensions/fx/a`);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ code: "extension-unavailable", extensionId: "fx" });
    const { host, child } = createRpcPair();
    child.handle(EXTENSION_HOST_METHODS.gatewayRequest, () => new Promise(() => undefined));
    target = host;
    const pending = fetch(`${base}/api/extensions/fx/a`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close("extension-crashed", "子进程退出");
    expect((await pending).status).toBe(503);
  });

  it("没有活跃实例时，宿主授予的保底前缀回 503，其他路径交下游", async () => {
    const forwarder = createGatewayForwarder({ extensionId: "fx", target: () => null, reservedPrefixes: ["/api/extensions/fx/"] });
    const base = await serve(forwarder);
    expect((await fetch(`${base}/api/extensions/fx/anything`)).status).toBe(503);
    expect(await (await fetch(`${base}/api/extensions/other/x`)).text()).toBe("downstream");
  });

  it("子进程回调鉴权：按 requestId 用真实 principal 执行 assertAction；伪造 requestId 拒绝", async () => {
    const { host, child } = createRpcPair();
    const asserted: Array<[string | undefined, string]> = [];
    const forwarder = createGatewayForwarder({
      extensionId: "fx",
      target: () => host,
      authenticate: async () => principal,
      assertAction: async (who, action) => {
        asserted.push([who?.subject, action]);
        if (action !== "extensions.configure") throw new Error("forbidden");
      }
    });
    host.handle(EXTENSION_HOST_METHODS.ctxAccessAssert, (params) => forwarder.assertForRequest(params));
    child.handle(EXTENSION_HOST_METHODS.gatewayRequest, async (params) => {
      const { requestId } = params as { requestId: string };
      await child.request(EXTENSION_HOST_METHODS.ctxAccessAssert, { requestId, action: "extensions.configure" });
      const denied = await child.request(EXTENSION_HOST_METHODS.ctxAccessAssert, { requestId, action: "models.manage" }).then(() => "ok", (error: { code: string }) => error.code);
      const forged = await child.request(EXTENSION_HOST_METHODS.ctxAccessAssert, { requestId: "forged", action: "extensions.configure" }).then(() => "ok", (error: { code: string }) => error.code);
      const out = child.streams.open("gateway.response");
      void out.write(Buffer.from(JSON.stringify({ denied, forged }))).then(() => out.end());
      return { handled: true, status: 200, headers: {}, bodyStreamId: out.streamId };
    });
    forwarder.addRoute({ routeId: "r1", prefix: "/api/extensions/fx/" });
    const base = await serve(forwarder);
    expect(await (await fetch(`${base}/api/extensions/fx/a`)).json()).toEqual({ denied: "permission-denied", forged: "permission-denied" });
    expect(asserted).toEqual([["alice", "extensions.configure"], ["alice", "models.manage"]]);
  });
});
