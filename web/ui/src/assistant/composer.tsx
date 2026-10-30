import { TextArea } from "../forms/FormControls.js";
import { useRef } from "react";

export type AssistantComposerProps = {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  rows?: number;
  maxLength?: number;
};

/** All assistant surfaces submit on Enter and keep Shift+Enter for newlines, outside IME composition. */
export function AssistantComposer(props: AssistantComposerProps) {
  const composing = useRef(false);
  return <TextArea className={props.className} value={props.value} rows={props.rows}
    maxLength={props.maxLength}
    placeholder={props.placeholder} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
      if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229 || props.disabled) return;
      event.preventDefault(); props.onSubmit();
    }} />;
}
