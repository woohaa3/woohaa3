/**
 * Tooltip primitive
 * （change: adopt-radix-lucide-canvas-ui，任务 2.2 / design D2/D3）。
 *
 * 封装 Radix Tooltip：统一 delay（来自 UiProvider）、portal container 与 `ui-tooltip`
 * class 契约。Tooltip 通过 hover 与 keyboard focus 双向可发现（Radix 语义）。
 *
 * 受控/非受控：默认非受控（hover/focus 触发）；需要程序化控制时传 `open`/`onOpenChange`。
 */
import { forwardRef, type ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useOptionalUiContext, usePortalContainer } from "./UiProvider.js";

export type TooltipProps = {
  /** 触发元素（作为 Radix `Trigger asChild`）。 */
  children: ReactNode;
  /** 提示内容。 */
  content: ReactNode;
  /** 提示相对触发元素的偏移。 */
  sideOffset?: number;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** 受控 open（缺省非受控）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 提示内容 class（业务可追加布局类）。 */
  className?: string;
  /** 关闭时是否保留在 DOM（Radix 默认会卸载）。 */
  forceMount?: boolean;
  /** 禁用提示（例如 disabled 控件不必提示）。 */
  disabled?: boolean;
};

/** 无 Provider 也可用：直接包一层 Radix Tooltip（缺 Provider 时提供本地 default delay）。 */
export const Tooltip = forwardRef<HTMLButtonElement, TooltipProps>(function Tooltip(props, ref) {
  const container = usePortalContainer();
  const hasProvider = useOptionalUiContext() !== null;
  if (props.disabled) return <>{props.children}</>;
  const root = (
    <TooltipPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <TooltipPrimitive.Trigger asChild ref={ref}>
        {props.children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container ?? undefined} forceMount={props.forceMount ? true : undefined}>
        <TooltipPrimitive.Content
          className={["ui-tooltip", props.className].filter(Boolean).join(" ")}
          side={props.side}
          align={props.align}
          sideOffset={props.sideOffset ?? 6}
          collisionPadding={8}
        >
          {props.content}
          <TooltipPrimitive.Arrow className="ui-tooltip__arrow" width={10} height={5} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  // UiProvider 已提供统一 delay/portal；脱离 Provider（测试/独立预览）时自带一个 narrow provider。
  return hasProvider ? root : <TooltipPrimitive.Provider delayDuration={350}>{root}</TooltipPrimitive.Provider>;
});

/** 仅有可见文案时才需要 Tooltip 的便捷包装（content 为空则原样返回）。 */
export function TooltipIfPresent(props: TooltipProps & { content?: ReactNode }) {
  const { content, ...rest } = props;
  if (content == null || content === "") return <>{props.children}</>;
  return <Tooltip {...rest} content={content} />;
}
