import {useEffect,useState} from "react";
import {normalizePasteboard,pasteboardStyle,type Pasteboard} from "./pasteboard.js";
import {useEditorTheme,themeStyle} from "./editor-theme.js";
export const PASTEBOARD_CHANGE="photocraft-pasteboard-change";
export function publishPasteboard(value:Pasteboard){window.dispatchEvent(new CustomEvent(PASTEBOARD_CHANGE,{detail:value}));}
function read(){try{return normalizePasteboard(JSON.parse(localStorage.getItem("photocraft.editor-preferences.v1")??"null")?.pasteboard);}catch{return normalizePasteboard(null);}}
/** Empty workspaces have no controller, but share the editor's local display preference. */
export function usePasteboardAppearance(){
 const [value,setValue]=useState(read),theme=useEditorTheme();
 useEffect(()=>{
  const changed=(event:Event)=>setValue(normalizePasteboard((event as CustomEvent).detail));
  const stored=(event:StorageEvent)=>{if(event.key===null||event.key==="photocraft.editor-preferences.v1")setValue(read());};
  window.addEventListener(PASTEBOARD_CHANGE,changed);window.addEventListener("storage",stored);
  return()=>{window.removeEventListener(PASTEBOARD_CHANGE,changed);window.removeEventListener("storage",stored);};
 },[]);
 return {...themeStyle(theme.resolved),...pasteboardStyle(value)};
}
