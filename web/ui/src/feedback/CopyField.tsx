import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "../primitives/Tooltip.js";
import { IconButton } from "../primitives/Button.js";
import { CheckIcon, CopyIcon } from "../icons/index.js";
/** 复制字段：成功/失败反馈，注入 adapter（Showcase 不触碰真实 clipboard）。 */
export function CopyField({
  value,
  label,
  copyText,
  className,
  children
}: {
  value: string;
  label: string;
  copyText: (value: string) => Promise<boolean | void>;
  className?: string;
  children?: ReactNode;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setStatus("idle");
    return () => {
      generation.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value]);
  return (
    <span className={["ui-copy-field", className].filter(Boolean).join(" ")} data-copy-status={status}>
      {children}
      <Tooltip content={`${label}：${value}`}>
        <IconButton
          label={`复制${label}`}
          size="sm"
          onClick={() => {
            const operation = ++generation.current;
            if (timer.current) clearTimeout(timer.current);
            void Promise.resolve().then(() => copyText(value)).then(
              (ok) => {
                if (operation !== generation.current) return;
                setStatus(ok === false ? "error" : "copied");
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => { if (operation === generation.current) setStatus("idle"); }, 1600);
              },
              () => { if (operation === generation.current) setStatus("error"); }
            );
          }}
        >
          {status === "copied" ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </Tooltip>
      <span className="ui-copy-field-feedback" role="status" aria-live="polite">
        {status === "copied" ? "已复制" : status === "error" ? "复制失败" : ""}
      </span>
    </span>
  );
}

