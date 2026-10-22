/**
 * 个人 ChatGPT OAuth（服务端 PKCE）
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.3/2.4/2.5 / design D3）。
 *
 * 使用按事务隔离的状态机与边界，不依赖单账户
 * 全局 `account.json`：每次事务绑定本应用 owner、浏览器会话、公开 origin、PKCE verifier、
 * state、nonce、有效期与预期 client/subject；一次交换失败不能重放。
 *
 * 订阅生成要求有效 access token 且包含 `chatgpt.tokens.use.direct` scope。仅身份登录成功
 * （有 ID token 但无该 scope）不启用生成。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ChatGptAccountCredential } from "./credentials.js";

export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_APP_NAME = "woohaa3";
/** 未注册时的动态 client 占位。 */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** 事务有效期（10 分钟）。 */
export const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export type ChatGptTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  clientId: string | null;
  /** 稳定 agent host 标识；授权 URL 必须携带（参照已验证 demo 的 `ext_agent_host_id`）。 */
  hostId?: string;
  /** 预期 subject（重登录时固定，防止换账户）。 */
  subject?: string;
  /** 绑定：本应用 owner 与浏览器会话摘要。 */
  ownerId: string;
  sessionBinding: string;
};

export type ChatGptTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
};

export type ChatGptOAuthDependencies = {
  issuer: string;
  appName?: string;
  resource?: string;
  /** 已注册应用 client id；缺省使用动态注册。 */
  appClientId?: string | null;
  fetchImpl?: typeof globalThis.fetch;
  /** JWKS 解析器；缺省从 issuer 派生。测试可注入本地 JWKS。 */
  jwks?: JWTVerifyGetKey;
  now?: () => number;
  random?: () => string;
  uuid?: () => string;
};

function defaultRandom(): string {
  return randomBytes(32).toString("base64url");
}

export class ChatGptOAuth {
  private readonly deps: ChatGptOAuthDependencies;
  private readonly issuer: string;
  private readonly resource: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly jwks: JWTVerifyGetKey;
  private readonly now: () => number;
  private readonly random: () => string;
  /** 同一 owner 的续期合并为一次。 */
  private readonly refreshing = new Map<string, Promise<ChatGptAccountCredential>>();

  constructor(deps: ChatGptOAuthDependencies) {
    this.deps = deps;
    this.issuer = deps.issuer.replace(/\/$/, "");
    this.resource = deps.resource ?? CHATGPT_RESOURCE;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    // JWKS 按需延迟创建，避免构造时网络副作用。
    this.jwks = deps.jwks ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? defaultRandom;
  }

  /** 开始一笔授权事务，返回授权 URL 与事务。 */
  begin(input: {
    redirectUri: string;
    ownerId: string;
    sessionBinding: string;
    /** 稳定 agent host 标识（参照已验证 demo）。缺省时由调用方保证尽快持久化。 */
    hostId?: string;
    account?: ChatGptAccountCredential | null;
  }): { transaction: ChatGptTransaction; url: string } {
    const transaction: ChatGptTransaction = {
      state: this.random(),
      nonce: this.random(),
      verifier: this.random(),
      redirectUri: input.redirectUri,
      expiresAt: this.now() + TRANSACTION_TTL_MS,
      clientId: input.account?.clientId ?? this.deps.appClientId ?? null,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      ownerId: input.ownerId,
      sessionBinding: input.sessionBinding,
      ...(input.account?.subject ? { subject: input.account.subject } : {})
    };
    const url = this.authorizeUrl(transaction, input.account ?? null);
    return { transaction, url };
  }

  private authorizeUrl(transaction: ChatGptTransaction, account: ChatGptAccountCredential | null): string {
    const url = new URL(`${this.issuer}/api/accounts/authorize`);
    const params = new URLSearchParams({
      client_id: transaction.clientId ?? DYNAMIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: transaction.redirectUri,
      scope: CHATGPT_SCOPES,
      resource: this.resource,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url")
    });
    if (!transaction.clientId) params.set("agent_name_hint", this.deps.appName ?? CHATGPT_APP_NAME);
    else if (account?.email) params.set("login_hint", account.email);
    // 已验证 demo 在 authorize URL 中携带稳定 `ext_agent_host_id`：缺失会使用户授权后得不到可用
    // 订阅授权。这里在事务已确定 hostId 时补上。
    if (transaction.hostId) params.set("ext_agent_host_id", transaction.hostId);
    url.search = params.toString();
    return url.toString();
  }

  /**
   * 校验回调并完成 code exchange + 身份验证。
   *
   * 校验：事务存在/未过期、state 匹配、绑定 owner/会话、回调 client_id 有效且与预期一致。
   */
  async complete(input: {
    transaction: ChatGptTransaction;
    query: Record<string, string | string[] | undefined>;
    ownerId: string;
    sessionBinding: string;
  }): Promise<ChatGptAccountCredential> {
    const t = input.transaction;
    if (!t) throw new Error("授权事务不存在，请重新发起授权。");
    if (t.ownerId !== input.ownerId) throw new Error("授权事务与当前用户不匹配。");
    if (t.sessionBinding !== input.sessionBinding) throw new Error("授权事务与当前浏览器会话不匹配。");
    if (t.expiresAt <= this.now()) throw new Error("授权事务已过期，请重新授权。");
    const state = first(input.query.state);
    if (state !== t.state) throw new Error("授权 state 无效或已使用，请重新授权。");
    const error = first(input.query.error);
    if (error) throw new Error(`授权未完成：${error.slice(0, 80)}`);
    const code = first(input.query.code);
    if (!code) throw new Error("授权回调缺少 code。");
    const clientId = first(input.query.client_id) ?? t.clientId;
    if (!clientId || clientId === DYNAMIC_CLIENT_ID || (t.clientId && clientId !== t.clientId)) {
      throw new Error("授权回调的 client_id 无效。");
    }

    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: t.verifier,
      redirect_uri: t.redirectUri,
      resource: this.resource
    });
    const identity = await this.verifyIdentity(tokens.id_token, clientId, t.nonce);
    if (t.subject && identity.sub !== t.subject) throw new Error("返回账户与已保存的账户不同。");
    return this.buildAccount(clientId, identity, tokens);
  }

  private buildAccount(
    clientId: string,
    identity: { sub: string; email?: string; iss?: string },
    tokens: ChatGptTokenResponse,
    previous?: ChatGptAccountCredential
  ): ChatGptAccountCredential {
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    if (scopes.includes(CHATGPT_PLAN_SCOPE) && typeof tokens.access_token !== "string") {
      throw new Error("授权未返回 access_token。");
    }
    return {
      clientId,
      subject: identity.sub,
      ...(identity.email ? { email: identity.email } : previous?.email ? { email: previous.email } : {}),
      ...(identity.iss ? { iss: identity.iss } : {}),
      scopes,
      accessToken: tokens.access_token ?? previous?.accessToken ?? "",
      ...(tokens.refresh_token ?? previous?.refreshToken ? { refreshToken: tokens.refresh_token ?? previous!.refreshToken } : {}),
      ...(tokens.id_token ?? previous?.idToken ? { idToken: tokens.id_token ?? previous!.idToken } : {}),
      expiresAt: this.now() + Number(tokens.expires_in || 3600) * 1000,
      connectedAt: previous?.connectedAt ?? new Date(this.now()).toISOString()
    };
  }

  /** 验证 ID token 签名、issuer、audience、exp/iat、nonce 与主体。 */
  private async verifyIdentity(idToken: string | undefined, clientId: string, nonce?: string): Promise<{ sub: string; email?: string; iss?: string }> {
    if (!idToken) throw new Error("授权未返回 ID token。");
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: this.issuer,
      audience: clientId,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5
    });
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("ID token 主体无效。");
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error("ID token nonce 验证失败。");
    return {
      sub: payload.sub,
      ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      ...(typeof payload.iss === "string" ? { iss: payload.iss } : {})
    };
  }

  private async tokenRequest(body: Record<string, string>): Promise<ChatGptTokenResponse> {
    const response = await this.fetchImpl(`${this.issuer}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`OAuth token 请求失败（HTTP ${response.status}），请重新授权。`);
    return (await response.json()) as ChatGptTokenResponse;
  }

  /** 判断账户是否具备订阅生成权限。 */
  planEnabled(account: ChatGptAccountCredential | null | undefined): boolean {
    return Boolean(account?.accessToken) && Boolean(account?.scopes?.includes(CHATGPT_PLAN_SCOPE));
  }

  /** 有效 access token：到期前 60s 内合并续期。 */
  async accessToken(input: {
    ownerId: string;
    account: ChatGptAccountCredential;
    persist: (account: ChatGptAccountCredential) => void;
  }): Promise<string> {
    if (!this.planEnabled(input.account)) throw new Error("请先登录并同意使用 ChatGPT 订阅额度。");
    if (input.account.expiresAt > this.now() + 60_000) return input.account.accessToken;
    const key = input.ownerId;
    let pending = this.refreshing.get(key);
    if (!pending) {
      pending = this.refresh(input.account).finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, pending);
    }
    const next = await pending;
    // 轮换后的 refresh token 原子保存；较旧记录不覆盖。
    input.persist(next);
    if (!this.planEnabled(next)) throw new Error("续期后没有订阅额度授权，请重新授权。");
    return next.accessToken;
  }

  private async refresh(account: ChatGptAccountCredential): Promise<ChatGptAccountCredential> {
    if (!account.refreshToken) throw new Error("缺少 refresh_token，请重新授权。");
    const tokens = await this.tokenRequest({
      grant_type: "refresh_token",
      client_id: account.clientId,
      refresh_token: account.refreshToken,
      resource: this.resource
    });
    let identity = { sub: account.subject, ...(account.email ? { email: account.email } : {}), ...(account.iss ? { iss: account.iss } : {}) };
    if (tokens.id_token) {
      const verified = await this.verifyIdentity(tokens.id_token, account.clientId);
      if (verified.sub !== account.subject) throw new Error("续期返回了不同身份。");
      identity = verified;
    }
    return this.buildAccount(account.clientId, identity, tokens, account);
  }

  /** 尽力撤销 refresh token；失败返回 false（本地清除仍进行）。 */
  async revoke(account: ChatGptAccountCredential): Promise<boolean> {
    if (!account.refreshToken) return true;
    try {
      const discovery = await this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000)
      });
      const config = (await discovery.json()) as { revocation_endpoint?: string };
      if (!config.revocation_endpoint) return false;
      if (new URL(config.revocation_endpoint).origin !== this.issuer) return false;
      const response = await this.fetchImpl(config.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: account.refreshToken,
          token_type_hint: "refresh_token",
          client_id: account.clientId
        }),
        signal: AbortSignal.timeout(10_000)
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /** 稳定 host 标识（每 owner 一个文件由上层保存；这里仅生成）。 */
  newHostId(): string {
    return `urn:uuid:${(this.deps.uuid ?? randomUUID)()}`;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
