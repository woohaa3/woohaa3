/**
 * RunningHub 账户余额的共享契约（前后端共用，不含 Node/浏览器依赖）。
 *
 * 上游接口是 `POST /uc/openapi/accountStatus`：Bearer API Key + `{ apikey }`，返回
 * `remainMoney` / `remainCoins` / `remainPoint` 等账户读数。浏览器不直接访问上游，
 * 只读取宿主同源 handler 的规范化结果。
 */
/** 宿主网关路由；与设置页模型刷新同属 `/api/providers/runninghub/*`。 */
export const RUNNINGHUB_BALANCE_PATH = "/api/providers/runninghub/balance";

/** 规范化后的账户余额；数值字段无法解析时为 null。 */
export type RunningHubBalance = {
  /** 钱包余额。 */
  remainMoney: number | null;
  /** 钱包币种，例如 `CNY`。 */
  currency: string | null;
  /** RH 币余额。 */
  remainCoins: number | null;
  /** 积分余额（部分账户才有）。 */
  remainPoint: number | null;
  /** 当前运行中的任务数。 */
  currentTaskCounts: number | null;
  /** API Key 类型，例如 `NORMAL`。 */
  apiType: string | null;
};

export type RunningHubBalanceFailureCode =
  | "runninghub-credentials-missing"
  | "runninghub-credentials-invalid"
  | "runninghub-balance-unavailable";

export type RunningHubBalanceResult =
  | { ok: true; balance: RunningHubBalance }
  | { ok: false; code: RunningHubBalanceFailureCode; message: string };

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 把上游 `data` 归一化为稳定读数；没有任何可读字段时返回 null。 */
export function normalizeRunningHubBalance(value: unknown): RunningHubBalance | null {
  const record = recordOf(value);
  if (!record) return null;
  const balance: RunningHubBalance = {
    remainMoney: numberValue(record.remainMoney),
    currency: textValue(record.currency),
    remainCoins: numberValue(record.remainCoins),
    remainPoint: numberValue(record.remainPoint),
    currentTaskCounts: numberValue(record.currentTaskCounts),
    apiType: textValue(record.apiType)
  };
  if (
    balance.remainMoney === null &&
    balance.remainCoins === null &&
    balance.remainPoint === null &&
    balance.currentTaskCounts === null
  ) {
    return null;
  }
  return balance;
}

/** 校验宿主 handler 返回的规范化结果；坏值不让浏览器伪造余额。 */
export function decodeRunningHubBalanceResult(value: unknown): RunningHubBalanceResult | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.ok === true) {
    const balance = normalizeRunningHubBalance(record.balance);
    return balance ? { ok: true, balance } : null;
  }
  if (record.ok === false && typeof record.code === "string" && typeof record.message === "string") {
    return {
      ok: false,
      code: record.code as RunningHubBalanceFailureCode,
      message: record.message
    };
  }
  return null;
}
