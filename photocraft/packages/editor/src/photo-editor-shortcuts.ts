import type {ViewportNavigation} from "./viewport-navigation.js";
/** 图片编辑器的快捷键与显示提示共用清单；不扩展内核能力白名单。 */
import type { EditorToolId } from "./photo-editor-tools.js";
import type {EditorDisplayAction} from "./editor-display.js";

export type PhotoEditorTool = Exclude<EditorToolId, "none"> | "move" | "transform" | "text";
export type EditorViewAction = "zoomIn" | "zoomOut" | "fit" | "actualSize" | "twoHundredPercent" | "printSize" | "fitLayers";
export const TOOL_KEYS: Partial<Record<PhotoEditorTool, string>> = {
  move: "V", marquee: "M", lasso: "L", magicWand: "W", brush: "B",pencil:"B",eyedropper:"I", eraser: "E", text: "T",pan:"H",zoom:"Z",bucket:"G"
};

export const COMMAND_SHORTCUTS = [
  { id: "edit.copy", key: "c", shift: false, label: "Mod+C" },
  { id: "edit.copyMerged", key: "c", shift: true, label: "Mod+Shift+C" },
  { id: "edit.cut", key: "x", shift: false, label: "Mod+X" },
  { id: "edit.paste", key: "v", shift: false, label: "Mod+V" },
  { id: "edit.pasteSpecial.pasteInPlace", key: "v", shift: true, label: "Mod+Shift+V" },
  { id:"edit.pasteSpecial.pasteInto",key:"v",shift:true,alt:true,label:"Mod+Alt+Shift+V" },
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
  { id: "layer.new.layerViaCut", key: "j", shift: true, label: "Mod+Shift+J" },
  { id: "layer.mergeLayers", key: "e", shift: false, label: "Mod+E" },
  { id: "layer.mergeVisible", key: "e", shift: true, label: "Mod+Shift+E" },
  { id: "layer.arrange.bringForward", key: "]", shift: false, label: "Mod+]" },
  { id: "layer.arrange.sendBackward", key: "[", shift: false, label: "Mod+[" },
  { id: "layer.arrange.bringToFront", key: "]", shift: true, label: "Mod+Shift+]" },
  { id: "layer.arrange.sendToBack", key: "[", shift: true, label: "Mod+Shift+[" }
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

export const LAYER_NAV_SHORTCUTS = [
  {id:"layer.selectAbove",code:"BracketRight",key:"]",shift:false,label:"Alt+]"},
  {id:"layer.selectBelow",code:"BracketLeft",key:"[",shift:false,label:"Alt+["},
  {id:"layer.selectTop",code:"Period",key:".",shift:false,label:"Alt+."},
  {id:"layer.selectBottom",code:"Comma",key:",",shift:false,label:"Alt+,"},
  {id:"layer.addAboveToSelection",code:"BracketRight",key:"]",shift:true,label:"Alt+Shift+]"},
  {id:"layer.addBelowToSelection",code:"BracketLeft",key:"[",shift:true,label:"Alt+Shift+["}
] as const;

export function isEditorMac(): boolean {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}
export function shortcutLabel(chord: string, isMac = isEditorMac()): string {
  return chord.replace("Mod", isMac ? "⌘" : "Ctrl").replace("Alt", isMac ? "Option" : "Alt").replace("Backspace", isMac ? "Delete" : "Backspace");
}
export function commandShortcutLabel(id: string): string | undefined {
  const chord = id==="edit.fillHistory"?"Mod+Alt+Backspace":id==="edit.fill"?"Shift+F5":id==="layer.stampVisible"?"Mod+Alt+Shift+E":id==="layer.stampDown"?"Mod+Alt+E":id==="select.allLayers"?"Mod+Alt+A":id==="select.findLayers"?"Mod+Alt+Shift+F": id === "layer.createClippingMask" || id === "layer.releaseClippingMask" ? "Mod+Alt+G" : id === "edit.clear" ? "Delete" : id === "edit.toggleLastState" ? "Mod+Alt+Z" : id === "layer.hideLayers" ? "Mod+," : LAYER_NAV_SHORTCUTS.find(entry=>entry.id===id)?.label ?? FILL_SHORTCUTS.find((entry) => entry.id === id)?.label ?? COMMAND_SHORTCUTS.find((entry) => entry.id === id)?.label;
  return chord ? shortcutLabel(chord) : undefined;
}

export type EditorShortcut =
  | {kind:"navigate";navigation:ViewportNavigation}
  | {kind:"documentsClose";mode:"all"|"others"}
  | {kind:"documentCycle";direction:-1|1}
  | {kind:"display";action:EditorDisplayAction}
  | {kind:"layerState";action:"transparencyLock"}
  | { kind: "command"; id: string }
  | { kind: "tool"; tool: PhotoEditorTool; cycle: boolean }
  | { kind:"blendCycle";direction:-1|1 }
  | { kind: "nudge"; dx: number; dy: number; pixels?:boolean; duplicate?:boolean }
  | { kind: "view"; action: EditorViewAction }
  | { kind: "brush"; property: "size" | "hardness"; direction: -1 | 1 }
  | { kind: "paintPercent"; property: "opacity" | "flow"; digit: number }
  | { kind: "color"; action: "swap" | "reset" }
  | { kind: "open" | "save" | "pan" | "escape" | "confirm" | "clipping" | "delete" };

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;
export function resolveEditorShortcut(event: KeyInput, isMac: boolean,useShiftForToolSwitch=true): EditorShortcut | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if(event.key==="Tab" && event.ctrlKey && !event.metaKey && !event.altKey) return {kind:"documentCycle",direction:event.shiftKey?-1:1};
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if ((isMac && event.ctrlKey) || (!isMac && event.metaKey)) return null;
  const key = event.code === "BracketLeft" ? "[" : event.code === "BracketRight" ? "]" : event.key.toLowerCase();
  if(!event.altKey && ["pageup","pagedown","home","end"].includes(key))return {kind:"navigate",navigation:{key:({pageup:"PageUp",pagedown:"PageDown",home:"Home",end:"End"} as const)[key as "pageup"|"pagedown"|"home"|"end"],horizontal:mod,small:event.shiftKey}};
  if(!mod && !event.altKey && event.shiftKey && (key==="f5" || key==="backspace" || isMac && key==="delete"))return {kind:"command",id:"edit.fill"};
  if(mod && event.altKey && !event.shiftKey && (key==="backspace" || isMac && key==="delete"))return {kind:"command",id:"edit.fillHistory"};
  if (key === "backspace" || (isMac && key === "delete")) {
    const fill = FILL_SHORTCUTS.find((entry) => entry.mod === mod && entry.alt === event.altKey && entry.shift === event.shiftKey);
    if (fill) return {kind:"command",id:fill.id};
  }
  if (["arrowleft","arrowright","arrowup","arrowdown"].includes(key)) {
    const step=event.shiftKey?10:1;
    return {kind:"nudge",dx:key==="arrowleft"?-step:key==="arrowright"?step:0,dy:key==="arrowup"?-step:key==="arrowdown"?step:0,...(mod?{pixels:true}:{}),...(event.altKey?{duplicate:true}:{})};
  }
  if (event.altKey) {
    if(mod && event.shiftKey && (event.code==="KeyV" || key==="v"))return {kind:"command",id:"edit.pasteSpecial.pasteInto"};
    if(mod && event.shiftKey && (event.code==="KeyT" || key==="t"))return {kind:"command",id:"edit.transform.againCopy"};
    if(mod && !event.shiftKey && (key==="w" || key==="p"))return {kind:"documentsClose",mode:key==="w"?"all":"others"};
    if(mod && (event.code==="KeyE" || key==="e")) return {kind:"command",id:event.shiftKey?"layer.stampVisible":"layer.stampDown"};
    if(mod && !event.shiftKey && (event.code==="KeyA" || key==="a")) return {kind:"command",id:"select.allLayers"};
    if(mod && event.shiftKey && (event.code==="KeyF" || key==="f")) return {kind:"command",id:"select.findLayers"};
    if (mod && !event.shiftKey && (event.code === "KeyG" || key === "g")) return {kind:"clipping"};
    if (mod && !event.shiftKey && (event.code === "KeyZ" || key === "z")) return {kind:"command",id:"edit.toggleLastState"};
    const navigation = !mod && LAYER_NAV_SHORTCUTS.find(entry=>(entry.code===event.code || entry.key===key) && entry.shift===event.shiftKey);
    return navigation ? {kind:"command",id:navigation.id} : null;
  }
  if(!mod&&!event.altKey&&!event.shiftKey && ["f2","f3","f4"].includes(key))return {kind:"command",id:({f2:"edit.cut",f3:"edit.copy",f4:"edit.paste"} as const)[key as "f2"|"f3"|"f4"]};
  if(key==="f8" && !mod && !event.shiftKey)return {kind:"display",action:"info"};
  // Q：切换 Quick Mask 编辑模式（I085），与上游同键位。
  if(key==="q" && !mod && !event.altKey && !event.shiftKey)return {kind:"command",id:"select.editInQuickMaskMode"};
  // 反斜杠：显示/隐藏活动层蒙版为红色叠加（I220）；Shift/Alt/Mod 组合留给其它命令。
  if((event.code==="Backslash" || key==="\\") && !mod && !event.altKey && !event.shiftKey)return {kind:"command",id:"layer.toggleMaskOverlay"};
  const display=DISPLAY_SHORTCUTS.find(entry=>entry.key===key && entry.mod===mod && entry.shift===event.shiftKey);
  if(display) return {kind:"display",action:display.action};
  if (mod) {
    if (!event.shiftKey && (event.code === "Comma" || key === ",")) return {kind:"command",id:"layer.hideLayers"};
    if(!event.shiftKey && (event.code==="Backslash" || key==="\\")) return {kind:"command",id:"channel.target.layerMask"};
    if(!event.shiftKey && key==="2") return {kind:"command",id:"channel.target.composite"};
    const command = COMMAND_SHORTCUTS.find((entry) => entry.key === key && entry.shift === event.shiftKey && !("alt" in entry && entry.alt));
    if (command) return { kind: "command", id: command.id };
    if (key === "t" && event.shiftKey) return { kind: "command", id: "edit.transform.again" };
    if (key === "t" && !event.shiftKey) return { kind: "tool", tool: "transform", cycle: false };
    if(key==="o" && !event.shiftKey)return {kind:"open"};
    if (key === "s" && !event.shiftKey) return { kind: "save" };
    if (key === "+" || key === "=") return { kind: "view", action: "zoomIn" };
    if (key === "-" && !event.shiftKey) return { kind: "view", action: "zoomOut" };
    if (key === "0" && !event.shiftKey) return { kind: "view", action: "fit" };
    if (key === "1" && !event.shiftKey) return { kind: "view", action: "actualSize" };
    return null;
  }
  if(!event.shiftKey && (event.code==="Slash" || key==="/")) return {kind:"layerState",action:"transparencyLock"};
  if(event.shiftKey && (event.code==="Equal" || key==="+" || key==="=")) return {kind:"blendCycle",direction:1};
  if(event.shiftKey && (event.code==="Minus" || key==="_" || key==="-")) return {kind:"blendCycle",direction:-1};
  const step = event.shiftKey ? 10 : 1;
  const digit = /^Digit[0-9]$/.test(event.code) ? Number(event.code.slice(-1)) : /^[0-9]$/.test(key) ? Number(key) : null;
  if (digit !== null) return {kind:"paintPercent",property:event.shiftKey ? "flow" : "opacity",digit};
  if (!event.shiftKey && (key === "x" || key === "d")) return {kind:"color",action:key === "x" ? "swap" : "reset"};
  if (key === "arrowleft" || key === "arrowright" || key === "arrowup" || key === "arrowdown") return {
    kind: "nudge", dx: key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
    dy: key === "arrowup" ? -step : key === "arrowdown" ? step : 0
  };
  if (key === " " && !event.shiftKey) return { kind: "pan" };
  if (key === "escape" && !event.shiftKey) return { kind: "escape" };
  if (key === "enter" && !event.shiftKey) return { kind: "confirm" };
  if ((key === "delete" || key === "backspace") && !event.shiftKey) return { kind: "delete" };
  if (["[","]","ö","#","'"].includes(key)) return { kind: "brush", property: event.shiftKey ? "hardness" : "size", direction: key === "[" || key === "ö" ? -1 : 1 };
  const tool = Object.entries(TOOL_KEYS).find(([, letter]) => letter?.toLowerCase() === key)?.[0] as PhotoEditorTool | undefined;
  if (tool && (!event.shiftKey || tool === "marquee" || tool==="brush")) return { kind: "tool", tool, cycle: event.shiftKey || !useShiftForToolSwitch };
  return null;
}

/** 输入、IME 与浮层消费按键；仅从编辑器自身的事件范围调用。 */
export function editorInputConsumesKeys(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]');
}

/** 选区工具的普通方向键只动边界；平台修饰键改为像素或临时整层移动。 */
export function nudgeTarget(tool:PhotoEditorTool,hasSelection:boolean,pixels=false):"boundary"|"selectedPixels"|"layer"|null {
  if(tool==="marquee" || tool==="lasso") return hasSelection ? pixels?"selectedPixels":"boundary" : null;
  if(tool!=="move" && !pixels) return null;
  return tool==="move" && hasSelection?"selectedPixels":"layer";
}
