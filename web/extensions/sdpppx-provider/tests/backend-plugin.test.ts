import { describe, expect, it, vi } from "vitest";
import type { GenerationProvider, HostExtensionContext, StorageExposer } from "@woohaa3/contracts";
import { createSdpppxProviderPlugin } from "../src/backend.js";
import { createMemorySessionStore, type SdpppxSession } from "../src/backend/session.js";
import {
  SDPPPX_ERROR_CODES,
  SDPPPX_LOGIN_START_ROUTE,
  SDPPPX_LOGIN_STATUS_ROUTE,
  SDPPPX_LOGOUT_ROUTE,
  SDPPPX_MODELS_REFRESH_ROUTE,
  SDPPPX_SESSION_ROUTE
} from "../src/shared.js";
import { EMPTY_DEPLOYMENT, FULL_ENV, createFetch, jsonResponse, pngResponse, textResponse } from "./helpers.js";

const NOW = 1_800_000_000_000;

const SESSION: SdpppxSession = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: NOW + 3_600_000,
  userId: "user-1",
  displayName: "小伍",
  avatarUrl: null
};

type RegisteredRoute = {
  route: string;
  auth: string;
  handle(input: { body: unknown; context: unknown }): Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown };
};

function createContext() {
  const routes = new Map<string, RegisteredRoute>();
  const disposers: Array<() => void> = [];
  let provider: GenerationProvider | null = null;
  const exposers = new Map<string, StorageExposer>();
  const ctx = {
    log: { scope: () => () => undefined },
    generation: {
      register: (next: GenerationProvider) => {
        provider = next;
        return () => {
          provider = null;
        };
      }
    },
    storage: {
      bucket: () => ({
        head: async () => null,
        get: async () => {
          throw Object.assign(new Error("missing"), { code: "STORAGE_OBJECT_NOT_FOUND" });
        }
      })
    },
    exposer: {
      register: (next: StorageExposer) => {
        exposers.set(next.exposerId, next);
        return () => {
          exposers.delete(next.exposerId);
        };
      }
    },
    webServer: {
      register: (route: RegisteredRoute) => {
        routes.set(route.route, route);
      },
      registerHttp: () => undefined,
      registerRawHttp: () => undefined
    },
    services: {},
    effect: (callback: () => unknown) => {
      const dispose = callback();
      if (typeof dispose === "function") disposers.push(dispose as () => void);
    }
  } as unknown as HostExtensionContext;
  return {
    ctx,
    routes,
    disposers,
    exposers,
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer();
    },
    provider: () => provider
  };
}

async function invoke(route: RegisteredRoute, body: unknown = {}) {
  return route.handle({ body, context: {} });
}

describe("SDPPPX host plugin assembly", () => {
  it("内置部署身份为空时 health 给出 degraded，但仍可装载", async () => {
    const plugin = createSdpppxProviderPlugin({
      env: {},
      deployment: EMPTY_DEPLOYMENT,
      now: () => NOW
    });
    expect(plugin.health?.({})).toMatchObject({
      state: "degraded",
      diagnostics: [{ code: SDPPPX_ERROR_CODES.configIncomplete }]
    });

    const configured = createSdpppxProviderPlugin({ env: FULL_ENV, now: () => NOW });
    expect(configured.health?.({})).toBeUndefined();
  });

  it("登录前注册占位 Provider：available=false、空模型；6 条路由全部 authenticated", async () => {
    const { ctx, routes, provider } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore()
    });
    await plugin.apply(ctx, {});
    const registration = provider();
    expect(registration).toMatchObject({
      extensionId: "sdpppx-provider",
      providerId: "sdpppx",
      available: false,
      selectionAuthority: "server",
      models: []
    });
    expect(routes.size).toBe(6);
    expect([...routes.values()].every((route) => route.auth === "authenticated")).toBe(true);

    const session = await invoke(routes.get(SDPPPX_SESSION_ROUTE)!, {});
    expect(session.body).toMatchObject({ status: "anonymous", session: null });
  });

  it("扫码授权成功后立即把模型写回已注册的 Provider", async () => {
    const { fetchImpl } = createFetch(({ url }) => {
      if (url.includes("/api/v2/qrcode/gene")) {
        return jsonResponse({
          code: 0,
          data: { random: "random-1", url: "https://cdn.authing.cn/qr.png" }
        });
      }
      if (url === "https://cdn.authing.cn/qr.png") return pngResponse();
      if (url.includes("/api/v2/qrcode/check")) {
        return jsonResponse({
          code: 0,
          data: { status: 2, ticket: "ticket-1", userInfo: { nickname: "微信昵称" } }
        });
      }
      if (url.includes("/api/v2/qrcode/userinfo")) {
        return jsonResponse({ code: 0, data: { token: "authing-token", nickname: "微信昵称" } });
      }
      if (url.includes("/authing-bridge3")) {
        return jsonResponse({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          user: { id: "user-1", user_metadata: { display_name: "微信昵称" } }
        });
      }
      if (url.includes("/rest/v1/tasks_template")) {
        return jsonResponse([{ id: "tpl-1", is_active: true, name_zhcn: "图片模板" }]);
      }
      return textResponse("unexpected", { status: 500 });
    });
    const { ctx, routes, provider } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore(),
      fetchImpl
    });
    await plugin.apply(ctx, {});
    const registration = provider()!;
    expect(registration.available).toBe(false);

    const started = await invoke(routes.get(SDPPPX_LOGIN_START_ROUTE)!, {});
    expect(started.status).toBe(200);
    const loginId = (started.body as { loginId: string }).loginId;
    const authorized = await invoke(routes.get(SDPPPX_LOGIN_STATUS_ROUTE)!, { loginId });
    expect(authorized.body).toMatchObject({ phase: "authorized" });

    // 回归：登录授权后的刷新必须同步 available / catalogRevision，否则目录构建会过滤掉该 Provider。
    expect(registration.available).toBe(true);
    expect(registration.catalogRevision).toBe(1);
    expect(registration.models).toEqual([
      {
        providerId: "sdpppx",
        providerModelId: "tpl-1",
        modelType: "image",
        title: "图片模板",
        taskTimeoutMs: 600_000
      }
    ]);
  });

  it("启动恢复持久会话后原地刷新目录；登出清空模型与目录版本", async () => {
    const { fetchImpl, calls } = createFetch(({ url }) => {
      if (url.includes("/rest/v1/tasks_template")) {
        return jsonResponse([
          { id: "tpl-1", is_active: true, name_zhcn: "图片模板" },
          { id: "tpl-2", is_active: true, name_en: "Video template" }
        ]);
      }
      return textResponse("unexpected", { status: 500 });
    });
    const { ctx, routes, provider } = createContext();
    const store = createMemorySessionStore(SESSION);
    const plugin = createSdpppxProviderPlugin({
      env: { ...FULL_ENV, SDPPPX_TEMPLATE_MODEL_TYPES: '{"tpl-2":"video"}' },
      now: () => NOW,
      store,
      fetchImpl
    });
    await plugin.apply(ctx, {});
    const registration = provider()!;
    await vi.waitFor(() => expect(registration.available).toBe(true));
    expect(registration.models).toEqual([
      {
        providerId: "sdpppx",
        providerModelId: "tpl-1",
        modelType: "image",
        title: "图片模板",
        taskTimeoutMs: 600_000
      },
      {
        providerId: "sdpppx",
        providerModelId: "tpl-2",
        modelType: "video",
        title: "Video template",
        taskTimeoutMs: 600_000
      }
    ]);
    expect(registration.catalogRevision).toBe(1);

    const session = await invoke(routes.get(SDPPPX_SESSION_ROUTE)!, {});
    expect(session.body).toMatchObject({ status: "authenticated" });
    expect(JSON.stringify(session.body)).not.toContain("access-1");
    expect(JSON.stringify(session.body)).not.toContain("refresh-1");

    const refreshed = await invoke(routes.get(SDPPPX_MODELS_REFRESH_ROUTE)!, {});
    expect(refreshed.body).toMatchObject({ ok: true, available: true, modelCount: 2, catalogRevision: 2 });
    expect(calls.filter((call) => call.url.includes("tasks_template"))).toHaveLength(2);

    const loggedOut = await invoke(routes.get(SDPPPX_LOGOUT_ROUTE)!, {});
    expect(loggedOut.body).toMatchObject({ status: "anonymous", session: null });
    expect(registration.available).toBe(false);
    expect(registration.models).toEqual([]);
    expect(registration.catalogRevision).toBe(3);
    expect(await store.load()).toBeNull();
  });

  it("启动恢复已过期会话时先续期再刷新目录，不让 sdpppx 模型消失", async () => {
    const { fetchImpl } = createFetch(({ url }) => {
      if (url.includes("/auth/v1/token")) {
        return jsonResponse({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
          user: { id: "user-1", user_metadata: { display_name: "小伍" } }
        });
      }
      if (url.includes("/rest/v1/tasks_template")) {
        return jsonResponse([{ id: "tpl-1", is_active: true, name_zhcn: "图片模板" }]);
      }
      return textResponse("unexpected", { status: 500 });
    });
    const { ctx, provider } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore({ ...SESSION, expiresAt: NOW - 1 }),
      fetchImpl
    });
    await plugin.apply(ctx, {});
    const registration = provider()!;
    await vi.waitFor(() => expect(registration.available).toBe(true));
    expect(registration.catalogRevision).toBe(1);
    expect(registration.models.map((model) => model.providerModelId)).toEqual(["tpl-1"]);
  });

  it("目录刷新失败保留旧目录，只更新诊断", async () => {    let fail = false;
    const { fetchImpl } = createFetch(({ url }) => {
      if (url.includes("/rest/v1/tasks_template")) {
        return fail
          ? textResponse("down", { status: 503 })
          : jsonResponse([{ id: "tpl-1", is_active: true, name_zhcn: "图片模板" }]);
      }
      return textResponse("unexpected", { status: 500 });
    });
    const { ctx, routes, provider } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore(SESSION),
      fetchImpl
    });
    await plugin.apply(ctx, {});
    const registration = provider()!;
    await vi.waitFor(() => expect(registration.available).toBe(true));
    const before = registration.models.map((model) => model.providerModelId);

    fail = true;
    const refreshed = await invoke(routes.get(SDPPPX_MODELS_REFRESH_ROUTE)!, {});
    expect(refreshed.body).toMatchObject({
      ok: true,
      available: true,
      modelCount: 1,
      error: SDPPPX_ERROR_CODES.catalogUnavailable
    });
    expect(registration.models.map((model) => model.providerModelId)).toEqual(before);
    expect(registration.available).toBe(true);
  });

  it("注册 sdpppx-temporary：未登录时不可用、有说明，且模板目录为空不影响就绪判定", async () => {
    const { ctx, exposers } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore()
    });
    await plugin.apply(ctx, {});
    const exposer = exposers.get("sdpppx-temporary");
    expect(exposer).toMatchObject({
      label: "SDPPPX 临时图床",
      ownerExtensionId: "sdpppx-provider",
      requiresReplica: false
    });
    expect(exposer?.temporaryHosting).toMatchObject({
      category: "provider",
      priority: 10,
      validitySeconds: null,
      constraints: { mediaKinds: ["image", "video"], maxBytes: 20 * 1024 * 1024 }
    });
    expect(exposer?.temporaryHosting?.ready?.()).toBe(false);
    expect(exposer?.temporaryHosting?.statusNote?.()).toBe("未登录 SDPPPX");
    // 只读查询不上传、不弹登录、不触发目录刷新。
    expect(exposer?.temporaryHosting?.credentialEpoch?.()).toBe(0);
  });

  it("恢复已登录会话后图床就绪，即使模板目录为空；登出后回到未登录", async () => {
    const { fetchImpl } = createFetch(({ url }) => {
      if (url.includes("/rest/v1/tasks_template")) return jsonResponse([]);
      return textResponse("unexpected", { status: 500 });
    });
    const { ctx, routes, exposers } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore(SESSION),
      fetchImpl
    });
    await plugin.apply(ctx, {});
    const exposer = exposers.get("sdpppx-temporary")!;
    await vi.waitFor(() => expect(exposer.temporaryHosting?.ready?.()).toBe(true));
    expect(exposer.temporaryHosting?.statusNote?.()).toBeNull();

    await invoke(routes.get(SDPPPX_LOGOUT_ROUTE)!, {});
    expect(exposer.temporaryHosting?.ready?.()).toBe(false);
    expect(exposer.temporaryHosting?.statusNote?.()).toBe("未登录 SDPPPX");
  });

  it("扩展释放后注销临时图床来源并中断进行中的准备", async () => {
    const { ctx, exposers, dispose } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore(SESSION)
    });
    await plugin.apply(ctx, {});
    expect(exposers.has("sdpppx-temporary")).toBe(true);
    dispose();
    expect(exposers.has("sdpppx-temporary")).toBe(false);
  });

  it("既有模板上传协议未被改写：注册对象仍走 uploadReference", async () => {
    const { fetchImpl, calls } = createFetch(({ url }) => {
      if (url.includes("/rest/v1/tasks_template")) return jsonResponse([]);
      if (url.includes("/tasks/upload")) return jsonResponse({ url: "https://sdpppx.example.com/uploaded.png" });
      return textResponse("unexpected", { status: 500 });
    });
    const { ctx, provider } = createContext();
    const plugin = createSdpppxProviderPlugin({
      env: FULL_ENV,
      now: () => NOW,
      store: createMemorySessionStore(SESSION),
      fetchImpl
    });
    await plugin.apply(ctx, {});
    const registration = provider()!;
    const uploaded = await registration.uploadReference!({
      reference: { role: "reference_image", mediaType: "image/png" },
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      storageKey: "media/sha256-a.png"
    });
    expect(uploaded).toMatchObject({ url: "https://sdpppx.example.com/uploaded.png" });
    const uploadCalls = calls.filter(call => call.url.includes("/tasks/upload"));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.url).toContain("provider=grsai");
    expect((uploadCalls[0]!.init.headers as Record<string, string>)["X-Tenant-ID"]).toBeTruthy();
    // 没有调用新的 /media/upload。
    expect(calls.some(call => call.url.includes("/media/upload"))).toBe(false);
  });
});
