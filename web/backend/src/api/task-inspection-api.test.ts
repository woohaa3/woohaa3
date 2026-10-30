import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskInspectionApi } from "./task-inspection-api.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function boot(options: {
  authenticated?: boolean;
  denied?: boolean;
  unavailable?: boolean;
  disabled?: boolean;
  /** 详情返回的内容（缺省 null = 任务不存在）。 */
  detailResult?: unknown;
  /** 产物定位：返回 null 表示「不知道」，抛错表示定位失败。 */
  locate?: (input: { storageKey: string; canvasId?: string }) => Promise<{ backendId: string; key: string; locator: string } | null>;
} = {}) {
  const snapshot = vi.fn(async (input: { query?: unknown }) => ({ observedAt: "2026-10-17T00:00:00Z", stateCounts: {}, items: [], nextCursor: null, query: input.query }));
  const detail = vi.fn(async () => options.detailResult ?? null);
  const assertAction = vi.fn(async () => {
    if (options.denied) throw Object.assign(new Error("denied"), { code: "forbidden" });
    if (options.unavailable) throw Object.assign(new Error("unavailable"), { code: "access-provider-unavailable" });
  });
  const handler = createTaskInspectionApi({
    ...(options.disabled ? { accessRuntime: { enabled: false as const, instance: { kind: "instance" as const, id: "instance:t", ownerId: "dev-admin", credentialOwnerId: "principal:dev-admin" } } } : {}),
    authenticator: async () => options.authenticated === false ? null : { subject: "alice", identityProvider: "test" },
    accessEnforcer: { assertAction } as never,
    inspection: { snapshot, detail } as never,
    ...(options.locate ? { locate: options.locate } : {})
  });
  const server = http.createServer((req, res) => void handler(req, res).then((handled) => {
    if (!handled) { res.writeHead(404); res.end(); }
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const request = (route: string, body: unknown = {}, method = "POST") => fetch(`http://127.0.0.1:${address.port}/api/task-inspection/${route}`, {
    method, ...(method === "POST" ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {})
  });
  return { request, snapshot, detail, assertAction };
}

describe("内置任务监控 API", () => {
  it.each([
    [{ authenticated: false }, 401],
    [{ denied: true }, 403],
    [{ unavailable: true }, 503]
  ] as const)("未获得授权时拒绝请求且不查询任务：%j", async (options, status) => {
    const app = await boot(options);
    expect((await app.request("snapshot")).status).toBe(status);
    expect(app.snapshot).not.toHaveBeenCalled();
    expect(app.detail).not.toHaveBeenCalled();
  });

  it("无需扩展 handler 即可查询快照，并检查 tasks.inspect", async () => {
    const app = await boot();
    const response = await app.request("snapshot", { query: { state: "failed", canvasId: "c1", bogus: "ignore" }, limit: 5 });
    expect(response.status).toBe(200);
    expect(app.assertAction).toHaveBeenCalledWith({ subject: "alice", identityProvider: "test" }, "tasks.inspect");
    expect(app.snapshot).toHaveBeenCalledWith({ principal: { subject: "alice", identityProvider: "test" }, query: { state: "failed", canvasId: "c1" }, limit: 5 });
  });

  it("本地单实例跳过认证与 action，按实例作用域查询", async () => {
    const app = await boot({ disabled: true, authenticated: false });
    const response = await app.request("snapshot", { limit: 5 });
    expect(response.status).toBe(200);
    expect(app.assertAction).not.toHaveBeenCalled();
    expect(app.snapshot).toHaveBeenCalledWith({ query: {}, limit: 5 });
  });

  it("非法查询、缺少任务标识和写操作不进入任务查询", async () => {
    const app = await boot();
    expect((await app.request("snapshot", { query: { state: "bogus" } })).status).toBe(400);
    expect((await app.request("snapshot", { limit: -1 })).status).toBe(400);
    expect((await app.request("detail")).status).toBe(400);
    expect((await app.request("snapshot", {}, "DELETE")).status).toBe(405);
    expect(app.snapshot).not.toHaveBeenCalled();
    expect(app.detail).not.toHaveBeenCalled();
  });

  it("未知任务返回 404，按规范化标识查详情", async () => {
    const app = await boot();
    expect((await app.request("detail", { taskKey: " missing " })).status).toBe(404);
    expect(app.detail).toHaveBeenCalledWith({ principal: { subject: "alice", identityProvider: "test" }, taskKey: "missing" });
  });
});

describe("产物位置（读取时解析）", () => {
  const found = {
    taskKey: "task-1",
    canvasId: "canvas-1",
    state: "succeeded",
    result: { mediaKind: "image", storageKey: "generation-outputs/a.png", size: 3, checksum: "abc" }
  };

  it("详情返回前补上所在后端与实际键（带 locator 时一并给出）", async () => {
    const locate = vi.fn(async () => ({ backendId: "server", key: "media/generation-outputs/a.png", locator: "media://server/media/generation-outputs/a.png" }));
    const app = await boot({ detailResult: found, locate });
    const response = await app.request("detail", { taskKey: "task-1" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { location: unknown } };
    expect(locate).toHaveBeenCalledWith({ storageKey: "generation-outputs/a.png", canvasId: "canvas-1" });
    expect(body.result.location).toEqual({
      backendId: "server",
      key: "media/generation-outputs/a.png",
      locator: "media://server/media/generation-outputs/a.png"
    });
  });

  it("定位失败或定位不到时详情照常返回，不把排障面板打成错误", async () => {
    const failing = await boot({
      detailResult: found,
      locate: async () => {
        throw new Error("storage down");
      }
    });
    const failedResponse = await failing.request("detail", { taskKey: "task-1" });
    expect(failedResponse.status).toBe(200);
    expect(((await failedResponse.json()) as { result: { location?: unknown } }).result.location).toBeUndefined();

    const missing = await boot({ detailResult: found, locate: async () => null });
    const missingResponse = await missing.request("detail", { taskKey: "task-1" });
    expect(missingResponse.status).toBe(200);
    expect(((await missingResponse.json()) as { result: { location?: unknown } }).result.location).toBeUndefined();
  });
});
