import { describe, expect, it, vi } from "vitest";
import { registerSdpppxRoutes, type SdpppxRouteRegistration } from "../src/backend/routes.js";
import type { SdpppxLoginFlow } from "../src/backend/login-flow.js";
import {
  EMPTY_SDPPPX_SNAPSHOT,
  SDPPPX_ERROR_CODES,
  SDPPPX_LOGIN_CANCEL_ROUTE,
  SDPPPX_LOGIN_START_ROUTE,
  SDPPPX_LOGIN_STATUS_ROUTE,
  SDPPPX_LOGOUT_ROUTE,
  SDPPPX_MODELS_REFRESH_ROUTE,
  SDPPPX_SESSION_ROUTE,
  type SdpppxModelRefreshResult,
  type SdpppxResult,
  type SdpppxSessionSnapshot
} from "../src/shared.js";
import { EMPTY_DEPLOYMENT, readTestConfig, FULL_ENV, TEST_DEPLOYMENT } from "./helpers.js";
import type { SdpppxDeployment } from "../src/backend/deployment-config.js";

function snapshot(): SdpppxSessionSnapshot {
  return {
    ...EMPTY_SDPPPX_SNAPSHOT,
    status: "authenticated",
    session: {
      displayName: "小伍",
      avatarUrl: "https://cdn.example.com/a.png",
      expiresAt: 1_800_000_000_000,
      balance: { totalBalance: 12 }
    }
  };
}

function setup(
  configEnv: Record<string, string> = FULL_ENV,
  deployment: SdpppxDeployment = TEST_DEPLOYMENT
) {
  const registered: SdpppxRouteRegistration[] = [];
  const flow = {
    start: vi.fn(async () => ({
      ok: true as const,
      loginId: "login-1",
      qrDataUrl: "data:image/png;base64,AAAA",
      phase: "pending" as const,
      expiresAt: 1_000_000
    })),
    status: vi.fn(async () => ({ phase: "scanned" as const })),
    cancel: vi.fn()
  };
  const logout = vi.fn(async () => snapshot());
  const refreshModels = vi.fn(async (): Promise<SdpppxResult<SdpppxModelRefreshResult>> => ({
    ok: true,
    available: true,
    modelCount: 2,
    catalogRevision: 3,
    error: null
  }));
  registerSdpppxRoutes({
    config: () => readTestConfig(configEnv, deployment),
    flow: flow as unknown as SdpppxLoginFlow,
    snapshot: async () => snapshot(),
    logout,
    refreshModels,
    register: (registration) => registered.push(registration)
  });
  const route = (name: string) => registered.find((entry) => entry.route === name)!;
  return { registered, route, flow, logout, refreshModels };
}

async function invoke(registration: SdpppxRouteRegistration, body?: unknown) {
  return registration.handle({ body, context: {} as never });
}

describe("sdpppx routes", () => {
  it("注册 6 条 authenticated handler", () => {
    const { registered } = setup();
    expect(registered.map((entry) => entry.route)).toEqual([
      SDPPPX_SESSION_ROUTE,
      SDPPPX_LOGIN_START_ROUTE,
      SDPPPX_LOGIN_STATUS_ROUTE,
      SDPPPX_LOGIN_CANCEL_ROUTE,
      SDPPPX_LOGOUT_ROUTE,
      SDPPPX_MODELS_REFRESH_ROUTE
    ]);
    expect(registered.every((entry) => entry.auth === "authenticated")).toBe(true);
  });

  it("/session 只返回无令牌快照", async () => {
    const { route } = setup();
    const result = await invoke(route(SDPPPX_SESSION_ROUTE));
    expect(result.status).toBe(200);
    const text = JSON.stringify(result.body);
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("refresh_token");
    expect(text).not.toContain("authing-token");
    expect((result.body as SdpppxSessionSnapshot).session?.displayName).toBe("小伍");
  });

  it("缺少部署参数时 start 返回 400 与缺失项", async () => {
    const { route, flow } = setup({}, EMPTY_DEPLOYMENT);
    const result = await invoke(route(SDPPPX_LOGIN_START_ROUTE), {});
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.configIncomplete });
    expect((result.body as { missing: string[] }).missing.length).toBe(3);
    expect(flow.start).not.toHaveBeenCalled();
  });

  it("start / status / cancel 的 body 校验与幂等", async () => {
    const { route, flow } = setup();
    expect((await invoke(route(SDPPPX_LOGIN_START_ROUTE), {})).status).toBe(200);
    expect(flow.start).toHaveBeenCalledTimes(1);

    expect((await invoke(route(SDPPPX_LOGIN_STATUS_ROUTE), {})).status).toBe(400);
    const status = await invoke(route(SDPPPX_LOGIN_STATUS_ROUTE), { loginId: " login-1 " });
    expect(status.body).toEqual({ phase: "scanned" });
    expect(flow.status).toHaveBeenCalledWith("login-1");

    expect(await invoke(route(SDPPPX_LOGIN_CANCEL_ROUTE), {})).toEqual({ status: 200, body: { ok: true } });
    expect(await invoke(route(SDPPPX_LOGIN_CANCEL_ROUTE), { loginId: "login-1" })).toEqual({
      status: 200,
      body: { ok: true }
    });
    expect(flow.cancel).toHaveBeenCalledWith("login-1");
  });

  it("logout 走统一清理，models/refresh 透传结果", async () => {
    const { route, logout, refreshModels } = setup();
    expect((await invoke(route(SDPPPX_LOGOUT_ROUTE), {})).status).toBe(200);
    expect(logout).toHaveBeenCalledTimes(1);

    const refreshed = await invoke(route(SDPPPX_MODELS_REFRESH_ROUTE), {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ ok: true, modelCount: 2, catalogRevision: 3 });
    expect(refreshModels).toHaveBeenCalledTimes(1);
  });

  it("刷新失败时按稳定码返回非 200", async () => {
    const { route, refreshModels } = setup();
    refreshModels.mockResolvedValueOnce({
      ok: false,
      code: SDPPPX_ERROR_CODES.sessionExpired,
      message: "登录已过期"
    });
    const result = await invoke(route(SDPPPX_MODELS_REFRESH_ROUTE), {});
    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain("refresh_token");
  });
});
