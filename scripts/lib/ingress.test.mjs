/**
 * 同源 ingress 路由判定：Agent 来源扩展的公开 HTTP 面必须交给 Application Service。
 *
 * 运行：`node --test scripts/lib/ingress.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createIngress, routeFor } from "./ingress.mjs";

test("Agent 来源扩展的公开路径路由到 Application Service", () => {
  for (const path of [
    "/api/oauth-agent",
    "/api/oauth-agent/status",
    "/api/sdk-agent/connections",
    "/api/sdk-agent/connections/abc/credential",
    "/api/local-agent/connections",
    "/api/local-agent/check"
  ]) {
    assert.equal(routeFor(path), "application", path);
  }
  // 旧 ChatGPT 前缀保留在 ingress（改名后仅作兼容入口；后端是否注册由公开路由表决定）。
  assert.equal(routeFor("/api/chatgpt/status"), "application");
  assert.equal(routeFor("/api/task-inspection/snapshot"), "application");
  // 宿主受控重启（change: 2026-10-21-harden-extension-fault-isolation，D6）。
  assert.equal(routeFor("/api/host/restart"), "application");
  assert.equal(routeFor("/api/hostile"), "none");
});

test("服务端接入扩展的本机 OAuth 公开路径路由到 Application Service", () => {
  // change: 2026-10-20-add-local-oauth-login：loopback 回调与完成页必须能到宿主。
  for (const path of ["/api/remote-server", "/api/remote-server/auth/callback", "/api/remote-server/auth/done"]) {
    assert.equal(routeFor(path), "application", path);
  }
  for (const path of ["/api/remote-serverish", "/api/remote-server-foo"]) {
    assert.equal(routeFor(path), "none", path);
  }
});

test("相似前缀不被 Agent 路由吞掉", () => {
  for (const path of ["/api/oauth-agentx", "/api/sdk-agentish/connections", "/api/local-agent-foo"]) {
    assert.equal(routeFor(path), "none", path);
  }
});

test("MCP 安装 API 经同源代理到宿主，匹配完整路径段", () => {
  for (const path of ["/api/mcp-installation", "/api/mcp-installation/codex", "/api/mcp-installation/opencode"]) {
    assert.equal(routeFor(path), "application");
  }
  assert.equal(routeFor("/api/mcp-installation-other"), "none");
});

test("本机遥测入口路由到 Application Service（宿主 core 承载）", () => {
  // change: 2026-10-20-add-local-client-telemetry：未登记的新 `/api/...` 会被判 none 直接 404。
  for (const path of ["/api/telemetry", "/api/telemetry/events", "/api/telemetry/summary", "/api/telemetry/anomalies"]) {
    assert.equal(routeFor(path), "application", path);
  }
  // 相似前缀不被吞掉。
  for (const path of ["/api/telemetry-anomalies", "/api/telemetryish/events"]) {
    assert.equal(routeFor(path), "none", path);
  }
});

test("ppserver 转发前缀路由到 Application Service", () => {
  // 未登记时整条链路 404：令牌拿到了、目录拉到了，前端生成却永远成功不了。
  for (const path of [
    "/api/ppserver",
    "/api/ppserver/tasks/create_stream",
    "/api/ppserver/tasks/status",
    "/api/ppserver/tasks/result",
    "/api/ppserver/auth/session"
  ]) {
    assert.equal(routeFor(path), "application", path);
  }
  // 相似前缀不被吞掉。
  for (const path of ["/api/ppserverish", "/api/ppserver-tasks/status"]) {
    assert.equal(routeFor(path), "none", path);
  }
});

test("站点 API 命名空间下的未知路径返回 404，不落 SPA", async () => {
  const ingress = createIngress({ targets: {}, basePath: "/dev/test/" });
  let body = "";
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(chunk) { body += chunk ?? ""; }
  };
  const handled = await ingress.handle({ url: "/dev/test/api/dev-admin", method: "GET", headers: {} }, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(body), { error: "not-found" });
  assert.equal(await ingress.handle({ url: "/dev/test/canvas/1", method: "GET", headers: {} }, res), false);
});
test("上游不可达的 502 带错误码、请求与目标（启动窗口可自证原因）", async () => {
  const http = await import("node:http");
  // 先占一个端口再放掉：拿到一个几乎确定没人监听的端口，制造 ECONNREFUSED。
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const events = [];
  const ingress = createIngress({
    targets: { application: `http://127.0.0.1:${port}` },
    logger: (event) => events.push(event)
  });
  const res = { statusCode: 0, headersSent: false, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end() {} };
  const req = {
    url: "/api/extensions",
    method: "GET",
    headers: {},
    pipe(upstream) { upstream.end(); return upstream; },
    on() { return this; }
  };

  assert.equal(await ingress.handle(req, res), true);
  assert.equal(res.statusCode, 502);
  assert.equal(events.length, 1);
  const [event] = events;
  // 关键是这五项齐全：没有 code / path / target 时，启动窗口和真故障在日志里无法区分。
  assert.equal(event.event, "ingress-upstream-error");
  assert.equal(event.status, 502);
  assert.equal(event.code, "ECONNREFUSED");
  assert.equal(event.method, "GET");
  assert.equal(event.path, "/api/extensions");
  assert.equal(event.target, `http://127.0.0.1:${port}`);
  assert.match(String(event.message), /ECONNREFUSED|connect/i);
});

test("上游超时与连接失败分开报码（upstream-timeout）", async () => {
  const http = await import("node:http");
  // 接受连接但永不响应：走 ingress 自己的超时分支。
  const hanging = http.createServer(() => {});
  await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const port = hanging.address().port;
  const events = [];
  const ingress = createIngress({
    targets: { application: `http://127.0.0.1:${port}` },
    timeoutMs: 120,
    logger: (event) => events.push(event)
  });
  const res = { statusCode: 0, headersSent: false, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end() {} };
  const req = {
    url: "/api/extensions",
    method: "POST",
    headers: {},
    pipe(upstream) { upstream.end(); return upstream; },
    on() { return this; }
  };

  assert.equal(await ingress.handle(req, res), true);
  assert.equal(res.statusCode, 502);
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "upstream-timeout");
  assert.equal(events[0].method, "POST");
  assert.equal(events[0].path, "/api/extensions");
  hanging.closeAllConnections?.();
  await new Promise((resolve) => hanging.close(resolve));
});
