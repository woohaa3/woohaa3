import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInstallJobView } from "@woohaa3/contracts";
import type { ExtensionManager } from "../host/core/extension-manager/manager.js";
import { ExtensionManagerError } from "../host/core/extension-manager/errors.js";
import { createExtensionInstallApiHandler } from "./extension-install-api.js";

const JOB: ExtensionInstallJobView = { jobId: "j1", action: "install", sourceId: "local-file", status: "running", phase: "download", startedAt: "2026-10-21T00:00:00Z" };
const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function fakeManager(overrides: Partial<ExtensionManager> = {}): ExtensionManager {
  return {
    installFromFile: vi.fn(async ({ body }) => {
      let size = 0;
      for await (const chunk of body as AsyncIterable<Buffer>) size += chunk.length;
      return { ...JOB, progress: size };
    }),
    installFromSource: vi.fn(() => ({ ...JOB, sourceId: "corp" })),
    uninstall: vi.fn(() => ({ ...JOB, action: "uninstall" as const })),
    rollback: vi.fn(() => ({ ...JOB, action: "rollback" as const })),
    job: vi.fn((id: string) => (id === "j1" ? JOB : undefined)),
    wait: vi.fn(),
    cancel: vi.fn((id: string) => (id === "j1" ? { ...JOB, status: "cancelled" as const } : null)),
    search: vi.fn(async () => ({ items: [], unavailable: [] })),
    requestRestart: vi.fn(),
    installed: vi.fn(() => []),
    view: vi.fn(),
    observe: vi.fn(),
    sweep: vi.fn(),
    close: vi.fn(),
    ...overrides
  } as unknown as ExtensionManager;
}

async function serve(
  manager: ExtensionManager | undefined,
  allow = true,
  detail?: Parameters<typeof createExtensionInstallApiHandler>[0]["marketplaceDetail"],
  versionStatus?: Parameters<typeof createExtensionInstallApiHandler>[0]["versionStatus"]
) {
  const handler = createExtensionInstallApiHandler({
    manager: () => manager,
    ...(detail ? { marketplaceDetail: detail } : {}),
    ...(versionStatus ? { versionStatus } : {}),
    accessEnforcer: {
      runtime: { enabled: false },
      assertAction: async () => {
        if (!allow) throw Object.assign(new Error("denied"), { code: "access-denied" });
      }
    } as never
  });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.statusCode = 404;
      res.end("downstream");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("扩展安装 API", () => {
  it("上传 .wxt 原始字节 → 202 { jobId }，流式传给 Manager", async () => {
    const manager = fakeManager();
    const base = await serve(manager);
    const res = await fetch(`${base}/api/extensions/install`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.alloc(1000) });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe("j1");
    expect(body.job.progress).toBe(1000);
  });

  it("JSON 来源安装校验字段；错误 Content-Type 回 415", async () => {
    const manager = fakeManager();
    const base = await serve(manager);
    const ok = await fetch(`${base}/api/extensions/install`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: "corp", extensionId: "demo", range: "^1" }) });
    expect(ok.status).toBe(202);
    expect(manager.installFromSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "corp", extensionId: "demo", range: "^1" }));
    const bad = await fetch(`${base}/api/extensions/install`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: "corp", extensionId: "Bad Id" }) });
    expect(bad.status).toBe(400);
    const wrongType = await fetch(`${base}/api/extensions/install`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(wrongType.status).toBe(415);
  });

  it("任务查询 / 取消 / 不存在", async () => {
    const base = await serve(fakeManager());
    expect((await fetch(`${base}/api/extensions/install/j1`)).status).toBe(200);
    expect((await (await fetch(`${base}/api/extensions/install/j1`, { method: "DELETE" })).json()).status).toBe("cancelled");
    expect((await fetch(`${base}/api/extensions/install/zzz`)).status).toBe(404);
  });

  it("卸载 / 回滚 / 搜索；重启不在这里（只有 /api/host/restart 一个入口）", async () => {
    const manager = fakeManager();
    const base = await serve(manager);
    expect((await fetch(`${base}/api/extensions/demo/uninstall`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purgeData: true }) })).status).toBe(202);
    expect(manager.uninstall).toHaveBeenCalledWith("demo", expect.objectContaining({ purgeData: true }));
    expect((await fetch(`${base}/api/extensions/demo/rollback`, { method: "POST" })).status).toBe(202);
    expect((await fetch(`${base}/api/extensions/marketplace/search?q=x&limit=500`)).status).toBe(200);
    expect(manager.search).toHaveBeenCalledWith({ text: "x", limit: 100 });
    expect(await (await fetch(`${base}/api/extensions/restart`, { method: "POST" })).text()).toBe("downstream");
  });

  it("无权限 403；没有 Manager 503；其它 /api/extensions 路径交下游", async () => {
    expect((await fetch(`${await serve(fakeManager(), false)}/api/extensions/install/j1`)).status).toBe(403);
    expect((await (await fetch(`${await serve(undefined)}/api/extensions/install/j1`)).json()).code).toBe("MARKETPLACE_UNAVAILABLE");
    const base = await serve(fakeManager());
    const downstream = await fetch(`${base}/api/extensions/demo/config`, { method: "PUT" });
    expect(await downstream.text()).toBe("downstream");
    expect((await fetch(`${base}/api/extensions`)).status).toBe(404);
  });
});

describe("GET /api/extensions/marketplace/extension（7.4）", () => {
  it("返回版本详情；参数缺失 400；未提供 503；来源错误映射 404/503", async () => {
    const view = { sourceId: "woohaa-server", extension: { extensionId: "demo", label: "Demo", versions: [] }, trustedKeyIds: [], signingKeys: [] };
    const calls: Array<{ sourceId: string; extensionId: string }> = [];
    const base = await serve(fakeManager(), true, () => async (input) => {
      calls.push(input);
      if (input.extensionId === "missing") throw new ExtensionManagerError("MARKETPLACE_SOURCE_NOT_FOUND", "没有");
      if (input.extensionId === "down") throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "未登录");
      return view;
    });
    const ok = await fetch(`${base}/api/extensions/marketplace/extension?sourceId=woohaa-server&extensionId=demo`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(view);
    expect(calls).toEqual([{ sourceId: "woohaa-server", extensionId: "demo" }]);
    expect((await fetch(`${base}/api/extensions/marketplace/extension?sourceId=woohaa-server&extensionId=Bad Id`)).status).toBe(400);
    expect((await fetch(`${base}/api/extensions/marketplace/extension?sourceId=woohaa-server&extensionId=missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/extensions/marketplace/extension?sourceId=woohaa-server&extensionId=down`)).status).toBe(503);
    expect((await fetch(`${base}/api/extensions/marketplace/extension?sourceId=a&extensionId=demo`, { method: "POST" })).status).toBe(405);
    const none = await serve(fakeManager());
    expect((await (await fetch(`${none}/api/extensions/marketplace/extension?sourceId=a&extensionId=demo`)).json()).code).toBe("MARKETPLACE_UNAVAILABLE");
  });
});

describe("GET /api/extensions/:id/version-status", () => {
  it("按受管记录的来源与版本查询；非受管 404；未提供 503", async () => {
    const seen: unknown[] = [];
    const manager = fakeManager({ installed: vi.fn(() => [{ extensionId: "demo", version: "1.0.0", sourceId: "woohaa-server", restartRequired: false, directory: "/x" }]) as never });
    const base = await serve(manager, true, undefined, () => async (input) => {
      seen.push(input);
      return { ...input, status: "withdrawn", reason: "安全问题", checkedAt: "t" };
    });
    const res = await fetch(`${base}/api/extensions/demo/version-status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "withdrawn", reason: "安全问题" });
    expect(seen).toEqual([{ sourceId: "woohaa-server", extensionId: "demo", version: "1.0.0" }]);
    expect((await fetch(`${base}/api/extensions/other/version-status`)).status).toBe(404);
    expect((await fetch(`${await serve(manager)}/api/extensions/demo/version-status`)).status).toBe(503);
  });
});

