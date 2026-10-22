/**
 * Listbox primitive
 * （change: adopt-radix-remaining-canvas-ui，任务 3.3 / design D5）。
 *
 * 生产非模态 listbox：`role="listbox"` + `role="option"`，提供 roving focus（方向键、
 * Home/End）、选中态与 disabled 语义。用于 dock 面模型导航等内联列表（不是浮层）。
 *
 * 受控：`value`/`onValueChange` 由业务 owner 持有；本层不缓存业务记录。
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";

export type ListboxOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** 选项额外 class。 */
  className?: string;
  /** 选项可访问名（label 为复杂结构时提供）。 */
  ariaLabel?: string;
  /** 选项附加数据属性。 */
  dataAttributes?: Record<string, string | undefined>;
};

export type ListboxProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ListboxOption[];
  label: string;
  className?: string;
  optionClassName?: string;
  /** 首个可选项获得焦点（键盘进入时）。 */
  autoFocus?: boolean;
  /** 空态内容（无匹配时）。 */
  empty?: ReactNode;
  /** 透传到根的数据属性。 */
  dataAttributes?: Record<string, string | undefined>;
};

function firstEnabledIndex(options: readonly ListboxOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

export function Listbox(props: ListboxProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, props.options.findIndex((option) => option.value === props.value));

  const move = useCallback(
    (delta: number) => {
      const total = props.options.length;
      if (total === 0) return;
      let next = activeIndex;
      for (let step = 0; step < total; step += 1) {
        next = (next + delta + total) % total;
        if (!props.options[next]?.disabled) break;
      }
      const option = props.options[next];
      if (option) {
        props.onValueChange(option.value);
        refs.current[next]?.focus();
      }
    },
    [activeIndex, props]
  );

  useEffect(() => {
    if (!props.autoFocus) return;
    const index = firstEnabledIndex(props.options);
    if (index >= 0) refs.current[index]?.focus();
  }, [props.autoFocus, props.options]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const index = firstEnabledIndex(props.options);
      if (index >= 0) {
        props.onValueChange(props.options[index]!.value);
        refs.current[index]?.focus();
      }
    } else if (event.key === "End") {
      event.preventDefault();
      for (let index = props.options.length - 1; index >= 0; index -= 1) {
        if (!props.options[index]?.disabled) {
          props.onValueChange(props.options[index]!.value);
          refs.current[index]?.focus();
          break;
        }
      }
    }
  };

  return (
    <div
      role="listbox"
      aria-label={props.label}
      className={["ui-listbox", props.className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
      {...props.dataAttributes}
    >
      {props.options.map((option, index) => {
        const selected = option.value === props.value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={option.ariaLabel}
            tabIndex={selected || (activeIndex < 0 && index === firstEnabledIndex(props.options)) ? 0 : -1}
            disabled={option.disabled}
            className={["ui-listbox__option", selected ? "is-active" : "", props.optionClassName, option.className]
              .filter(Boolean)
              .join(" ")}
            {...option.dataAttributes}
            onClick={() => props.onValueChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
      {props.options.length === 0 ? props.empty : null}
    </div>
  );
}
