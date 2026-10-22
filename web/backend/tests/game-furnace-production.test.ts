import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createFakeRequestAuthenticator, testPrincipal } from "@woohaa3/application-service";
import type { SiteAccessPolicy } from "@woohaa3/contracts";
import { createBackendService } from "../src/composition.js";

/** configured 模式的站点策略：具名主体 `tester` 拥有全部 action（生产由 site-access 扩展提供）。 */
function testerSitePolicy(): SiteAccessPolicy {
  return {
    policyId: "test-site-access",
    policyVersion: () => "1",
    async allowedActions() {
      return ["extensions.configure", "providers.credentials.write", "models.manage", "tasks.inspect"];
    },
    async authorize({ principal }) {
      return principal.subject === "tester" ? { allowed: true } : { allowed: false, code: "forbidden" };
    }
  };
}

it.each(["configured", "local-dev"])("%s 认证下生产清单接通目录启停门禁、真实 HTTP 项目往返与媒体", async (authMode) => {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-furnace-production-"));
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const service = await createBackendService({
    env: { ...(authMode === "local-dev" ? { WOOHAA3_AGENT_LOOPBACK_MODE: "1", WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL: "local-dev" } : {}), WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
      WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite", WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
      WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite") },
    logger: () => {},
    modelsConfig: { version: 1, models: [] }, enableYjsSync: true,
    ...(authMode === "local-dev"
      ? {}
      : {
          authenticator: createFakeRequestAuthenticator(req => req.headers.authorization === "Bearer user"
            ? testPrincipal("tester", { identityProvider: "test" })
            : null),
          // 受控 handler 的画布读写走统一 `ResourceAccessPolicy`（change: 2026-10-13-...，任务 4.4/6.2）：
          // 测试身份配套**显式**资源策略，不依赖工作区当前安装的访问实现。
          seedProviders: {
            siteAccess: testerSitePolicy(),
            resourceAccess: {
              policyId: "test:furnace-resource",
              async authorize({ permission }) {
                return { allowed: true, permission };
              }
            }
          }
        }),
    mediaStorage: {
      async put(key, bytes, contentType) { objects.set(key, { bytes: bytes.slice(), contentType }); },
      async get(key) { const object = objects.get(key); if (!object) throw new Error("missing"); return object; },
      async exists(key) { return objects.has(key); },
      async stat(key) { const object = objects.get(key)!; return { size: object.bytes.length, contentType: object.contentType }; }
    }
  });
  const server = http.createServer((req, res) => void service.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // 任务 6.2：受控 handler 现在按 principal.subject 对 canvasId 做权威授权（读/写）。建立真实画布，
  // 使授权器可判定；否则会 fail closed。configured 模式授权器放行任意具名主体，local-dev 限开发 principal。
  const canvasService = service.modules().canvas.composition!.service;
  await canvasService.createCanvas({ canvasId: "c" });
  await canvasService.createCanvas({ canvasId: "copy" });
  // local-dev（无身份提供者）不启用访问控制，所有请求按实例作用域放行；configured 模式仍要求
  // 具名 principal。两条路径都不再存在浏览器可获取的 dev 管理员令牌。
  const localDev = authMode === "local-dev";
  const call = async (route: string, body: unknown, authorized = true) => {
    const res = await fetch(`${base}/api/extensions/game-furnace/handlers/${route}`, { method: "POST",
      headers: { "content-type": "application/json", ...(!localDev && authorized ? { authorization: "Bearer user" } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const plane = service.modules().application.plugins();
    await plane.reconcile();
    expect(plane.status("game-furnace")).toMatchObject({ actualState: "active", desiredEnabled: true, configVersion: 1 });
    expect(service.modules().runtime.host.snapshot().some(entry => entry.extensionId === "game-furnace")).toBe(true);
    const request = { canvasId: "c", nodeId: "n", operations: [{ type: "requirements.patch", patch: { name: "跳跃", description: "跳过障碍" } }] };
    expect((await call("game-furnace/project-collect", request, false)).status).toBe(localDev ? 200 : 401);
    const forged = await fetch(`${base}/api/extensions/game-furnace/handlers/game-furnace/project-collect`, {
      method: "POST", headers: { "content-type": "application/json", "x-woohaa3-admin-token": "forged" }, body: JSON.stringify(request)
    });
    expect(forged.status).toBe(localDev ? 200 : 401);
    const collected = await call("game-furnace/project-collect", request);
    expect(collected.status).toBe(200);
    expect(collected.body.projectStorageKey).toMatch(/^sha256-[a-f0-9]{64}$/);
    const opened = await call("game-furnace/project-open", { canvasId: "c", nodeId: "n", projectStorageKey: collected.body.projectStorageKey });
    expect(opened.body).toMatchObject({ ok: true, inputHash: collected.body.inputHash,
      state: { requirements: { name: "跳跃", description: "跳过障碍" } } });
    // 另一目标读取同一不可变原件后建立独立项目，不能共享执行/局部身份。
    const restored = await call("game-furnace/project-open", { canvasId: "copy", nodeId: "copy", projectStorageKey: collected.body.projectStorageKey });
    expect(restored.body.state).toMatchObject({ requirements: opened.body.state.requirements, resources: opened.body.state.resources,
      projectOwner: { canvasId: "copy", nodeId: "copy" } });
    expect(restored.body.state.projectId).not.toBe(opened.body.state.projectId);
    expect(restored.body.projectStorageKey).not.toBe(opened.body.projectStorageKey);
    expect(service.modules().task.port().extensionTasks).toBeTypeOf("function");
    const old = await service.modules().runtime.host.activateVersioned({ extensionId: "game-furnace", activate(host) {
      host.registerHandler({ route: "private", auth: "authenticated", handle: () => ({ body: { leaked: true } }) });
    } }, 99, "recovery");
    expect(old.ok).toBe(true);
    expect((await call("_recovery/game-furnace/99/private", {})).status).toBe(404);
    const lease = plane.workLease("game-furnace")!;
    const admitted = lease.admit();
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("work not admitted");
    // 主干改为目录前缀管理启停：在线写 enabled:false 必须拒绝，不能绕过目录控制。
    const rejected = await plane.write({ extensionId: "game-furnace", expectedRevision: plane.snapshot().revision, enabled: false, values: {}, secretRefs: [], actor: "tester" });
    expect(rejected).toMatchObject({ ok: false, code: "config-invalid" });
    expect(plane.status("game-furnace")?.actualState).toBe("active");
    const openRequest = { canvasId: "c", nodeId: "n", projectStorageKey: collected.body.projectStorageKey };
    expect((await call("game-furnace/project-open", openRequest)).status).toBe(200);
    expect((await call("game-furnace/project-open", openRequest, false)).status).toBe(localDev ? 200 : 401);
    lease.resume(admitted.workId)!.settle("succeeded");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
