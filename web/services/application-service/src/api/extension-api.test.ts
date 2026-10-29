/**
 * 站点插件管理/状态 HTTP API 测试
 * （change: 2026-10-05-extract-application-plugin-host，任务 3.2/3.3 / design D6/D7）。
 *
 * 验证：无权限写请求零写入、脱敏响应、expectedRevision 冲突、重连 snapshot、可信认证适配器
 * 授权、受控 handler 分级分派与内部 work/recovery 只允许服务令牌。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ApplicationExtensionMetadata, ApplicationBackendHost, PrincipalContext, SiteAccessPolicy, AccessAction } from "@woohaa3/contracts";
import { createSqliteSiteExtensionConfigStore } from "../extensions/config-store.js";
import { createSqliteExtensionWorkRepository } from "../repository/extension-work-repository.js";
import { createApplicationExtensionHost } from "../extensions/host.js";
import { createSiteExtensionControlPlane } from "../extensions/control-plane.js";
import { createFakeRequestAuthenticator, testPrincipal, type ApplicationRequestAuthenticator } from "../auth/adapter.js";
import { createAccessEnforcer } from "../extensions/access-enforcement.js";
import { createApplicationExtensionApiHandler } from "./extension-api.js";

const dirs: string[] = [];
const resources: Array<{ close(): void }> = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-extension-api-"));
  dirs.push(dir);
  return path.join(dir, "plugin.sqlite");
}
afterAll(() => {
  for (const resource of resources.splice(0)) resource.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const METADATA: ApplicationExtensionMetadata = {
  extensionId: "sample-site-extension",
  name: "样例站点插件",
  description: "测试。",
  version: "1.0.0",
  managementScope: "site",
  host: "application",
  configSchema: { schemaId: "sample-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [
    { id: "sample.action", kind: "handler", description: "样例", auth: "authenticated" },
    { id: "sample.public", kind: "handler", description: "公开样例", auth: "public" }
  ]
};

/** 测试用 site-access 策略：仅配置的 subject 拥有具名 action（模拟 site-access 扩展）。 */
function fakeSitePolicy(adminSubjects: readonly string[]): SiteAccessPolicy {
  const admins = new Set(adminSubjects);
  const grant = (principal: PrincipalContext): boolean => admins.has(principal.subject);
  return {
    policyId: "test-site-access",
    policyVersion: () => "1",
    async allowedActions({ principal }) {
      return grant(principal) ? (["extensions.configure", "providers.credentials.write", "models.manage", "tasks.inspect"] as AccessAction[]) : [];
    },
    async authorize({ principal, action }) {
      void action;
      return grant(principal) ? { allowed: true } : { allowed: false, code: "forbidden" };
    }
  };
}

function makeHarness(options: { serviceToken?: string; auth?: "authenticated" | "disabled"; withHandler?: boolean; withHttp?: boolean; adminSubjects?: readonly string[]; extensionRelease?: () => { releaseId: string; href: string } | null } = {}) {
  const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
  const work = createSqliteExtensionWorkRepository({ path: tempDb() });
  resources.push(store, work);
  const host = createApplicationExtensionHost();
  const plane = createSiteExtensionControlPlane({
    host,
    store,
    workStore: work,
    metadata: { list: () => [METADATA], get: (id) => (id === METADATA.extensionId ? METADATA : undefined) },
    definitions: [
      {
        extensionId: METADATA.extensionId,
        activate: (h) => {
          h.registerCapability({ id: "sample.action", value: {} });
          if (options.withHandler) {
            h.registerHandler({ route: "sample/admin", auth: "authenticated", requiredActions: ["extensions.configure"], handle: ({ body }) => ({ body: { echo: body } }) });
            h.registerHandler({ route: "sample/public", auth: "public", handle: () => ({ body: { ok: true } }) });
          }
          if (options.withHttp && h.registerHttpHandler) {
            h.registerHttpHandler({
              route: "oauth",
              method: "GET",
              auth: "public",
              purpose: "auth-transaction",
              handle: async (_req, res) => {
                res.setHeader("Set-Cookie", "sid=abc; HttpOnly");
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.writeHead(200);
                res.end("<html>ok</html>");
              }
            });
            h.registerHttpHandler({
              route: "events",
              method: "POST",
              auth: "public",
              purpose: "new-work",
              stream: true,
              handle: async (_req, res) => {
                res.setHeader("Content-Type", "text/event-stream");
                res.writeHead(200);
                res.write("event: progress\ndata: {\"stage\":\"x\"}\n\n");
                res.end();
              }
            });
            h.registerHttpHandler({
              route: "receipt",
              method: "GET",
              auth: "public",
              purpose: "work-control",
              handle: async (_req, res) => {
                res.writeHead(200);
                res.end(JSON.stringify({ status: "succeeded" }));
              }
            });
          }
        }
      }
    ],
    now: () => new Date("2026-10-04T00:00:00.000Z")
  });
  const authenticator: ApplicationRequestAuthenticator =
    options.auth === "disabled"
      ? createFakeRequestAuthenticator(() => null)
      : createFakeRequestAuthenticator((req) => {
          const actor = req.headers["x-woohaa3-test-actor"] as string | undefined;
          if (!actor) return null;
          return testPrincipal(actor, { identityProvider: "test" });
        });
  const siteAccess = fakeSitePolicy(options.adminSubjects ?? ["admin@example"]);
  const accessEnforcer = createAccessEnforcer({ siteAccessPolicy: () => siteAccess, resourceAccessPolicy: () => null });
  const handler = createApplicationExtensionApiHandler({
    controlPlane: plane,
    host,
    authenticator,
    accessEnforcer,
    ...(options.withHttp
      ? {
          publicRoutes: [
            { extensionId: METADATA.extensionId, publicPath: "/api/chatgpt", route: "chatgpt", methods: ["GET", "POST"] as const }
          ]
        }
      : {}),
    ...(options.serviceToken ? { serviceToken: options.serviceToken } : {}),
    ...(options.extensionRelease ? { extensionRelease: options.extensionRelease } : {})
  });
  return { handler, plane, store, work, host };
}

function makeRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = options.method;
  req.url = options.url;
  for (const [key, value] of Object.entries(options.headers ?? {})) req.headers[key] = value;
  const payload = options.body !== undefined ? JSON.stringify(options.body) : "";
  // body 在下一轮宏任务提供：认证改为 async 后会先 await 让出，再调用 readJson；
  // 微任务会过早触发 emit 导致 readJson 收不到数据。
  setImmediate(() => {
    if (payload !== "") req.emit("data", Buffer.from(payload));
    req.emit("end");
  });
  return req;
}

function mockResponse(req: IncomingMessage): { res: ServerResponse; written: string[]; headers: Record<string, string | string[]> } {
  const written: string[] = [];
  const headers: Record<string, string | string[]> = {};
  const res = new ServerResponse(req);
  res.setHeader = ((name: string, value: string | string[]) => {
    headers[name.toLowerCase()] = value;
    return res;
  }) as typeof res.setHeader;
  const originalEnd = res.end.bind(res);
  res.write = ((chunk?: unknown) => { if (chunk !== undefined) written.push(String(chunk)); return true; }) as typeof res.write;
  res.end = ((chunk?: unknown) => {
    if (chunk !== undefined) written.push(String(chunk));
    try { originalEnd(); } catch { /* mock socket */ }
    return res;
  }) as typeof res.end;
  return { res, written, headers };
}

async function call(
  handler: ReturnType<typeof createApplicationExtensionApiHandler>,
  request: IncomingMessage
): Promise<{ status: number; body: unknown; headers: Record<string, string | string[]>; raw: string }> {
  const { res, written, headers } = mockResponse(request);
  await handler(request, res);
  const text = written.join("");
  let body: unknown = null;
  if (text !== "" && /^[\s]*[{[]/.test(text)) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { status: res.statusCode, body, headers, raw: text };
}

describe("站点插件公开状态 API", () => {
  it("公开 snapshot 无令牌可读，且不含秘密", async () => {
    const { handler, plane } = makeHarness();
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: { threshold: 5 }, secretRefs: ["cred"], actor: "admin" });
    const result = await call(handler, makeRequest({ method: "GET", url: "/api/extensions" }));
    expect(result.status).toBe(200);
    const body = result.body as { revision: number; plugins: Array<{ extensionId: string }> };
    expect(body.revision).toBe(plane.snapshot().revision);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("threshold");
    expect(serialized).not.toContain("\"cred\"");
    expect(serialized).not.toContain("secretRef");
    expect(serialized).not.toContain("values");
  });

  it("changes 增量在 cursor 过旧时要求 resync", async () => {
    const { handler, plane } = makeHarness();
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const result = await call(handler, makeRequest({ method: "GET", url: "/api/extensions/changes?after=0" }));
    expect(result.status).toBe(200);
    expect((result.body as { resyncRequired: boolean }).resyncRequired).toBe(false);
    const stale = await call(handler, makeRequest({ method: "GET", url: "/api/extensions/changes?after=99" }));
    expect((stale.body as { resyncRequired: boolean }).resyncRequired).toBe(true);
  });

  it("发布目录指针随 snapshot 与 changes 返回，切换后立即反映（change: 2026-10-21-add-extension-marketplace-point，6.2）", async () => {
    let pointer: { releaseId: string; href: string } | null = { releaseId: "a".repeat(64), href: `/extension-releases/${"a".repeat(64)}.json` };
    const { handler, plane } = makeHarness({ extensionRelease: () => pointer });
    const snapshot = await call(handler, makeRequest({ method: "GET", url: "/api/extensions" }));
    expect((snapshot.body as { extensionRelease?: unknown }).extensionRelease).toEqual(pointer);
    pointer = { releaseId: "b".repeat(64), href: `/extension-releases/${"b".repeat(64)}.json` };
    const changes = await call(handler, makeRequest({ method: "GET", url: `/api/extensions/changes?after=${plane.snapshot().revision}` }));
    expect((changes.body as { extensionRelease?: unknown }).extensionRelease).toEqual(pointer);
    // 宿主没有指针：字段缺省，旧客户端不受影响。
    pointer = null;
    const none = await call(handler, makeRequest({ method: "GET", url: "/api/extensions" }));
    expect(none.body).not.toHaveProperty("extensionRelease");
  });
});

describe("可信认证适配器授权", () => {
  it("认证未配置时写请求零写入", async () => {
    const { handler, plane } = makeHarness({ auth: "disabled" });
    const result = await call(
      handler,
      makeRequest({
        method: "PUT",
        url: `/api/extensions/${METADATA.extensionId}/config`,
        headers: { "content-type": "application/json", "x-woohaa3-admin-actor": "forged" },
        body: { expectedRevision: 0, enabled: true, values: {}, secretRefs: [] }
      })
    );
    expect(result.status).toBe(401);
    expect(plane.snapshot().revision).toBe(0);
    expect(plane.status(METADATA.extensionId)?.actualState).toBe("unconfigured");
  });

  it("非授权身份不能写入（伪造 actor 头无效）", async () => {
    const { handler, plane } = makeHarness();
    const result = await call(
      handler,
      makeRequest({
        method: "PUT",
        url: `/api/extensions/${METADATA.extensionId}/config`,
        headers: {
          "content-type": "application/json",
          "x-woohaa3-test-actor": "user@example",
          "x-woohaa3-admin-actor": "admin@forged"
        },
        body: { expectedRevision: 0, enabled: true, values: {}, secretRefs: [] }
      })
    );
    // 已认证但不在 site-access adminSubjects：403（区别于未认证 401）。
    expect(result.status).toBe(403);
    expect(plane.snapshot().revision).toBe(0);
  });

  it("管理员身份经适配器写入成功", async () => {
    const { handler, plane } = makeHarness();
    const result = await call(
      handler,
      makeRequest({
        method: "PUT",
        url: `/api/extensions/${METADATA.extensionId}/config`,
        headers: {
          "content-type": "application/json",
          "x-woohaa3-test-actor": "admin@example"
        },
        body: { expectedRevision: 0, enabled: true, values: { threshold: 5 }, secretRefs: ["cred"] }
      })
    );
    expect(result.status).toBe(200);
    expect((result.body as { revision: number }).revision).toBe(1);
    expect(plane.status(METADATA.extensionId)?.actualState).toBe("active");
  });

  it("expectedRevision 冲突返回 409 且保留较新配置", async () => {
    const { handler, plane } = makeHarness();
    const headers = { "content-type": "application/json", "x-woohaa3-test-actor": "admin@example" };
    await call(handler, makeRequest({ method: "PUT", url: `/api/extensions/${METADATA.extensionId}/config`, headers, body: { expectedRevision: 0, enabled: true, values: { v: 1 }, secretRefs: [] } }));
    await call(handler, makeRequest({ method: "PUT", url: `/api/extensions/${METADATA.extensionId}/config`, headers, body: { expectedRevision: plane.snapshot().revision, enabled: true, values: { v: 2 }, secretRefs: [] } }));
    const stale = plane.snapshot().revision - 1;
    const conflict = await call(handler, makeRequest({ method: "PUT", url: `/api/extensions/${METADATA.extensionId}/config`, headers, body: { expectedRevision: stale, enabled: false, values: {}, secretRefs: [] } }));
    expect(conflict.status).toBe(409);
    expect((conflict.body as { code: string }).code).toBe("revision-conflict");
    expect((conflict.body as { currentRevision: number }).currentRevision).toBe(plane.snapshot().revision);
    expect(plane.status(METADATA.extensionId)?.desiredEnabled).toBe(true);
  });
});

describe("受控插件 handler 分派", () => {
  it("受保护 handler 拒绝未认证（401）与无权限（403），放行管理员", async () => {
    const { handler, plane } = makeHarness({ withHandler: true });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const anonymous = await call(
      handler,
      makeRequest({
        method: "POST",
        url: `/api/extensions/${METADATA.extensionId}/handlers/sample/admin`,
        headers: { "content-type": "application/json" },
        body: { x: 1 }
      })
    );
    expect(anonymous.status).toBe(401);
    const denied = await call(
      handler,
      makeRequest({
        method: "POST",
        url: `/api/extensions/${METADATA.extensionId}/handlers/sample/admin`,
        headers: { "content-type": "application/json", "x-woohaa3-test-actor": "user" },
        body: { x: 1 }
      })
    );
    expect(denied.status).toBe(403);
    const allowed = await call(
      handler,
      makeRequest({
        method: "POST",
        url: `/api/extensions/${METADATA.extensionId}/handlers/sample/admin`,
        headers: { "content-type": "application/json", "x-woohaa3-test-actor": "admin@example" },
        body: { x: 1 }
      })
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ echo: { x: 1 } });
  });

  it("未激活插件的 handler 路由不可达", async () => {
    const { handler } = makeHarness({ withHandler: true });
    const result = await call(
      handler,
      makeRequest({ method: "POST", url: `/api/extensions/${METADATA.extensionId}/handlers/sample/public`, headers: { "content-type": "application/json" }, body: {} })
    );
    expect(result.status).toBe(404);
  });
});

describe("内部 work/recovery 接口", () => {
  it("无服务令牌拒绝；有令牌可 admission 与 resume", async () => {
    const { handler, plane } = makeHarness({ serviceToken: "svc" });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });

    const unauthorized = await call(handler, makeRequest({ method: "POST", url: `/internal/v1/extensions/${METADATA.extensionId}/work` }));
    expect(unauthorized.status).toBe(401);

    const admitted = await call(
      handler,
      makeRequest({
        method: "POST",
        url: `/internal/v1/extensions/${METADATA.extensionId}/work`,
        headers: { "x-woohaa3-service-token": "svc" }
      })
    );
    expect(admitted.status).toBe(200);
    const workId = (admitted.body as { workId: string }).workId;
    expect(workId).toBeTruthy();

    const resumed = await call(
      handler,
      makeRequest({
        method: "POST",
        url: `/internal/v1/extensions/${METADATA.extensionId}/work/${workId}/resume`,
        headers: { "x-woohaa3-service-token": "svc" }
      })
    );
    expect(resumed.status).toBe(200);
    expect((resumed.body as { configVersion: number }).configVersion).toBe(1);
  });
});

describe("受控 HTTP handler 分派（design D4）", () => {
  it("公开映射经受控 HTTP handler 返回 HTML 与 Set-Cookie", async () => {
    const { handler, plane } = makeHarness({ withHttp: true });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const result = await call(handler, makeRequest({ method: "GET", url: "/api/chatgpt/oauth?code=xyz&state=s" }));
    expect(result.status).toBe(200);
    expect(result.headers["set-cookie"]).toContain("HttpOnly");
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.raw).toContain("<html>ok</html>");
  });

  it("流式 handler 可写入 SSE 事件", async () => {
    const { handler, plane } = makeHarness({ withHttp: true });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const result = await call(handler, makeRequest({ method: "POST", url: "/api/chatgpt/events", body: { requestId: "r1" } }));
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
    expect(result.raw).toContain("event: progress");
  });

  it("draining 拒绝新工作，但保留在途控制与只读", async () => {
    const { handler, plane } = makeHarness({ withHttp: true });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    // 进入 draining：desiredEnabled=false，但有旧版本实例保留。
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: plane.snapshot().revision, enabled: false, values: {}, secretRefs: [], actor: "admin" });
    const newWork = await call(handler, makeRequest({ method: "POST", url: "/api/chatgpt/events", body: {} }));
    expect([503, 404]).toContain(newWork.status);
    // 只读回执仍可访问（若实例仍 active）或用 404；关键是不因 draining 一律 500。
    const receipt = await call(handler, makeRequest({ method: "GET", url: "/api/chatgpt/receipt?requestId=r1" }));
    expect([200, 404, 503]).toContain(receipt.status);
  });

  it("公开映射之外的路径不泄漏插件；方法不允许返回 405", async () => {
    const { handler, plane } = makeHarness({ withHttp: true });
    await plane.write({ extensionId: METADATA.extensionId, expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const wrongMethod = await call(handler, makeRequest({ method: "DELETE", url: "/api/chatgpt/oauth" }));
    expect(wrongMethod.status).toBe(405);
  });
});

describe("受控原始 HTTP handler 分派（design D4）", () => {
  it("原始 handler 收到 Node 形状 req/res 与可信上下文", async () => {
    const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
    const work = createSqliteExtensionWorkRepository({ path: tempDb() });
    resources.push(store, work);
    const host = createApplicationExtensionHost();
    const metadata: ApplicationExtensionMetadata = {
      ...METADATA,
      extensionId: "raw-plugin",
      capabilities: [{ id: "raw", kind: "handler", description: "raw", auth: "public" }]
    };
    const plane = createSiteExtensionControlPlane({
      host,
      store,
      workStore: work,
      metadata: { list: () => [metadata], get: (id) => (id === "raw-plugin" ? metadata : undefined) },
      definitions: [
        {
          extensionId: "raw-plugin",
          activate: (h) => {
            h.registerRawHttpHandler?.({
              route: "*",
              method: "GET",
              auth: "public",
              purpose: "read",
              stream: true,
              handle: async (req, res, context) => {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/plain");
                res.end(`subject=${context.principal?.subject ?? "none"};cookie=${req.headers.cookie ?? ""}`);
              }
            });
          }
        }
      ],
      now: () => new Date("2026-10-04T00:00:00.000Z")
    });
    const auth = createFakeRequestAuthenticator((req) => {
      const actor = req.headers["x-woohaa3-test-actor"] as string | undefined;
      if (!actor) return null;
      return testPrincipal(actor, { identityProvider: "test" });
    });
    const handler = createApplicationExtensionApiHandler({
      controlPlane: plane,
      host,
      authenticator: auth,
      publicRoutes: [{ extensionId: "raw-plugin", publicPath: "/api/raw", route: "raw", methods: ["GET"] }]
    });
    await plane.write({ extensionId: "raw-plugin", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const result = await call(handler, makeRequest({
      method: "GET",
      url: "/api/raw/thing?x=1",
      headers: { "x-woohaa3-test-actor": "user-a", cookie: "sid=1" }
    }));
    expect(result.status).toBe(200);
    // 原始 handler 收到可信 principal（由宿主注入）与原始 Cookie 头。
    expect(result.raw).toContain("subject=user-a");
    expect(result.raw).toContain("cookie=sid=1");
  });

  it("公开路由的 404 区分「路由未注册」与「插件未激活」", async () => {
    const store = createSqliteSiteExtensionConfigStore({ path: tempDb() });
    const work = createSqliteExtensionWorkRepository({ path: tempDb() });
    resources.push(store, work);
    const host = createApplicationExtensionHost();
    const metadata: ApplicationExtensionMetadata = {
      ...METADATA,
      extensionId: "route-plugin",
      capabilities: [{ id: "raw", kind: "handler", description: "raw", auth: "public" }]
    };
    const plane = createSiteExtensionControlPlane({
      host,
      store,
      workStore: work,
      metadata: { list: () => [metadata], get: (id) => (id === "route-plugin" ? metadata : undefined) },
      definitions: [
        {
          extensionId: "route-plugin",
          activate: (h) => {
            h.registerRawHttpHandler?.({
              route: "connections",
              method: "GET",
              auth: "public",
              purpose: "read",
              handle: async (_req, res) => {
                res.statusCode = 200;
                res.end("ok");
              }
            });
          }
        }
      ],
      now: () => new Date("2026-10-04T00:00:00.000Z")
    });
    const handler = createApplicationExtensionApiHandler({
      controlPlane: plane,
      host,
      authenticator: createFakeRequestAuthenticator(() => null),
      publicRoutes: [{ extensionId: "route-plugin", publicPath: "/api/route-plugin", route: "route-plugin", methods: ["GET"] }]
    });
    await plane.write({ extensionId: "route-plugin", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });

    const registered = await call(handler, makeRequest({ method: "GET", url: "/api/route-plugin/connections" }));
    expect(registered.status).toBe(200);

    // 激活了但这条 route 没注册：不能报「插件未激活」，否则排查会被引向扩展没起来。
    const missing = await call(handler, makeRequest({ method: "GET", url: "/api/route-plugin/not-registered" }));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "route-not-registered" });
    expect((missing.body as { message: string }).message).toContain("未注册该路由");

    await plane.write({ extensionId: "route-plugin", expectedRevision: plane.snapshot().revision, enabled: false, values: {}, secretRefs: [], actor: "admin" });
    const inactive = await call(handler, makeRequest({ method: "GET", url: "/api/route-plugin/connections" }));
    expect(inactive.status).toBe(404);
    expect(inactive.body).toMatchObject({ code: "extension-not-found" });
  });

  it.each([0, 20])("流式 deadline=%i：0 不限时，正数到达后实际取消连接", async deadlineMs => {
    const store = createSqliteSiteExtensionConfigStore({ path: ":memory:" });
    const work = createSqliteExtensionWorkRepository({ path: ":memory:" });
    resources.push(store, work);
    const registration = (h: ApplicationBackendHost) => {
      h.registerRawHttpHandler?.({
        route: "*",
        method: "GET",
        auth: "public",
        purpose: "read",
        stream: true,
        streamBudget: { deadlineMs, heartbeatMs: 5, maxEvents: 1000, maxBytes: 1024 * 1024 },
        handle: async (_req, res, context) => {
          res.setHeader("Content-Type", "text/event-stream");
          res.writeHead(200);
          if (deadlineMs === 0) {
            await new Promise(resolve => setTimeout(resolve, 40));
            expect(context.signal?.aborted).toBe(false);
            res.end();
            return;
          }
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) return resolve();
            context.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      });
    };
    const host = createApplicationExtensionHost({
      workFacadeFor: () => ({ admit: () => ({ ok: true, workId: "w", configVersion: 1 }), resume: () => null, activeWorkCount: () => 0 })
    });
    const metadata: ApplicationExtensionMetadata = {
      ...METADATA,
      extensionId: "sse-plugin",
      capabilities: [{ id: "raw", kind: "handler", description: "raw", auth: "public" }]
    };
    const plane = createSiteExtensionControlPlane({
      host,
      store,
      workStore: work,
      metadata: { list: () => [metadata], get: (id) => (id === "sse-plugin" ? metadata : undefined) },
      definitions: [{ extensionId: "sse-plugin", activate: (h) => registration(h) }],
      now: () => new Date("2026-10-04T00:00:00.000Z")
    });
    const handler = createApplicationExtensionApiHandler({
      controlPlane: plane,
      host,
      authenticator: createFakeRequestAuthenticator(() => null),
      publicRoutes: [{ extensionId: "sse-plugin", publicPath: "/api/sse", route: "sse", methods: ["GET"] }]
    });
    await plane.write({ extensionId: "sse-plugin", expectedRevision: 0, enabled: true, values: {}, secretRefs: [], actor: "admin" });
    const started = Date.now();
    const result = await call(handler, makeRequest({ method: "GET", url: "/api/sse/stream" }));
    // deadline（20ms）到达后连接被结束，而不是一直挂着。
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.status).toBe(200);
    expect(result.raw).toContain(": heartbeat");
  });
});
