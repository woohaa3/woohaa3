/**
 * 微信扫码登录状态机。
 *
 * 边界：
 * - pending 只在宿主内存，最多 3 条、TTL 5 分钟；过期、取消、失败后立刻移除。
 * - 同一 `loginId` 的 `userinfo + bridge` **至多执行一次**：进入授权分支先置 `authorizing`，
 *   后续并发轮询只返回已扫码。
 * - 终态单独保留一小段时间（不在 pending 表里），让「授权成功后又轮询一次」拿到既有结果，
 *   而不是重新换令牌。
 * - 会话写入前比对 `session.epoch()`；登出发生在授权途中时丢弃这次结果。
 */
import { randomUUID } from "node:crypto";
import type {
  SdpppxBalance,
  SdpppxErrorCode,
  SdpppxFailure,
  SdpppxLoginStart,
  SdpppxLoginStatus,
  SdpppxResult,
  SdpppxSessionView
} from "../shared.js";
import { SDPPPX_ERROR_CODES } from "../shared.js";
import type { SdpppxConfig } from "./config.js";
import { SdpppxHttpError } from "./http.js";
import { resolveAuthingTarget } from "./app-id.js";
import {
  checkAuthingQr,
  exchangeAuthingUser,
  fetchQrImageDataUrl,
  geneAuthingQr,
  type AuthingQrTarget
} from "./authing-qr.js";
import { BridgeError, exchangeAuthingToken } from "./bridge.js";
import { fetchSdpppxBalance } from "./balance.js";
import { sessionView, type SessionManager, type SdpppxSession } from "./session.js";

export const SDPPPX_LOGIN_TTL_MS = 5 * 60 * 1000;
export const SDPPPX_LOGIN_MAX_PENDING = 3;
const TERMINAL_TTL_MS = SDPPPX_LOGIN_TTL_MS;
const TERMINAL_LIMIT = 8;

type PendingLogin = {
  loginId: string;
  random: string;
  expiresAt: number;
  epoch: number;
  phase: "pending" | "scanned";
  authorizing: boolean;
  target: AuthingQrTarget;
  nickname?: string | null;
  avatarUrl?: string | null;
};

type TerminalLogin = {
  at: number;
  status: SdpppxLoginStatus;
};

export type SdpppxLoginFlowOptions = {
  config: () => SdpppxConfig;
  session: SessionManager;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
  /** 登录成功后的副作用（刷新目录）；失败不影响登录结果。 */
  onAuthorized?: (view: SdpppxSessionView) => Promise<void> | void;
  /** 余额读取（测试注入）；缺省走 Supabase。 */
  loadBalance?: (session: SdpppxSession) => Promise<SdpppxBalance | null>;
};

export type SdpppxLoginFlow = ReturnType<typeof createSdpppxLoginFlow>;

function failure(code: SdpppxErrorCode, message: string, missing?: string[]): SdpppxFailure {
  return { ok: false, code, message, ...(missing ? { missing } : {}) };
}

function codeOf(error: unknown, fallback: SdpppxErrorCode): SdpppxErrorCode {
  if (error instanceof SdpppxHttpError) {
    const codes = Object.values(SDPPPX_ERROR_CODES) as string[];
    if (codes.includes(error.code)) return error.code as SdpppxErrorCode;
  }
  return fallback;
}

export function createSdpppxLoginFlow(options: SdpppxLoginFlowOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const pending = new Map<string, PendingLogin>();
  const terminal = new Map<string, TerminalLogin>();

  const balanceFor = async (session: SdpppxSession): Promise<SdpppxBalance | null> => {
    if (options.loadBalance) return options.loadBalance(session);
    return fetchSdpppxBalance({
      config: options.config(),
      accessToken: session.accessToken,
      userId: session.userId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
  };

  function recordTerminal(loginId: string, status: SdpppxLoginStatus): void {
    terminal.delete(loginId);
    terminal.set(loginId, { at: now(), status });
    while (terminal.size > TERMINAL_LIMIT) {
      const oldest = terminal.keys().next().value;
      if (typeof oldest !== "string") break;
      terminal.delete(oldest);
    }
  }

  function expireIfNeeded(entry: PendingLogin): boolean {
    if (entry.expiresAt > now()) return false;
    pending.delete(entry.loginId);
    recordTerminal(entry.loginId, { phase: "expired" });
    log({ event: "sdpppx-login-expired", loginIdPresent: true });
    return true;
  }

  function prune(): void {
    const current = now();
    for (const entry of [...pending.values()]) {
      if (entry.expiresAt <= current) {
        pending.delete(entry.loginId);
        recordTerminal(entry.loginId, { phase: "expired" });
      }
    }
    for (const [loginId, record] of [...terminal.entries()]) {
      if (current - record.at > TERMINAL_TTL_MS) terminal.delete(loginId);
    }
  }

  function authorizedStatus(session: SdpppxSession, balance: SdpppxBalance | null): SdpppxLoginStatus {
    return {
      phase: "authorized",
      nickname: session.displayName,
      avatarUrl: session.avatarUrl,
      session: sessionView(session, balance)
    };
  }

  async function authorize(entry: PendingLogin, ticket: string): Promise<SdpppxLoginStatus> {
    const config = options.config();
    const startedEpoch = entry.epoch;
    try {
      const authingUser = await exchangeAuthingUser(entry.target, ticket, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: 15_000
      });
      const session = await exchangeAuthingToken(config, authingUser.token, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        now,
        hint: {
          displayName: authingUser.nickname ?? entry.nickname ?? null,
          avatarUrl: authingUser.avatarUrl ?? entry.avatarUrl ?? null
        }
      });
      if (options.session.epoch() !== startedEpoch) {
        // 登出发生在扫码途中：结果属于旧主体，丢弃且不写会话。
        pending.delete(entry.loginId);
        recordTerminal(entry.loginId, { phase: "cancelled" });
        log({ event: "sdpppx-login-discarded-stale", reason: "epoch" });
        return { phase: "cancelled" };
      }
      await options.session.set(session);
      const balance = await balanceFor(session);
      const status = authorizedStatus(session, balance);
      pending.delete(entry.loginId);
      recordTerminal(entry.loginId, status);
      log({ event: "sdpppx-login-authorized" });
      if (options.onAuthorized && status.session) {
        try {
          await options.onAuthorized(status.session);
        } catch {
          log({ event: "sdpppx-post-login-refresh-failed", code: "sdpppx-catalog-unavailable" });
        }
      }
      return status;
    } catch (error) {
      pending.delete(entry.loginId);
      const code = error instanceof BridgeError
        ? SDPPPX_ERROR_CODES.loginFailed
        : codeOf(error, SDPPPX_ERROR_CODES.loginFailed);
      const status: SdpppxLoginStatus = {
        phase: "error",
        error: code === SDPPPX_ERROR_CODES.sessionExpired ? SDPPPX_ERROR_CODES.sessionExpired : code
      };
      recordTerminal(entry.loginId, status);
      log({ event: "sdpppx-login-failed", code });
      return status;
    }
  }

  async function start(): Promise<SdpppxResult<SdpppxLoginStart>> {
    const config = options.config();
    if (config.degradedCode !== null) {
      return failure(config.degradedCode, "缺少 SDPPPX 部署参数", config.missing);
    }
    prune();
    let target;
    try {
      target = await resolveAuthingTarget(config, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
      });
    } catch (error) {
      const code = codeOf(error, SDPPPX_ERROR_CODES.serviceUnavailable);
      log({ event: "sdpppx-authing-target-failed", code });
      return failure(
        code,
        code === SDPPPX_ERROR_CODES.authingAppMissing ? "租户未配置 Authing" : "服务暂不可用"
      );
    }
    let qr;
    try {
      qr = await geneAuthingQr(target, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: 15_000
      });
    } catch (error) {
      const code = codeOf(error, SDPPPX_ERROR_CODES.serviceUnavailable);
      log({ event: "sdpppx-qrcode-gene-failed", code });
      return failure(code, code === SDPPPX_ERROR_CODES.wechatUnavailable ? "未开通微信登录" : "服务暂不可用");
    }
    let qrDataUrl: string;
    try {
      qrDataUrl = await fetchQrImageDataUrl(qr.url, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: 15_000
      });
    } catch (error) {
      const code = codeOf(error, SDPPPX_ERROR_CODES.serviceUnavailable);
      log({ event: "sdpppx-qrcode-image-failed", code });
      return failure(code, "服务暂不可用");
    }

    while (pending.size >= SDPPPX_LOGIN_MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (typeof oldest !== "string") break;
      pending.delete(oldest);
    }
    const loginId = randomUUID();
    const expiresAt = now() + SDPPPX_LOGIN_TTL_MS;
    pending.set(loginId, {
      loginId,
      random: qr.random,
      expiresAt,
      epoch: options.session.epoch(),
      phase: "pending",
      authorizing: false,
      target
    });
    log({ event: "sdpppx-login-started", maxPending: pending.size });
    return { ok: true, loginId, qrDataUrl, phase: "pending", expiresAt };
  }

  async function status(loginId: string): Promise<SdpppxLoginStatus> {
    prune();
    const done = terminal.get(loginId);
    if (done) return done.status;
    const entry = pending.get(loginId);
    if (!entry) return { phase: "expired" };
    if (expireIfNeeded(entry)) return { phase: "expired" };
    if (entry.authorizing) {
      return { phase: entry.phase, nickname: entry.nickname ?? null, avatarUrl: entry.avatarUrl ?? null };
    }
    let check;
    try {
      check = await checkAuthingQr(entry.target, entry.random, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: 15_000
      });
    } catch (error) {
      // 网络中断保留 pending 到 TTL，让前端继续轮询；不把一次抖动变成登录失败。
      const code = codeOf(error, SDPPPX_ERROR_CODES.serviceUnavailable);
      log({ event: "sdpppx-qrcode-check-failed", code });
      return { phase: entry.phase };
    }
    if (expireIfNeeded(entry)) return { phase: "expired" };
    if (check.status === 1) {
      entry.phase = "scanned";
      entry.nickname = check.nickname ?? entry.nickname ?? null;
      entry.avatarUrl = check.avatarUrl ?? entry.avatarUrl ?? null;
      return { phase: "scanned", nickname: entry.nickname ?? null, avatarUrl: entry.avatarUrl ?? null };
    }
    if (check.status === 2) {
      if (entry.authorizing) {
        return { phase: "scanned", nickname: entry.nickname ?? null, avatarUrl: entry.avatarUrl ?? null };
      }
      const ticket = check.ticket;
      if (!ticket) {
        pending.delete(loginId);
        const failed: SdpppxLoginStatus = { phase: "error", error: SDPPPX_ERROR_CODES.loginFailed };
        recordTerminal(loginId, failed);
        return failed;
      }
      entry.authorizing = true;
      entry.nickname = check.nickname ?? entry.nickname ?? null;
      entry.avatarUrl = check.avatarUrl ?? entry.avatarUrl ?? null;
      return authorize(entry, ticket);
    }
    if (check.status === 3) {
      pending.delete(loginId);
      recordTerminal(loginId, { phase: "cancelled" });
      return { phase: "cancelled" };
    }
    if (check.status === -1) {
      pending.delete(loginId);
      recordTerminal(loginId, { phase: "expired" });
      return { phase: "expired" };
    }
    return { phase: entry.phase };
  }

  function cancel(loginId: string): void {
    prune();
    const entry = pending.get(loginId);
    if (entry) {
      pending.delete(loginId);
      recordTerminal(loginId, { phase: "cancelled" });
    }
  }

  function dispose(): void {
    pending.clear();
    terminal.clear();
  }

  return {
    start,
    status,
    cancel,
    dispose,
    pendingCount: () => pending.size
  };
}
