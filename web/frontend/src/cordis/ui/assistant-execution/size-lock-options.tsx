import { useState, type ReactNode } from "react";
import { Button, Popover } from "@woohaa3/ui/primitives";
import { ChevronDownIcon } from "@woohaa3/ui/icons";
import "./size-lock-options.css";

/** 首次生成与续聊共用的导演区执行选项。 */
export function SizeLockOptions({ children, available, tone = "primary", checked, disabled, onCheckedChange }: {
  children: ReactNode;
  available: boolean;
  tone?: "primary" | "neutral";
  checked: boolean;
  disabled: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  if (!available) return <>{children}</>;
  return (
    <div className="assistant-size-lock-button">
      {children}
      <Popover
        open={open && !disabled}
        onOpenChange={setOpen}
        align="end"
        side="top"
        className="assistant-size-lock-options"
        trigger={
          <Button className="assistant-size-lock-button__arrow" aria-label="生成选项" title="生成选项" tone={tone} disabled={disabled}>
            <ChevronDownIcon size={14} />
          </Button>
        }
      >
        <label className="assistant-size-lock">
          <input type="checkbox" checked={checked} disabled={disabled}
            onChange={event => onCheckedChange(event.target.checked)} />
          锁定大小范围
        </label>
      </Popover>
    </div>
  );
}
