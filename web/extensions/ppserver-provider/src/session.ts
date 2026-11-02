/**
 * Supabase 令牌的**自动续期**。
 *
 * 为什么必须持久化 `refresh_token`：Supabase 的刷新是**轮换**的 —— 每次
 * `grant_type=refresh_token` 都会返回新的 refresh_token，旧的随即失效。只把新令牌放在内存里，
 * 宿主一重启就只剩一个已经作废的 refresh_token，等于没刷新。所以这里落盘到
 * 宿主的扩展数据目录（`WOOHAA3_EXTENSION_DATA_DIR`），每次刷新后原子覆盖。
 *
 * 权限与边界：
 * - 文件模式 0600，目录在数据目录下（已被 .gitignore 覆盖）；
 * - 不记录令牌内容到日志，只记「刷新成功/失败」与过期时间；
 * - 刷新失败不抛给调用方去重试（会放大成风暴），而是退回到当前令牌并标记 degraded。
 *
 * 令牌来源优先级，与 PS 插件同构：
 *   1. 已持久化的 refresh_token（能自己续期，最优先）；
 *   2. 配置里手填的 accessToken（开发期临时方案，过期就得重填）。
 */

import fs from "node:fs/promises";
import path from "node:path";

/** 提前量：临到期前 60 秒就刷新，避免请求刚好卡在过期那一刻。 */
const REFRESH_SKEW_MS = 60_000;

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳。 */
  expiresAt: number;
};

export type SupabaseSessionResult =
  | { ok: true; session: StoredSession; refreshed: boolean }
  | { ok: false; message: string };

/** 解出 JWT 的 `exp`（秒）。读不到就返回 undefined —— 不猜有效期。 */
export function readExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** 该续期了：进入提前量窗口。**不等于已过期** —— 还剩几十秒的令牌仍然可用。 */
export function needsRefresh(session: StoredSession, now = Date.now()): boolean {
  return session.expiresAt - REFRESH_SKEW_MS <= now;
}

/** 真的过期了（服务端一定会拒绝）。续期失败时只有这一种情况才该报错。 */
export function isExpired(session: StoredSession, now = Date.now()): boolean {
  return session.expiresAt <= now;
}

/** 会话文件位置：宿主给的扩展数据目录；没给就退到临时目录（开发期可接受，重启即丢）。 */
export function sessionFilePath(extensionDataDir: string | undefined): string {
  const base = extensionDataDir && extensionDataDir.trim() !== ""
    ? extensionDataDir
    : path.join(process.env.TEMP ?? process.env.TMPDIR ?? ".", "woohaa-ppserver-provider");
  return path.join(base, "ppserver-session.json");
}

export async function loadSession(file: string): Promise<StoredSession | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return undefined;
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return undefined;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
  } catch {
    return undefined;
  }
}

/** 原子写入：先写临时文件再改名，避免半截 JSON 让下次启动读不出来。 */
export async function saveSession(file: string, session: StoredSession): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function clearSession(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

/** `POST /auth/v1/token?grant_type=refresh_token` 的响应解读。 */
export function interpretRefreshResponse(payload: unknown, now = Date.now()): StoredSession | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token.trim() : "";
  if (!accessToken) return undefined;
  const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token.trim() : "";
  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
    ? record.expires_in
    : 3600;
  // 优先用 JWT 自带的 exp：服务端的 expires_in 与令牌本身偶有偏差时以令牌为准。
  const expiresAt = readExpiry(accessToken) ?? now + expiresIn * 1000;
  return { accessToken, refreshToken, expiresAt };
}

export type EnsureSessionOptions = {
  /** Supabase 地址（形如 `https://.../supabase/<项目 id>`）。 */
  supabaseUrl: string;
  /** 公开 anon key，刷新请求要带。 */
  anonKey: string;
  /** 配置里手填的访问令牌（可选，用于首次冷启动）。 */
  fallbackAccessToken?: string;
  /**
   * 配置里手填的 refresh_token（可选）。
   *
   * 只贴 access_token 的话约一小时后就续不上了；给了它，首次请求时用它换一次，
   * 之后续期就靠落盘的那份。**只在没有持久化会话时使用** —— 否则会拿配置里的旧令牌
   * 覆盖掉已经轮换过的新令牌。
   */
  seedRefreshToken?: string;
  filePath: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  /** 刷新失败时的回调（记日志用），不吞掉原因。 */
  onRefreshError?: (message: string) => void;
};

/**
 * 正在进行的续期。
 *
 * **为什么必须有**：Supabase 刷新是轮换的 —— 一份 refresh_token 只能用一次。
 * 两个请求同时进入续期窗口时，各自读到同一份 refresh_token、各自发一次刷新：
 * 先到的成功并把新值写盘，后到的拿到 `refresh_token_already_used` 失败。
 * 后者的调用方会以为续期坏了，而实际上会话是好的。
 * 实测在宿主里连续请求（目录刷新 + 一次生成）必然撞上这个形状。
 *
 * 并发合并只在这里做：并发的调用共享同一个 Promise，**只发一次刷新**。
 * 键取会话文件路径 —— 不同文件的会话互不相干，没必要串到一条链上。
 */
const inFlightRefreshes = new Map<string, Promise<SupabaseSessionResult>>();

/**
 * 拿到一个当前可用的会话：优先用磁盘上的 refresh_token 续期，其次用配置里的令牌。
 *
 * **不会因为刷新失败就抛错**：只要手上还有一个未过期的令牌就继续用它，
 * 让用户在过期前还有机会正常生成；真过期了再由请求本身报 401。
 */
export function ensureSession(options: EnsureSessionOptions): Promise<SupabaseSessionResult> {
  const key = options.filePath;
  const running = inFlightRefreshes.get(key);
  if (running) return running;
  const task = runEnsureSession(options).finally(() => {
    // 只在还是自己那一条时才删：万一期间被替换，删掉会把新的 in-flight 丢掉。
    if (inFlightRefreshes.get(key) === task) inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, task);
  return task;
}

async function runEnsureSession(options: EnsureSessionOptions): Promise<SupabaseSessionResult> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const stored = await loadSession(options.filePath);

  // 1. 有持久化会话且没到期：直接用。
  if (stored && !needsRefresh(stored, now())) {
    return { ok: true, session: stored, refreshed: false };
  }

  // 2. 有 refresh_token：续期。
  if (stored?.refreshToken) {
    if (!options.supabaseUrl || !options.anonKey) {
      return { ok: false, message: "缺少 Supabase 地址或 anon key，无法续期令牌" };
    }
    try {
      const url = `${options.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          apikey: options.anonKey,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({ refresh_token: stored.refreshToken }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        const message = `续期失败（HTTP ${response.status}）`;
        options.onRefreshError?.(message);
        // 旧令牌还没真正过期就先用着（只是进了续期窗口，不是不能用）。
        if (!isExpired(stored, now())) return { ok: true, session: stored, refreshed: false };
        return { ok: false, message };
      }
      const next = interpretRefreshResponse(await response.json(), now());
      if (!next) {
        const message = "续期响应缺少 access_token";
        options.onRefreshError?.(message);
        return { ok: false, message };
      }
      // **先落盘再返回**：新 refresh_token 一旦没存住，旧的已经作废，下次就续不上了。
      await saveSession(options.filePath, next);
      return { ok: true, session: next, refreshed: true };
    } catch (error) {
      const message = `续期异常：${error instanceof Error ? error.message : String(error)}`;
      options.onRefreshError?.(message);
      if (!isExpired(stored, now())) return { ok: true, session: stored, refreshed: false };
      return { ok: false, message };
    }
  }

  // 3a. 没有持久化会话、但有配置的 refresh_token：先换一次，再把轮换后的值落盘。
  const seed = options.seedRefreshToken?.trim();
  if (seed && options.supabaseUrl && options.anonKey) {
    try {
      const url = `${options.supabaseUrl.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { apikey: options.anonKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refresh_token: seed }),
        signal: AbortSignal.timeout(15_000)
      });
      if (response.ok) {
        const next = interpretRefreshResponse(await response.json(), now());
        if (next) {
          await saveSession(options.filePath, next);
          return { ok: true, session: next, refreshed: true };
        }
      } else {
        options.onRefreshError?.(`用配置的刷新令牌换权失败（HTTP ${response.status}）`);
      }
    } catch (error) {
      options.onRefreshError?.(`用配置的刷新令牌换权异常：${error instanceof Error ? error.message : String(error)}`);
    }
    // 换权失败就继续往下，看手填的访问令牌还能不能用。
  }

  // 3b. 没有持久化会话：用手填令牌起一个（拿不到 refresh_token，只能等到期再换）。
  const fallback = options.fallbackAccessToken?.trim();
  if (fallback) {
    const expiresAt = readExpiry(fallback) ?? now() + 3600_000;
    const session = { accessToken: fallback, refreshToken: "", expiresAt };
    if (needsRefresh(session, now())) {
      return { ok: false, message: "访问令牌已过期，请重新获取" };
    }
    return { ok: true, session, refreshed: false };
  }

  return { ok: false, message: "没有可用的访问令牌：请配置 accessToken 或提供 refresh_token" };
}
