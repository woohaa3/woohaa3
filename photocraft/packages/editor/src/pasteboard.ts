import type {CSSProperties} from "react";
export const CANVAS_COLORS=[{id:"default",label:"默认"},{id:"black",label:"黑色"},{id:"darkGray",label:"深灰"},{id:"mediumGray",label:"中灰"},{id:"lightGray",label:"浅灰"},{id:"custom",label:"自定义"}] as const;
export type Pasteboard={color:(typeof CANVAS_COLORS)[number]["id"];custom:string;border:"dropShadow"|"line"|"none";dots:boolean};
export const DEFAULT_PASTEBOARD:Pasteboard={color:"default",custom:"#282828",border:"dropShadow",dots:true};
export function normalizePasteboard(value:unknown):Pasteboard {
 const raw=value&&typeof value==="object"?value as Record<string,unknown>:{};
 return {color:CANVAS_COLORS.some(item=>item.id===raw.color)?raw.color as Pasteboard["color"]:"default",custom:typeof raw.custom==="string"&&/^#[\da-f]{6}$/i.test(raw.custom)?raw.custom.toLowerCase():DEFAULT_PASTEBOARD.custom,
 border:raw.border==="line"||raw.border==="none"?raw.border:"dropShadow",dots:typeof raw.dots==="boolean"?raw.dots:true};
}
export function cyclePasteboard(value:Pasteboard,backward:boolean):Pasteboard {
 const index=CANVAS_COLORS.findIndex(item=>item.id===value.color);
 return {...value,color:CANVAS_COLORS[(index+(backward?-1:1)+CANVAS_COLORS.length)%CANVAS_COLORS.length]!.id};
}
export function pasteboardStyle(value:Pasteboard):CSSProperties {
 const color=value.color==="default"?"var(--photo-editor-canvas-color, var(--app-web-subtle))":value.color==="custom"?value.custom:({black:"#000000",darkGray:"#282828",mediumGray:"#535353",lightGray:"#b8b8b8"} as const)[value.color];
 return {backgroundColor:color,backgroundImage:value.color==="default"&&value.dots?"radial-gradient(circle at 11px 11px, var(--photo-editor-canvas-dot, var(--app-web-border)) 1px, transparent 1.5px)":"none",backgroundSize:"22px 22px"};
}
export function canvasBorderStyle(value:Pasteboard):CSSProperties {
 return {boxShadow:value.border==="dropShadow"?"0 2px 8px var(--app-web-shadow)":"none",outline:value.border==="line"?"1px solid #141414":"none"};
}
