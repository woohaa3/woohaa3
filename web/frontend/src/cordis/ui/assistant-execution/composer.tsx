import { TextArea } from "../../../shared/ui/FormControls.js";
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

/** All assistant surfaces use newline by default and explicit submission outside IME composition. */
export function AssistantComposer(props: AssistantComposerProps) {
  const composing = useRef(false);
  return <TextArea className={props.className} value={props.value} rows={props.rows}
    maxLength={props.maxLength}
    placeholder={props.placeholder} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229 && !props.disabled) {
        event.preventDefault(); props.onSubmit();
      }
    }} />;
}
