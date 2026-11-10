/**
 * RunningHub 账户余额读取（宿主侧）。
 *
 * API Key 只存在宿主配置里；浏览器通过同源 handler 拿规范化读数，不接触 Key。
 * 上游文档：`POST /uc/openapi/accountStatus`，Bearer API Key，body `{ apikey }`。
 */
import {
  normalizeRunningHubBalance,
  type RunningHubBalanceResult
} from "../balance.js";
import { DEFAULT_RUNNINGHUB_API_BASE } from "../shared.js";

const BALANCE_TIMEOUT_MS = 10_000;
const ACCOUNT_STATUS_PATH = "/uc/openapi/accountStatus";

function failure(message: string): RunningHubBalanceResult {
  return { ok: false, code: "runninghub-balance-unavailable", message };
}

/** 从受控 API 基址取站点 origin：余额接口不在 `/openapi/v2` 下。 */
export function runningHubAccountStatusUrl(apiBaseURL: string = DEFAULT_RUNNINGHUB_API_BASE): string {
  return `${new URL(apiBaseURL).origin}${ACCOUNT_STATUS_PATH}`;
}

export async function fetchRunningHubBalance(options: {
  apiKey: string;
  apiBaseURL?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<RunningHubBalanceResult> {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    return { ok: false, code: "runninghub-credentials-missing", message: "未配置 RunningHub API Key" };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(runningHubAccountStatusUrl(options.apiBaseURL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ apikey: apiKey }),
      signal: AbortSignal.timeout(options.timeoutMs ?? BALANCE_TIMEOUT_MS)
    });
  } catch {
    return failure("无法连接 RunningHub 账户接口");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) return failure(`RunningHub 账户接口返回 HTTP ${response.status}`);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return failure("RunningHub 账户接口返回失败");
  }
  const code = (payload as { code?: unknown }).code;
  if (code !== 0 && code !== "0") {
    // 802/806 是上游对无效/未授权 API Key 的稳定业务码；单独表态，界面可提示换 Key。
    const numeric = typeof code === "number" ? code : Number(code);
    if (numeric === 802 || numeric === 806) {
      return { ok: false, code: "runninghub-credentials-invalid", message: "RunningHub API Key 无效或未授权" };
    }
    return failure("RunningHub 账户接口返回失败");
  }
  const balance = normalizeRunningHubBalance((payload as { data?: unknown }).data);
  if (!balance) return failure("RunningHub 账户接口没有返回可读余额");
  return { ok: true, balance };
}
