import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createAccessEnforcer, createFakeRequestAuthenticator, testPrincipal } from "@woohaa3/application-service";
import { createMcpInstallationApi } from "./mcp-installation-api.js";
import { InstallationError } from "../mcp-installation/errors.js";
import { createOriginGuard } from "../http/origin-guard.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function start(controlled = false, allow = true) {
  const installer = { detect: vi.fn(async () => ({ clients: [] })), install: vi.fn(async () => ({ changed: true })) };
  const handler = createMcpInstallationApi({ installer: installer as any, basePath: "/work/", authenticator: createFakeRequestAuthenticator(req => req.headers.authorization ? testPrincipal("admin") : null), accessEnforcer: createAccessEnforcer({ runtime: controlled ? { enabled: true } as any : { enabled: false, instance: { kind: "instance", id: "test", ownerId: "dev-admin", credentialOwnerId: "principal:dev-admin" } }, siteAccessPolicy: () => ({ policyId: "test", policyVersion: () => "1", allowedActions: async () => allow ? ["extensions.configure"] : [], authorize: async () => allow ? ({ allowed: true as const }) : ({ allowed: false as const, code: "forbidden" as const }) }), resourceAccessPolicy: () => null }) });
  const guard = createOriginGuard([]);
  const server = http.createServer((req, res) => {
    if (!guard(req).ok) { res.statusCode = 403; res.end(); return; }
    void handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
  return { installer, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
it("GET 仅检测，POST 使用注册表客户端与公开部署前缀，不采纳提交路径/URL", async () => {
  const { installer, base } = await start();
  expect((await fetch(`${base}/api/mcp-installation`)).status).toBe(200);
  expect(installer.install).not.toHaveBeenCalled();
  expect(installer.detect).toHaveBeenCalledWith(`${base}/work/mcp/model-canvas`);
  expect((await fetch(`${base}/api/mcp-installation/opencode`, { method: "POST", headers: { Origin: base }, body: JSON.stringify({ path: "/anything", url: "https://evil.test" }) })).status).toBe(200);
  expect(installer.install).toHaveBeenCalledWith("opencode", `${base}/work/mcp/model-canvas`, "default");
  expect((await fetch(`${base}/api/mcp-installation/unknown`, { method: "POST" })).status).toBe(405);
  expect(installer.install).toHaveBeenCalledTimes(1);
});
it("注册表内的新客户端与目标段都被接受；未知目标由安装器确认后返回 404", async () => {
  const { installer, base } = await start();
  expect((await fetch(`${base}/api/mcp-installation/claude-code`, { method: "POST", headers: { Origin: base } })).status).toBe(200);
  expect(installer.install).toHaveBeenLastCalledWith("claude-code", `${base}/work/mcp/model-canvas`, "default");
  expect((await fetch(`${base}/api/mcp-installation/deepseek-harness/web`, { method: "POST", headers: { Origin: base } })).status).toBe(200);
  expect(installer.install).toHaveBeenLastCalledWith("deepseek-harness", `${base}/work/mcp/model-canvas`, "web");
  expect((await fetch(`${base}/api/mcp-installation/codex/extra/segment`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${base}/api/mcp-installation/codex`, { method: "GET" })).status).toBe(405);
  expect(installer.install).toHaveBeenCalledTimes(2);
});
it("动态目标缺失返回 404，其余写入失败仍是 409", async () => {
  const { installer, base } = await start();
  installer.install.mockRejectedValueOnce(new InstallationError("未找到该客户端的安装目标，请重新检测后重试。", "target-not-found"))
    .mockRejectedValueOnce(new InstallationError("客户端配置正在写入或目录不可写，请稍后重试。"));
  expect((await fetch(`${base}/api/mcp-installation/deepseek-harness/removed`, { method: "POST", headers: { Origin: base } })).status).toBe(404);
  expect((await fetch(`${base}/api/mcp-installation/codex`, { method: "POST", headers: { Origin: base } })).status).toBe(409);
});
it("受控部署沿用管理员 action；未认证和无权限不读取或写入文件", async () => {
  const { installer, base } = await start(true, false);
  expect((await fetch(`${base}/api/mcp-installation`)).status).toBe(401);
  expect((await fetch(`${base}/api/mcp-installation/codex`, { method: "POST", headers: { authorization: "test" } })).status).toBe(403);
  expect(installer.detect).not.toHaveBeenCalled(); expect(installer.install).not.toHaveBeenCalled();
});
it("跨源写入由宿主 Origin 守卫拒绝", async () => {
  const { installer, base } = await start();
  expect((await fetch(`${base}/api/mcp-installation/codex`, { method: "POST", headers: { Origin: "https://evil.test" } })).status).toBe(403);
  expect(installer.install).not.toHaveBeenCalled();
});
