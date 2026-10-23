import { useEffect, useRef, useState, type ComponentType } from "react";
import { Button, IconButton } from "./ui/Button.js";
import { Popover } from "./ui/Popover.js";
import { Tooltip } from "./ui/Tooltip.js";
import type { PhotoEditorTool } from "./photo-editor-shortcuts.js";

/**
 * 工具组选项。`Icon` 只要求「能接受 size」，因为工具栏同时消费 lucide 图标与 `ui/icons`
 * 里的统一包装（`withDefaults`）——后者不是 `ForwardRefExoticComponent`，用 `LucideIcon`
 * 会把「钢笔」这类既有工具排除在外。
 */
type ToolOption = { id: PhotoEditorTool; label: string; shortcut?: string; Icon: ComponentType<{ size?: number | string }> };

export function EditorToolGroup({ tool, options, disabled, onChoose }: {
  tool: PhotoEditorTool;
  options: readonly ToolOption[];
  disabled: boolean;
  onChoose: (tool: PhotoEditorTool) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const last = useRef(options[0]!);
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const selected = options.find((option) => option.id === tool);
  if (selected) last.current = selected;
  const current = selected ?? options.find(option => option.id === last.current.id) ?? options[0]!;
  const active = options.some((option) => option.id === tool);
  useEffect(() => () => clear(), []);
  useEffect(() => { if (disabled) { clear(); held.current = false; setOpen(false); } }, [disabled]);
  return <>
    <Tooltip content={`${current.label}${current.shortcut ? `（${current.shortcut}）` : ""}；长按或右键选择`} side="right">
      <IconButton ref={setAnchor} label={current.label} pressed={active} disabled={disabled}
        className="photo-editor__tool photo-editor__tool-group"
        onPointerDown={event => {
          clear(); held.current = false;
          if (disabled || event.button !== 0) return;
          timer.current = setTimeout(() => { timer.current = null; held.current = true; setOpen(true); }, 350);
        }}
        onPointerUp={clear} onPointerLeave={clear}
        onPointerCancel={() => { clear(); held.current = false; setOpen(false); }}
        onContextMenu={event => { event.preventDefault(); clear(); if (!disabled) setOpen(true); }}
        onClick={() => { clear(); if (held.current) { held.current = false; return; } if (!disabled) onChoose(current.id); }}>
        <current.Icon /><span className="photo-editor__tool-group-mark" />
      </IconButton>
    </Tooltip>
    {anchor ? <Popover anchorElement={anchor} open={open && !disabled} onOpenChange={setOpen}
      side="right" align="start" className="photo-editor__tool-group-menu">
      {options.map(option => <Button key={option.id} size="sm" tone={tool === option.id ? "neutral" : "ghost"}
        data-selected={tool === option.id ? "true" : undefined} icon={<option.Icon size={16} />}
        onClick={() => { setOpen(false); onChoose(option.id); }}>{option.label}{option.shortcut ? <kbd>{option.shortcut}</kbd> : null}</Button>)}
    </Popover> : null}
  </>;
}
