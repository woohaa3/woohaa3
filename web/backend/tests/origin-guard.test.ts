/**
 * 浏览器写请求 Origin/CSRF 与允许 Origin 解析单测
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 2.4）。
 *
 * 覆盖：安全方法放行；无 Origin 的服务端调用放行；同源（Host/x-forwarded-host）放行；
 * 跨源拒绝；`Origin: null` 拒绝；允许列表显式放行；配置解析丢弃非法条目。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ALLOWED_ORIGINS_ENV, parseAllowedOrigins } from "../src/composition/config.js";
import { createOriginGuard } from "../src/http/origin-guard.js";

function req(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

describe("createOriginGuard（任务 2.4）", () => {
  it("安全方法不做 Origin 校验", () => {
    const guard = createOriginGuard([]);
    expect(guard(req("GET", { origin: "https://evil.example", host: "app.example" }))).toEqual({ ok: true });
    expect(guard(req("HEAD", { origin: "https://evil.example" }))).toEqual({ ok: true });
    expect(guard(req("OPTIONS", { origin: "https://evil.example" }))).toEqual({ ok: true });
  });

  it("无 Origin 的非浏览器/服务端写请求放行", () => {
    const guard = createOriginGuard([]);
    expect(guard(req("POST", { host: "app.example" }))).toEqual({ ok: true });
  });

  it("与请求 Host 同源的写请求放行", () => {
    const guard = createOriginGuard([]);
    expect(guard(req("POST", { origin: "https://app.example", host: "app.example" }))).toEqual({ ok: true });
    // ingress 注入的原始 Host 优先于直连 Host。
    expect(guard(req("PUT", { origin: "https://app.example", host: "127.0.0.1:9", "x-forwarded-host": "app.example" }))).toEqual({ ok: true });
  });

  it("跨源写请求拒绝", () => {
    const guard = createOriginGuard([]);
    const result = guard(req("POST", { origin: "https://evil.example", host: "app.example" }));
    expect(result).toMatchObject({ ok: false, status: 403, code: "invalid-origin" });
  });

  it("Origin: null / 畸形 Origin 拒绝", () => {
    const guard = createOriginGuard([]);
    expect(guard(req("POST", { origin: "null", host: "app.example" }))).toMatchObject({ ok: false, status: 403 });
    expect(guard(req("POST", { origin: "not a url", host: "app.example" }))).toMatchObject({ ok: false, status: 403 });
  });

  it("允许列表显式放行跨源 Origin", () => {
    const guard = createOriginGuard(["https://admin.example"]);
    expect(guard(req("POST", { origin: "https://admin.example", host: "app.example" }))).toEqual({ ok: true });
  });
});

describe("parseAllowedOrigins（任务 2.4）", () => {
  it("解析、归一化并去重合法 origin", () => {
    const env = { [ALLOWED_ORIGINS_ENV]: "https://a.example, https://a.example/, http://b.example:8443" };
    expect(parseAllowedOrigins(env)).toEqual(["https://a.example", "http://b.example:8443"]);
  });

  it("丢弃非 http(s)、含路径与畸形条目", () => {
    const env = { [ALLOWED_ORIGINS_ENV]: "ftp://a.example, https://b.example/path, javascript:alert(1), , https://c.example" };
    expect(parseAllowedOrigins(env)).toEqual(["https://c.example"]);
  });

  it("缺省为空", () => {
    expect(parseAllowedOrigins({})).toEqual([]);
  });
});
