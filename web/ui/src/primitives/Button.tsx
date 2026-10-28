/**
 * Button / IconButton primitives
 * （change: adopt-radix-lucide-canvas-ui，任务 2.2 / design D3）。
 *
 * 自有 DOM primitive（Radix 不提供视觉 Button）：只封装重复的 size/tone/disabled/loading
 * 语义、统一 class 前缀与 token 消费；保留 ref、事件透传与有限 className 扩展点。
 * MUST NOT 接受任意业务状态枚举。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonSize = "sm" | "md" | "lg";
export type ButtonTone = "neutral" | "primary" | "danger" | "ghost";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  size?: ButtonSize;
  tone?: ButtonTone;
  /** busy 呈现：`aria-busy` + 禁用重复触发（仍可被读屏发现）。 */
  loading?: boolean;
  /** 前缀图标（默认 `aria-hidden`）。 */
  icon?: ReactNode;
  type?: "button" | "submit" | "reset";
};

/** 生成统一 `ui-button` class（业务可传 className 追加布局类）。 */
export function buttonClassName(
  base: string,
  options: { size?: ButtonSize; tone?: ButtonTone; className?: string }
): string {
  return [base, `ui-button--${options.tone ?? "neutral"}`, `ui-button--${options.size ?? "md"}`, options.className]
    .filter(Boolean)
    .join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const {
    size = "md",
    tone = "neutral",
    loading = false,
    icon,
    disabled,
    className,
    children,
    type = "button",
    ...rest
  } = props;
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClassName("ui-button", { size, tone, className })}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      disabled={disabled || loading}
    >
      {icon ? (
        <span className="ui-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children != null ? <span className="ui-button__label">{children}</span> : null}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> & {
  /** 强制可访问名称（icon-only MUST 有名称，design D3）。 */
  label: string;
  size?: ButtonSize;
  tone?: ButtonTone;
  loading?: boolean;
  /** 图标（默认 `aria-hidden`）。 */
  children: ReactNode;
  /** 切换类控件的按下态。 */
  pressed?: boolean;
  type?: "button" | "submit" | "reset";
};

/**
 * 紧凑图标按钮。默认图标 `aria-hidden`；`label` 是唯一的可访问名称来源。
 * 陌生操作由调用方用 Tooltip 包裹本组件提供可见说明。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(props, ref) {
  const { size = "md", tone = "ghost", loading = false, disabled, className, children, pressed, label, type = "button", ...rest } = props;
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={["ui-icon-button", `ui-icon-button--${tone}`, `ui-icon-button--${size}`, className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      aria-pressed={pressed}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      disabled={disabled || loading}
    >
      <span className="ui-icon-button__icon" aria-hidden="true">
        {children}
      </span>
    </button>
  );
});
