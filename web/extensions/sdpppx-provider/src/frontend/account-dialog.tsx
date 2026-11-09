/**
 * 个人中心（单例弹窗）：租户、余额、会话到期、退出登录与重新扫码。
 *
 * 只读展示宿主快照；余额不可用显示占位，**不阻塞退出登录**。重新扫码会先清掉当前会话，
 * 避免旧主体在扫码途中继续被使用。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { objectPayload } from "@woohaa3/frontend/extension-api";
import type { DialogDefinition, DialogRendererProps } from "@woohaa3/frontend/extension-api";
import {
  SDPPPX_ACCOUNT_DIALOG_ID,
  hostOf,
  type SdpppxSessionSnapshot
} from "../shared.js";
import type { SdpppxAccountService } from "./account-service.js";
import "./sdpppx.css";

export const sdpppxAccountDialogDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "sm",
  variant: "standard",
  validatePayload: objectPayload<Record<string, never>>(SDPPPX_ACCOUNT_DIALOG_ID, () => ({}))
};

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleString();
}

function formatMoney(value: number): string {
  return Number.isFinite(value) ? String(value) : "—";
}

export type SdpppxAccountDialogProps = {
  service: SdpppxAccountService;
  onClose: () => void;
  onOpenLogin: () => void;
  instanceId?: string;
};

export function SdpppxAccountDialog({ service, onClose, onOpenLogin, instanceId }: SdpppxAccountDialogProps) {
  const snapshot: SdpppxSessionSnapshot = useSyncExternalStore<SdpppxSessionSnapshot>(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );
  const [busy, setBusy] = useState<"logout" | "rescan" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 打开时取一次最新会话与余额；失败保留本地快照，不把弹窗变成空白。
  useEffect(() => {
    void service.refresh();
  }, [service]);

  const logout = useCallback(async () => {
    setBusy("logout");
    setError(null);
    const result = await service.logout();
    setBusy(null);
    if (!result.ok) {
      setError("退出登录失败，请重试。");
      return;
    }
    onClose();
  }, [onClose, service]);

  const rescan = useCallback(async () => {
    setBusy("rescan");
    setError(null);
    const result = await service.logout();
    setBusy(null);
    if (!result.ok) {
      setError("退出当前账号失败，请重试。");
      return;
    }
    onClose();
    onOpenLogin();
  }, [onClose, onOpenLogin, service]);

  const session = snapshot.session;
  const config = snapshot.config;
  const balance = session?.balance;
  const name = session?.displayName?.trim() || "SDPPPX 账号";
  const labelPrefix = instanceId ?? SDPPPX_ACCOUNT_DIALOG_ID;
  const baseHost = hostOf(config.baseUrl) ?? config.baseUrl;

  return (
    <Dialog.Content
      variant="standard"
      size="sm"
      labelledBy={`${labelPrefix}-title`}
      instanceId={instanceId ?? SDPPPX_ACCOUNT_DIALOG_ID}
      onOverlayClick={onClose}
    >
      <DialogHeader onClose={onClose}>
        <DialogTitle id={`${labelPrefix}-title`}>SDPPPX 个人中心</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="sdpppx-account" data-testid="sdpppx-account-dialog">
          {session ? (
            <div className="sdpppx-account__identity">
              {session.avatarUrl ? (
                <img className="sdpppx-account__avatar" src={session.avatarUrl} alt="" width={40} height={40} />
              ) : (
                <span className="sdpppx-account__avatar is-fallback" aria-hidden="true">
                  {name.slice(0, 1)}
                </span>
              )}
              <div>
                <p className="sdpppx-account__name" data-testid="sdpppx-account-name">
                  {name}
                </p>
                <p className="sdpppx-account__expiry">会话到期：{formatTime(session.expiresAt)}</p>
              </div>
            </div>
          ) : (
            <p className="sdpppx-account__anonymous">当前未登录。可重新扫码登录 SDPPPX。</p>
          )}

          <dl className="sdpppx-account__facts">
            <dt>租户</dt>
            <dd data-testid="sdpppx-account-tenant">{config.tenantId ?? "—"}</dd>
            <dt>服务</dt>
            <dd>{baseHost || "—"}</dd>
            <dt>余额</dt>
            <dd data-testid="sdpppx-account-balance">
              {balance ? (
                <span>
                  总额 {formatMoney(balance.totalBalance)}
                  {balance.paid !== undefined ? ` · 充值 ${formatMoney(balance.paid)}` : ""}
                  {balance.monthlyBonus !== undefined ? ` · 月度赠送 ${formatMoney(balance.monthlyBonus)}` : ""}
                  {balance.dailyBonus !== undefined ? ` · 每日赠送 ${formatMoney(balance.dailyBonus)}` : ""}
                </span>
              ) : (
                <span className="sdpppx-account__muted">余额暂不可用</span>
              )}
            </dd>
          </dl>

          {error ? (
            <p className="sdpppx-account__error" data-testid="sdpppx-account-error">
              {error}
            </p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="sm" tone="ghost" onClick={onClose} data-testid="sdpppx-account-close">
          关闭
        </Button>
        <Button
          size="sm"
          tone="neutral"
          onClick={() => void rescan()}
          loading={busy === "rescan"}
          disabled={busy !== null}
          data-testid="sdpppx-account-rescan"
        >
          重新扫码
        </Button>
        <Button
          size="sm"
          tone="danger"
          onClick={() => void logout()}
          loading={busy === "logout"}
          disabled={busy !== null}
          data-testid="sdpppx-account-logout"
        >
          退出登录
        </Button>
      </DialogFooter>
    </Dialog.Content>
  );
}

/** renderer 工厂（入口文件保持无 JSX）。 */
export function createSdpppxAccountDialogRenderer(
  service: SdpppxAccountService,
  onOpenLogin: () => void
): (props: DialogRendererProps) => ReactElement {
  return function SdpppxAccountDialogRenderer({ instance, requestClose }: DialogRendererProps) {
    return (
      <SdpppxAccountDialog
        service={service}
        instanceId={instance.instanceId}
        onClose={requestClose}
        onOpenLogin={onOpenLogin}
      />
    );
  };
}
