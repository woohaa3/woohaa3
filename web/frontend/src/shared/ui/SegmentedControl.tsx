/**
 * SegmentedControl primitive（单/多选 ToggleGroup）
 * （change: adopt-radix-lucide-canvas-ui，任务 2.4 / design D3）。
 *
 * single 模式 SHALL NOT 取消到空值：Radix `type="single"` 在再次激活当前项时回传空串，
 * 本层显式忽略空值，保证「始终有一个合法选项」。multiple 模式暴露多选语义与选中状态。
 *
 * 使用受控 `value`/`onValueChange`，状态始终由业务 owner（Theme Service、tool 模式）持有。
 */
import type { ReactNode } from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

export type SegmentedOption = {
  value: string;
  label: ReactNode;
  /** 可选前缀图标（默认 aria-hidden）。 */
  icon?: ReactNode;
  disabled?: boolean;
  /** 可访问名（label 为纯图标时必填）。 */
  ariaLabel?: string;
  /** 触发元素的 title（迁移期保留的可见提示）。 */
  title?: string;
};

type CommonProps = {
  options: readonly SegmentedOption[];
  className?: string;
  /** 组可访问名。 */
  label?: string;
  /** 每个选项追加 class 的钩子（迁移期保留业务 class）。 */
  optionClassName?: string;
  /** 透传到 radiogroup 根的数据属性（迁移期保留 data-* 契约）。 */
  dataAttributes?: Record<`data-${string}`, string>;
};

export type SegmentedControlProps =
  | (CommonProps & {
      type?: "single";
      value: string;
      onValueChange: (value: string) => void;
    })
  | (CommonProps & {
      type: "multiple";
      value: readonly string[];
      onValueChange: (value: string[]) => void;
    });

export function SegmentedControl(props: SegmentedControlProps) {
  const rootClass = ["ui-segmented", props.className].filter(Boolean).join(" ");
  if (props.type === "multiple") {
    return (
      <ToggleGroupPrimitive.Root
        className={rootClass}
        type="multiple"
        value={[...props.value]}
        aria-label={props.label}
        {...props.dataAttributes}
        onValueChange={(next) => props.onValueChange(next)}
      >
        {props.options.map((option) => (
          <SegmentedItem key={option.value} option={option} className={props.optionClassName} />
        ))}
      </ToggleGroupPrimitive.Root>
    );
  }
  return (
    <ToggleGroupPrimitive.Root
      className={rootClass}
      type="single"
      value={props.value}
      aria-label={props.label}
      {...props.dataAttributes}
      onValueChange={(next) => {
        // single 模式不可取消到空值：忽略空串与非法值。
        if (next) props.onValueChange(next);
      }}
    >
      {props.options.map((option) => (
        <SegmentedItem key={option.value} option={option} className={props.optionClassName} />
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

function SegmentedItem({ option, className }: { option: SegmentedOption; className?: string }) {
  return (
    <ToggleGroupPrimitive.Item
      className={["ui-segmented__option", className].filter(Boolean).join(" ")}
      value={option.value}
      disabled={option.disabled}
      aria-label={option.ariaLabel}
      title={option.title}
    >
      {option.icon ? (
        <span className="ui-segmented__icon" aria-hidden="true">
          {option.icon}
        </span>
      ) : null}
      {option.label != null ? <span className="ui-segmented__label">{option.label}</span> : null}
    </ToggleGroupPrimitive.Item>
  );
}
