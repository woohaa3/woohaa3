import { describe, expect, it, vi } from "vitest";
import {
  decodeRunningHubBalanceResult,
  normalizeRunningHubBalance,
  RUNNINGHUB_BALANCE_PATH
} from "../src/balance.js";
import {
  fetchRunningHubBalance,
  runningHubAccountStatusUrl
} from "../src/backend/balance.js";
import { runningHubBalanceText } from "../src/frontend/provider-balance.js";

describe("RunningHub 账户余额契约", () => {
  it("从受控 API 基址取站点 origin 与账户接口路径", () => {
    expect(runningHubAccountStatusUrl("https://www.runninghub.ai/openapi/v2")).toBe(
      "https://www.runninghub.ai/uc/openapi/accountStatus"
    );
    expect(RUNNINGHUB_BALANCE_PATH).toBe("/api/providers/runninghub/balance");
  });

  it("把上游字符串读数归一化为数值，并保留钱包币种", () => {
    expect(
      normalizeRunningHubBalance({
        remainCoins: "99999",
        currentTaskCounts: "2",
        remainMoney: "999.5",
        currency: "CNY",
        apiType: "NORMAL",
        remainPoint: 88.5
      })
    ).toEqual({
      remainCoins: 99999,
      currentTaskCounts: 2,
      remainMoney: 999.5,
      currency: "CNY",
      apiType: "NORMAL",
      remainPoint: 88.5
    });
  });

  it("没有任何可读字段时拒绝伪造余额", () => {
    expect(normalizeRunningHubBalance({ currency: "CNY" })).toBeNull();
    expect(decodeRunningHubBalanceResult({ ok: true, balance: {} })).toBeNull();
  });

  it("同时展示积分余额与钱包余额；RH 币不展示", () => {
    expect(
      runningHubBalanceText({
        remainMoney: 28.8781,
        currency: "USD",
        remainCoins: 78831,
        remainPoint: 17291,
        currentTaskCounts: 0,
        apiType: "SHARED"
      })
    ).toBe("积分 17,291 · 余额 $28.88");
    expect(
      runningHubBalanceText({
        remainMoney: 999.5,
        currency: "CNY",
        remainCoins: 99999,
        remainPoint: 17291,
        currentTaskCounts: 0,
        apiType: "NORMAL"
      })
    ).toBe("积分 17,291 · 余额 ¥999.5");
    expect(
      runningHubBalanceText({
        remainMoney: null,
        currency: null,
        remainCoins: 1200,
        remainPoint: null,
        currentTaskCounts: null,
        apiType: null
      })
    ).toBeNull();
  });

  it("未配置 Key 时不发请求", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchRunningHubBalance({ apiKey: "  ", fetchImpl })).resolves.toEqual({
      ok: false,
      code: "runninghub-credentials-missing",
      message: "未配置 RunningHub API Key"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("使用 Bearer Key 与 apikey body 查询账户接口", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(JSON.parse(String(init?.body))).toEqual({ apikey: "secret" });
      return Response.json({
        code: 0,
        msg: "success",
        data: { remainCoins: "12", remainMoney: "34", currency: "CNY", currentTaskCounts: "0", apiType: "NORMAL" }
      });
    });
    const result = await fetchRunningHubBalance({
      apiKey: "secret",
      apiBaseURL: "https://www.runninghub.ai/openapi/v2",
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.runninghub.ai/uc/openapi/accountStatus",
      expect.objectContaining({ method: "POST" })
    );
    expect(result).toEqual({
      ok: true,
      balance: {
        remainCoins: 12,
        remainMoney: 34,
        currency: "CNY",
        currentTaskCounts: 0,
        apiType: "NORMAL",
        remainPoint: null
      }
    });
  });

  it("上游业务码非 0 或 HTTP 失败时返回稳定错误，不回显上游正文", async () => {
    await expect(
      fetchRunningHubBalance({
        apiKey: "secret",
        fetchImpl: async () => Response.json({ code: 806, msg: "apikey user not found", data: null })
      })
    ).resolves.toEqual({
      ok: false,
      code: "runninghub-credentials-invalid",
      message: "RunningHub API Key 无效或未授权"
    });
    await expect(
      fetchRunningHubBalance({
        apiKey: "secret",
        fetchImpl: async () => Response.json({ code: 1002, msg: "other error", data: null })
      })
    ).resolves.toEqual({
      ok: false,
      code: "runninghub-balance-unavailable",
      message: "RunningHub 账户接口返回失败"
    });
    await expect(
      fetchRunningHubBalance({
        apiKey: "secret",
        fetchImpl: async () => new Response("upstream secret", { status: 500 })
      })
    ).resolves.toEqual({
      ok: false,
      code: "runninghub-balance-unavailable",
      message: "RunningHub 账户接口返回 HTTP 500"
    });
  });
});
