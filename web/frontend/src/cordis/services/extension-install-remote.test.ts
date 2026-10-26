/**
 * 受管扩展安装 remote（change: 2026-10-21-add-extension-marketplace-point，7.2）。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { createExtensionInstallRemote } from "./extension-install-remote.js";

function recorder(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createExtensionInstallRemote", () => {
  it("从文件安装以原始字节流 POST，带文件名头；202 返回 jobId", async () => {
    const { calls, fetchImpl } = recorder(() => json(202, { jobId: "j1" }));
    const remote = createExtensionInstallRemote({ fetchImpl });
    const file = Object.assign(new Blob(["wxt"]), { name: "demo 1.wxt" });
    await expect(remote.installFile(file)).resolves.toEqual({ ok: true, jobId: "j1" });
    expect(calls[0]!.url).toBe("/api/extensions/install");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
    expect((calls[0]!.init.headers as Record<string, string>)["x-extension-filename"]).toBe("demo%201.wxt");
    expect(calls[0]!.init.body).toBe(file);
  });

  it("202/422 回带任务视图时一并返回；422 同步失败仍按任务处理", async () => {
    const job = { jobId: "j2", action: "install", sourceId: "local-file", status: "failed", phase: "queued", startedAt: "t", failure: { code: "MARKETPLACE_UNAVAILABLE", message: "x" } };
    const remote = createExtensionInstallRemote({ fetchImpl: recorder(() => json(422, { jobId: "j2", job })).fetchImpl });
    await expect(remote.installFile(new Blob(["x"]))).resolves.toEqual({ ok: true, jobId: "j2", job });
  });

  it("失败带稳定码；网络失败为 unavailable", async () => {
    const remote = createExtensionInstallRemote({ fetchImpl: recorder(() => json(400, { code: "MARKETPLACE_ARCHIVE_UNSAFE", message: "x" })).fetchImpl });
    await expect(remote.installFile(new Blob(["x"]))).resolves.toMatchObject({ ok: false, code: "MARKETPLACE_ARCHIVE_UNSAFE" });
    const down = createExtensionInstallRemote({ fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await expect(down.rollback("demo")).resolves.toMatchObject({ ok: false, code: "unavailable" });
  });

  it("受控重启复用 P0 的 /api/host/restart；不支持映射为 MARKETPLACE_RESTART_UNSUPPORTED", async () => {
    const ok = recorder(() => json(202, { status: "restarting" }));
    await expect(createExtensionInstallRemote({ fetchImpl: ok.fetchImpl }).restart()).resolves.toEqual({ ok: true });
    expect(ok.calls[0]!.url).toBe("/api/host/restart");
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({ reason: "extension-installed" });
    const unsupported = recorder(() => json(503, { code: "restart-unsupported", message: "当前宿主进程不支持受控重启" }));
    await expect(createExtensionInstallRemote({ fetchImpl: unsupported.fetchImpl }).restart()).resolves.toMatchObject({
      ok: false,
      code: "MARKETPLACE_RESTART_UNSUPPORTED"
    });
  });

  it("解除隔离：POST /api/extensions/:id/unquarantine；拒绝时带稳定码", async () => {
    const ok = recorder(() => json(202, { ok: true }));
    await expect(createExtensionInstallRemote({ fetchImpl: ok.fetchImpl }).unquarantine("my ext")).resolves.toEqual({ ok: true });
    expect(ok.calls[0]!.url).toBe("/api/extensions/my%20ext/unquarantine");
    expect(ok.calls[0]!.init.method).toBe("POST");
    const denied = recorder(() => json(403, {}));
    await expect(createExtensionInstallRemote({ fetchImpl: denied.fetchImpl }).unquarantine("demo")).resolves.toMatchObject({ ok: false, code: "forbidden" });
    const down = createExtensionInstallRemote({ fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await expect(down.unquarantine("demo")).resolves.toMatchObject({ ok: false, code: "unavailable" });
  });
});
