/**
 * ScrollArea primitive
 * （change: adopt-radix-lucide-canvas-ui，任务 2.4 / design D3）。
 *
 * 只承载可滚动容器的结构与自定义滚动条，不缓存业务记录；内容仍由 consumer 渲染。
 * 滚动条宽度/颜色只消费 `--app-*` token（见 primitives.css）。
 */
import { forwardRef, type ReactNode } from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

export type ScrollAreaProps = {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  /** 视口可访问名（可选）。 */
  label?: string;
  type?: "auto" | "always" | "scroll" | "hover";
  /** 是否显示水平滚动条（默认 false）。 */
  horizontal?: boolean;
  testId?: string;
  style?: React.CSSProperties;
};

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(props, ref) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={["ui-scroll-area", props.className].filter(Boolean).join(" ")}
      type={props.type ?? "auto"}
      scrollHideDelay={600}
      data-testid={props.testId}
    >
      <ScrollAreaPrimitive.Viewport
        className={["ui-scroll-area__viewport", props.viewportClassName].filter(Boolean).join(" ")}
        aria-label={props.label}
      >
        {props.children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar className="ui-scroll-area__scrollbar" orientation="vertical">
        <ScrollAreaPrimitive.Thumb className="ui-scroll-area__thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      {props.horizontal ? (
        <ScrollAreaPrimitive.Scrollbar
          className="ui-scroll-area__scrollbar ui-scroll-area__scrollbar--horizontal"
          orientation="horizontal"
        >
          <ScrollAreaPrimitive.Thumb className="ui-scroll-area__thumb" />
        </ScrollAreaPrimitive.Scrollbar>
      ) : null}
      <ScrollAreaPrimitive.Corner className="ui-scroll-area__corner" />
    </ScrollAreaPrimitive.Root>
  );
});
