/**
 * Supabase REST 访问：认证头、schema profile 与 JSON 解析在这里收口。
 *
 * 会话 JWT 只在宿主进程内使用；该模块不记录请求头或正文。
 */
import type { SdpppxConfig } from "./config.js";
import { SdpppxHttpError, fetchJson, type SdpppxHttpOptions } from "./http.js";

export type ReadySupabase = {
  url: string;
  anonKey: string;
  tenantId: string;
};

/** 必需配置齐全时返回非空值；否则抛稳定码，避免发出半配置请求。 */
export function requireSupabase(config: SdpppxConfig): ReadySupabase {
  if (!config.tenantId || !config.supabaseUrl || !config.supabaseAnonKey) {
    throw new SdpppxHttpError("SDPPPX 部署参数不完整", 0, "sdpppx-config-incomplete");
  }
  return { url: config.supabaseUrl, anonKey: config.supabaseAnonKey, tenantId: config.tenantId };
}

export function supabaseUrl(base: ReadySupabase, path: string): string {
  return `${base.url.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export type SupabaseRequestOptions = SdpppxHttpOptions & {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** 使用会话 JWT 作为 Authorization；缺省用 anon key。 */
  accessToken?: string | null;
  /** PostgREST schema：`biz_tasks` / `biz_tenants` / `biz_users`。 */
  profile?: string;
  /** 额外的幂等/偏好头。 */
  headers?: Record<string, string>;
};

export async function supabaseJson(
  base: ReadySupabase,
  path: string,
  options: SupabaseRequestOptions = {}
): Promise<unknown> {
  const headers: Record<string, string> = {
    apikey: base.anonKey,
    Authorization: `Bearer ${options.accessToken ?? base.anonKey}`,
    Accept: "application/json",
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.profile ? { "Accept-Profile": options.profile } : {}),
    ...options.headers
  };
  return fetchJson(
    supabaseUrl(base, path),
    {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    },
    options
  );
}

/** 只接受数组；PostgREST 的单行响应也按一行数组处理。 */
export function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item));
}

export function firstRow(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return rowsOf(value)[0];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
