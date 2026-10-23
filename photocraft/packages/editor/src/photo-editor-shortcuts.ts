import { toolFamily } from "./features/tool-groups.js";
/** 图片编辑器的快捷键与显示提示共用清单；不扩展内核能力白名单。 */
import type { EditorToolId } from "./photo-editor-tools.js";
import type {EditorDisplayAction} from "./editor-display.js";

export type PhotoEditorTool = Exclude<EditorToolId, "pan" | "none"> | "move" | "transform" | "text";
export type EditorViewAction = "zoomIn" | "zoomOut" | "fit" | "actualSize";
export const TOOL_KEYS: Partial<Record<PhotoEditorTool, string>> = {
  move: "V", marquee: "M", lasso: "L", wand: "W", quick: "W", brush: "B", eraser: "E", text: "T",
  clone: "S", heal: "J", retouch: "J", pen: "P",
  pencil: "B", colorReplacement: "B", backgroundEraser: "E", magicEraser: "E",
  gradient: "G", bucket: "G", eyedropper: "I", "shape-rect": "U", "shape-rounded-rect": "U",
  "shape-ellipse": "U", "shape-triangle": "U", "shape-polygon": "U", "shape-star": "U", "shape-line": "U", "custom-shape": "U",
  "pen-freeform": "P", "pen-curvature": "P", "path-select": "A", "direct-select": "A",
  "polygon-lasso": "L", "magnetic-lasso": "L", crop: "C", hand: "H", zoom: "Z"
};

export type CommandShortcut = {
  readonly id: string;
  readonly key: string;
  readonly shift: boolean;
  /** 是否还要按住 Alt（目前只有「重复上次滤镜」）。 */
  readonly alt?: boolean;
  readonly label: string;
};

export const COMMAND_SHORTCUTS: readonly CommandShortcut[] = [
  { id: "edit.copy", key: "c", shift: false, label: "Mod+C" },
  { id: "edit.copyMerged", key: "c", shift: true, label: "Mod+Shift+C" },
  { id: "edit.cut", key: "x", shift: false, label: "Mod+X" },
  { id: "edit.paste", key: "v", shift: false, label: "Mod+V" },
  { id: "edit.pasteSpecial.pasteInPlace", key: "v", shift: true, label: "Mod+Shift+V" },
  { id: "edit.undo", key: "z", shift: false, label: "Mod+Z" },
  { id: "edit.redo", key: "z", shift: true, label: "Mod+Shift+Z" },
  { id: "select.all", key: "a", shift: false, label: "Mod+A" },
  { id: "select.deselect", key: "d", shift: false, label: "Mod+D" },
  { id: "select.reselect", key: "d", shift: true, label: "Mod+Shift+D" },
  { id: "select.inverse", key: "i", shift: true, label: "Mod+Shift+I" },
  { id: "layer.new.layer", key: "n", shift: true, label: "Mod+Shift+N" },
  { id: "layer.groupLayers", key: "g", shift: false, label: "Mod+G" },
  { id: "layer.ungroupLayers", key: "g", shift: true, label: "Mod+Shift+G" },
  { id: "layer.new.layerViaCopy", key: "j", shift: false, label: "Mod+J" },
  { id: "layer.mergeLayers", key: "e", shift: false, label: "Mod+E" },
  { id: "layer.mergeVisible", key: "e", shift: true, label: "Mod+Shift+E" },
  { id: "layer.arrange.bringForward", key: "]", shift: false, label: "Mod+]" },
  { id: "layer.arrange.sendBackward", key: "[", shift: false, label: "Mod+[" },
  { id: "layer.arrange.bringToFront", key: "]", shift: true, label: "Mod+Shift+]" },
  { id: "layer.arrange.sendToBack", key: "[", shift: true, label: "Mod+Shift+[" },
  // 重复上次滤镜（U46）：与上游 `filter.lastFilter` 同键位。只经命令门分派，
  // 因此开关状态仍由内核 `commandsJson()` 的 `enabled` 决定（没应用过滤镜时不可用）。
  { id: "filter.lastFilter", key: "f", shift: false, alt: true, label: "Mod+Alt+F" }
] as const;

export const FILL_SHORTCUTS = [
  {id:"edit.fillForeground",source:"foreground",alt:true,mod:false,shift:false,label:"Alt+Backspace"},
  {id:"edit.fillBackground",source:"background",alt:false,mod:true,shift:false,label:"Mod+Backspace"},
  {id:"edit.fillForegroundPreserve",source:"foreground",alt:true,mod:false,shift:true,label:"Alt+Shift+Backspace"},
  {id:"edit.fillBackgroundPreserve",source:"background",alt:false,mod:true,shift:true,label:"Mod+Shift+Backspace"}
] as const;

export const DISPLAY_SHORTCUTS = [
  {action:"extras",key:"h",mod:true,shift:false,label:"Mod+H"},
  {action:"panels",key:"tab",mod:false,shift:false,label:"Tab"},
  {action:"sidebar",key:"tab",mod:false,shift:true,label:"Shift+Tab"}
] as const;

export function isEditorMac(): boolean {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}
export function shortcutLabel(chord: string, isMac = isEditorMac()): string {
  return chord.replace("Mod", isMac ? "⌘" : "Ctrl").replace("Alt", isMac ? "Option" : "Alt").replace("Backspace", isMac ? "Delete" : "Backspace");
}
export function commandShortcutLabel(id: string): string | undefined {
  const chord = id === "layer.createClippingMask" || id === "layer.releaseClippingMask" ? "Mod+Alt+G" : id === "edit.clear" ? "Delete" : FILL_SHORTCUTS.find((entry) => entry.id === id)?.label ?? COMMAND_SHORTCUTS.find((entry) => entry.id === id)?.label;
  return chord ? shortcutLabel(chord) : undefined;
}

export type EditorShortcut =
  | {kind:"display";action:EditorDisplayAction}
  | { kind: "command"; id: string }
  | { kind: "tool"; tool: PhotoEditorTool; cycle: boolean }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "view"; action: EditorViewAction }
  | { kind: "brush"; property: "size" | "hardness"; direction: -1 | 1 }
  | { kind: "paintPercent"; property: "opacity" | "flow"; digit: number }
  | { kind: "color"; action: "swap" | "reset" }
  | { kind: "save" | "pan" | "escape" | "confirm" | "clipping" | "delete" }
  /**
   * 快速蒙版开关（Q）。
   *
   * 刻意不是 `{kind:"command"}`：`select.editInQuickMaskMode` 走共享 `run()` 会**绕过**选区域草稿
   * 直接改正式文档，结果是"内核已进快速蒙版、本域以为没有草稿"，画笔无处可落、保存却照常成功。
   * 只有经本域会话 `features.selections.beginQuickMask()/exitQuickMask()` 才和预览/确认/取消同源。
   */
  | { kind: "quickMask" }
  /**
   * 像素蒙版叠加开关（`\`）。
   *
   * 与 Q 的区别：这里**不**改草稿，切换的是查看状态（会话级），所以可以走共享 `run()`。
   * 但仍显式建模成一个动作而不是 `{kind:"command"}`，因为要按当前侧取反（内核命令本身是切换），
   * 且面板上"切换叠加（\）"的文案必须真的有键可依。
   */
  | { kind: "maskOverlay" };

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;
export function resolveEditorShortcut(event: KeyInput, isMac: boolean): EditorShortcut | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if ((isMac && event.ctrlKey) || (!isMac && event.metaKey)) return null;
  const key = event.code === "BracketLeft" ? "[" : event.code === "BracketRight" ? "]" : event.key.toLowerCase();
  if (key === "backspace" || (isMac && key === "delete")) {
    const fill = FILL_SHORTCUTS.find((entry) => entry.mod === mod && entry.alt === event.altKey && entry.shift === event.shiftKey);
    if (fill) return {kind:"command",id:fill.id};
  }
  if (event.altKey) {
    // 带 Alt 的**命令**快捷键（目前只有「重复上次滤镜」）。其余 Alt 组合保持原有语义：
    // 只有 Mod+Alt+G 是剪切蒙版，其它一律不认，避免抢走系统/输入法的 Alt 键。
    const altCommand = COMMAND_SHORTCUTS.find(
      (entry) => entry.alt === true && entry.key === key && entry.shift === event.shiftKey && mod
    );
    if (altCommand) return { kind: "command", id: altCommand.id };
    return mod && !event.shiftKey && (event.code === "KeyG" || key === "g") ? {kind:"clipping"} : null;
  }
  const display=DISPLAY_SHORTCUTS.find(entry=>entry.key===key && entry.mod===mod && entry.shift===event.shiftKey);
  if(display) return {kind:"display",action:display.action};
  if (mod) {
    // 只匹配**不带** Alt 的命令键；带 Alt 的组合由上面的 `altKey` 分支处理，
    // 否则新增的 Mod+Alt+F 会把本身的 Mod+F 也一并抢走。
    const command = COMMAND_SHORTCUTS.find((entry) => entry.alt !== true && entry.key === key && entry.shift === event.shiftKey);
    if (command) return { kind: "command", id: command.id };
    if (key === "t" && !event.shiftKey) return { kind: "tool", tool: "transform", cycle: false };
    if (key === "s" && !event.shiftKey) return { kind: "save" };
    if (key === "+" || key === "=") return { kind: "view", action: "zoomIn" };
    if (key === "-" && !event.shiftKey) return { kind: "view", action: "zoomOut" };
    if (key === "0" && !event.shiftKey) return { kind: "view", action: "fit" };
    if (key === "1" && !event.shiftKey) return { kind: "view", action: "actualSize" };
    return null;
  }
  const step = event.shiftKey ? 10 : 1;
  const digit = /^Digit[0-9]$/.test(event.code) ? Number(event.code.slice(-1)) : /^[0-9]$/.test(key) ? Number(key) : null;
  if (digit !== null) return {kind:"paintPercent",property:event.shiftKey ? "flow" : "opacity",digit};
  if (!event.shiftKey && (key === "x" || key === "d")) return {kind:"color",action:key === "x" ? "swap" : "reset"};
  if (key === "arrowleft" || key === "arrowright" || key === "arrowup" || key === "arrowdown") return {
    kind: "nudge", dx: key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
    dy: key === "arrowup" ? -step : key === "arrowdown" ? step : 0
  };
  if (key === "q" && !event.shiftKey) return { kind: "quickMask" };
  // 反斜杠在部分键盘布局下 `key` 是 `\` 而 `code` 是 `Backslash`；两者都认，避免布局差异下按键失效。
  if (!event.shiftKey && (event.code === "Backslash" || key === "\\")) return { kind: "maskOverlay" };
  if (key === " " && !event.shiftKey) return { kind: "pan" };
  if (key === "escape" && !event.shiftKey) return { kind: "escape" };
  if (key === "enter" && !event.shiftKey) return { kind: "confirm" };
  if ((key === "delete" || key === "backspace") && !event.shiftKey) return { kind: "delete" };
  if (key === "[" || key === "]") return { kind: "brush", property: event.shiftKey ? "hardness" : "size", direction: key === "[" ? -1 : 1 };
  const matches = Object.entries(TOOL_KEYS).filter(([, letter]) => letter?.toLowerCase() === key).map(([tool]) => tool as PhotoEditorTool);
  const tool = matches[event.shiftKey ? 1 : 0] ?? matches[0];
  if (tool && (!event.shiftKey || tool === "marquee" || toolFamily(tool).length > 1)) return { kind: "tool", tool, cycle: event.shiftKey };
  return null;
}

/** 输入、IME 与浮层消费按键；仅从编辑器自身的事件范围调用。 */
export function editorInputConsumesKeys(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]');
}
