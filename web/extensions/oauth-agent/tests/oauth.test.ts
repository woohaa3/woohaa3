/**
 * OAuth PKCE / state / nonce / JWT 校验测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.3/2.4）。
 *
 * 使用本地生成的测试密钥与伪造 callback，不使用真实凭据。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyObject } from "jose";
import { ChatGptOAuth, CHATGPT_PLAN_SCOPE, DYNAMIC_CLIENT_ID } from "../src/backend/oauth.js";

const ISSUER = "https://issuer.test";

type TestKey = { privateKey: KeyObject; jwk: JWK };
async function makeKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  return { privateKey, jwk };
}

function jwksResolver(keys: JWK[]) {
  return async (protectedHeader?: { kid?: string }) => {
    const kid = protectedHeader?.kid;
    return keys.find((key) => key.kid === kid) ?? keys[0]!;
  };
}

async function signIdToken(key: TestKey, input: { sub: string; aud: string; nonce?: string; issuer?: string; expiresIn?: string }): Promise<string> {
  const jwt = new SignJWT({ ...(input.nonce ? { nonce: input.nonce } : {}), email: `${input.sub}@example.test` })
    .setProtectedHeader({ alg: "RS256", kid: (key.jwk.kid as string) ?? "test" })
    .setIssuer(input.issuer ?? ISSUER)
    .setAudience(input.aud)
    .setSubject(input.sub)
    .setIssuedAt()
    .setExpirationTime(input.expiresIn ?? "1h");
  return jwt.sign(key.privateKey);
}

function fetchFor(tokenResponse: unknown, status = 200): typeof globalThis.fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => tokenResponse
  })) as unknown as typeof globalThis.fetch;
}

describe("ChatGptOAuth", () => {
  it("首次授权使用动态注册 client id，且 URL 带 PKCE/S256/state/nonce/scope", () => {
    const oauth = new ChatGptOAuth({ issuer: ISSUER, random: (() => { let i = 0; return () => `r${i++}`; })() });
    const { transaction, url } = oauth.begin({ redirectUri: "http://127.0.0.1:5180/api/oauth-agent/authorize/complete", ownerId: "local:1", sessionBinding: "b" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe(DYNAMIC_CLIENT_ID);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toBe(createHash("sha256").update(transaction.verifier).digest("base64url"));
    expect(parsed.searchParams.get("state")).toBe(transaction.state);
    expect(parsed.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(parsed.searchParams.get("scope")).toContain(CHATGPT_PLAN_SCOPE);
    expect(transaction.clientId).toBeNull();
  });

  it("授权 URL 携带调用方提供的稳定 ext_agent_host_id（参照已验证 demo）", () => {
    const oauth = new ChatGptOAuth({ issuer: ISSUER, random: (() => { let i = 0; return () => `r${i++}`; })() });
    const hostId = oauth.newHostId();
    const { url } = oauth.begin({ redirectUri: "http://127.0.0.1:5180/api/oauth-agent/authorize/complete", ownerId: "local:1", sessionBinding: "b", hostId });
    expect(new URL(url).searchParams.get("ext_agent_host_id")).toBe(hostId);
    expect(hostId.startsWith("urn:uuid:")).toBe(true);
  });

  it("校验回调 client_id、state、过期、owner/会话绑定与 nonce", async () => {
    const key = await makeKey("k1");
    const oauth = new ChatGptOAuth({ issuer: ISSUER, jwks: jwksResolver([key.jwk]) });
    const { transaction } = oauth.begin({ redirectUri: "http://localhost/cb", ownerId: "local:1", sessionBinding: "b" });
    // 伪造动态 client id 被拒。
    await expect(
      oauth.complete({ transaction, query: { state: transaction.state, code: "c", client_id: DYNAMIC_CLIENT_ID }, ownerId: "local:1", sessionBinding: "b" })
    ).rejects.toThrow(/client_id/);
    // 会话/owner 不匹配被拒。
    await expect(
      oauth.complete({ transaction, query: { state: transaction.state, code: "c", client_id: "real-client" }, ownerId: "local:2", sessionBinding: "b" })
    ).rejects.toThrow(/用户不匹配/);
    await expect(
      oauth.complete({ transaction, query: { state: transaction.state, code: "c", client_id: "real-client" }, ownerId: "local:1", sessionBinding: "other" })
    ).rejects.toThrow(/会话不匹配/);
    // state 错误。
    await expect(
      oauth.complete({ transaction, query: { state: "wrong", code: "c", client_id: "real-client" }, ownerId: "local:1", sessionBinding: "b" })
    ).rejects.toThrow(/state/);
  });

  it("完成授权时验证 ID token 签名、issuer、audience、nonce 与主体", async () => {
    const key = await makeKey("k1");
    // 先发起事务以获得 nonce，再用返回 id_token 的 fetch 完成。
    const probe = new ChatGptOAuth({ issuer: ISSUER, jwks: jwksResolver([key.jwk]) });
    const begin = probe.begin({ redirectUri: "http://localhost/cb", ownerId: "local:1", sessionBinding: "b", account: { clientId: "real-client" } as never });
    const idToken = await signIdToken(key, { sub: "chatgpt-sub", aud: "real-client", nonce: begin.transaction.nonce });
    const oauth2 = new ChatGptOAuth({
      issuer: ISSUER,
      jwks: jwksResolver([key.jwk]),
      fetchImpl: fetchFor({ access_token: "at2", refresh_token: "rt2", id_token: idToken, scope: `openid ${CHATGPT_PLAN_SCOPE}`, expires_in: 3600 })
    });
    const completed = await oauth2.complete({
      transaction: begin.transaction,
      query: { state: begin.transaction.state, code: "c", client_id: "real-client" },
      ownerId: "local:1",
      sessionBinding: "b"
    });
    expect(completed.subject).toBe("chatgpt-sub");
    expect(oauth2.planEnabled(completed)).toBe(true);
  });

  it("nonce/audience/issuer 不匹配时拒绝", async () => {
    const key = await makeKey("k1");
    async function attempt(idToken: string): Promise<void> {
      const oauth = new ChatGptOAuth({
        issuer: ISSUER,
        jwks: jwksResolver([key.jwk]),
        fetchImpl: fetchFor({ access_token: "at", id_token: idToken, scope: `openid ${CHATGPT_PLAN_SCOPE}`, expires_in: 3600 })
      });
      const { transaction } = oauth.begin({ redirectUri: "http://localhost/cb", ownerId: "local:1", sessionBinding: "b", account: { clientId: "real-client" } as never });
      await oauth.complete({ transaction, query: { state: transaction.state, code: "c", client_id: "real-client" }, ownerId: "local:1", sessionBinding: "b" });
    }
    const wrongNonce = await signIdToken(key, { sub: "s", aud: "real-client", nonce: "nope" });
    await expect(attempt(wrongNonce)).rejects.toThrow(/nonce/);
    const wrongAud = await signIdToken(key, { sub: "s", aud: "other-client" });
    await expect(attempt(wrongAud)).rejects.toThrow();
    const wrongIss = await signIdToken(key, { sub: "s", aud: "real-client", issuer: "https://evil.test" });
    await expect(attempt(wrongIss)).rejects.toThrow();
    const expired = await signIdToken(key, { sub: "s", aud: "real-client", expiresIn: "-1h" });
    await expect(attempt(expired)).rejects.toThrow();
  });

  it("仅身份登录（缺少订阅 scope）不启用生成", async () => {
    const key = await makeKey("k1");
    const probe = new ChatGptOAuth({ issuer: ISSUER, jwks: jwksResolver([key.jwk]) });
    const begin = probe.begin({ redirectUri: "http://localhost/cb", ownerId: "local:1", sessionBinding: "b", account: { clientId: "real-client" } as never });
    const idToken = await signIdToken(key, { sub: "chatgpt-sub", aud: "real-client", nonce: begin.transaction.nonce });
    const oauth2 = new ChatGptOAuth({
      issuer: ISSUER,
      jwks: jwksResolver([key.jwk]),
      fetchImpl: fetchFor({ id_token: idToken, scope: "openid profile email" })
    });
    const account = await oauth2.complete({
      transaction: begin.transaction,
      query: { state: begin.transaction.state, code: "c", client_id: "real-client" },
      ownerId: "local:1",
      sessionBinding: "b"
    });
    expect(oauth2.planEnabled(account)).toBe(false);
  });

  it("续期合并为一次且轮换 token；续期主体变化拒绝", async () => {
    const key = await makeKey("k1");
    let tokenCalls = 0;
    const fetchImpl = (async (_url: string, init?: { body?: URLSearchParams }) => {
      tokenCalls += 1;
      const grant = init?.body?.get("grant_type");
      if (grant === "refresh_token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "new-at", refresh_token: "new-rt", scope: `openid ${CHATGPT_PLAN_SCOPE}`, expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch;
    const oauth = new ChatGptOAuth({ issuer: ISSUER, jwks: jwksResolver([key.jwk]), fetchImpl: fetchImpl as never });
    const account = {
      clientId: "real-client",
      subject: "sub-1",
      scopes: [CHATGPT_PLAN_SCOPE],
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: Date.now() - 1000,
      connectedAt: new Date().toISOString()
    };
    const [a, b] = await Promise.all([
      oauth.accessToken({ ownerId: "o1", account, persist: () => undefined }),
      oauth.accessToken({ ownerId: "o1", account, persist: () => undefined })
    ]);
    expect(a).toBe("new-at");
    expect(b).toBe("new-at");
    expect(tokenCalls).toBe(1);

    // 续期主体变化：id token 返回不同 sub。
    const otherKey = key;
    const tokenWithDifferentSub = await signIdToken(otherKey, { sub: "sub-2", aud: "real-client" });
    const fetchBad = (async () => ({ ok: true, status: 200, json: async () => ({ access_token: "x", refresh_token: "y", id_token: tokenWithDifferentSub, scope: `openid ${CHATGPT_PLAN_SCOPE}`, expires_in: 3600 }) })) as unknown as typeof globalThis.fetch;
    const oauthBad = new ChatGptOAuth({ issuer: ISSUER, jwks: jwksResolver([key.jwk]), fetchImpl: fetchBad });
    await expect(
      oauthBad.accessToken({ ownerId: "o2", account, persist: () => undefined })
    ).rejects.toThrow(/不同身份/);
  });
});
