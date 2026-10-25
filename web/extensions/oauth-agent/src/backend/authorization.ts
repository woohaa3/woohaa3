/**
 * ChatGPT 个人授权状态机与事务编排
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 2.3/2.4/2.5 / design D3）。
 *
 * 状态：`disconnected` / `authorizing` / `connected-without-plan` / `ready` /
 * `reauthorization-required`。仅身份登录（无订阅 scope）不启用生成。每笔事务一次性消费，
 * 绑定 owner 与浏览器会话；回调只通知结果，不传 token。
 */
import type { IncomingMessage } from "node:http";
import type { ChatGptAuthSnapshot } from "@woohaa3/contracts";
import type { ChatGptAccountCredential, ChatGptCredentialStore } from "./credentials.js";
import type { ChatGptOAuth, ChatGptTransaction } from "./oauth.js";
import type { OwnerResolver, ResolvedOwner } from "./identity.js";

export type AuthorizationResult =
  | { ok: true; snapshot: ChatGptAuthSnapshot; setCookie?: string }
  | { ok: false; status: number; code: string; message: string };

export type AuthorizeStartResult =
  | { ok: true; url: string; expiresAt: number; setCookie?: string }
  | { ok: false; status: number; code: string; message: string };

export type ChatGptAuthorizationService = {
  snapshot: (ownerId: string, ownerKind: "principal" | "local-session") => ChatGptAuthSnapshot;
  /** 返回授权 URL 并记录事务（owner 已由调用方解析，redirectUri 由部署/请求派生）。 */
  start: (input: { owner: ResolvedOwner; req: IncomingMessage; redirectUri: string }) => Promise<AuthorizeStartResult>;
  /** 完成授权回调。 */
  complete: (input: { owner: ResolvedOwner; req: IncomingMessage; query: Record<string, string | string[] | undefined> }) => Promise<AuthorizationResult>;
  cancelAuthorization?: (ownerId: string) => void;
  /** 断开：终止推理、撤销并清除本地 token；返回远程撤销是否确认。 */
  disconnect: (ownerId: string) => Promise<{ revoked: boolean }>;
  /** 确保有效 access token（必要时续期并持久化）；不可用时抛出可读错误。 */
  ensureAccessToken: (ownerId: string) => Promise<string>;
  /** 读取账户（不含 token 暴露给外部的用途由调用方约束）。 */
  account: (ownerId: string) => ChatGptAccountCredential | null;
  /** 供生成层读取 owner 与 token 的受控入口。 */
  credentialOwnerKind: (ownerId: string) => "principal" | "local-session";
};

export type ChatGptAuthorizationOptions = {
  store: ChatGptCredentialStore;
  oauth: ChatGptOAuth;
  owners: OwnerResolver;
  now?: () => number;
};

function sessionBindingOf(owner: ResolvedOwner, _req: IncomingMessage): string {
  // 绑定浏览器会话：使用**已认证的 owner 身份**，而不是原始 cookie 头。
  //
  // 本地会话的 `owner.ownerId`（`local:<id>`）本就读自服务端签名的 HttpOnly 会话 cookie，
  // 已经是稳定、每浏览器会话唯一的身份；生产 principal 模式下 ownerId 是可信 `principal.subject`。
  // 原始 `Cookie` 头在 start（同源 XHR）与回调（跨站顶层导航）之间并不稳定——额外 cookie、顺序、
  // 以及 SameSite 行为都会让它不同，从而把**同一会话**误判为不匹配（实测：授权回调报
  // 「授权事务与当前浏览器会话不匹配」）。owner 身份才是正确的绑定对象。
  return owner.ownerId;
}

export function createChatGptAuthorizationService(
  options: ChatGptAuthorizationOptions
): ChatGptAuthorizationService {
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, ChatGptTransaction>();
  const generations = new Map<string, number>();
  const cancelAuthorization = (ownerId: string) => {
    generations.set(ownerId, (generations.get(ownerId) ?? 0) + 1);
    for (const [state, transaction] of pending) if (transaction.ownerId === ownerId) pending.delete(state);
  };
  /** 已签发但尚未持久化的 host id（首次授权时）；完成时并入账户记录。 */
  const pendingHosts = new Map<string, string>();

  const readAccount = (ownerId: string): ChatGptAccountCredential | null => {
    return options.store.read(ownerId)?.account ?? null;
  };

  const persistAccount = (ownerId: string, account: ChatGptAccountCredential): void => {
    const existing = options.store.read(ownerId);
    const host = existing?.host ?? { extAgentHostId: pendingHosts.get(ownerId) ?? options.oauth.newHostId() };
    pendingHosts.delete(ownerId);
    options.store.write(ownerId, { account, host });
  };

  const snapshot = (ownerId: string, ownerKind: "principal" | "local-session"): ChatGptAuthSnapshot => {
    const account = readAccount(ownerId);
    const hasPending = [...pending.values()].some((t) => t.ownerId === ownerId);
    const base = {
      localSession: ownerKind === "local-session",
      ownerKind
    } as const;
    if (!account) {
      return { state: hasPending ? "authorizing" : "disconnected", planEnabled: false, ...base };
    }
    if (!options.oauth.planEnabled(account)) {
      return {
        state: "connected-without-plan",
        planEnabled: false,
        account: viewOf(account),
        message: "已登录，但未同意使用 ChatGPT 订阅额度，请重新授权。",
        ...base
      };
    }
    // 续期失败/权限缺失/主体变化由 ensureAccessToken 标记；状态为 expired 视为需重新授权。
    if (account.expiresAt <= now() - 24 * 60 * 60 * 1000) {
      return {
        state: "reauthorization-required",
        planEnabled: false,
        account: viewOf(account),
        message: "授权已过期，请重新授权。",
        ...base
      };
    }
    return { state: "ready", planEnabled: true, account: viewOf(account), ...base };
  };

  const fail = (status: number, code: string, message: string): AuthorizationResult => ({ ok: false, status, code, message });

  return {
    snapshot,
    account: readAccount,
    cancelAuthorization,
    credentialOwnerKind: (ownerId) => snapshot(ownerId, "local-session").ownerKind,
    async start(input): Promise<AuthorizeStartResult> {
      const owner = input.owner;
      cancelAuthorization(owner.ownerId);
      const existing = readAccount(owner.ownerId);
      // 稳定 host 标识：优先复用已保存的，否则新建并**立即持久化**（即使授权尚未完成），
      // 使同一 owner 多次授权得到同一 host id。参照已验证 demo 的 ext_agent_host_id 语义。
      const storedRecord = options.store.read(owner.ownerId);
      let hostId = storedRecord?.host?.extAgentHostId;
      if (!hostId) {
        hostId = options.oauth.newHostId();
        if (existing) {
          options.store.write(owner.ownerId, { account: existing, host: { extAgentHostId: hostId } });
        } else {
          // 尚无账户时也保留 host：用一个占位账户结构持久化会污染状态，因此仅在本事务使用，
          // 完成时 persistAccount 会复用现有 host。
          pendingHosts.set(owner.ownerId, hostId);
        }
      }
      const { transaction, url } = options.oauth.begin({
        redirectUri: input.redirectUri,
        ownerId: owner.ownerId,
        sessionBinding: sessionBindingOf(owner, input.req),
        hostId,
        account: existing
      });
      pending.set(transaction.state, transaction);
      // 清理过期事务，防止无界增长。
      for (const [state, t] of pending) {
        if (t.expiresAt <= now()) pending.delete(state);
      }
      return {
        ok: true,
        url,
        expiresAt: transaction.expiresAt,
        ...(owner.setCookie ? { setCookie: owner.setCookie } : {})
      };
    },
    async complete(input): Promise<AuthorizationResult> {
      const owner = input.owner;
      const state = Array.isArray(input.query.state) ? input.query.state[0] : input.query.state;
      if (typeof state !== "string" || state === "") return fail(400, "invalid-request", "回调缺少 state。");
      const transaction = pending.get(state);
      // 一次性消费：先移除，失败也不能重放。
      pending.delete(state);
      if (!transaction) return fail(400, "invalid-transaction", "授权事务不存在或已被使用，请重新授权。");
      const generation = generations.get(owner.ownerId) ?? 0;
      if (transaction.ownerId !== owner.ownerId) return fail(400, "authorization-failed", "授权事务不属于当前账号，请重新登录。");
      try {
        const account = await options.oauth.complete({
          transaction,
          query: input.query,
          ownerId: owner.ownerId,
          sessionBinding: sessionBindingOf(owner, input.req)
        });
        if ((generations.get(owner.ownerId) ?? 0) !== generation) return fail(409, "authorization-cancelled", "授权已取消或重试，旧回调已丢弃。");
        persistAccount(owner.ownerId, account);
        return {
          ok: true,
          snapshot: snapshot(owner.ownerId, owner.ownerKind),
          ...(owner.setCookie ? { setCookie: owner.setCookie } : {})
        };
      } catch (error) {
        return fail(400, "authorization-failed", error instanceof Error ? error.message : String(error));
      }
    },
    async disconnect(ownerId): Promise<{ revoked: boolean }> {
      // 取消本 owner 未完成事务。
      cancelAuthorization(ownerId);
      const record = options.store.read(ownerId);
      // Publish local revocation before waiting for a remote service.
      options.store.clear(ownerId);
      pendingHosts.delete(ownerId);
      let revoked = true;
      if (record?.account) revoked = await options.oauth.revoke(record.account);
      return { revoked };
    },
    async ensureAccessToken(ownerId): Promise<string> {
      const account = readAccount(ownerId);
      if (!account) throw new Error("尚未授权 ChatGPT。");
      const generation = generations.get(ownerId) ?? 0;
      const stillCurrent = () => (generations.get(ownerId) ?? 0) === generation && readAccount(ownerId)?.connectedAt === account.connectedAt && readAccount(ownerId)?.subject === account.subject;
      const token = await options.oauth.accessToken({
        ownerId, account, persist: (next) => {
          if (!stillCurrent()) throw new Error("授权已撤销，丢弃迟到续期");
          persistAccount(ownerId, next);
        },
      });
      if (!stillCurrent()) throw new Error("授权已撤销");
      return token;
    }
  };
}

function viewOf(account: ChatGptAccountCredential): { email?: string; subject: string; connectedAt: string } {
  return {
    ...(account.email ? { email: account.email } : {}),
    subject: account.subject,
    connectedAt: account.connectedAt
  };
}
