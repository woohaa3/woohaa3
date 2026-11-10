/**
 * RunningHub 在「模型提供商」列表行里的余额读数（`agent-assistant.provider-balance`）。
 *
 * 宿主只按 `providerId` 找到本贡献并渲染；读数由宿主同源 handler 经
 * `/uc/openapi/accountStatus` 取回并归一化，浏览器不接触 API Key。未配置、读取失败或
 * 上游没有可读余额时不占位。
 */
import { createElement, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import {
  RUNNINGHUB_BALANCE_PATH,
  decodeRunningHubBalanceResult,
  type RunningHubBalance
} from "../balance.js";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

/** 同时展示积分余额与钱包余额；RH 币不作为余额展示。 */
export function runningHubBalanceText(balance: RunningHubBalance): string | null {
  const parts: string[] = [];
  if (balance.remainPoint !== null) parts.push(`积分 ${formatNumber(balance.remainPoint)}`);
  if (balance.remainMoney !== null) {
    const currency = balance.currency?.toUpperCase();
    const money =
      currency === "CNY"
        ? `¥${formatNumber(balance.remainMoney)}`
        : currency === "USD"
          ? `$${formatNumber(balance.remainMoney)}`
          : currency
            ? `${formatNumber(balance.remainMoney)} ${currency}`
            : formatNumber(balance.remainMoney);
    parts.push(`余额 ${money}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function RunningHubProviderBalance({ transport }: { transport: ApplicationRemoteTransport }) {
  const [balance, setBalance] = useState<RunningHubBalance | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void transport
      .request({ path: RUNNINGHUB_BALANCE_PATH, method: "GET", signal: controller.signal })
      .then(result => {
        if (!active) return;
        if (!result.ok) {
          // 传输层对非 2xx 只保留稳定 error 文本；未配置 Key 是正常空状态，不占位。
          if (result.error && result.error !== "未配置 RunningHub API Key") setFailure(result.error);
          return;
        }
        const decoded = decodeRunningHubBalanceResult(result.data);
        if (decoded?.ok) setBalance(decoded.balance);
        else if (decoded && !decoded.ok && decoded.code !== "runninghub-credentials-missing") {
          setFailure(decoded.message);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, [transport]);

  const text = balance ? runningHubBalanceText(balance) : null;
  if (!text) {
    // 已配置但上游拒绝/不可用时只留一个简短读数，避免用户以为余额功能没有接上；
    // 具体原因放 title，不把上游正文或凭据带进界面。
    return failure
      ? <span className="agent-assistant__balance" data-testid="runninghub-provider-balance" data-state="error" title={failure}>余额不可用</span>
      : null;
  }
  const details: string[] = [];
  if (balance && balance.currentTaskCounts !== null) {
    details.push(`运行中 ${formatNumber(balance.currentTaskCounts)}`);
  }

  return (
    <span
      className="agent-assistant__balance"
      data-testid="runninghub-provider-balance"
      {...(details.length > 0 ? { title: details.join(" · ") } : {})}
    >
      {text}
    </span>
  );
}

/** `agent-assistant.provider-balance` 的 renderer 工厂（入口文件保持无 JSX）。 */
export function createRunningHubProviderBalanceRenderer(
  transport: ApplicationRemoteTransport
): () => ReactElement {
  return () => createElement(RunningHubProviderBalance, { transport });
}
