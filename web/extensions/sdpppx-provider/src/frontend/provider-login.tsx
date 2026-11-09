/**
 * AI 助手「添加连接」里的 SDPPPX 登录入口。
 *
 * 应用启动**不再自动弹登录**：用户先在供应商列表选择 SDPPPX，挂载本组件时读取一次真实
 * 会话；只有确认是未登录才打开微信扫码弹窗。已登录时显示当前账号、余额与账号管理入口。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { Button } from "@woohaa3/ui/primitives";
import type { SdpppxSessionSnapshot } from "../shared.js";
import type { SdpppxAccountService } from "./account-service.js";

export type SdpppxProviderLoginProps = {
  service: SdpppxAccountService;
  onOpenLogin: () => void;
  onOpenAccount: () => void;
};

export function SdpppxProviderLogin({ service, onOpenLogin, onOpenAccount }: SdpppxProviderLoginProps) {
  const snapshot: SdpppxSessionSnapshot = useSyncExternalStore<SdpppxSessionSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const opened = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    void service.refresh().then((next) => {
      if (active) setRefreshing(false);
      // 只有确认未登录才自动弹；读取失败不把用户当成未登录。
      // StrictMode 会先清理再重放同一个 effect，因此不能在 effect 开头就上锁。
      if (active && !opened.current && next?.status === "anonymous") {
        opened.current = true;
        onOpenLogin();
      }
    });
    return () => {
      active = false;
    };
  }, [onOpenLogin, service]);

  // 已登录：进入详情时再刷新一次，余额随 /session 一起取回。
  useEffect(() => {
    if (snapshot.status !== "authenticated") return;
    let active = true;
    setRefreshing(true);
    void service.refresh().finally(() => {
      if (active) setRefreshing(false);
    });
    return () => {
      active = false;
    };
  }, [service, snapshot.status]);

  if (snapshot.status === "unconfigured") {
    const missing = snapshot.missing.length > 0 ? snapshot.missing.join(" / ") : "SDPPPX 部署参数";
    return (
      <div className="sdpppx-provider-login" data-testid="sdpppx-provider-login" data-state="unconfigured">
        <p>缺少 SDPPPX 部署配置，无法登录：{missing}</p>
      </div>
    );
  }

  if (snapshot.status === "authenticated" && snapshot.session) {
    const name = snapshot.session.displayName?.trim() || "已登录";
    const balance = snapshot.session.balance;
    const total = balance && Number.isFinite(balance.totalBalance) ? String(balance.totalBalance) : null;
    return (
      <div className="sdpppx-provider-login" data-testid="sdpppx-provider-login" data-state="authenticated">
        <dl className="sdpppx-account__facts">
          <dt>账号</dt>
          <dd data-testid="sdpppx-provider-login-account">{name}</dd>
          <dt>余额</dt>
          <dd data-testid="sdpppx-provider-login-balance">
            {refreshing ? "正在读取…" : total ?? "暂不可用"}
          </dd>
        </dl>
        <Button size="sm" tone="neutral" onClick={onOpenAccount}>管理账号</Button>
      </div>
    );
  }

  const expired = snapshot.notice === "sdpppx-session-expired";
  return (
    <div className="sdpppx-provider-login" data-testid="sdpppx-provider-login" data-state={expired ? "expired" : "anonymous"}>
      <p>{expired ? "SDPPPX 登录已过期，请重新扫码。" : "使用微信扫码登录 SDPPPX，登录后可使用当前租户的模板生成模型。"}</p>
      <Button size="sm" tone="primary" onClick={onOpenLogin}>{expired ? "重新扫码" : "微信扫码登录"}</Button>
    </div>
  );
}

export function createSdpppxProviderLoginRenderer(
  service: SdpppxAccountService,
  onOpenLogin: () => void,
  onOpenAccount: () => void
): () => ReactElement {
  return () => (
    <SdpppxProviderLogin service={service} onOpenLogin={onOpenLogin} onOpenAccount={onOpenAccount} />
  );
}
