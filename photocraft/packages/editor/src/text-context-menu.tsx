import {useEffect,useState,type ReactNode} from "react";
import type {TextEditing} from "./use-text-editing.js";
import type {TextClipboardControls} from "./text-clipboard.js";
import {CursorMenu,type MenuItem} from "./ui/Menu.js";

/** Type editing menu uses the same guarded clipboard and draft actions as the menu bar. */
export function TextContextMenu({children,editing,clipboard,disabled,onEnd,onLorem}:{children:ReactNode;editing:TextEditing;clipboard:TextClipboardControls|undefined;disabled:boolean;onEnd:(commit:boolean)=>void;onLorem?:()=>void}){
 const [position,setPosition]=useState<{x:number;y:number}|null>(null);
 useEffect(()=>setPosition(null),[editing.style,editing.selection,editing.composing,disabled]);
 const blocked=disabled || editing.composing || !editing.active;
 const items:MenuItem[]=([] as MenuItem[]).concat(([
  ["edit.cut","剪切"],["edit.copy","复制"],["edit.paste","粘贴"],["select.all","全选"]
 ] as const).map(([id,label])=>({id,label,disabled:blocked || !clipboard?.enabled(id),onSelect:()=>clipboard?.run(id)})),
 onLorem?[{id:"type.pasteLoremIpsum",label:"插入 Lorem Ipsum",separatorBefore:true,disabled:blocked,onSelect:onLorem}]:[],
 [{id:"text.confirm",label:"确认文字",separatorBefore:true,disabled:blocked,onSelect:()=>onEnd(true)},{id:"text.cancel",label:"取消文字编辑",disabled:disabled,onSelect:()=>onEnd(false)}]);
 return <div className="photo-editor-text-menu" onContextMenu={event=>{
  if((event.target as Element).closest("[data-cursor-menu]"))return;
  event.preventDefault();event.stopPropagation();if(blocked){setPosition(null);return;}setPosition({x:event.clientX,y:event.clientY});
 }}>{children}<CursorMenu open={position!==null && !blocked} onOpenChange={open=>{if(!open)setPosition(null);}} x={position?.x??0} y={position?.y??0} items={items} label="文字编辑"/></div>;
}
