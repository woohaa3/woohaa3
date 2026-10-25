/**
 * ChatGPT 授权行（Provider 凭据弹窗顶部 contribution）
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1 / design D5；由宿主
 *  `cordis/plugins/chatgpt/authorization-row.tsx` 迁入）。
 *
 * 由 ChatGPT extension 前端入口贡献，排在所有 API Key 条目之前：显示授权状态、授权/重新授权
 * 与断开。**不显示 API Key 输入**，也不暴露 token；授权入口经同源 popup 打开授权 URL，回调
 * 只经同源 `postMessage` 通知本面板刷新状态。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  SettingsSection,
  SettingsFeedback,
  ServiceLogo,
} from "@woohaa3/frontend/extension-api";
import type { ChatGptService } from "./service.js";

export type SettingsPanelHostProps = {
  /** 设置语境下的「返回插件列表」（经同一草稿门禁）。 */
  requestClose?: () => void;
  /** 上报 dirty/pending（宿主据此决定能否关闭或切换视图）。 */
  reportEditState?: (state: { dirty?: boolean; pending?: boolean }) => void;
};

export function ChatGptAuthorizationRow({
  service,
  reportEditState,
  onOpenRuntimes,
}: {
  service: ChatGptService;
  onOpenRuntimes?: () => void;
} & SettingsPanelHostProps) {
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<{ url: string; blocked: boolean } | null>(null);
  const state = snapshot.auth?.state ?? "disconnected";
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const popupRef = useRef<Window | null>(null);
  const authorizationPending = useRef(false);
  const watcherRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatching = () => {
    if (watcherRef.current) clearInterval(watcherRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++attempt.current; stopWatching(); if (authorizationPending.current) void service.cancelAuthorization?.(); try { popupRef.current?.close(); } catch { /* Closed or cross-origin. */ } };
  }, []);
  useEffect(() => {
    if (state === "ready") {
      authorizationPending.current = false;
      stopWatching();
      setAuthorization(null);
    }
  }, [state]);

  // 授权面板没有草稿输入；授权/断开/确认进行中都算 pending，禁止关闭设置或切换视图。
  useEffect(() => {
    reportEditState?.({ dirty: false, pending: busy });
  }, [reportEditState, busy]);

  const authorize = async () => {
    const currentAttempt = ++attempt.current;
    authorizationPending.current = true;
    setBusy(true);
    setNotice(null);
    setAuthorization(null);
    stopWatching();
    let popup: Window | null = null;
    try {
      // 在用户手势内预开窗口；被拦截或打开失败时仍获取链接，供用户直接点击。
      try {
        // WKWebView 将空字符串交给新窗口回调，Tauri 的 URL 解析会拒绝；必须显式 about:blank。
        popup = globalThis.open?.("about:blank", "woohaa3-chatgpt-auth", "width=520,height=640") ?? null;
      } catch {
        // 浏览器策略可能抛错；下方的普通链接不依赖 window.open。
      }
      popupRef.current = popup;
      const result = await service.authorize((url) => {
        if (!mounted.current || attempt.current !== currentAttempt) return;
        let opened = false;
        if (popup && !popup.closed) {
          try {
            popup.location.href = url;
            popup.focus();
            opened = true;
          } catch {
            // 已复用窗口可能因跨源策略不能导航，保留原始授权链接。
          }
        }
        setAuthorization({ url, blocked: !opened });
      });
      if (!mounted.current || attempt.current !== currentAttempt) { try { popup?.close(); } catch { /* Closed. */ } return; }
      if (!result.ok) throw new Error(result.error ?? "无法发起授权");
      // 同源回调通知刷新；关闭 popup 时再刷新，兜底消息丢失。
      if (popup && !popup.closed) {
        const watchedPopup = popup;
        watcherRef.current = setInterval(() => {
          if (watchedPopup.closed) {
            stopWatching();
            void service.refresh();
          }
        }, 500);
        timeoutRef.current = setTimeout(stopWatching, 10 * 60 * 1000);
      }
    } catch (error) {
      try { popup?.close(); } catch { /* 跨源/已关闭 */ }
      if (!mounted.current || attempt.current !== currentAttempt) return;
      authorizationPending.current = false;
      setAuthorization(null);
      setNotice(error instanceof Error ? error.message : "无法发起授权，请重试。");
    } finally {
      if (mounted.current && attempt.current === currentAttempt) setBusy(false);
    }
  };

  const cancelAuthorization = async () => {
    ++attempt.current; authorizationPending.current = false; stopWatching(); setBusy(false);
    try { popupRef.current?.close(); } catch { /* Closed. */ }
    const result = await service.cancelAuthorization?.();
    if (!mounted.current) return;
    if (result?.ok) { setAuthorization(null); setNotice(null); void service.refresh(); }
    else setNotice(result?.error ?? "取消授权失败，请重试。");
  };

  const disconnect = async () => {
    setBusy(true);
    const result = await service.disconnect();
    setBusy(false);
    if (!result.ok) setNotice(result.error ?? "断开失败");
    else {
      setConfirmDisconnect(false);
      setNotice(null);
    }
  };

  return (
    <div
      className="chatgpt-auth-row"
      data-state={state}
      data-testid="chatgpt-auth-row"
    >
      <SettingsSection
        title="ChatGPT 账号"
      >
        {onOpenRuntimes ? <SettingsFeedback tone="warning">
          ChatGPT Agent 使用 Codex 运行时。首次使用前，可下载组件或选择本机 Codex 程序。
          <Button size="sm" onClick={onOpenRuntimes}>管理运行时组件</Button>
        </SettingsFeedback> : null}
        <div className="chatgpt-auth-row__account">
          <div>
            <strong className="chatgpt-auth-row__name"><span className="service-identity"><ServiceLogo service="chatgpt" />ChatGPT</span></strong>
            {snapshot.auth?.account?.email ? <p className="settings-section__hint">{snapshot.auth.account.email}</p> : null}
          </div>
          {state === "connected-without-plan" || state === "reauthorization-required" ? <span
            className="settings-section__badge"
            data-testid="chatgpt-auth-state"
          >
            {stateLabel(state)}
          </span> : null}
          <div className="settings-section__actions">
            <Button
              tone={state === "ready" ? "neutral" : "primary"}
              loading={busy}
              onClick={() => void authorize()}
            >
              {state === "ready"
                ? "重新授权"
                : state === "reauthorization-required"
                  ? "重新授权 ChatGPT"
                  : "授权 ChatGPT"}
            </Button>
            {state === "ready" ||
            state === "connected-without-plan" ||
            state === "reauthorization-required" ? (
              <Button
                tone="ghost"
                disabled={busy}
                onClick={() => setConfirmDisconnect(true)}
              >
                断开连接
              </Button>
            ) : null}
          </div>
        </div>
        {snapshot.error || (state !== "ready" && state !== "disconnected" && snapshot.auth?.message) ? (
          <SettingsFeedback tone={snapshot.error ? "danger" : "neutral"}>
            {snapshot.error ?? snapshot.auth?.message}
          </SettingsFeedback>
        ) : null}
        {busy && !authorization && service.cancelAuthorization ? <Button size="sm" tone="ghost" onClick={() => void cancelAuthorization()}>取消授权</Button> : null}
        {authorization ? (
          <SettingsFeedback tone={authorization.blocked ? "warning" : "neutral"}>
            <p>{authorization.blocked
              ? "授权窗口未能打开，请点击下方链接继续。"
              : "请在新窗口中完成 ChatGPT 授权。若未看到窗口，可点击下方链接打开。"}</p>
            <a className="chatgpt-auth-row__authorization-link" href={authorization.url} target="woohaa3-chatgpt-auth" rel="opener">打开授权页面</a>
            {service.cancelAuthorization ? <Button size="sm" tone="ghost" onClick={() => void cancelAuthorization()}>取消授权</Button> : null}
          </SettingsFeedback>
        ) : null}
        {confirmDisconnect ? (
          <SettingsFeedback tone="warning">
            <p>断开后需要重新授权才能继续使用。历史与画布结果会保留。</p>
            <div className="settings-section__actions">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setConfirmDisconnect(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                确认断开
              </Button>
            </div>
          </SettingsFeedback>
        ) : null}
        {notice ? (
          <SettingsFeedback tone="danger">{notice}</SettingsFeedback>
        ) : null}
      </SettingsSection>
    </div>
  );
}

function stateLabel(state: string): string {
  switch (state) {
    case "ready":
      return "已启用订阅";
    case "connected-without-plan":
      return "已登录，未授权订阅额度";
    case "authorizing":
      return "授权中";
    case "reauthorization-required":
      return "需重新授权";
    default:
      return "未授权";
  }
}
