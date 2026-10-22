/**
 * 编辑器自有的 Dialog primitives
 * （change: 2026-10-21-extract-photocraft-subproject，design D3）。
 *
 * 只负责弹窗内部结构；**弹窗栈、焦点、Escape、遮罩与关闭策略仍归宿主**。编辑器把它作为
 * renderer 内容交给 `EditorDialogPort` 注册，宿主 Dialog Host 决定何时呈现。
 *
 * 这里不 import 宿主的共享 Dialog 组件：核心包必须能在只含 `photocraft/` 的副本中构建。
 */
import type { ReactNode } from "react";
import { IconButton } from "./Button.js";
import { CloseIcon } from "./icons.js";

export type DialogContentProps = {
  size?: "sm" | "md" | "lg" | "fullscreen";
  className?: string;
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  busy?: boolean;
  instanceId?: string;
  children: ReactNode;
};

export function DialogContent(props: DialogContentProps) {
  if (!props.ariaLabel && !props.labelledBy) {
    throw new Error("DialogContent 需要 ariaLabel 或 labelledBy（可访问名称）");
  }
  const classes = ["dlg", `dlg--${props.size ?? "md"}`, props.busy ? "dlg--busy" : "", props.className]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={classes}
      role="dialog"
      aria-modal="true"
      aria-label={props.ariaLabel}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      aria-busy={props.busy || undefined}
      data-dialog-instance={props.instanceId}
    >
      {props.children}
    </div>
  );
}

export function DialogHeader(props: { children: ReactNode; onClose?: () => void; closeLabel?: string }) {
  return (
    <header className="dlg__header">
      <div className="dlg__header-text">{props.children}</div>
      {props.onClose ? (
        <IconButton className="dlg__close" label={props.closeLabel ?? "关闭"} onClick={props.onClose}>
          <CloseIcon className="dlg__icon dlg__close-icon" />
        </IconButton>
      ) : null}
    </header>
  );
}

export function DialogTitle(props: { id?: string; children: ReactNode }) {
  return (
    <h2 className="dlg__title" id={props.id}>
      {props.children}
    </h2>
  );
}

export function DialogBody(props: { children: ReactNode; className?: string }) {
  return <div className={["dlg__body", props.className].filter(Boolean).join(" ")}>{props.children}</div>;
}

export function DialogFooter(props: { children: ReactNode; className?: string }) {
  return <footer className={["dlg__footer", props.className].filter(Boolean).join(" ")}>{props.children}</footer>;
}
