/**
 * Tabs primitive
 * （change: adopt-radix-lucide-canvas-ui，任务 2.4 / design D3）。
 *
 * 用于**真正的视图切换**：受控 `value`/`onValueChange`，Radix 提供 ARIA tab/tabpanel、
 * 方向键导航与 roving focus。本层统一 `ui-tabs*` class 与 portal 无关的 DOM。
 */
import type { ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

export type TabItem = { value: string; label: ReactNode; disabled?: boolean; icon?: ReactNode };

export type TabsProps = {
  value: string;
  onValueChange: (value: string) => void;
  items: readonly TabItem[];
  /** 各 value 对应的面板内容（按 value 取用）。 */
  panels: Record<string, ReactNode>;
  className?: string;
  /** 列表可访问名。 */
  label?: string;
  /** 键盘方向（默认 ltr）。 */
  dir?: "ltr" | "rtl";
};

export function Tabs(props: TabsProps) {
  return (
    <TabsPrimitive.Root
      className={["ui-tabs", props.className].filter(Boolean).join(" ")}
      value={props.value}
      onValueChange={props.onValueChange}
      dir={props.dir}
    >
      <TabsPrimitive.List className="ui-tabs__list" aria-label={props.label}>
        {props.items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            className="ui-tabs__trigger"
            value={item.value}
            disabled={item.disabled}
          >
            {item.icon ? (
              <span className="ui-tabs__icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {props.items.map((item) => (
        <TabsPrimitive.Content key={item.value} className="ui-tabs__content" value={item.value}>
          {props.panels[item.value]}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
