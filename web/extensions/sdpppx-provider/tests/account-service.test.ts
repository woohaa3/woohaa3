import { describe, expect, it, vi } from "vitest";
import {
  createSdpppxAccountService,
  decodeSdpppxLoginStatus,
  decodeSdpppxSnapshot
} from "../src/frontend/account-service.js";
import {
  SDPPPX_ERROR_CODES,
  SDPPPX_LOGIN_START_ROUTE,
  SDPPPX_LOGIN_STATUS_ROUTE,
  SDPPPX_LOGOUT_ROUTE,
  SDPPPX_MODELS_REFRESH_ROUTE,
  SDPPPX_SESSION_ROUTE
} from "../src/shared.js";

const CONFIG = {
  baseUrl: "https://sdpppx.zombee.tech/ppserver",
  tenantId: "tenant-1",
  supabaseHost: "project.supabase.co",
  authingAppIdConfigured: true,
  authingHost: "https://core.authing.cn",
  authingScene: "WXAPP_AUTH",
  bridgeHost: "project.supabase.co",
  templateModelTypes: { "tpl-2": "video" as const },
  promptField: "prompt",
  uploadProvider: "grsai",
  taskTimeoutMs: 600000
};

function snapshotPayload(extra: Record<string, unknown> = {}) {
  return {
    status: "authenticated",
    degradedCode: null,
    missing: [],
      config: CONFIG,
    session: {
      displayName: "小伍",
      avatarUrl: "https://cdn.example.com/a.png",
      expiresAt: 1_800_000_000_000,
      balance: { totalBalance: 12, paid: 10, dailyBonus: 2 }
    },
    notice: null,
    ...extra
  };
}

function transportOf(responses: Record<string, unknown>) {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  const request = vi.fn(async (input: { path: string; method?: string; body?: unknown }) => {
    calls.push(input);
    const suffix = Object.keys(responses).find((key) => input.path.endsWith(key));
    if (suffix === undefined) return { ok: false as const, code: "not-found" as const, error: "missing" };
    const value = responses[suffix];
    if (value instanceof Error) throw value;
    if (typeof value === "object" && value !== null && "transportError" in value) {
      return {
        ok: false as const,
        code: "invalid" as const,
        error: "bad request",
        status: 400,
        body: (value as { transportError: unknown }).transportError
      };
    }
    return { ok: true as const, status: 200, data: value };
  });
  return { request, calls };
}

function serviceOf(responses: Record<string, unknown>) {
  const transport = transportOf(responses);
  return { service: createSdpppxAccountService(transport), ...transport };
}

describe("snapshot decoders", () => {
  it("只保留会话视图字段，令牌字段一律丢弃", () => {
    const decoded = decodeSdpppxSnapshot(
      snapshotPayload({
        access_token: "should-drop",
        session: {
          displayName: "小伍",
          avatarUrl: null,
          expiresAt: 1_800_000_000_000,
          balance: null,
          accessToken: "also-drop",
          refresh_token: "drop"
        }
      })
    );
    expect(decoded?.status).toBe("authenticated");
    expect(decoded?.session).toEqual({
      displayName: "小伍",
      avatarUrl: null,
      expiresAt: 1_800_000_000_000,
      balance: null
    });
    const text = JSON.stringify(decoded);
    expect(text).not.toContain("should-drop");
    expect(text).not.toContain("also-drop");
    expect(text).not.toContain("drop");
  });

  it("形状不符时返回 null，不伪造登录态", () => {
    expect(decodeSdpppxSnapshot(null)).toBeNull();
    expect(decodeSdpppxSnapshot({ status: "nope", config: CONFIG })).toBeNull();
    expect(decodeSdpppxSnapshot({ status: "anonymous" })).toBeNull();
    expect(decodeSdpppxLoginStatus({ phase: "unknown" })).toBeNull();
    expect(decodeSdpppxLoginStatus({ phase: "authorized", session: { displayName: null } })).toMatchObject({
      phase: "authorized"
    });
  });
});

describe("account service", () => {
  it("refresh 读 /session 并通知订阅者", async () => {
    const { service, calls } = serviceOf({ [SDPPPX_SESSION_ROUTE]: snapshotPayload() });
    const listener = vi.fn();
    service.subscribe(listener);
    const next = await service.refresh();
    expect(next?.status).toBe("authenticated");
    expect(calls[0]?.path).toBe("/api/extensions/sdpppx-provider/handlers/session");
    expect(calls[0]?.method).toBe("GET");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().session?.displayName).toBe("小伍");
  });

  it("refresh 失败返回 null，不把宿主故障误判成未登录", async () => {
    const { service } = serviceOf({});
    expect(await service.refresh()).toBeNull();
    expect(service.getSnapshot().status).toBe("anonymous");
  });

  it("startLogin 拆成功响应；失败时保留宿主稳定码", async () => {
    const ok = serviceOf({
      [SDPPPX_LOGIN_START_ROUTE]: {
        ok: true,
        loginId: "login-1",
        qrDataUrl: "data:image/png;base64,AAAA",
        phase: "pending",
        expiresAt: 1_000_000
      }
    });
    await expect(ok.service.startLogin()).resolves.toMatchObject({ ok: true, loginId: "login-1" });
    expect(ok.calls[0]?.method).toBe("POST");

    const denied = serviceOf({
      [SDPPPX_LOGIN_START_ROUTE]: {
        transportError: { ok: false, code: SDPPPX_ERROR_CODES.configIncomplete, message: "缺少参数", missing: ["A"] }
      }
    });
    await expect(denied.service.startLogin()).resolves.toEqual({
      ok: false,
      code: SDPPPX_ERROR_CODES.configIncomplete,
      message: "缺少参数"
    });
  });

  it("pollLogin 终态 authorized 时立刻更新本地快照", async () => {
    const { service } = serviceOf({
      [SDPPPX_LOGIN_STATUS_ROUTE]: {
        phase: "authorized",
        nickname: "小伍",
        session: snapshotPayload().session
      }
    });
    const status = await service.pollLogin("login-1");
    expect(status.phase).toBe("authorized");
    expect(service.getSnapshot().status).toBe("authenticated");
    expect(service.getSnapshot().session?.expiresAt).toBe(1_800_000_000_000);
  });

  it("logout 强制投影为匿名，refreshModels 透传结果", async () => {
    const { service } = serviceOf({
      [SDPPPX_LOGOUT_ROUTE]: snapshotPayload({ status: "anonymous", session: null }),
      [SDPPPX_MODELS_REFRESH_ROUTE]: { ok: true, available: true, modelCount: 2, catalogRevision: 4, error: null }
    });
    const logout = await service.logout();
    expect(logout.ok).toBe(true);
    expect(service.getSnapshot().status).toBe("anonymous");
    expect(service.getSnapshot().session).toBeNull();

    const refreshed = await service.refreshModels();
    expect(refreshed).toEqual({
      ok: true,
      available: true,
      modelCount: 2,
      catalogRevision: 4,
      error: null
    });
  });

  it("refreshModels 失败时给出稳定码", async () => {
    const { service } = serviceOf({
      [SDPPPX_MODELS_REFRESH_ROUTE]: {
        transportError: { ok: false, code: SDPPPX_ERROR_CODES.sessionExpired, message: "登录已过期" }
      }
    });
    await expect(service.refreshModels()).resolves.toEqual({
      ok: false,
      code: SDPPPX_ERROR_CODES.sessionExpired,
      message: "登录已过期"
    });
  });

  it("取消登录与订阅释放都是幂等的", async () => {
    const { service } = serviceOf({});
    await expect(service.cancelLogin("login-1")).resolves.toBeUndefined();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    unsubscribe();
    unsubscribe();
    service.dispose();
    expect(listener).not.toHaveBeenCalled();
  });
});
