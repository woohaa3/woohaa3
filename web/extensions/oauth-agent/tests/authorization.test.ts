/**
 * 授权服务与 per-user 隔离测试
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.3/2.4/2.5/6.1）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createChatGptCredentialStore } from "../src/backend/credentials.js";
import { createOwnerResolver } from "../src/backend/identity.js";
import { createChatGptAuthorizationService } from "../src/backend/authorization.js";
import { ChatGptOAuth, CHATGPT_PLAN_SCOPE } from "../src/backend/oauth.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-chatgpt-auth-"));
  dirs.push(dir);
  return dir;
}

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
}

/** 无网络 OAuth：只测试事务/绑定/隔离；交换通过注入的 fake fetch 完成。 */
function buildService(dir: string, fetchImpl: typeof globalThis.fetch) {
  const store = createChatGptCredentialStore({ directory: dir, masterKey: Buffer.alloc(32, 4) });
  const oauth = new ChatGptOAuth({
    issuer: "https://issuer.test",
    random: (() => { let i = 0; return () => `r${i++}`; })(),
    fetchImpl,
    jwks: async () => ({})
  });
  const owners = createOwnerResolver({
    authConfigured: false,
    resolvePrincipalSubject: () => null,
    publicPosture: false,
    allowLocalSession: true,
    sessionSecret: Buffer.alloc(32, 6),
    secure: false
  });
  const authorization = createChatGptAuthorizationService({ store, oauth, owners });
  return { store, ownership: owners, authorization };
}

describe("ChatGPT 授权服务", () => {
  it("状态在无凭据时为 disconnected", () => {
    const { authorization } = buildService(tempDir(), (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never);
    expect(authorization.snapshot("local:1", "local-session").state).toBe("disconnected");
  });

  it("授权事务一次性消费：重放回调被拒", async () => {
    const keyFixed = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
    const dir = tempDir();
    const { authorization } = buildService(dir, keyFixed);
    const owner = { ok: true as const, ownerId: "local:1", ownerKind: "local-session" as const, localSession: true };
    const start = await authorization.start({ owner, req: request(), redirectUri: "http://localhost/cb" });
    expect(start.ok).toBe(true);
    const state = start.ok ? new URL(start.url).searchParams.get("state")! : "";
    // 第一次消费会因 token 交换失败而返回错误，但事务已被消费。
    const first = await authorization.complete({ owner, req: request(), query: { state, code: "c", client_id: "real" } });
    expect(first.ok).toBe(false);
    const replay = await authorization.complete({ owner, req: request(), query: { state, code: "c", client_id: "real" } });
    expect(!replay.ok && replay.code).toBe("invalid-transaction");
  });

  it("断开后 run 状态回 disconnected 且不影响其他 owner", async () => {
    const dir = tempDir();
    const { store, authorization } = buildService(dir, (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never);
    const account = {
      clientId: "c",
      subject: "chatgpt-sub",
      scopes: [CHATGPT_PLAN_SCOPE],
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      connectedAt: new Date().toISOString()
    };
    store.write("local:1", { account, host: { extAgentHostId: "h1" } });
    store.write("local:2", { account: { ...account, accessToken: "at2" }, host: { extAgentHostId: "h2" } });
    expect(authorization.snapshot("local:1", "local-session").state).toBe("ready");
    const result = await authorization.disconnect("local:1");
    expect(result.revoked).toBe(false); // 撤销端点不可达 → 本地仍清除。
    expect(authorization.snapshot("local:1", "local-session").state).toBe("disconnected");
    expect(authorization.snapshot("local:2", "local-session").state).toBe("ready");
    expect(store.read("local:2")).not.toBeNull();
  });
});
