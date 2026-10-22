/**
 * owner 解析与本地会话 cookie 测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.2）。
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createOwnerResolver, CHATGPT_SESSION_COOKIE } from "../src/backend/identity.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

const secret = Buffer.alloc(32, 5);

describe("owner 解析", () => {
  it("有应用认证时 owner = principal.subject", () => {
    const resolver = createOwnerResolver({
      authConfigured: true,
      resolvePrincipalSubject: (req) => (req.headers["x-test-user"] as string | undefined) ?? null,
      publicPosture: true,
      allowLocalSession: false,
      sessionSecret: secret,
      secure: true
    });
    const result = resolver.resolve(request({ "x-test-user": "app-user-42" }));
    expect(result.ok && result.ownerId).toBe("principal:app-user-42");
    expect(result.ok && result.ownerKind).toBe("principal");
  });

  it("有应用认证但未认证时拒绝", () => {
    const resolver = createOwnerResolver({
      authConfigured: true,
      resolvePrincipalSubject: () => null,
      publicPosture: true,
      allowLocalSession: false,
      sessionSecret: secret,
      secure: true
    });
    const result = resolver.resolve(request());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("unauthenticated");
  });

  it("公网缺少可信认证时拒绝匿名 fallback", () => {
    const resolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: true,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: true
    });
    const result = resolver.resolve(request());
    expect(!result.ok && result.code).toBe("anonymous-fallback-disabled");
  });

  it("本地模式签发 HttpOnly cookie，且同一 cookie 稳定、伪造签名被拒", () => {
    const resolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: false,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: false
    });
    const first = resolver.resolve(request());
    expect(first.ok).toBe(true);
    expect(first.ok && first.setCookie).toContain(`${CHATGPT_SESSION_COOKIE}=`);
    expect(first.ok && first.setCookie).toContain("HttpOnly");
    const cookieValue = first.ok ? first.setCookie!.split(";")[0]! : "";
    // 复用同一 cookie 得到同一 owner。
    const second = resolver.resolve(request({ cookie: cookieValue }));
    expect(second.ok && second.ownerId).toBe(first.ok ? first.ownerId : "");
    expect(second.ok && second.setCookie).toBeUndefined();
    // 伪造签名被拒绝 → 新签发不同 owner。
    const tampered = `${cookieValue.split(".").slice(0, 2).join(".")}.forged`;
    const third = resolver.resolve(request({ cookie: `${CHATGPT_SESSION_COOKIE}=${tampered}` }));
    expect(third.ok && third.ownerId).not.toBe(first.ok ? first.ownerId : "");
  });

  it("本地模式未启用时不可用", () => {
    const resolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: false,
      allowLocalSession: false,
      sessionSecret: secret,
      secure: false
    });
    const result = resolver.resolve(request());
    expect(!result.ok && result.code).toBe("not-configured");
  });
});

describe("owner 解析：显式输入（宿主在其它路由的 HTTP 边界复用）", () => {
  it("resolveFor 与 resolve 同规则：生产主体 → principal", () => {
    const resolver = createOwnerResolver({
      authConfigured: true,
      resolvePrincipalSubject: () => null,
      publicPosture: true,
      allowLocalSession: false,
      sessionSecret: secret,
      secure: true
    });
    const result = resolver.resolveFor({ subject: "app-user-9" });
    expect(result.ok && result.ownerId).toBe("principal:app-user-9");
  });

  it("resolveFor：有认证但无主体 → 拒绝（不静默匿名）", () => {
    const resolver = createOwnerResolver({
      authConfigured: true,
      resolvePrincipalSubject: () => null,
      publicPosture: true,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: false
    });
    const result = resolver.resolveFor({ cookie: `${CHATGPT_SESSION_COOKIE}=whatever` });
    expect(!result.ok && result.code).toBe("unauthenticated");
  });

  it("resolveFor：本地开发姿态复用 cookie 会话，或签发新会话", () => {
    const resolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: false,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: false
    });
    const first = resolver.resolveFor({});
    expect(first.ok && first.ownerId.startsWith("local:")).toBe(true);
    const cookieValue = first.ok ? first.setCookie!.split(";")[0]! : "";
    const second = resolver.resolveFor({ cookie: cookieValue });
    expect(second.ok && second.ownerId).toBe(first.ok ? first.ownerId : "");
    expect(second.ok && second.setCookie).toBeUndefined();
  });

  it("resolveFor：公网缺认证 → 拒绝匿名 fallback", () => {
    const resolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: true,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: false
    });
    const result = resolver.resolveFor({ subject: "ignored" });
    expect(!result.ok && result.code).toBe("anonymous-fallback-disabled");
  });

  it("子挂载下 cookie 名称/Path 一致且确定性（根挂载保持既有名称与 Path=/）", () => {
    const resolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: false,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: false,
      basePath: "/canvas/"
    });
    const first = resolver.resolveFor({});
    expect(first.ok).toBe(true);
    const setCookie = first.ok ? first.setCookie! : "";
    expect(setCookie).toContain(`${CHATGPT_SESSION_COOKIE}-canvas=`);
    expect(setCookie).toContain("Path=/canvas/");
    // 读取复用同一名称与 Path。
    const cookieValue = setCookie.split(";")[0]!;
    const second = resolver.resolveFor({ cookie: cookieValue });
    expect(second.ok && second.ownerId).toBe(first.ok ? first.ownerId : "");
    expect(resolver.clearSessionCookie()).toContain(`${CHATGPT_SESSION_COOKIE}-canvas=`);
    expect(resolver.clearSessionCookie()).toContain("Path=/canvas/");

    const rootResolver = createOwnerResolver({
      authConfigured: false,
      resolvePrincipalSubject: () => null,
      publicPosture: false,
      allowLocalSession: true,
      sessionSecret: secret,
      secure: false
    });
    const root = rootResolver.resolveFor({});
    expect(root.ok && root.setCookie).toContain(`${CHATGPT_SESSION_COOKIE}=`);
    expect(root.ok && root.setCookie).toContain("Path=/;");
    expect(rootResolver.clearSessionCookie()).toContain("Path=/;");
  });
});
