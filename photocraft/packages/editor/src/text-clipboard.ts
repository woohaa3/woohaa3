import {useEffect,useRef,useState} from "react";
import type {TextEditing} from "./use-text-editing.js";

export type TextClipboardAction="edit.cut"|"edit.copy"|"edit.paste"|"select.all";
export type TextClipboardControls={enabled:(action:TextClipboardAction)=>boolean;run:(action:TextClipboardAction)=>void};

/** 系统纯文字剪贴板；异步返回只可应用到发起时的同一草稿和选择。 */
export function useTextClipboard(editing:TextEditing,owner:unknown,blocked:boolean,report:(message:string|null)=>void):TextClipboardControls|undefined {
  const [pending,setPending]=useState(false);
  const latest=useRef({owner,blocked,editing});latest.current={owner,blocked,editing};
  const mounted=useRef(true),inFlight=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const enabled=(action:TextClipboardAction)=>{
    if(!editing.active || editing.composing || blocked || pending)return false;
    if(action==="select.all")return true;
    if(action==="edit.paste")return typeof navigator.clipboard?.readText==="function";
    return editing.selection.start!==editing.selection.end && typeof navigator.clipboard?.writeText==="function";
  };
  const run=(action:TextClipboardAction)=>{
    if(inFlight.current || !enabled(action))return;
    if(action==="select.all"){editing.select({start:0,end:editing.style.text.length,direction:"forward"});return;}
    const snapshot=editing.clipboardSnapshot();if(!snapshot)return;
    inFlight.current=true;setPending(true);
    const valid=()=>mounted.current && latest.current.owner===owner && !latest.current.blocked && snapshot.valid();
    void (async()=>{
      try {
        if(action==="edit.paste"){const text=await navigator.clipboard.readText();if(valid()){report(null);if(text)snapshot.replace(text);}}
        else {await navigator.clipboard.writeText(snapshot.text);if(valid()){report(null);if(action==="edit.cut")snapshot.replace("");}}
      }catch {if(valid())report("无法访问系统文字剪贴板，请重试或使用系统快捷键");}
      finally {inFlight.current=false;if(mounted.current)setPending(false);}
    })();
  };
  return editing.active?{enabled,run}:undefined;
}
