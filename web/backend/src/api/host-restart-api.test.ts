import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAccessEnforcer,
  createFakeRequestAuthenticator,
  testPrincipal,
  type AccessEnforcer
} from "@woohaa3/application-service";
import type { SiteAccessPolicy } from "@woohaa3/contracts";
import {
  HOST_RESTART_EXIT_CODE,
  createHostRestartApiHandler,
  createHostRestartController,
  type HostRestartApiDependencies,
  type HostRestartRequest
} from "./host-restart-api.js";

function sitePolicy(allowed: boolean): SiteAccessPolicy {
  return {
    policyId: "test-site-access",
    policyVersion: () => "1",
    async allowedActions() {
      return allowed ? ["extensions.configure"] : [];
    },
    async authorize() {
      return allowed ? { allowed: true } : { allowed: false, reason: "denied" };
    }
  } as SiteAccessPolicy;
}

function enforcer(allowed: boolean): AccessEnforcer {
  return createAccessEnforcer({ siteAccessPolicy: () => sitePolicy(allowed), resourceAccessPolicy: () => null });
}

const localAuth = {
  authenticator: createFakeRequestAuthenticator(() => { throw new Error("本地单实例不应认证"); }),
  accessEnforcer: createAccessEnforcer({
    runtime: {
      enabled: false,
      instance: { kind: "instance", id: "instance:test", ownerId: "dev-admin", credentialOwnerId: "principal:dev-admin" }
    },
    siteAccessPolicy: () => sitePolicy(true),
    resourceAccessPolicy: () => null
  })
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(deps: Omit<HostRestartApiDependencies, "controller"> & { subscribe?: boolean }) {
  const controller = createHostRestartController();
  const requests: HostRestartRequest[] = [];
  if (deps.subscribe !== false) controller.subscribe((request) => requests.push(request));
  const marks: unknown[] = [];
  const handler = createHostRestartApiHandler({
    markRestartRequested: (input) => marks.push(input),
    ...deps,
    controller
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/host/restart`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { url, post, requests, marks, controller };
}

/** 等 res.finish 之后的通知被投递。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("POST /api/host/restart", () => {
  it("管理员请求：写标记、回 202，响应写完后通知进程入口", async () => {
    const { post, requests, marks } = await start(localAuth);
    const response = await post({ reason: "安装扩展后生效", exitSafeMode: true });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "restarting", exitCode: HOST_RESTART_EXIT_CODE });
    await tick();
    expect(marks).toEqual([{ reason: "安装扩展后生效", exitSafeMode: true }]);
    expect(requests).toMatchObject([{ reason: "安装扩展后生效", exitSafeMode: true }]);
  });

  it("排空期间重复请求幂等：仍回 202，不再写标记或二次通知", async () => {
    const { post, requests, marks } = await start(localAuth);
    expect((await post({})).status).toBe(202);
    await tick();
    const again = await post({ reason: "again" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: "draining" });
    await tick();
    expect(marks).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.reason).toBe("manual");
  });

  it("未认证 / 无权限：拒绝且宿主不退出", async () => {
    const unauthenticated = await start({
      authenticator: createFakeRequestAuthenticator(() => null),
      accessEnforcer: enforcer(true)
    });
    expect((await unauthenticated.post({})).status).toBe(401);
    const forbidden = await start({
      authenticator: createFakeRequestAuthenticator(() => testPrincipal("someone", { identityProvider: "test" })),
      accessEnforcer: enforcer(false)
    });
    expect((await forbidden.post({})).status).toBe(403);
    await tick();
    expect(unauthenticated.requests).toEqual([]);
    expect(forbidden.requests).toEqual([]);
    expect(forbidden.marks).toEqual([]);
  });

  it("请求体非法或方法不对：400 / 405，不触发重启", async () => {
    const { url, post, requests } = await start(localAuth);
    expect((await post({ exitSafeMode: "yes" })).status).toBe(400);
    expect((await fetch(url)).status).toBe(405);
    await tick();
    expect(requests).toEqual([]);
  });

  it("没有进程入口订阅时回 503，不写标记", async () => {
    const { post, marks, controller } = await start({ ...localAuth, subscribe: false });
    expect((await post({})).status).toBe(503);
    expect(marks).toEqual([]);
    expect(controller.requested()).toBe(false);
  });

  it("写标记失败只记日志，仍受理重启", async () => {
    const events: Record<string, unknown>[] = [];
    const { post, requests } = await start({
      ...localAuth,
      markRestartRequested: () => { throw new Error("disk full"); },
      logger: (event) => events.push(event)
    });
    expect((await post({})).status).toBe(202);
    await tick();
    expect(requests).toHaveLength(1);
    expect(events.map((event) => event.event)).toContain("host-restart-mark-failed");
  });
});
