import {readInterfaceAnimations,subscribeInterfaceAnimations} from "./interface-animations.js";
import {useEffect,useMemo,useState,type CSSProperties,type ReactNode} from "react";
import {EDITOR_THEMES,type EditorThemeId} from "./editor-theme-palettes.js";
import {UiProvider} from "./ui/UiProvider.js";
import type {EditorDialogPort} from "./ports.js";
export {EDITOR_THEMES};
export type EditorThemePreference={theme:EditorThemeId|"system";darkTheme:EditorThemeId;lightTheme:EditorThemeId};
const KEY="photocraft.interface-theme.v1",CHANGE="photocraft-theme-change";
const defaults:EditorThemePreference={theme:"system",darkTheme:"proMedium",lightTheme:"proLight"};
const find=(id:unknown)=>EDITOR_THEMES.find(item=>item.id===id);
export function decodeThemePreference(raw:unknown):EditorThemePreference {
 const value=raw&&typeof raw==="object"?raw as Record<string,unknown>:{};
 return {theme:value.theme==="system"||find(value.theme)?value.theme as EditorThemePreference["theme"]:defaults.theme,
 darkTheme:find(value.darkTheme)?.dark?value.darkTheme as EditorThemeId:defaults.darkTheme,
 lightTheme:find(value.lightTheme)?.dark===false?value.lightTheme as EditorThemeId:defaults.lightTheme};
}
function readPreference():EditorThemePreference {try{return decodeThemePreference(JSON.parse(localStorage.getItem(KEY)??"null"));}catch{return {...defaults};}}
export function stepThemeBrightness(id:EditorThemeId,lighter:boolean):EditorThemeId {
 const levels=["pro","proMedium","proLightGray","proLight"] as const;
 const index=levels.findIndex(value=>value===id),at=index<0?(find(id)?.dark?1:2):index;
 return levels[Math.max(0,Math.min(3,at+(lighter?1:-1)))];
}
export function themeStyle(id:EditorThemeId):CSSProperties {
 const t=find(id)!.tokens;
 const dots:Record<EditorThemeId,string>={pro:"transparent",proMedium:"transparent",proLightGray:"transparent",proLight:"transparent",classic:"transparent",studio:"#2e2e32",studioLight:"#c8c8ce",adwaita:"#dededf",adwaitaDark:"#1d1d20",breezeLight:"#dbdee2",breezeDark:"#111418",softDark:"#282830",softLight:"#dad8e0",solarizedDark:"#0a3d4a"};
 return {
  "--app-web-panel":t.card,"--app-web-elevated":t.card,"--app-web-subtle":t.dock,
  "--app-web-border":t.card_border,"--app-web-border-strong":t.field_border,
  "--app-web-text-primary":t.text,"--app-web-text-muted":t.text_dim,
  "--app-web-overlay":t.scrim,"--app-web-shadow":t.shadow,
  "--app-interaction-accent":t.accent,"--app-interaction-accent-hover":t.accent,
  "--app-interaction-accent-pressed":t.accent,"--app-interaction-accent-soft":t.accent_soft,
  "--app-interaction-on-accent":t.primary_text,"--app-interaction-disabled":t.text_faint,
  "--app-interaction-focus":t.accent_border,"--app-status-danger":t.danger,
  "--app-status-danger-background":t.card,"--app-status-danger-soft":t.accent_soft,
  "--photo-editor-canvas-dot":dots[id],"--photo-editor-canvas-color":t.canvas,"--photo-editor-chrome":t.chrome,"--photo-editor-field":t.field,
  "--photo-editor-hover":t.hover,"--photo-editor-pressed":t.pressed,
  colorScheme:find(id)!.dark?"dark":"light",color:t.text,background:t.chrome
 } as CSSProperties;
}
export function useEditorTheme() {
 const [preference,setPreference]=useState(readPreference);
 const [systemDark,setSystemDark]=useState(()=>typeof matchMedia==="function"?matchMedia("(prefers-color-scheme: dark)").matches:true);
 const [error,setError]=useState<string|null>(null);
 useEffect(()=>{
  const media=typeof matchMedia==="function"?matchMedia("(prefers-color-scheme: dark)"):null;
  const changed=()=>setSystemDark(media?.matches??true);
  const sync=(event:Event)=>{if(event instanceof StorageEvent){if(event.key!==KEY&&event.key!==null)return;setPreference(readPreference());}else setPreference(decodeThemePreference((event as CustomEvent).detail));};
  media?.addEventListener?.("change",changed);changed();window.addEventListener("storage",sync);window.addEventListener(CHANGE,sync);
  return()=>{media?.removeEventListener?.("change",changed);window.removeEventListener("storage",sync);window.removeEventListener(CHANGE,sync);};
 },[]);
 const resolved=preference.theme==="system"?(systemDark?preference.darkTheme:preference.lightTheme):preference.theme;
 const select=(id:EditorThemePreference["theme"])=>{
  if(id!=="system"&&!find(id))return;
  const next={...preference,theme:id};if(id!=="system"){if(find(id)!.dark)next.darkTheme=id;else next.lightTheme=id;}
  setPreference(next);setError(null);try{localStorage.setItem(KEY,JSON.stringify(next));}catch{setError("主题已应用，但无法保存到本机");}
  window.dispatchEvent(new CustomEvent(CHANGE,{detail:next}));
 };
 return {preference,resolved,select,error,step:(lighter:boolean)=>select(stepThemeBrightness(resolved,lighter))};
}
export function EditorThemeRoot({children,dialog=false}:{children:ReactNode;dialog?:boolean}) {
 const [animations,setAnimations]=useState(readInterfaceAnimations);
 useEffect(()=>subscribeInterfaceAnimations(setAnimations),[]);
 const theme=useEditorTheme();const style=useMemo(()=>themeStyle(theme.resolved),[theme.resolved]);
 return <div className={dialog?"photo-editor-theme-scope photo-editor-theme-scope--dialog":"photo-editor-theme-scope"} data-editor-theme={theme.resolved} data-editor-animations={animations?"on":"off"} style={style}><UiProvider>{children}</UiProvider></div>;
}
/** Only decorates this editor's registered renderers. Stack and dismiss policy stay with the host. */
export function themedEditorDialogs(port:EditorDialogPort):EditorDialogPort {
 return {subscribe:listener=>port.subscribe(listener),isModalActive:()=>port.isModalActive(),top:()=>port.top(),open:request=>port.open(request),close:id=>port.close(id),
 registerDialog:(id,registration)=>port.registerDialog(id,{...registration,renderer:props=><EditorThemeRoot dialog>{registration.renderer(props)}</EditorThemeRoot>})};
}
