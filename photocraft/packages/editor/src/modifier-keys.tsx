import {createContext,useContext} from "react";
import type {EditorDisplayControls} from "./editor-display.js";
import {isEditorMac} from "./photo-editor-shortcuts.js";
import {Button} from "./ui/Button.js";
export type StickyModifiers={shift:boolean;command:boolean;alt:boolean};
export const NO_STICKY_MODIFIERS:StickyModifiers={shift:false,command:false,alt:false};
export const StickyModifierContext=createContext<StickyModifiers>(NO_STICKY_MODIFIERS);
export const useStickyModifiers=()=>useContext(StickyModifierContext);
type Modified={shiftKey:boolean;ctrlKey:boolean;metaKey:boolean;altKey:boolean;preventDefault:()=>void;stopPropagation:()=>void};
/** Add virtual keys; bind event methods to preserve React propagation and the real native event. */
export function withStickyModifiers<T extends Modified>(event:T,sticky:StickyModifiers,mac:boolean):T {
 if(!sticky.shift&&!sticky.command&&!sticky.alt)return event;
 return Object.assign(Object.create(event),{shiftKey:event.shiftKey||sticky.shift,altKey:event.altKey||sticky.alt,ctrlKey:event.ctrlKey||sticky.command&&!mac,metaKey:event.metaKey||sticky.command&&mac,preventDefault:()=>event.preventDefault(),stopPropagation:()=>event.stopPropagation()}) as T;
}
export function ModifierKeysPanel({display,disabled}:{display:EditorDisplayControls;disabled:boolean}) {
 if(!display.state.modifiersVisible)return null;
 const value=display.state.stickyModifiers??NO_STICKY_MODIFIERS;
 return <div className="photo-editor__modifier-keys" data-canvas-viewport-control="true" onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>
  <div><span>修饰键</span><Button size="sm" tone="ghost" title="关闭修饰键面板" onClick={()=>display.toggle("modifiers")}>关闭</Button></div>
  {([["shift","Shift"],["command",isEditorMac()?"Cmd":"Ctrl"],["alt",isEditorMac()?"Option":"Alt"]] as const).map(([key,label])=><Button key={key} size="sm" tone={value[key]?"primary":"ghost"} data-sticky-key={key} data-sticky-on={value[key]||undefined} disabled={disabled||!display.toggleStickyModifier} onClick={()=>display.toggleStickyModifier?.(key)}>{label}</Button>)}
 </div>;
}
