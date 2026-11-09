import { describe, expect, it } from "vitest";
import {
  BridgeError,
  exchangeAuthingToken,
  refreshSupabaseSession
} from "../src/backend/bridge.js";
import { SdpppxHttpError } from "../src/backend/http.js";
import {
  EMPTY_DEPLOYMENT,
  readTestConfig,
  FULL_ENV,
  bodyOf,
  createFetch,
  headersOf,
  jsonResponse,
  textResponse
} from "./helpers.js";

const NOW = 1_700_000_000_000;

describe("authing-bridge3", () => {
  it("发送 apikey/Bearer anonKey 与 {token, tenantId}，解析会话并保留昵称头像", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 1800,
        user: {
          id: "user-1",
          user_metadata: {
            display_name: "微信用户",
            avatar_url: "https://cdn.example.com/avatar.png"
          }
        }
      })
    );
    const session = await exchangeAuthingToken(readTestConfig(FULL_ENV), "authing-token", {
      fetchImpl,
      now: () => NOW
    });
    expect(session).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW + 1_800_000,
      userId: "user-1",
      displayName: "微信用户",
      avatarUrl: "https://cdn.example.com/avatar.png"
    });
    const call = calls[0]!;
    expect(call.url).toBe("https://project.supabase.co/functions/v1/authing-bridge3");
    expect(headersOf(call).apikey).toBe("anon-key");
    expect(headersOf(call).Authorization).toBe("Bearer anon-key");
    expect(bodyOf(call)).toEqual({ token: "authing-token", tenantId: "tenant-1" });
  });

  it("4xx 归为 rejected，5xx/网络归为 unavailable", async () => {
    const rejected = createFetch(() => textResponse("bad", { status: 400 }));
    await expect(
      exchangeAuthingToken(readTestConfig(FULL_ENV), "token", { fetchImpl: rejected.fetchImpl })
    ).rejects.toMatchObject({ kind: "rejected" });

    const unavailable = createFetch(() => textResponse("down", { status: 502 }));
    await expect(
      exchangeAuthingToken(readTestConfig(FULL_ENV), "token", { fetchImpl: unavailable.fetchImpl })
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("响应缺令牌时视为 rejected，不返回半成品会话", async () => {
    const { fetchImpl } = createFetch(() => jsonResponse({ user: { id: "user-1" } }));
    await expect(
      exchangeAuthingToken(readTestConfig(FULL_ENV), "token", { fetchImpl, now: () => NOW })
    ).rejects.toBeInstanceOf(BridgeError);
  });

  it("refresh token 续期走 grant_type=refresh_token，仅带 apikey", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({ access_token: "a2", refresh_token: "r2", expires_in: 3600 })
    );
    const session = await refreshSupabaseSession(readTestConfig(FULL_ENV), "r1", {
      fetchImpl,
      now: () => NOW
    });
    expect(session.accessToken).toBe("a2");
    const call = calls[0]!;
    expect(call.url).toBe("https://project.supabase.co/auth/v1/token?grant_type=refresh_token");
    expect(headersOf(call).apikey).toBe("anon-key");
    expect(headersOf(call).Authorization).toBeUndefined();
    expect(bodyOf(call)).toEqual({ refresh_token: "r1" });
  });

  it("缺 Supabase 配置时不发请求", async () => {
    const { fetchImpl, calls } = createFetch(() => jsonResponse({}));
    await expect(
      exchangeAuthingToken(
        readTestConfig({ SDPPPX_AUTHING_APP_ID: "app" }, EMPTY_DEPLOYMENT),
        "token",
        { fetchImpl }
      )
    ).rejects.toBeInstanceOf(SdpppxHttpError);
    expect(calls).toHaveLength(0);
  });
});
