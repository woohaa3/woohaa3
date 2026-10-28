/**
 * Collapsible primitive
 * （change: adopt-radix-lucide-canvas-ui，任务 2.4 / design D3）。
 *
 * 只拥有交互结构（trigger 的 `aria-expanded`/`data-state` 与 content 显隐），
 * 不缓存业务记录。受控 `open`/`onOpenChange` 由业务 owner 持有；`defaultOpen` 用于
 * 非受控场景（Showcase diagnostics）。
 *
 * 提供两种用法：
 * - `Collapsible`：trigger/content 由 props 传入的便捷组合；
 * - `CollapsibleRoot` / `CollapsibleTrigger` / `CollapsibleContent`：需要把 trigger 放
 *   在业务 header 内（例如 Task Activity 的标题行）时自由组合。
 */
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

export const CollapsibleRoot = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Root>,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>(function CollapsibleRoot(props, ref) {
  return <CollapsiblePrimitive.Root ref={ref} {...props} />;
});

export const CollapsibleTrigger = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(function CollapsibleTrigger(props, ref) {
  return <CollapsiblePrimitive.Trigger ref={ref} {...props} />;
});

export const CollapsibleContent = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Content>,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(function CollapsibleContent(props, ref) {
  return <CollapsiblePrimitive.Content ref={ref} {...props} />;
});

export type CollapsibleProps = {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  disabled?: boolean;
  /** 内容是否在关闭后保留挂载（默认 Radix 卸载）。 */
  forceMount?: boolean;
};

export function Collapsible(props: CollapsibleProps) {
  return (
    <CollapsiblePrimitive.Root
      className={["ui-collapsible", props.className].filter(Boolean).join(" ")}
      open={props.open}
      defaultOpen={props.defaultOpen}
      onOpenChange={props.onOpenChange}
      disabled={props.disabled}
    >
      <CollapsiblePrimitive.Trigger
        className={["ui-collapsible__trigger", props.triggerClassName].filter(Boolean).join(" ")}
      >
        {props.trigger}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content
        className={["ui-collapsible__content", props.contentClassName].filter(Boolean).join(" ")}
        forceMount={props.forceMount ? true : undefined}
      >
        {props.children}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
