import { useState, type ReactNode } from "react";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { CursorMenu, type MenuItem } from "./ui/Menu.js";

/** 图片编辑区的鼠标入口；所有变换仍由 App 的同一个草稿会话负责。 */
export function EditorCanvasMenu({ children, commands, disabled, transforming, canTransform,
  canTransformSelection, canConfirm, hasGesture, onTransform, onEndTransform, onCommand }: {
  children: ReactNode;
  commands: ReadonlyMap<string, PhotocraftCommand>;
  disabled: boolean;
  transforming: boolean;
  canTransform: boolean;
  canTransformSelection: boolean;
  canConfirm: boolean;
  hasGesture: () => boolean;
  onTransform: (selectionOnly: boolean) => void;
  onEndTransform: (commit: boolean) => void;
  onCommand: (id: string) => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const available = (id: string) => {
    const command = commands.get(id);
    return !disabled && !!command?.allowed && command.enabled;
  };
  const items: MenuItem[] = transforming ? [
    { id: "confirm", label: "确认变换", disabled: disabled || !canConfirm, onSelect: () => onEndTransform(true) },
    { id: "cancel", label: "取消变换", onSelect: () => onEndTransform(false) }
  ] : [
    { id: "edit.transform", label: "自由变换", disabled: !available("edit.transform") || !canTransform,
      onSelect: () => onTransform(false) },
    ...(canTransformSelection ? [
      { id: "select.transformSelection", label: "变换选区", disabled: !available("select.transformSelection"),
        onSelect: () => onTransform(true) },
      { id: "select.deselect", label: "取消选择", separatorBefore: true, disabled: !available("select.deselect"), onSelect: onCommand }
    ] : [])
  ];
  return <div className="photo-editor__stage"
    onContextMenu={event => {
      // 原位文字保留系统的复制、粘贴菜单，但不冒泡到宿主节点。
      event.stopPropagation();
      if ((event.target as Element).closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      event.preventDefault();
      if ((event.target as Element).closest("[data-cursor-menu]")) return;
      if (disabled || hasGesture()) { setPosition(null); return; }
      setPosition({ x: event.clientX, y: event.clientY });
    }}
    onKeyDown={event => { if ((event.target as Element).closest("[data-cursor-menu]")) event.stopPropagation(); }}
    onKeyUp={event => { if ((event.target as Element).closest("[data-cursor-menu]")) event.stopPropagation(); }}>
    {children}
    <CursorMenu open={position !== null && !disabled} onOpenChange={open => { if (!open) setPosition(null); }}
      x={position?.x ?? 0} y={position?.y ?? 0} items={items} label="图片编辑" />
  </div>;
}
