import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "../src/guarded-fetch.js";
import {
  NetworkDeniedError,
  isHostAllowed,
  isPrivateAddress,
  isPrivateHost,
  isUrlAllowed,
  parseHostRule,
  parseHostRules
} from "../src/network-policy.js";

describe("出网主机白名单（network-policy）", () => {
  it("解析条目：通配、端口、IPv6 字面量；拒绝协议、路径与空串", () => {
    expect(parseHostRule("API.Example.com")).toMatchObject({ host: "api.example.com", wildcard: false, port: null });
    expect(parseHostRule("*.example.org:8443")).toMatchObject({ host: "example.org", wildcard: true, port: 8443 });
    expect(parseHostRule("[2001:db8::1]:443")).toMatchObject({ host: "2001:db8::1", port: 443 });
    for (const bad of ["", "https://x.com", "x.com/path", "user@x.com", "x.com:99999", "*.", "a*.b.com"]) {
      expect(() => parseHostRule(bad), bad).toThrow(/非法/);
    }
  });

  it("匹配：精确域名、*. 只匹配子域、端口约束、大小写与末尾点", () => {
    const rules = parseHostRules(["api.example.com", "*.cdn.example.net", "files.example.org:8443"]);
    expect(isHostAllowed(rules, "API.example.com.", 443)).toBe(true);
    expect(isHostAllowed(rules, "evil-api.example.com", 443)).toBe(false);
    expect(isHostAllowed(rules, "a.cdn.example.net", 443)).toBe(true);
    expect(isHostAllowed(rules, "cdn.example.net", 443)).toBe(false);
    expect(isHostAllowed(rules, "a.cdn.example.net.evil.com", 443)).toBe(false);
    expect(isHostAllowed(rules, "files.example.org", 8443)).toBe(true);
    expect(isHostAllowed(rules, "files.example.org", 443)).toBe(false);
    expect(isUrlAllowed(rules, "https://files.example.org:8443/x")).toBe(true);
    expect(isUrlAllowed(rules, "https://files.example.org/x")).toBe(false);
  });

  it("空白名单不允许任何主机", () => {
    expect(isHostAllowed(parseHostRules([]), "api.example.com", 443)).toBe(false);
  });

  it("私网判定：IPv4 / IPv6 / 映射地址 / 本机主机名", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "999.1.1.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("printer.local")).toBe(true);
    expect(isPrivateHost("api.example.com")).toBe(false);
  });
});

describe("createGuardedFetch 的 allowedHosts", () => {
  const ok = (async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } })) as typeof fetch;

  it("不传 allowedHosts：行为不变（回归）", async () => {
    const guarded = createGuardedFetch({ baseUrl: "https://queue.fal.run", maxBytes: 16, timeoutMs: 1000, fetchImpl: ok });
    await expect(guarded("https://v3.fal.media/x.png")).resolves.toBeInstanceOf(Response);
  });

  it("baseUrl 不在白名单：构造即抛 EXTENSION_NETWORK_DENIED", () => {
    expect(() => createGuardedFetch({ baseUrl: "https://api.other.com", maxBytes: 1, timeoutMs: 1, allowedHosts: ["api.example.com"] })).toThrow(NetworkDeniedError);
    try {
      createGuardedFetch({ baseUrl: "https://api.other.com", maxBytes: 1, timeoutMs: 1, allowedHosts: [] });
    } catch (error) {
      expect((error as NetworkDeniedError).code).toBe("EXTENSION_NETWORK_DENIED");
    }
  });

  it("受控下载与重定向目标必须在白名单内", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("redirect")) return new Response(null, { status: 302, headers: { location: "https://evil.example.net/x.png" } });
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    });
    const guarded = createGuardedFetch({
      baseUrl: "https://api.example.com",
      maxBytes: 16,
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch,
      allowedHosts: ["api.example.com", "*.media.example.com"]
    });
    await expect(guarded("https://v1.media.example.com/x.png")).resolves.toBeInstanceOf(Response);
    await expect(guarded("https://v3.fal.media/x.png")).rejects.toThrow(/permissions\.network/);
    await expect(guarded("https://v1.media.example.com/redirect")).rejects.toMatchObject({ code: "EXTENSION_NETWORK_DENIED" });
  });
});
