import { describe, expect, it, vi } from "vitest";
import {
  createSdpppxLoginFlow,
  SDPPPX_LOGIN_MAX_PENDING,
  SDPPPX_LOGIN_TTL_MS
} from "../src/backend/login-flow.js";
import { createMemorySessionStore, createSessionManager } from "../src/backend/session.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { readTestConfig, FULL_ENV, createFetch, jsonResponse, pngResponse, textResponse } from "./helpers.js";

function setup(options: { now?: () => number; bridgeStatus?: number; checkStatus?: () => number; checkFailureStatus?: number } = {}) {
  let status = options.checkStatus ?? (() => 0);
  const calls: string[] = [];
  const { fetchImpl } = createFetch(({ url }) => {
    calls.push(url);
    if (url.includes("/api/v2/qrcode/gene")) {
      return jsonResponse({ code: 0, data: { random: `random-${calls.length}`, url: "https://cdn.authing.cn/qr.png" } });
    }
    if (url === "https://cdn.authing.cn/qr.png") return pngResponse();
    if (url.includes("/api/v2/qrcode/check")) {
      if (options.checkFailureStatus) return textResponse("upstream", { status: options.checkFailureStatus });
      return jsonResponse({
        code: 0,
        data: {
          status: status(),
          ...(status() === 2 ? { ticket: "ticket-1", userInfo: { nickname: "微信昵称" } } : {})
        }
      });
    }
    if (url.includes("/api/v2/qrcode/userinfo")) {
      return jsonResponse({ code: 0, data: { token: "authing-token", nickname: "微信昵称" } });
    }
    if (url.includes("/authing-bridge3")) {
      if (options.bridgeStatus && options.bridgeStatus >= 400) {
        return textResponse("bridge failed", { status: options.bridgeStatus });
      }
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        user: { id: "user-1", user_metadata: { display_name: "微信昵称" } }
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const now = options.now ?? (() => 1_000_000);
  const config = readTestConfig(FULL_ENV);
  const session = createSessionManager({
    config: () => config,
    store: createMemorySessionStore(),
    fetchImpl,
    now
  });
  const onAuthorized = vi.fn();
  const flow = createSdpppxLoginFlow({
    config: () => config,
    session,
    fetchImpl,
    now,
    loadBalance: async () => null,
    onAuthorized
  });
  return {
    flow,
    session,
    calls,
    onAuthorized,
    setCheckStatus(next: () => number) {
      status = next;
    }
  };
}

describe("微信扫码登录状态机", () => {
  it("start 返回 data URL 二维码并登记 pending", async () => {
    const { flow } = setup();
    const result = await flow.start();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.expiresAt).toBe(1_000_000 + SDPPPX_LOGIN_TTL_MS);
    expect(flow.pendingCount()).toBe(1);
  });

  it("pending → scanned → authorized，且授权交换至多一次", async () => {
    const { flow, session, calls, onAuthorized, setCheckStatus } = setup();
    const started = await flow.start();
    if (!started.ok) throw new Error("start failed");

    setCheckStatus(() => 0);
    expect(await flow.status(started.loginId)).toEqual({ phase: "pending" });

    setCheckStatus(() => 1);
    expect(await flow.status(started.loginId)).toMatchObject({ phase: "scanned" });

    setCheckStatus(() => 2);
    const authorized = await flow.status(started.loginId);
    expect(authorized.phase).toBe("authorized");
    expect(authorized.session?.displayName).toBe("微信昵称");
    expect(session.session()?.accessToken).toBe("access-1");
    expect(onAuthorized).toHaveBeenCalledTimes(1);

    const userinfoCalls = calls.filter((url) => url.includes("/userinfo")).length;
    const bridgeCalls = calls.filter((url) => url.includes("/authing-bridge3")).length;
    expect(userinfoCalls).toBe(1);
    expect(bridgeCalls).toBe(1);

    // 已完成后再轮询：返回既有终态，不再换令牌。
    expect(await flow.status(started.loginId)).toMatchObject({ phase: "authorized" });
    expect(calls.filter((url) => url.includes("/userinfo"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("/authing-bridge3"))).toHaveLength(1);
  });

  it("取消与过期都是终态，重复查询返回同一结果", async () => {
    const cancelled = setup({ checkStatus: () => 3 });
    const first = await cancelled.flow.start();
    if (!first.ok) throw new Error("start failed");
    expect(await cancelled.flow.status(first.loginId)).toEqual({ phase: "cancelled" });
    expect(await cancelled.flow.status(first.loginId)).toEqual({ phase: "cancelled" });

    const expired = setup({ checkStatus: () => -1 });
    const second = await expired.flow.start();
    if (!second.ok) throw new Error("start failed");
    expect(await expired.flow.status(second.loginId)).toEqual({ phase: "expired" });
    expect(await expired.flow.status(second.loginId)).toEqual({ phase: "expired" });
  });

  it("cancel 幂等，未知 loginId 也成功", async () => {
    const { flow } = setup();
    const started = await flow.start();
    if (!started.ok) throw new Error("start failed");
    flow.cancel(started.loginId);
    flow.cancel(started.loginId);
    flow.cancel("unknown");
    expect(flow.pendingCount()).toBe(0);
    expect(await flow.status(started.loginId)).toEqual({ phase: "cancelled" });
  });

  it("pending 最多 3 条，超出时淘汰最旧", async () => {
    const { flow } = setup();
    const ids: string[] = [];
    for (let index = 0; index < SDPPPX_LOGIN_MAX_PENDING + 1; index += 1) {
      const started = await flow.start();
      if (!started.ok) throw new Error("start failed");
      ids.push(started.loginId);
    }
    expect(flow.pendingCount()).toBe(SDPPPX_LOGIN_MAX_PENDING);
    // 最旧的已被淘汰；查询返回 expired（不再发起 check）。
    expect(await flow.status(ids[0]!)).toEqual({ phase: "expired" });
  });

  it("TTL 到期后查询得到 expired 并从 pending 移除", async () => {
    let now = 1_000_000;
    const { flow } = setup({ now: () => now });
    const started = await flow.start();
    if (!started.ok) throw new Error("start failed");
    now += SDPPPX_LOGIN_TTL_MS + 1;
    expect(await flow.status(started.loginId)).toEqual({ phase: "expired" });
    expect(flow.pendingCount()).toBe(0);
  });

  it("bridge 失败时进入 error，不写会话", async () => {
    const { flow, session } = setup({ checkStatus: () => 2, bridgeStatus: 502 });
    const started = await flow.start();
    if (!started.ok) throw new Error("start failed");
    const result = await flow.status(started.loginId);
    expect(result.phase).toBe("error");
    expect(result.error).toBe(SDPPPX_ERROR_CODES.loginFailed);
    expect(session.session()).toBeNull();
  });

  it("登出后迟到的授权结果被丢弃", async () => {
    const { flow, session } = setup({ checkStatus: () => 2 });
    const started = await flow.start();
    if (!started.ok) throw new Error("start failed");
    await session.clear(null);
    const result = await flow.status(started.loginId);
    expect(result.phase).toBe("cancelled");
    expect(session.session()).toBeNull();
  });

  it("轮询中的网络抖动保留 pending，不把一次失败变成登录失败", async () => {
    const { flow } = setup({ checkStatus: () => 0, checkFailureStatus: 503 });
    const started = await flow.start();
    if (!started.ok) throw new Error("start failed");
    expect(await flow.status(started.loginId)).toEqual({ phase: "pending" });
    expect(flow.pendingCount()).toBe(1);
  });
});
