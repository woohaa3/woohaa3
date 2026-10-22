/**
 * Popover primitive
 * （change: adopt-radix-lucide-canvas-ui，任务 2.3 / design D3）。
 *
 * 受控 Popover：`open`/`onOpenChange` 由业务 owner 持有，本组件只承载定位、portal、
 * outside dismiss 与碰撞边距（交给 Radix positioning）。不缓存业务记录。
 *
 * 两种锚点模式：
 * - `trigger`：普通触发器（Radix `Trigger asChild`）；
 * - `anchor`：固定/虚拟锚点坐标（例如 Task Activity 的成功结果预览贴右侧定位）。
 */
import { forwardRef, type ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { usePortalContainer } from "./UiProvider.js";

type PopoverCommonProps = {
  /** 受控 open。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** popup 追加 class。 */
  className?: string;
  /** 是否在 outside pointerdown 时请求关闭（默认 true）。 */
  dismissOnOutside?: boolean;
  /** Escape 请求关闭（默认 true）。 */
  dismissOnEscape?: boolean;
  /** 关闭后焦点是否回到 trigger（默认 true）。 */
  restoreFocus?: boolean;
  /** Hover previews must not move keyboard focus into the popup. */
  autoFocus?: boolean;
  /** 测试标识。 */
  testId?: string;
};

export type PopoverProps = PopoverCommonProps &
  (
    | { trigger: ReactNode; anchor?: never; anchorPoint?: never; anchorElement?: never }
    | { anchor: ReactNode; trigger?: never; anchorPoint?: never; anchorElement?: never }
    | { anchorPoint: { x: number; y: number }; trigger?: never; anchor?: never; anchorElement?: never }
    // Existing DOM anchors avoid applying viewport coordinates inside transformed parents.
    | { anchorElement: HTMLElement; trigger?: never; anchor?: never; anchorPoint?: never }
  );

export const Popover = forwardRef<HTMLButtonElement, PopoverProps>(function Popover(props, ref) {
  const {
    open,
    onOpenChange,
    children,
    side = "bottom",
    align = "center",
    sideOffset = 6,
    className,
    dismissOnOutside = true,
    dismissOnEscape = true,
    restoreFocus = true,
    autoFocus = true,
    testId
  } = props;
  const container = usePortalContainer();

  const handlePointerDownOutside = (event: { preventDefault(): void }) => {
    if (!dismissOnOutside) event.preventDefault();
  };
  const handleEscapeKeyDown = (event: { preventDefault(): void }) => {
    if (!dismissOnEscape) event.preventDefault();
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {props.trigger != null ? (
        <PopoverPrimitive.Trigger asChild ref={ref}>
          {props.trigger}
        </PopoverPrimitive.Trigger>
      ) : props.anchor != null ? (
        <PopoverPrimitive.Anchor asChild>{props.anchor}</PopoverPrimitive.Anchor>
      ) : props.anchorElement != null ? (
        <PopoverPrimitive.Anchor virtualRef={{ current: props.anchorElement }} />
      ) : (
        <PopoverPrimitive.Anchor
          className="ui-popover__anchor"
          style={{ position: "fixed", left: props.anchorPoint!.x, top: props.anchorPoint!.y, width: 0, height: 0 }}
        />
      )}
      <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Content
          className={["ui-popover", className].filter(Boolean).join(" ")}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          data-testid={testId}
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onOpenAutoFocus={(event) => {
            if (!autoFocus) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!restoreFocus) event.preventDefault();
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
});
