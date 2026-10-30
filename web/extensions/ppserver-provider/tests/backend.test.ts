import { describe, expect, it } from "vitest";
import { createPpserverRegistration } from "../src/backend.js";

const SUPABASE = "https://pp.test/supabase/proj";
const BASE = "https://pp.test/ppserver";

/**
 * `available` 的三个判据：令牌（任一形态）、地址、Supabase 地址。
 *
 * 这里守的是一条踩过的回归：以前只认 `accessToken`，配了 refreshToken 而没填
 * accessToken 的用户会拿到 `provider: undefined` —— 一个模型都注册不上，
 * 可设置页恰恰把 refreshToken 标成「推荐」。
 */
describe("ppserver 注册可用性", () => {
  it("只有 refreshToken 也算可用", () => {
    const { registration } = createPpserverRegistration({
      refreshToken: "refresh-1",
      baseUrl: BASE,
      supabaseUrl: SUPABASE
    });
    expect(registration.available).toBe(true);
    expect(registration.provider).toBeDefined();
  });

  it("只有 resolveAccessToken 也算可用（它本身就是令牌来源）", () => {
    const { registration } = createPpserverRegistration({
      resolveAccessToken: async () => "jwt-1",
      baseUrl: BASE,
      supabaseUrl: SUPABASE
    });
    expect(registration.available).toBe(true);
    expect(registration.provider).toBeDefined();
  });

  it("两种令牌都没有时不可用，但仍注册（设置页要能看到插件）", () => {
    const { registration } = createPpserverRegistration({ baseUrl: BASE, supabaseUrl: SUPABASE });
    expect(registration.available).toBe(false);
    expect(registration.provider).toBeUndefined();
    // 仍返回一个注册对象：未配齐不等于不注册。
    expect(registration.extensionId).toBe("ppserver-provider");
  });

  it("缺 Supabase 地址时不可用 —— 读不到模板表就没有模型", () => {
    const { registration } = createPpserverRegistration({ accessToken: "jwt-1", baseUrl: BASE });
    expect(registration.available).toBe(false);
  });
});
