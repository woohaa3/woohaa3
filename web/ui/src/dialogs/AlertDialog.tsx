/**
 * AlertDialog 异步确认（change: add-frontend-dialog-system，任务 2.3 / design D5）。
 *
 * 确认开始时原子进入 busy：禁用确认/取消与隐式关闭，并保证业务回调最多执行一次。
 * 成功由调用方关闭当前实例；失败保留弹窗、退出 busy 并显示安全错误。
 * 迟到结果以 instanceId 校验，不得关闭后来打开或 replace 的其它弹窗。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog.js";
import { AlertDialogSurface } from "../primitives/DialogSurface.js";
import { Button } from "../primitives/Button.js";

export type AsyncConfirmResult = { ok: true } | { ok: false; error: string };

export type AlertDialogProps = {
  instanceId: string;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  children?: ReactNode;
  /** 点击取消（含 Escape/遮罩，由 Host 传同一入口）。 */
  onCancel: () => void;
  /**
   * 异步确认。成功（`ok: true`）时组件不自行关闭，由 Host/调用方按 instanceId 关闭；
   * 失败时保留打开并展示错误。
   */
  onConfirm: () => Promise<AsyncConfirmResult>;
  /** busy 状态变化回调（Host 用于阻止隐式关闭）。 */
  onBusyChange?: (busy: boolean) => void;
};

export function AlertDialog(props: AlertDialogProps) {
  return <AlertDialogInstance key={props.instanceId} {...props} />;
}

function AlertDialogInstance(props: AlertDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 防止双击/重复触发：同步 ref 记录进行中的确认，晚于 state 更新生效。
  const inFlight = useRef(false);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const handleConfirm = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    props.onBusyChange?.(true);
    let operation: Promise<AsyncConfirmResult>;
    try { operation = props.onConfirm(); }
    catch (cause) { operation = Promise.reject(cause); }
    void Promise.resolve(operation)
      .then((result) => {
        if (!active.current) return;
        if (!result.ok) {
          setError(result.error);
          setBusy(false);
          inFlight.current = false;
          props.onBusyChange?.(false);
        }
        // 成功：保持 busy，等待 Host 按 instanceId 关闭，避免关闭前被再次触发。
      })
      .catch((cause: unknown) => {
        if (!active.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
        inFlight.current = false;
        props.onBusyChange?.(false);
      });
  }, [props]);

  return (
    <AlertDialogSurface
      className="dlg dlg--alert dlg--sm"
      busy={busy}
      labelledBy={`${props.instanceId}-title`}
      describedBy={`${props.instanceId}-desc`}
      instanceId={props.instanceId}
      {...(busy ? {} : { onOverlayClick: props.onCancel })}
    >      <DialogHeader onClose={busy ? undefined : props.onCancel}>
        <DialogTitle id={`${props.instanceId}-title`}>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DialogDescription id={`${props.instanceId}-desc`}>{props.description}</DialogDescription>
        {props.children}
        {error ? (
          <p className="dlg__error" role="alert">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={props.onCancel} disabled={busy}>
          {props.cancelLabel ?? "取消"}
        </Button>
        <Button
          tone={props.danger ? "danger" : "primary"}
          onClick={handleConfirm}
          disabled={busy}
          aria-busy={busy ? "true" : undefined}
        >
          {props.confirmLabel ?? "确认"}
        </Button>
      </DialogFooter>
    </AlertDialogSurface>
  );
}
