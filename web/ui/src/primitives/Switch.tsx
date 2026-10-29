/**
 * Switch primitive（Radix Switch adapter）
 * （change: add-frontend-plugin-manager，任务 4.1 / design D5）。
 *
 * 受控布尔开关：暴露 `checked`/`onCheckedChange`、`disabled` 与必填可访问名
 * （`aria-label` 或 `aria-labelledby` 由调用方提供）。视觉只消费 `--app-*` token
 * （见 primitives.css `.ui-switch`）。
 *
 * 一次键盘 Space/Enter 只产生一次 `onCheckedChange`（由 Radix 保证）；`disabled` 时
 * 不接受 pointer/keyboard 改变。
 */
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

export type SwitchProps = Omit<ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, "asChild"> & {
  /** 稳定测试/定位标识。 */
  testId?: string;
};

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, testId, ...rest },
  ref
) {
  return (
    <SwitchPrimitive.Root
      {...rest}
      ref={ref}
      className={["ui-switch", className].filter(Boolean).join(" ")}
      data-testid={testId}
    >
      <SwitchPrimitive.Thumb className="ui-switch__thumb" />
    </SwitchPrimitive.Root>
  );
});
