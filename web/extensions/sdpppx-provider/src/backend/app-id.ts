/**
 * 解析租户的 Authing appId。
 *
 * 优先级：`SDPPPX_AUTHING_APP_ID` → Supabase REST 查 `public.tenants` 与
 * `biz_tenants.tenants_auth_authing`。不猜、不复用其它租户的 appId；查不到就是稳定缺口。
 */
import type { SdpppxConfig } from "./config.js";
import { SdpppxHttpError, type SdpppxHttpOptions } from "./http.js";
import { requireSupabase, rowsOf, supabaseJson } from "./supabase.js";
import type { AuthingQrTarget } from "./authing-qr.js";

export type ResolvedAuthingTarget = AuthingQrTarget;

function normalizeHost(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * 需要 appId 时才做 REST 查询；配置齐全但租户没有 Authing 绑定是**部署缺口**，
 * 与网络失败区分：前者 `sdpppx-authing-app-missing`，后者 `sdpppx-service-unavailable`。
 */
export async function resolveAuthingTarget(
  config: SdpppxConfig,
  options: SdpppxHttpOptions = {}
): Promise<ResolvedAuthingTarget> {
  if (config.authingAppId) {
    return { appId: config.authingAppId, host: config.authingHost, scene: config.authingScene };
  }
  const base = requireSupabase(config);
  const tenantQuery = `tenants?id=eq.${encodeURIComponent(base.tenantId)}&select=id&limit=1`;
  const tenantRows = rowsOf(
    await supabaseJson(base, `/rest/v1/${tenantQuery}`, { ...options, accessToken: null })
  );
  if (tenantRows.length === 0) {
    throw new SdpppxHttpError("租户不存在", 404, "sdpppx-authing-app-missing");
  }
  const authingQuery =
    `tenants_auth_authing?tenant_id=eq.${encodeURIComponent(base.tenantId)}` +
    `&select=authing_id,authing_url&limit=1`;
  let rows: Record<string, unknown>[];
  try {
    rows = rowsOf(
      await supabaseJson(base, `/rest/v1/${authingQuery}`, {
        ...options,
        accessToken: null,
        profile: "biz_tenants"
      })
    );
  } catch (error) {
    // 表不存在 / 无权限：部署未开启 Authing 绑定，按「查不到」处理而不是网络故障。
    if (error instanceof SdpppxHttpError && (error.status === 404 || error.status === 400)) {
      rows = [];
    } else {
      throw error;
    }
  }
  const row = rows[0];
  const appId = typeof row?.authing_id === "string" ? row.authing_id.trim() : "";
  if (!appId) {
    throw new SdpppxHttpError("租户未配置 Authing appId", 404, "sdpppx-authing-app-missing");
  }
  const tenantHost = config.authingHostExplicit ? undefined : normalizeHost(row?.authing_url);
  return {
    appId,
    host: tenantHost ?? config.authingHost,
    scene: config.authingScene
  };
}
