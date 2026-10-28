/** 表单控件复用工作台的按钮、浮层与列表；值和保存时机由业务持有。 */
import {
  forwardRef,
  useState,
  type TextareaHTMLAttributes,
  type InputHTMLAttributes,
} from "react";
import { Button } from "../primitives/Button.js";
import { Popover } from "../primitives/Popover.js";
import { Listbox, type ListboxOption } from "./Listbox.js";
import { ChevronDownIcon } from "../icons/icons.js";

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function TextInput({ className, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      className={["ui-text-input", className].filter(Boolean).join(" ")}
    />
  );
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ className, ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={["ui-text-input", "ui-text-area", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
});

export function SelectInput({
  label,
  value,
  onValueChange,
  options,
  disabled,
  placeholder = "请选择",
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ListboxOption[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover
      open={open && !disabled}
      onOpenChange={setOpen}
      align="start"
      className="ui-select-input__popup"
      trigger={
        <Button
          className={["ui-select-input", className].filter(Boolean).join(" ")}
          aria-label={label}
          disabled={disabled || options.length === 0}
        >
          <span className="ui-select-input__value">
            {selected?.label ?? placeholder}
          </span>
          <ChevronDownIcon size={14} />
        </Button>
      }
    >
      <Listbox
        label={label}
        value={value}
        options={options}
        onValueChange={(next) => {
          onValueChange(next);
          setOpen(false);
        }}
      />
    </Popover>
  );
}
