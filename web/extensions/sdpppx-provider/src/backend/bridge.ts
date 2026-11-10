/**
 * `authing-bridge3` 会话交换与 Supabase refresh token 续期。
 *
 * 令牌只在本模块的返回值里流动，调用方立刻写入会话存储；错误信息只保留稳定分类，
 * 不透出上游正文。
 */
import type { SdpppxConfig } from "./config.js";
import { SdpppxHttpError, fetchJson, type SdpppxHttpOptions } from "./http.js";
import { requireSupabase } from "./supabase.js";

export type SupabaseSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type BridgeFailureKind = "rejected" | "unavailable";

export class BridgeError extends Error {
  readonly kind: BridgeFailureKind;

  constructor(message: string, kind: BridgeFailureKind) {
    super(message);
    this.name = "BridgeError";
    this.kind = kind;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function urlOf(value: unknown): string | null {
  const text = textOf(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function displayNameOf(user: Record<string, unknown>): string | null {
  const metadata = recordOf(user.user_metadata) ?? recordOf(user.app_metadata) ?? {};
  const candidates = [
    metadata.display_name,
    metadata.displayName,
    metadata.full_name,
    metadata.name,
    metadata.nickname,
    user.nickname,
    user.name,
    typeof user.email === "string" ? user.email.split("@")[0] : undefined
  ];
  for (const candidate of candidates) {
    const text = textOf(candidate);
    if (text) return text;
  }
  return null;
}

function avatarOf(user: Record<string, unknown>): string | null {
  const metadata = recordOf(user.user_metadata) ?? recordOf(user.app_metadata) ?? {};
  for (const candidate of [metadata.avatar_url, metadata.avatarUrl, metadata.picture, metadata.avatar]) {
    const url = urlOf(candidate);
    if (url) return url;
  }
  return null;
}

function sessionFromPayload(
  payload: unknown,
  now: number,
  fallback?: { displayName?: string | null; avatarUrl?: string | null }
): SupabaseSession | null {
  const record = recordOf(payload);
  if (!record) return null;
  const accessToken = textOf(record.access_token);
  const refreshToken = textOf(record.refresh_token);
  if (!accessToken || !refreshToken) return null;
  const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) && record.expires_in > 0
    ? record.expires_in
    : 3600;
  const user = recordOf(record.user) ?? {};
  const userId = textOf(user.id) ?? textOf(user.sub) ?? "";
  return {
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    userId,
    displayName: displayNameOf(user) ?? fallback?.displayName ?? null,
    avatarUrl: avatarOf(user) ?? fallback?.avatarUrl ?? null
  };
}

function failureKind(error: unknown): BridgeFailureKind {
  if (error instanceof SdpppxHttpError && (error.status === 400 || error.status === 401 || error.status === 403)) {
    return "rejected";
  }
  return "unavailable";
}

/** 用 Authing token 换 Supabase 会话。 */
export async function exchangeAuthingToken(
  config: SdpppxConfig,
  token: string,
  options: SdpppxHttpOptions & { now?: () => number; hint?: { displayName?: string | null; avatarUrl?: string | null } } = {}
): Promise<SupabaseSession> {
  const base = requireSupabase(config);
  if (!config.bridgeUrl) {
    throw new BridgeError("未配置 bridge 地址", "unavailable");
  }
  let payload: unknown;
  try {
    payload = await fetchJson(
      config.bridgeUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: base.anonKey,
          Authorization: `Bearer ${base.anonKey}`
        },
        body: JSON.stringify({ token, tenantId: base.tenantId })
      },
      options
    );
  } catch (error) {
    throw new BridgeError("会话桥接不可用", failureKind(error));
  }
  const session = sessionFromPayload(payload, (options.now ?? Date.now)(), options.hint);
  if (!session) {
    throw new BridgeError("会话桥接未返回完整会话", "rejected");
  }
  return session;
}

/** 用 refresh token 续期；并发合并在 session.ts，这里只负责单次调用。 */
export async function refreshSupabaseSession(
  config: SdpppxConfig,
  refreshToken: string,
  options: SdpppxHttpOptions & { now?: () => number } = {}
): Promise<SupabaseSession> {
  const base = requireSupabase(config);
  const url = `${base.url}/auth/v1/token?grant_type=refresh_token`;
  let payload: unknown;
  try {
    payload = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: base.anonKey
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      },
      options
    );
  } catch (error) {
    throw new BridgeError("会话续期不可用", failureKind(error));
  }
  const session = sessionFromPayload(payload, (options.now ?? Date.now)());
  if (!session) {
    throw new BridgeError("会话续期被拒绝", "rejected");
  }
  return session;
}
