import { describe, expect, it, vi } from "vitest";
import type { ExtensionDocumentBatchResult, ExtensionDocumentStore } from "@woohaa3/contracts";
import {
  createDocumentSessionStore,
  createMemorySessionStore,
  createSessionManager,
  sessionView,
  type SessionStore,
  type SdpppxSession
} from "../src/backend/session.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { readTestConfig, FULL_ENV, createFetch, jsonResponse, textResponse } from "./helpers.js";

const NOW = 1_000_000;

function activeSession(overrides: Partial<SdpppxSession> = {}): SdpppxSession {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: NOW + 60_000,
    userId: "user-1",
    displayName: "小伍",
    avatarUrl: "https://cdn.example.com/a.png",
    ...overrides
  };
}

function managerOf(store: SessionStore, fetchImpl?: typeof globalThis.fetch) {
  return createSessionManager({
    config: () => readTestConfig(FULL_ENV),
    store,
    now: () => NOW,
    ...(fetchImpl ? { fetchImpl } : {})
  });
}

describe("document session store", () => {
  it("读取形状不符的文档当作没有会话", async () => {
    const store = {
      owner: () => "sdpppx-provider",
      get: vi.fn(async () => ({ found: true as const, document: { key: "session/current", value: { accessToken: 1 }, revision: 1, updatedAt: "" } })),
      batch: vi.fn(),
      scan: vi.fn(),
      schemaVersion: vi.fn(),
      setSchemaVersion: vi.fn()
    } as unknown as ExtensionDocumentStore;
    await expect(createDocumentSessionStore(store).load()).resolves.toBeNull();
  });

  it("写会话使用 set，清会话使用 delete；写失败必须抛出", async () => {
    const batch = vi.fn(async (): Promise<ExtensionDocumentBatchResult> => ({
      ok: true,
      revisions: { "session/current": 2 }
    }));
    const store = {
      owner: () => "sdpppx-provider",
      get: vi.fn(),
      batch,
      scan: vi.fn(),
      schemaVersion: vi.fn(),
      setSchemaVersion: vi.fn()
    } as unknown as ExtensionDocumentStore;
    const sessionStore = createDocumentSessionStore(store);

    await sessionStore.save(activeSession());
    expect(batch).toHaveBeenLastCalledWith([
      {
        op: "set",
        key: "session/current",
        value: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresAt: NOW + 60_000,
          userId: "user-1",
          displayName: "小伍",
          avatarUrl: "https://cdn.example.com/a.png"
        }
      }
    ]);

    await sessionStore.save(null);
    expect(batch).toHaveBeenLastCalledWith([{ op: "delete", key: "session/current" }]);

    batch.mockResolvedValueOnce({
      ok: false,
      code: "revision-conflict",
      key: "session/current",
      currentRevision: 3
    });
    await expect(sessionStore.save(activeSession())).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.serviceUnavailable
    });
  });
});

describe("session manager", () => {
  it("持久化后可从 store 恢复，视图不包含令牌", async () => {
    const store = createMemorySessionStore();
    const manager = managerOf(store);
    await manager.set(activeSession());
    expect(await store.load()).toMatchObject({ accessToken: "access-1" });

    const restored = managerOf(store);
    await restored.load();
    expect(restored.session()?.displayName).toBe("小伍");
    const view = sessionView(restored.session()!, null);
    expect(JSON.stringify(view)).not.toContain("access-1");
    expect(JSON.stringify(view)).not.toContain("refresh-1");
    expect(view.expiresAt).toBe(NOW + 60_000);
  });

  it("临近到期时刷新，并发调用只发一次网络请求", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        user: { id: "user-1" }
      })
    );
    const manager = managerOf(createMemorySessionStore(activeSession({ expiresAt: NOW + 10_000 })), fetchImpl);
    const [first, second] = await Promise.all([manager.accessToken(), manager.accessToken()]);
    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://project.supabase.co/auth/v1/token?grant_type=refresh_token");
    expect((calls[0]!.init.headers as Record<string, string>).apikey).toBe("anon-key");
  });

  it("刷新被 4xx 明确拒绝时清会话", async () => {
    const store = createMemorySessionStore(activeSession({ expiresAt: NOW + 10_000 }));
    const { fetchImpl } = createFetch(() => textResponse("invalid_grant", { status: 400 }));
    const manager = managerOf(store, fetchImpl);
    await expect(manager.accessToken()).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(manager.session()).toBeNull();
    expect(await store.load()).toBeNull();
  });

  it("刷新遇到 5xx 时保留会话到期，但本次请求按 503 失败", async () => {
    const original = activeSession({ expiresAt: NOW + 10_000 });
    const store = createMemorySessionStore(original);
    const { fetchImpl } = createFetch(() => textResponse("upstream down", { status: 503 }));
    const manager = managerOf(store, fetchImpl);
    await expect(manager.accessToken()).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.serviceUnavailable });
    expect(manager.rawSession()).toMatchObject({ accessToken: "access-1" });
    expect(await store.load()).toMatchObject({ accessToken: "access-1" });
  });

  it("登出期间到达的续期结果被 epoch 丢弃", async () => {
    const store = createMemorySessionStore(activeSession({ expiresAt: NOW + 10_000 }));
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof globalThis.fetch;
    const manager = managerOf(store, fetchImpl);

    const pending = manager.accessToken();
    await Promise.resolve();
    await manager.clear(SDPPPX_ERROR_CODES.sessionExpired);
    resolveFetch?.(jsonResponse({ access_token: "late", refresh_token: "late", expires_in: 3600 }));
    await expect(pending).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(manager.rawSession()).toBeNull();
    expect(await store.load()).toBeNull();
  });

  it("登出后迟到写入的会话不会复活（set 前已清空）", async () => {
    const store = createMemorySessionStore(activeSession());
    const manager = managerOf(store);
    await manager.load();
    await manager.clear(null);
    expect(manager.session()).toBeNull();
    expect(manager.epoch()).toBe(1);
  });
});
