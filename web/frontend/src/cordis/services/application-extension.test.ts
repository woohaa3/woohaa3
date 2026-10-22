/**
 * 站点插件 remote 与状态 Service 测试
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 4.1 / design D5）。
 *
 * 验证：旧响应不会覆盖新 revision、断线补偿（增量失败重取 snapshot）、
 * dispose 无残留订阅，以及浏览器不携带服务令牌。
 */
import { describe, expect, it, vi } from "vitest";
import type { ApplicationExtensionStatus } from "@woohaa3/contracts";
import { createApplicationRemote } from "./application-remote.js";
import { createApplicationExtensionStatusService } from "./application-extension-status.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function status(extensionId: string, revision: number, desiredEnabled: boolean): ApplicationExtensionStatus {
  return {
    extensionId,
    desiredEnabled,
    actualState: desiredEnabled ? "active" : "disabled",
    configVersion: 1,
    extensionRevision: revision,
    activeWorkCount: 0,
    diagnostics: []
  };
}

describe("applicationExtensionRemote（任务 4.1）", () => {
  it("fetchSnapshot 走 /api/extensions 且不携带任何认证头", async () => {
    const calls: Array<{ url: string; headers: unknown }> = [];
    const remote = createApplicationRemote({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), headers: init?.headers });
        return jsonResponse({ revision: 3, plugins: [] });
      }) as unknown as typeof fetch
    });
    const result = await remote.fetchSnapshot();
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("/api/extensions");
    expect(calls[0].headers).toBeUndefined();
  });

  it("writeConfig 返回修订与状态；冲突携带 currentRevision", async () => {
    let currentRevision = 0;
    const remote = createApplicationRemote({
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { expectedRevision: number };
        if (body.expectedRevision === currentRevision) {
          currentRevision += 1;
          return jsonResponse({ revision: currentRevision, status: status("p", currentRevision, true) });
        }
        return jsonResponse({ code: "revision-conflict", message: "冲突", currentRevision }, 409);
      }) as unknown as typeof fetch
    });
    const ok = await remote.writeConfig({ extensionId: "p", expectedRevision: 0, enabled: true, values: {}, secretRefs: [] });
    expect(ok.ok).toBe(true);
    // 仍用过期 revision 0：冲突。
    const conflict = await remote.writeConfig({ extensionId: "p", expectedRevision: 0, enabled: false, values: {}, secretRefs: [] });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("revision-conflict");
      expect(conflict.currentRevision).toBe(1);
    }
  });

  it("401 映射为 unauthorized；非 JSON 响应映射为 malformed", async () => {
    const unauthorized = createApplicationRemote({
      fetchImpl: (async () => jsonResponse({ code: "unauthorized", message: "需要管理员" }, 401)) as unknown as typeof fetch
    });
    expect(await unauthorized.fetchSnapshot()).toMatchObject({ ok: false, code: "unauthorized" });
    const malformed = createApplicationRemote({
      fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch
    });
    expect(await malformed.fetchSnapshot()).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("applicationExtensionStatusService（任务 4.1）", () => {
  it("旧响应不会覆盖新 revision", async () => {
    let resolveSnapshot: ((value: Response) => void) | undefined;
    const remote = createApplicationRemote({
      fetchImpl: (async () =>
        new Promise<Response>((resolve) => {
          resolveSnapshot = resolve;
        })) as unknown as typeof fetch
    });
    const service = createApplicationExtensionStatusService({ remote, subscribeToChanges: false });
    // 先手动发布一个新状态（revision 5）。
    const first = service.refresh();
    resolveSnapshot?.(jsonResponse({ revision: 5, plugins: [status("p", 5, true)] }));
    await first;
    expect(service.getSnapshot().revision).toBe(5);

    // 迟到的旧响应（revision 2）不得覆盖。
    const second = service.refresh();
    resolveSnapshot?.(jsonResponse({ revision: 2, plugins: [status("p", 2, false)] }));
    await second;
    expect(service.getSnapshot().revision).toBe(5);
    expect(service.getSnapshot().plugins[0]?.desiredEnabled).toBe(true);
    service.dispose();
  });

  it("增量失败时重取权威 snapshot（断线补偿）", async () => {
    let snapshotRevision = 1;
    const calls: string[] = [];
    const remote = createApplicationRemote({
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/changes")) return jsonResponse({ code: "unavailable" }, 503);
        snapshotRevision += 1;
        return jsonResponse({ revision: snapshotRevision, plugins: [status("p", snapshotRevision, true)] });
      }) as unknown as typeof fetch
    });
    const service = createApplicationExtensionStatusService({ remote, subscribeToChanges: false });
    await service.refresh();
    expect(service.getSnapshot().revision).toBe(2);
    await service.refreshChanges();
    // 增量失败 → 重取 snapshot（revision 再推进）。
    expect(calls.some((url) => url.includes("/changes"))).toBe(true);
    expect(service.getSnapshot().revision).toBe(3);
    expect(service.getSnapshot().error).toBeNull();
    service.dispose();  });

  it("resyncRequired 时重取 snapshot；dispose 后无残留订阅", async () => {
    let revision = 1;
    const remote = createApplicationRemote({
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/changes")) return jsonResponse({ revision, changes: [], resyncRequired: true });
        revision += 1;
        return jsonResponse({ revision, plugins: [] });
      }) as unknown as typeof fetch
    });
    const service = createApplicationExtensionStatusService({ remote, subscribeToChanges: false });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    await service.refresh();
    const before = listener.mock.calls.length;
    await service.refreshChanges();
    expect(service.getSnapshot().revision).toBe(3);
    expect(listener.mock.calls.length).toBeGreaterThan(before);
    service.dispose();
    unsubscribe();
    // dispose 后再刷新不通知、不写入。
    await service.refreshChanges();
    expect(listener).toHaveBeenCalledTimes(before + 1);
  });
});
