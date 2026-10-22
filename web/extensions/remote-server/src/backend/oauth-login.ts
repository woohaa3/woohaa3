/**
 * 本机宿主侧的浏览器授权码登录（授权码 + PKCE S256 + loopback 回调）。
 *
 * 为什么这条路径在宿主里而不是浏览器里（change: 2026-10-20-add-local-oauth-login，design D1/D5）：
 * - 本机宿主是 **public client**：它没有、也不该有企业应用签名令牌，所以授权码流程分两段——
 *   浏览器在服务端走企业统一登录，服务端签发**本服务的**一次性授权码，经 loopback 回调交给宿主；
 * - 授权码只在服务端回调里出现一次，回调在宿主内部换会话并落库，页面脚本与前端 store 都看不到它；
 * - state 与 verifier 只存在本进程内（有界、TTL 10 分钟、一次性），日志里也只有稳定码。
 *
 * 与设备码的关系（design D6）：这是「浏览器与宿主同机」时的默认路径，设备码永远保留为兜底。
 * 因此本模块在任何一步失败时都只给**稳定码 + 中文短语**，让面板能立刻把短码摆出来。
 */
import { createHash, randomBytes } from "node:crypto";
import type { ApplicationExtensionRawRequest, ApplicationExtensionRawResponse } from "@woohaa3/contracts";
import {
  IDENTITY_SERVICE,
  OAUTH_LOGIN_UNSUPPORTED,
  buildTofAuthorizeUrl,
  connectProcedurePath,
  oauthCallbackUrl,
  oauthDonePath,
  parseLoopbackOrigin,
  parseServerUrl,
  resolveRemoteEndpoints,
  type RemoteOAuthLoginPoll,
  type RemoteOAuthLoginStartResult,
  type RemoteServerSnapshot
} from "../shared.js";
import { callConnect, readString } from "./connect.js";
import { parseSessionExpiry, type RemoteSession, type RemoteSessionSource } from "./session.js";

/** 一次浏览器授权尝试的存活时间：超过它，state 与 verifier 一起作废（design D5/D7）。 */
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
/** 进行中尝试的上限：进程内表必须有界，否则一个能开页面的浏览器就能把它撑爆。 */
export const OAUTH_PENDING_LIMIT = 32;
/** 已落定结果的上限（回调写、轮询读）；同样有界。 */
export const OAUTH_RESULT_LIMIT = 32;
/** 结果记录的存活时间：轮询最多等 5 分钟，留一倍余量给「页面开着回来再点一次」。 */
const OAUTH_RESULT_TTL_MS = OAUTH_ATTEMPT_TTL_MS;
/** state 形状：16 字节 hex（与 oauth-start 生成的一致）。 */
const STATE_PATTERN = /^[0-9a-f]{32}$/;

/** 只允许写进日志的稳定事件名（design D8）。 */
export type OAuthLoginLogEvent = "remote-oauth-start" | "remote-oauth-approved" | "remote-oauth-failed";

/**
 * 一条浏览器登录诊断事件。
 *
 * 形状刻意收窄：**没有**能装 code / verifier / challenge / state / 令牌的位置，只有稳定码、
 * 阶段与远端主机。调用方一旦拿不到能装秘密的键，就不会写错。
 */
export type OAuthLoginLogInput = {
  event: OAuthLoginLogEvent;
  level?: "debug" | "info" | "warn" | "error";
  code?: string;
  reason?: string;
  /** 远端基址（由调用方折成主机名后进日志）。 */
  serverUrl?: string | null;
  status?: number;
};

export type OAuthLoginOptions = {
  now: () => number;
  fetchImpl: typeof globalThis.fetch;
  /**
   * 当前可用的远端基址；未配置为 null（= 纯本地，不是错误）。
   *
   * 允许返回 Promise：地址回落（部署配置 → 已登录会话）在宿主侧是异步的，这里只负责 await
   * 一次，不自己判来源——判据只有 `resolveServerUrl` 一处。
   */
  configuredServerUrl: () => string | null | Promise<string | null>;
  /**
   * 唯一会话来源；这里只用 save。
   *
   * 为什么只取 save：会话落库后由 sessionSource 的 onSessionChanged 通知宿主重新解析画布
   * 同步上游（见 backend/index.ts 的装配）。回调里再手动调一次 refresh 会变成两次解析，
   * 而「会话变了就通知」本来就该只有一个入口。
   */
  sessionSource: Pick<RemoteSessionSource, "save">;
  /** 会话到浏览器快照的唯一投影（与其它 handler 同一口径，避免两处各写一份形状）。 */
  snapshotOf: (session: RemoteSession) => RemoteServerSnapshot;
  /** 应用基址（反代子路径部署）；缺省空串。 */
  basePath: () => string;
  /** 宿主是否提供 registerRawHttpHandler：缺失时回调无处落地，oauth-start 必须回 unsupported。 */
  rawHttpAvailable: boolean;
  log: (input: OAuthLoginLogInput) => void;
};

export type OAuthLoginController = {
  start: (body: unknown) => Promise<{ status: number; body: RemoteOAuthLoginStartResult }>;
  poll: (body: unknown) => Promise<{ status: number; body: RemoteOAuthLoginPoll }>;
  /** 服务端 302 回来的入口：换码、落会话、302 到完成页。 */
  handleCallback: (req: ApplicationExtensionRawRequest, res: ApplicationExtensionRawResponse) => Promise<void>;
  /** 完成页：只渲染「成功/失败，可以关闭此窗口」。 */
  handleDone: (req: ApplicationExtensionRawRequest, res: ApplicationExtensionRawResponse) => Promise<void>;
};

/** 进行中的一次尝试（只在进程内；绝不进响应体、日志或磁盘）。 */
type PendingAttempt = {
  verifier: string;
  redirectUri: string;
  serverUrl: string;
  expiresAt: number;
};

/**
 * 回调落定的结果：成功带快照（浏览器只读快照，令牌不出宿主），失败带**稳定码 + 中文短语**。
 *
 * 为什么两者都留：面板只需要短语，而排障（日志、上报、将来的诊断面）要能按稳定码检索，
 * 「授权过期」与「服务端暂时不可用」的下一步完全不同。
 */
type AttemptOutcome =
  | { kind: "approved"; snapshot: RemoteServerSnapshot }
  | { kind: "failed"; code: string; error: string };

type StoredOutcome = AttemptOutcome & { expiresAt: number };

/** 一眼可读的失败短语：只按稳定码映射，远端正文永远不进这里。 */
const OAUTH_FAILURE_TEXT: Record<string, string> = {
  tof_state_invalid: "企业统一登录的会话已失效，请重新发起",
  tof_invalid_code: "企业统一登录没有完成（授权码无效）",
  tof_expired: "授权码已过期，请重新发起",
  tof_unable: "服务端暂时无法完成登录",
  unreachable: "无法连接远端服务端",
  timeout: "远端响应超时"
};

function failureText(code: string): string {
  return OAUTH_FAILURE_TEXT[code] ?? "登录没有完成";
}

/** 服务端回调带回来的错误码只认自己那四种；其余一律折算成 tof_unable（不反射远端文本）。 */
function normalizeTofError(raw: string): string {
  switch (raw) {
    case "tof_state_invalid":
    case "tof_invalid_code":
    case "tof_expired":
    case "tof_unable":
      return raw;
    default:
      return "tof_unable";
  }
}

/**
 * 换码失败的稳定码。
 *
 * ExchangeLocalLogin 的失败只有两类：**这张码/这次授权不被接受**（未认证、参数非法、已被用过）
 * 与**远端根本没答上来**（网络、超时、未实现）。两者的下一步不同，所以不能压成一个「登录失败」。
 */
function exchangeFailureCode(result: { status: number; code: string }): string {
  if (result.status === 0) return result.code === "timeout" ? "timeout" : "unreachable";
  if (result.code === "unauthenticated" || result.code === "permission_denied" || result.code === "invalid_argument") {
    return "tof_invalid_code";
  }
  return "tof_unable";
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function readStringField(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : null;
}

/** 清掉过期记录；Map 保序，所以下面按插入顺序淘汰最老的。 */
function pruneExpired<K, V extends { expiresAt: number }>(store: Map<K, V>, now: number): void {
  for (const [key, value] of store) {
    if (value.expiresAt <= now) store.delete(key);
  }
}

/** 写入并保证有界（超限淘汰最老的）。 */
function remember<K, V extends { expiresAt: number }>(store: Map<K, V>, key: K, value: V, limit: number): void {
  store.set(key, value);
  while (store.size > limit) {
    const oldest = store.keys().next();
    if (oldest.done === true) break;
    store.delete(oldest.value);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 完成页 HTML。
 *
 * 只有常量文案与（已经映射成中文的）失败短语，**没有** code / verifier / state / 令牌：
 * 这个页面是服务端渲染的终点，地址栏与历史里也不该留下任何凭据（design D5）。
 */
function renderDonePage(input: { ok: boolean; message: string }): string {
  const title = input.ok ? "登录成功" : "登录未完成";
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"referrer\" content=\"no-referrer\">",
    "<meta name=\"robots\" content=\"noindex\">",
    "<title>" + title + "</title>",
    "<style>",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    "background:#f6f7f9;color:#1f2329;font:14px/1.6 system-ui,-apple-system,\"Segoe UI\",sans-serif}",
    "main{max-width:420px;padding:28px 32px;border-radius:12px;background:#fff;",
    "box-shadow:0 1px 3px rgba(15,23,42,.12);text-align:center}",
    "h1{margin:0 0 12px;font-size:18px}",
    "p{margin:0;color:#4b5563}",
    "</style>",
    "</head>",
    "<body><main>",
    "<h1>" + title + "</h1>",
    "<p>" + escapeHtml(input.message) + "</p>",
    "</main></body>",
    "</html>"
  ].join("");
}

/** 回调与完成页共用的安全响应头：这类响应不该被缓存、也不该把地址栏/来源带给下一跳。 */
function setBrowserAuthHeaders(res: ApplicationExtensionRawResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendText(res: ApplicationExtensionRawResponse, status: number, text: string): void {
  setBrowserAuthHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function sendHtml(res: ApplicationExtensionRawResponse, status: number, html: string): void {
  setBrowserAuthHeaders(res);
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function sendRedirect(res: ApplicationExtensionRawResponse, location: string): void {
  setBrowserAuthHeaders(res);
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

/** 读一次请求的 URL（只用来取 query；路径本身由宿主的路由决定）。 */
function requestUrl(req: ApplicationExtensionRawRequest): URL | null {
  const raw = typeof req.url === "string" ? req.url : "";
  if (raw === "") return null;
  try {
    return new URL(raw, "http://localhost");
  } catch {
    return null;
  }
}

/**
 * 浏览器授权码登录的宿主侧状态机。
 *
 * 三张表（都可以为空、都有界、都按时间淘汰）：
 * - pending：state → verifier/redirect_uri/serverUrl（回调命中后**先消费再使用**）；
 * - outcomes：state → 成功快照或失败短语（轮询**一次性**读取；完成页只 peek 不清）；
 * - 会话本身不在这里：它属于 sessionSource（唯一归属）。
 */
export function createOAuthLogin(options: OAuthLoginOptions): OAuthLoginController {
  const pending = new Map<string, PendingAttempt>();
  const outcomes = new Map<string, StoredOutcome>();

  const recordOutcome = (state: string, outcome: AttemptOutcome): void => {
    pruneExpired(outcomes, options.now());
    remember(outcomes, state, { ...outcome, expiresAt: options.now() + OAUTH_RESULT_TTL_MS }, OAUTH_RESULT_LIMIT);
  };

  /**
   * 一条失败的发起结果。
   *
   * error 是**稳定码**：只有 unsupported 表示「这台环境没有这条路径」，面板据此直接改走短码；
   * 其余（not-configured / invalid-origin）也都会回退，但保留区分是为了日志与排障说得清。
   */
  const failStart = (
    error: string,
    code: string,
    reason: string,
    message: string
  ): { status: number; body: RemoteOAuthLoginStartResult } => {
    options.log({ event: "remote-oauth-failed", level: "warn", code, reason });
    return { status: 200, body: { ok: false, error, message } };
  };

  const unsupported = (code: string, reason: string, message: string) =>
    failStart(OAUTH_LOGIN_UNSUPPORTED, code, reason, message);

  return {
    /**
     * 发起一次浏览器登录。
     *
     * origin 由浏览器自报（window.location.origin），宿主**必须**校验它是 loopback：
     * redirect_uri 直接由它拼出来，放行别的 host 就等于把授权码送给攻击者（design D2）。
     *
     * 地址：**优先用请求体里的那个**（面板里刚填、还没落进 config.local.json 的草稿），
     * 缺省才回落到部署配置 / 已登录会话。此前这里只认回落链，于是「手填地址 + 首次登录」
     * 恒报 not-configured、面板静默改走短码——人明明打了地址，却被要求抄码，且没有任何
     * 说明。设备码那条路一直收面板地址，两条路必须同一个口径。
     *
     * 请求体里的地址仍然要过 parseServerUrl：它与探测（probe）用同一个解析器，因此
     * 「探测得通」与「能拿去发起授权」不会分成两套判断。
     */
    async start(body) {
      const origin = parseLoopbackOrigin(readStringField(body, "origin"));
      if (!origin.ok) return unsupported("invalid-origin", origin.message, "只能在本机页面上使用浏览器登录：" + origin.message);
      if (!options.rawHttpAvailable) {
        return unsupported("unsupported", "宿主没有提供公开 HTTP 回调", "当前宿主不支持浏览器登录，请改用短码");
      }
      const requested = readStringField(body, "serverUrl");
      let serverUrl: string | null;
      if (requested !== null && requested.trim() !== "") {
        const parsed = parseServerUrl(requested);
        if (!parsed.ok) return failStart("invalid-server-url", "invalid-server-url", parsed.message, parsed.message);
        serverUrl = parsed.value;
      } else {
        serverUrl = await options.configuredServerUrl();
      }
      if (serverUrl === null) {
        return failStart("not-configured", "not-configured", "没有配置服务端地址", "还没有配置服务端地址，无法发起浏览器登录");
      }
      if (serverUrl.startsWith("/")) {
        // 站内相对地址无法推出授权入口的绝对地址（服务端要求 redirect_uri 是绝对 loopback 地址）。
        return unsupported("unsupported", "站内相对地址无法构造绝对授权入口", "站内相对地址不支持浏览器登录，请改用短码");
      }

      const { rpcBase } = resolveRemoteEndpoints(serverUrl);
      const state = randomBytes(16).toString("hex");
      // verifier：32 字节 base64url = 43 字符，落在 RFC 7636 的 43–128 区间内。
      const verifier = base64Url(randomBytes(32));
      const codeChallenge = base64Url(createHash("sha256").update(verifier).digest());
      const redirectUri = oauthCallbackUrl(origin.value, options.basePath());
      const expiresAt = options.now() + OAUTH_ATTEMPT_TTL_MS;
      pruneExpired(pending, options.now());
      remember(pending, state, { verifier, redirectUri, serverUrl, expiresAt }, OAUTH_PENDING_LIMIT);
      options.log({ event: "remote-oauth-start", serverUrl });
      return {
        status: 200,
        body: {
          ok: true,
          attemptId: state,
          authorizeUrl: buildTofAuthorizeUrl({ rpcBase, redirectUri, state, codeChallenge }),
          expiresAt
        } satisfies RemoteOAuthLoginStartResult
      };
    },

    /**
     * 轮询一次：终态一次性读取（读过即清），避免同一份结果被反复交出去。
     */
    async poll(body) {
      const attemptId = readStringField(body, "attemptId");
      if (attemptId === null || !STATE_PATTERN.test(attemptId)) {
        return { status: 200, body: { state: "failed", code: "invalid-attempt", error: "这次登录请求无效，请重新发起" } };
      }
      const outcome = outcomes.get(attemptId);
      if (outcome !== undefined) {
        outcomes.delete(attemptId);
        pending.delete(attemptId);
        return {
          status: 200,
          body:
            outcome.kind === "approved"
              ? { state: "approved", snapshot: outcome.snapshot }
              : { state: "failed", code: outcome.code, error: outcome.error }
        };
      }
      const attempt = pending.get(attemptId);
      if (attempt === undefined) {
        return { status: 200, body: { state: "failed", code: "attempt-not-found", error: "这次登录请求已失效，请重新发起" } };
      }
      if (attempt.expiresAt <= options.now()) {
        pending.delete(attemptId);
        return {
          status: 200,
          body: { state: "failed", code: "attempt-expired", error: "这次登录等待已超时，请重新发起或改用短码" }
        };
      }
      return { status: 200, body: { state: "pending" } };
    },

    /**
     * 服务端 302 回来的回调（公开路由，GET）。
     *
     * 顺序很重要：**先消费 state、再用它**。这样即使换码过程中抛出/超时，重放同一个回调也
     * 命中不了第二次（design D5「一次性」）。
     */
    async handleCallback(req, res) {
      const url = requestUrl(req);
      if (url === null) return sendText(res, 400, "无法解析这次回调的地址");
      const state = url.searchParams.get("state") ?? "";
      if (!STATE_PATTERN.test(state)) return sendText(res, 400, "回调缺少有效的 state 参数");
      const attempt = pending.get(state);
      pending.delete(state);
      if (attempt === undefined) return sendText(res, 400, "这次登录请求已失效（state 不匹配或已被使用）");

      const doneUrl = oauthDonePath(options.basePath()) + "?attempt=" + encodeURIComponent(state);

      // 过期的尝试按「state 没命中」处理（design D5：命中不了 pending 就 400）：
      // 它没有任何可交换的东西，给一个完成页只会让人以为「还有救」。
      if (attempt.expiresAt <= options.now()) {
        options.log({ event: "remote-oauth-failed", level: "warn", code: "tof_expired", reason: "state 已过期", serverUrl: attempt.serverUrl });
        return sendText(res, 400, "这次登录请求已过期，请回到应用重新发起");
      }

      // 服务端在失败时带 error=tof_* 回来；把它映射成稳定码与中文短语，绝不反射远端正文。
      const returnedError = url.searchParams.get("error");
      if (returnedError !== null && returnedError !== "") {
        const code = normalizeTofError(returnedError);
        options.log({ event: "remote-oauth-failed", level: "warn", code, reason: "授权入口返回失败", serverUrl: attempt.serverUrl });
        recordOutcome(state, { kind: "failed", code, error: failureText(code) });
        return sendRedirect(res, doneUrl);
      }

      const code = url.searchParams.get("code") ?? "";
      if (code === "") {
        options.log({ event: "remote-oauth-failed", level: "warn", code: "tof_invalid_code", reason: "回调没有带回授权码", serverUrl: attempt.serverUrl });
        recordOutcome(state, { kind: "failed", code: "tof_invalid_code", error: failureText("tof_invalid_code") });
        return sendRedirect(res, doneUrl);
      }

      const exchanged = await callConnect<unknown>(
        options.fetchImpl,
        attempt.serverUrl,
        connectProcedurePath(IDENTITY_SERVICE, "ExchangeLocalLogin"),
        { code, codeVerifier: attempt.verifier, redirectUri: attempt.redirectUri }
      );
      if (!exchanged.ok) {
        const stable = exchangeFailureCode(exchanged);
        options.log({
          event: "remote-oauth-failed",
          level: "warn",
          code: stable,
          reason: exchanged.message,
          serverUrl: attempt.serverUrl,
          status: exchanged.status
        });
        recordOutcome(state, { kind: "failed", code: stable, error: failureText(stable) });
        return sendRedirect(res, doneUrl);
      }

      const token = readString(exchanged.value, "sessionToken");
      const subjectId = readString(exchanged.value, "subjectId");
      if (token === null || subjectId === null) {
        options.log({
          event: "remote-oauth-failed",
          level: "warn",
          code: "invalid-response",
          reason: "远端返回的会话形状不符",
          serverUrl: attempt.serverUrl
        });
        recordOutcome(state, { kind: "failed", code: "invalid-response", error: "服务端返回的会话形状不符，请改用短码" });
        return sendRedirect(res, doneUrl);
      }

      const session: RemoteSession = {
        serverUrl: attempt.serverUrl,
        token,
        subject: subjectId,
        displayName: null,
        expiresAt: parseSessionExpiry(readString(exchanged.value, "expiresAt"), options.now())
      };
      await options.sessionSource.save(session);
      recordOutcome(state, { kind: "approved", snapshot: options.snapshotOf(session) });
      options.log({ event: "remote-oauth-approved", serverUrl: attempt.serverUrl });
      return sendRedirect(res, doneUrl);
    },

    /**
     * 完成页。
     *
     * 只 peek 结果（不清）：清的理由只属于轮询——页面可能被刷新，而面板还在等那个结果。
     */
    async handleDone(req, res) {
      const url = requestUrl(req);
      const attempt = url?.searchParams.get("attempt") ?? "";
      const outcome = STATE_PATTERN.test(attempt) ? outcomes.get(attempt) : undefined;
      if (outcome === undefined) {
        return sendHtml(
          res,
          200,
          renderDonePage({
            ok: false,
            message: "这次登录结果已不可用（可能已被读取或已过期）。可以关闭此窗口，回到应用重试。"
          })
        );
      }
      if (outcome.kind === "approved") {
        return sendHtml(res, 200, renderDonePage({ ok: true, message: "登录成功，可以关闭此窗口回到应用。" }));
      }
      return sendHtml(
        res,
        200,
        renderDonePage({
          ok: false,
          message: "登录失败：" + outcome.error + "。可以关闭此窗口，或回到应用改用短码。"
        })
      );
    }
  };
}
