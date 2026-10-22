/**
 * 宿主认证接缝测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.3/3.5）。
 *
 * 验证：认证只经注入的 identity provider 解析器；未配置/未认证一律 null；冻结 principal 不可改写；
 * 旧 shared-secret/HMAC/admin 角色机制已删除（不导出）。
 */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createFakeRequestAuthenticator,
  createProviderRequestAuthenticator,
  createUnauthenticatedAuthenticator,
  testPrincipal,
  toAdapterRequestInput
} from "./adapter.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  for (const [key, value] of Object.entries(headers)) req.headers[key] = value;
  return req;
}

describe("宿主认证接缝（任务 1.3/3.5）", () => {
  it("未配置认证器一律返回 null（不下沉放行）", async () => {
    const auth = createUnauthenticatedAuthenticator();
    expect(await auth(request({ "x-woohaa3-test-actor": "admin" }))).toBeNull();
  });

  it("fake 认证器冻结 principal：attributes 不可改写", async () => {
    const auth = createFakeRequestAuthenticator((req) => {
      const subject = req.headers["x-woohaa3-test-actor"];
      if (typeof subject !== "string") return null;
      return testPrincipal(subject, { identityProvider: "fake", attributes: { org: "acme" } });
    });
    const principal = await auth(request({ "x-woohaa3-test-actor": "user-a" }));
    expect(principal?.subject).toBe("user-a");
    expect(Object.isFrozen(principal)).toBe(true);
    expect(() => {
      (principal as { subject: string }).subject = "forged";
    }).toThrow();
  });

  it("provider 认证器把原始请求映射为 identity 输入并按 ok 返回 principal", async () => {
    let seen: { transport: string; headers: unknown } | undefined;
    const auth = createProviderRequestAuthenticator(() => ({
      providerId: "test-identity",
      async authenticate(input) {
        seen = { transport: input.transport, headers: input.headers };
        return { ok: true, principal: testPrincipal("user-b", { identityProvider: "test-identity" }) };
      }
    }));
    const principal = await auth(request({ cookie: "sid=1" }), "ws");
    expect(principal?.subject).toBe("user-b");
    expect(seen?.transport).toBe("ws");
  });

  it("provider 未认证返回 null；provider 抛出故障时向上抛出", async () => {
    const denied = createProviderRequestAuthenticator(() => ({
      providerId: "test-identity",
      async authenticate() {
        return { ok: false, code: "unauthenticated" as const };
      }
    }));
    expect(await denied(request())).toBeNull();

    const failing = createProviderRequestAuthenticator(() => {
      throw Object.assign(new Error("身份提供者不可用"), { code: "access-provider-unavailable" });
    });
    await expect(failing(request())).rejects.toMatchObject({ code: "access-provider-unavailable" });
  });

  it("toAdapterRequestInput 只取原始受控字段", () => {
    const req = request({ "x-forwarded-for": "1.2.3.4" });
    req.method = "GET";
    req.url = "/api/extensions";
    const input = toAdapterRequestInput(req);
    expect(input.headers["x-forwarded-for"]).toBe("1.2.3.4");
    expect(input.method).toBe("GET");
  });
});
