/**
 * 只读余额快照。
 *
 * 余额是「个人中心的可选展示」：任何查询失败（缺表、无权限、RPC 未部署、网络）都返回
 * `null`，绝不阻塞登录态、退出登录或任务执行。
 */
import type { SdpppxBalance } from "../shared.js";
import type { SdpppxConfig } from "./config.js";
import { firstRow, requireSupabase, rowsOf, supabaseJson } from "./supabase.js";
import type { SdpppxHttpOptions } from "./http.js";

export type BalanceInput = {
  config: SdpppxConfig;
  accessToken: string;
  userId: string;
} & SdpppxHttpOptions;

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function balanceOf(row: Record<string, unknown>): SdpppxBalance | null {
  const total = pick(row, ["total_balance", "balance"]);
  if (total === undefined) return null;
  const paid = pick(row, ["paid", "paid_balance", "recharge", "recharge_balance"]);
  const monthlyBonus = pick(row, ["monthly_bonus", "monthly_bonus_balance"]);
  const dailyBonus = pick(row, ["daily_bonus", "daily_bonus_balance"]);
  return {
    totalBalance: total,
    ...(paid !== undefined ? { paid } : {}),
    ...(monthlyBonus !== undefined ? { monthlyBonus } : {}),
    ...(dailyBonus !== undefined ? { dailyBonus } : {})
  };
}

export async function fetchSdpppxBalance(input: BalanceInput): Promise<SdpppxBalance | null> {
  try {
    const base = requireSupabase(input.config);
    if (!input.userId) return null;
    // `tenants` 在 public schema；失败时按 legacy 处理（与 sdppp demo 同语义）。
    let mode: "multi" | "legacy" = "legacy";
    try {
      const modePayload = await supabaseJson(
        base,
        `/rest/v1/tenants?id=eq.${encodeURIComponent(base.tenantId)}&select=balance_mode&limit=1`,
        { ...input, accessToken: input.accessToken }
      );
      const row = firstRow(modePayload);
      if (row?.balance_mode === "multi") mode = "multi";
    } catch {
      mode = "legacy";
    }
    if (mode === "multi") {
      const payload = await supabaseJson(base, "/rest/v1/rpc/get_user_balance_multi", {
        ...input,
        method: "POST",
        accessToken: input.accessToken,
        body: { p_user_id: input.userId, p_tenant_id: base.tenantId }
      });
      const row = firstRow(payload) ?? rowsOf(payload)[0];
      return row ? balanceOf(row) : null;
    }
    const payload = await supabaseJson(
      base,
      `/rest/v1/users_balances?user_id=eq.${encodeURIComponent(input.userId)}` +
        `&tenant_id=eq.${encodeURIComponent(base.tenantId)}&select=*&limit=1`,
      { ...input, accessToken: input.accessToken, profile: "biz_users" }
    );
    const row = firstRow(payload);
    return row ? balanceOf(row) : null;
  } catch {
    return null;
  }
}
