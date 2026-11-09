/**
 * 会话状态机与 owner-scoped 持久化。
 *
 * 边界：令牌只存在宿主进程与宿主的 documents 存储；本模块的对外读模型只有昵称、头像、
 * 到期时间与余额。`epoch` 在登出/切换主体时递增，登录流程据此丢弃迟到结果。
 */
import type { ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import type {
  SdpppxBalance,
  SdpppxErrorCode,
  SdpppxSessionStatus,
  SdpppxSessionView
} from "../shared.js";
import { SDPPPX_ERROR_CODES } from "../shared.js";
import type { SdpppxConfig } from "./config.js";
import { BridgeError, refreshSupabaseSession, type SupabaseSession } from "./bridge.js";
import { SdpppxHttpError } from "./http.js";

const SESSION_KEY = "session/current";
const REFRESH_AHEAD_MS = 30_000;

export type SdpppxSession = SupabaseSession;

export type SessionStore = {
  load(): Promise<SdpppxSession | null>;
  save(session: SdpppxSession | null): Promise<void>;
};

type PersistedSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
};

function isPersistedSession(value: unknown): value is PersistedSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    record.accessToken !== "" &&
    typeof record.refreshToken === "string" &&
    record.refreshToken !== "" &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    typeof record.userId === "string" &&
    (record.displayName === null || typeof record.displayName === "string") &&
    (record.avatarUrl === null || typeof record.avatarUrl === "string")
  );
}

/** 内存实现用于最小装配与测试；不参与跨重启保留。 */
export function createMemorySessionStore(initial: SdpppxSession | null = null): SessionStore {
  let current = initial;
  return {
    async load() {
      return current;
    },
    async save(session) {
      current = session;
    }
  };
}

/**
 * 文档存储实现。读失败（形状不符/存储不可用）一律当作「没有会话」；写失败必须抛出，
 * 不能假装登录成功。
 */
export function createDocumentSessionStore(store: ExtensionDocumentStore): SessionStore {
  return {
    async load() {
      try {
        const record = await store.get(SESSION_KEY);
        if (!record.found) return null;
        return isPersistedSession(record.document.value)
          ? { ...record.document.value }
          : null;
      } catch {
        return null;
      }
    },
    async save(session) {
      const value: ExtensionDocumentValue = session === null
        ? null
        : {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: session.expiresAt,
            userId: session.userId,
            displayName: session.displayName,
            avatarUrl: session.avatarUrl
          };
      const result = await store.batch([
        session === null ? { op: "delete", key: SESSION_KEY } : { op: "set", key: SESSION_KEY, value }
      ]);
      if (!result.ok) {
        throw new SdpppxHttpError(
          result.code === "revision-conflict" ? "会话写入冲突" : result.message,
          0,
          "sdpppx-service-unavailable"
        );
      }
    }
  };
}

export type SessionManagerOptions = {
  config: () => SdpppxConfig;
  store: SessionStore;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

export type SessionManager = ReturnType<typeof createSessionManager>;

/**
 * `epoch` 语义：每次 clear 递增。登录流程在 start 时记下 epoch，写会话前再比对；
 * 不匹配就丢弃这次迟到结果，避免「登出后旧扫码又把会话装回来」。
 */
export function createSessionManager(options: SessionManagerOptions) {
  const now = options.now ?? Date.now;
  let current: SdpppxSession | null = null;
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let epoch = 0;
  let notice: SdpppxErrorCode | null = null;
  let refreshInFlight: Promise<SdpppxSession> | null = null;
  let refreshController: AbortController | null = null;
  const log = options.log ?? (() => undefined);

  const isUsable = (session: SdpppxSession | null): session is SdpppxSession =>
    session !== null && session.expiresAt > now();

  async function load(): Promise<void> {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        current = await options.store.load();
      } catch {
        current = null;
      } finally {
        loaded = true;
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  async function persist(session: SdpppxSession | null): Promise<void> {
    await options.store.save(session);
  }

  async function refresh(): Promise<SdpppxSession> {
    if (refreshInFlight) return refreshInFlight;
    const session = current;
    if (!session) {
      throw new SdpppxHttpError("未登录", 401, SDPPPX_ERROR_CODES.sessionExpired);
    }
    const startedEpoch = epoch;
    const controller = new AbortController();
    refreshController = controller;
    const run = (async (): Promise<SdpppxSession> => {
      try {
        const next = await refreshSupabaseSession(options.config(), session.refreshToken, {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          now,
          signal: controller.signal
        });
        if (epoch !== startedEpoch) {
          // 登出发生在续期途中：结果属于旧主体，不得写回。
          throw new SdpppxHttpError("登录已过期", 401, SDPPPX_ERROR_CODES.sessionExpired);
        }
        current = next;
        notice = null;
        await persist(next);
        log({ event: "sdpppx-session-refreshed" });
        return next;
      } catch (error) {
        if (epoch !== startedEpoch) {
          throw new SdpppxHttpError("登录已过期", 401, SDPPPX_ERROR_CODES.sessionExpired);
        }
        if (error instanceof BridgeError && error.kind === "rejected") {
          await clear(SDPPPX_ERROR_CODES.sessionExpired);
          throw new SdpppxHttpError("登录已过期", 401, SDPPPX_ERROR_CODES.sessionExpired);
        }
        throw new SdpppxHttpError("会话续期暂不可用", 503, SDPPPX_ERROR_CODES.serviceUnavailable);
      }
    })();
    refreshInFlight = run;
    try {
      return await run;
    } finally {
      if (refreshInFlight === run) refreshInFlight = null;
      if (refreshController === controller) refreshController = null;
    }
  }

  async function accessToken(): Promise<string> {
    await load();
    const session = current;
    if (!session) {
      throw new SdpppxHttpError("未登录", 401, SDPPPX_ERROR_CODES.sessionExpired);
    }
    if (session.expiresAt - now() > REFRESH_AHEAD_MS) return session.accessToken;
    try {
      return (await refresh()).accessToken;
    } catch (error) {
      if (error instanceof SdpppxHttpError && error.code === SDPPPX_ERROR_CODES.sessionExpired) {
        throw error;
      }
      // 网络失败保留会话；已过期的会话本次请求失败，但不谎称还有效。
      throw new SdpppxHttpError(
        isUsable(session) ? "会话续期暂不可用" : "登录已过期",
        isUsable(session) ? 503 : 401,
        isUsable(session) ? SDPPPX_ERROR_CODES.serviceUnavailable : SDPPPX_ERROR_CODES.sessionExpired
      );
    }
  }

  async function ensureActive(): Promise<void> {
    await load();
    if (!current) return;
    if (current.expiresAt - now() > REFRESH_AHEAD_MS) return;
    try {
      await refresh();
    } catch {
      // 明确拒绝时 refresh 已清会话；网络失败时保留，状态由 expiresAt 决定。
    }
  }

  async function clear(reason: SdpppxErrorCode | null = null): Promise<void> {
    epoch += 1;
    current = null;
    notice = reason;
    refreshController?.abort();
    refreshController = null;
    refreshInFlight = null;
    try {
      await persist(null);
    } catch (error) {
      // 登出必须让内存立即不可用；存储写入失败的诊断交给调用方日志，不把令牌留在内存。
      log({ event: "sdpppx-session-clear-failed", code: "sdpppx-service-unavailable" });
      void error;
    }
  }

  async function set(session: SdpppxSession): Promise<void> {
    // 先写存储再切内存：写失败不能留下「界面已登录、重启就没了」的假象。
    await persist(session);
    current = session;
    notice = null;
    log({ event: "sdpppx-session-set", userIdPresent: session.userId !== "" });
  }

  function status(): SdpppxSessionStatus {
    const config = options.config();
    if (config.degradedCode !== null) return "unconfigured";
    return isUsable(current) ? "authenticated" : "anonymous";
  }

  return {
    load,
    accessToken,
    ensureActive,
    clear,
    set,
    status,
    epoch: () => epoch,
    notice: () => notice,
    session: () => (isUsable(current) ? current : null),
    rawSession: () => current,
    isUsable: () => isUsable(current),
    setNotice: (code: SdpppxErrorCode | null) => {
      notice = code;
    }
  };
}

/** 会话 → 浏览器可见投影；`balance` 单独传入，余额失败不影响登录态。 */
export function sessionView(session: SdpppxSession, balance: SdpppxBalance | null): SdpppxSessionView {
  return {
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
    expiresAt: session.expiresAt,
    balance
  };
}
