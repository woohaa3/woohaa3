/**
 * 微信扫码登录弹窗（单例）。
 *
 * 边界：
 * - 轮询只属于打开着的弹窗：1.5s 一次，终态立即停；卸载/关闭都会 `cancel`，不留无人轮询的 pending。
 * - 六态都由宿主状态驱动：pending / scanned / authorized / expired / cancelled / error。过期与取消
 *   保留二维码区域并给「刷新二维码」；error 给「重试」。
 * - 文案只用稳定短语，不透出 Authing / bridge 原始报错。
 * - 「稍后」只关闭当前弹窗；登录入口仍在供应商列表，需要时再打开。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "@woohaa3/ui/primitives";
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@woohaa3/ui/dialogs";
import { objectPayload } from "@woohaa3/frontend/extension-api";
import type { DialogDefinition, DialogRendererProps } from "@woohaa3/frontend/extension-api";
import {
  SDPPPX_ERROR_CODES,
  SDPPPX_LOGIN_DIALOG_ID,
  type SdpppxErrorCode,
  type SdpppxLoginPhase,
  type SdpppxLoginStart
} from "../shared.js";
import type { SdpppxAccountService } from "./account-service.js";
import "./sdpppx.css";

export const SDPPPX_LOGIN_POLL_INTERVAL_MS = 1500;

/** 单例、可关闭；payload 为空对象（内容全部来自宿主快照与登录状态）。 */
export const sdpppxLoginDialogDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "sm",
  variant: "standard",
  validatePayload: objectPayload<Record<string, never>>(SDPPPX_LOGIN_DIALOG_ID, () => ({}))
};

function promptForError(code: string | undefined): string {
  switch (code) {
    case SDPPPX_ERROR_CODES.configIncomplete:
      return "缺少 SDPPPX 部署参数，请联系管理员。";
    case SDPPPX_ERROR_CODES.authingAppMissing:
      return "当前租户还没有配置微信登录（Authing appId）。";
    case SDPPPX_ERROR_CODES.wechatUnavailable:
      return "当前租户未开通微信登录，请联系管理员。";
    case SDPPPX_ERROR_CODES.sessionExpired:
      return "登录已过期，请重新扫码。";
    case SDPPPX_ERROR_CODES.loginFailed:
      return "登录失败，请重新扫码。";
    case SDPPPX_ERROR_CODES.serviceUnavailable:
    default:
      return "服务暂不可用，请稍后重试。";
  }
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

type LoginState = {
  loginId: string | null;
  qrDataUrl: string | null;
  expiresAt: number;
  phase: SdpppxLoginPhase;
  nickname: string | null;
  error: string | null;
};

const INITIAL_STATE: LoginState = {
  loginId: null,
  qrDataUrl: null,
  expiresAt: 0,
  phase: "pending",
  nickname: null,
  error: null
};

export type SdpppxLoginDialogProps = {
  service: SdpppxAccountService;
  onClose: () => void;
  /** 弹窗实例 id（宿主注入）；独立渲染时退回 dialog id 作为稳定标签前缀。 */
  instanceId?: string;
  /** 登录成功后的回调（自动关窗由弹窗自己完成）。 */
  onAuthorized?: () => void;
};

export function SdpppxLoginDialog({ service, onClose, onAuthorized, instanceId }: SdpppxLoginDialogProps) {
  const [state, setState] = useState<LoginState>(INITIAL_STATE);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const activeLoginId = useRef<string | null>(null);
  const mounted = useRef(true);
  const startRun = useRef(0);
  /** 自动关窗与成功回调通过 ref 取最新实现，避免父级重渲染把关闭计时器清掉。 */
  const onCloseRef = useRef(onClose);
  const onAuthorizedRef = useRef(onAuthorized);
  onCloseRef.current = onClose;
  onAuthorizedRef.current = onAuthorized;

  const cancelActive = useCallback(() => {
    const loginId = activeLoginId.current;
    activeLoginId.current = null;
    if (loginId) void service.cancelLogin(loginId);
  }, [service]);

  const start = useCallback(async (): Promise<void> => {
    const run = startRun.current + 1;
    startRun.current = run;
    cancelActive();
    setStarting(true);
    setState(INITIAL_STATE);
    const result = await service.startLogin();
    if (!mounted.current || startRun.current !== run) {
      if (result.ok) void service.cancelLogin(result.loginId);
      return;
    }
    setStarting(false);
    if (!result.ok) {
      setState({
        ...INITIAL_STATE,
        phase: "error",
        error: result.code
      });
      return;
    }
    activeLoginId.current = result.loginId;
    const started: SdpppxLoginStart = result;
    setState({
      loginId: started.loginId,
      qrDataUrl: started.qrDataUrl,
      expiresAt: started.expiresAt,
      phase: "pending",
      nickname: null,
      error: null
    });
    setNow(Date.now());
  }, [cancelActive, service]);

  // 打开即取一张新码；弹窗重新打开不会复用上一张。
  useEffect(() => {
    mounted.current = true;
    void start();
    return () => {
      mounted.current = false;
      startRun.current += 1;
      cancelActive();
    };
  }, [cancelActive, start]);  // 倒计时每秒刷新；不参与轮询。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const terminal = state.phase === "authorized" || state.phase === "expired" || state.phase === "cancelled" || state.phase === "error";

  // 成功态：通知一次并自动关窗。计时器只随成功态建立，不会被轮询 effect 的清理提前取消。
  useEffect(() => {
    if (state.phase !== "authorized") return;
    onAuthorizedRef.current?.();
    const timer = setTimeout(() => {
      if (mounted.current) onCloseRef.current();
    }, 700);
    return () => clearTimeout(timer);
  }, [state.phase]);

  // 轮询：只在有 loginId 且未终态时运行。终态/卸载立即清理，不叠加请求。
  useEffect(() => {
    const loginId = state.loginId;
    if (!loginId || terminal) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      const status = await service.pollLogin(loginId);
      if (disposed) return;
      setState((current) => {
        if (current.loginId !== loginId) return current;
        return {
          ...current,
          phase: status.phase,
          nickname: status.nickname ?? current.nickname,
          error: status.error ?? null
        };
      });
      if (status.phase === "pending" || status.phase === "scanned") {
        timer = setTimeout(() => void tick(), SDPPPX_LOGIN_POLL_INTERVAL_MS);
      }
    };
    timer = setTimeout(() => void tick(), SDPPPX_LOGIN_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [service, state.loginId, terminal]);

  const remainingSeconds = useMemo(
    () => Math.max(0, Math.ceil((state.expiresAt - now) / 1000)),
    [now, state.expiresAt]
  );

  const done = (): void => {
    cancelActive();
    onClose();
  };

  const skip = (): void => {
    done();
  };

  const retry = (): void => {
    void start();
  };

  const statusText = (() => {
    switch (state.phase) {
      case "scanned":
        return "已扫码，请在手机上确认登录。";
      case "authorized":
        return "登录成功。";
      case "expired":
        return "二维码已失效，请刷新后重新扫码。";
      case "cancelled":
        return "登录已取消，可重新扫码。";
      case "error":
        return promptForError(state.error ?? undefined);
      case "pending":
        return starting ? "正在获取二维码…" : "请用微信扫描二维码登录。";
      default:
        return "";
    }
  })();

  const showQr = state.qrDataUrl !== null && state.phase !== "error";
  const canRefresh = state.phase === "expired" || state.phase === "cancelled";
  const expiredByClock = state.phase === "pending" && state.expiresAt > 0 && remainingSeconds === 0;
  const labelPrefix = instanceId ?? SDPPPX_LOGIN_DIALOG_ID;

  return (
    <Dialog.Content
      variant="standard"
      size="sm"
      labelledBy={`${labelPrefix}-title`}
      instanceId={instanceId ?? SDPPPX_LOGIN_DIALOG_ID}
      onOverlayClick={done}
    >
      <DialogHeader onClose={done}>
        <DialogTitle id={`${labelPrefix}-title`}>微信扫码登录 SDPPPX</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="sdpppx-login" data-phase={state.phase}>
          <div className="sdpppx-login__qr" data-testid="sdpppx-login-qr">
            {showQr ? (
              <img
                className="sdpppx-login__image"
                src={state.qrDataUrl ?? ""}
                alt="微信登录二维码"
                width={200}
                height={200}
              />
            ) : (
              <div className="sdpppx-login__placeholder">{starting ? "正在生成二维码…" : "暂无可用的二维码"}</div>
            )}
            {state.phase === "scanned" ? (
              <div className="sdpppx-login__overlay" data-testid="sdpppx-login-scanned">
                <span>已扫码</span>
                <span>请在手机上确认</span>
              </div>
            ) : null}
          </div>

          <p className="sdpppx-login__status" data-testid="sdpppx-login-status">
            {statusText}
          </p>

          {state.phase === "pending" || state.phase === "scanned" ? (
            <p className="sdpppx-login__countdown" data-testid="sdpppx-login-countdown">
              {expiredByClock ? "二维码已失效，请刷新" : `二维码有效期 ${formatCountdown(remainingSeconds)}`}
            </p>
          ) : null}

          {state.nickname && state.phase !== "authorized" ? (
            <p className="sdpppx-login__account">{state.nickname}</p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="sm" tone="ghost" onClick={skip} data-testid="sdpppx-login-later">
          稍后
        </Button>
        {canRefresh || expiredByClock ? (
          <Button size="sm" tone="primary" onClick={retry} loading={starting} data-testid="sdpppx-login-retry">
            刷新二维码
          </Button>
        ) : null}
        {state.phase === "error" ? (
          <Button size="sm" tone="neutral" onClick={retry} loading={starting} data-testid="sdpppx-login-error-retry">
            重试
          </Button>
        ) : null}
      </DialogFooter>
    </Dialog.Content>
  );
}

/** `ctx.dialogs.registerDialog` 的 renderer 工厂（entry 保持无 JSX）。 */
export function createSdpppxLoginDialogRenderer(
  service: SdpppxAccountService,
  onAuthorized?: () => void
): (props: DialogRendererProps) => ReactElement {
  return function SdpppxLoginDialogRenderer({ instance, requestClose }: DialogRendererProps) {
    return (
      <SdpppxLoginDialog
        service={service}
        instanceId={instance.instanceId}
        onClose={requestClose}
        {...(onAuthorized ? { onAuthorized } : {})}
      />
    );
  };
}

/** 稳定错误码给测试与界面共用；不在界面显示原始 code。 */
export function sdpppxLoginErrorCode(code: string | undefined): SdpppxErrorCode | null {
  const known = Object.values(SDPPPX_ERROR_CODES) as string[];
  return code && known.includes(code) ? (code as SdpppxErrorCode) : null;
}
