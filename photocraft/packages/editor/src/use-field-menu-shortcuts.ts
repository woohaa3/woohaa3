import {useEffect,useRef,useState,type KeyboardEvent as ReactKeyboardEvent} from "react";
import {resolveEditorShortcut,type EditorShortcut} from "./photo-editor-shortcuts.js";
/** 表单保留文本编辑组合；平台菜单组合在字段事务确认后执行。 */
export function fieldMenuShortcut(event:KeyboardEvent,isMac:boolean):EditorShortcut|null {
 const target=event.target;
 if(!(target instanceof Element) || !target.closest("input") || target.closest('[role="dialog"],[role="menu"],[contenteditable]')) return null;
 if(!(isMac?event.metaKey:event.ctrlKey) || (!event.altKey && ["a","c","v","x","z","y"].includes(event.key.toLowerCase()))) return null;
 const action=resolveEditorShortcut(event,isMac);
 return action && (action.kind==="command" || action.kind==="clipping" || action.kind==="save" || action.kind==="documentsClose" || action.kind==="view" || (action.kind==="tool" && action.tool==="transform"))?action:null;
}
export function useFieldMenuShortcuts({owner,targetKey,blocked,isMac,before,apply}: {
 owner:object;targetKey:string;blocked:boolean;isMac:boolean;before:()=>boolean;apply:(action:EditorShortcut)=>void;
}) {
 const [pending,setPending]=useState<{owner:object;targetKey:string;action:EditorShortcut}|null>(null);
 const current=useRef({owner,targetKey,blocked,before,apply,isMac});current.current={owner,targetKey,blocked,before,apply,isMac};
 useEffect(()=>{
   if(!pending) return;setPending(null);
   const now=current.current;
   if(pending.owner===now.owner && pending.targetKey===now.targetKey && !now.blocked) now.apply(pending.action);
 },[pending]);
 return (event:ReactKeyboardEvent)=>{
   const now=current.current,action=fieldMenuShortcut(event.nativeEvent,now.isMac);
   if(!action) return false;
   event.preventDefault();event.stopPropagation();
   if(now.blocked || !now.before()) return true;
   setPending({owner:now.owner,targetKey:now.targetKey,action});return true;
 };
}
