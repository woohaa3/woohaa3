import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
import {CursorMenu} from "./ui/Menu.js";
import {PHOTO_TOOLS} from "./photo-editor-chrome.js";
import type {PhotoEditorTool} from "./photo-editor-shortcuts.js";
const ID="image-editor.reset-all-tools";
export function useToolReset(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,reset:(all:boolean)=>void,error:(message:string)=>void) {
 const current=useRef({blocked,reset,error});current.current={blocked,reset,error};const opening=useRef(false),instance=useRef<string|null>(null),owner=useRef<string|null>(null);
 const ownerKey=()=>JSON.stringify(controller.dialogOwner());
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!current.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的工具重置请求"}},renderer:props=><DialogContent size="sm" ariaLabel="重置全部工具" instanceId={props.instance.instanceId}>
   <DialogHeader onClose={props.requestClose}><DialogTitle>重置全部工具？</DialogTitle></DialogHeader><DialogBody><p>将所有工具选项和画笔恢复默认；保留前景色、背景色及文档内容。</p></DialogBody>
   <DialogFooter><Button onClick={props.requestClose}>取消</Button><Button tone="primary" onClick={()=>{
    if(current.current.blocked||dialogs.top()?.instanceId!==instance.current||instance.current!==props.instance.instanceId||owner.current!==ownerKey())return;
    dialogs.close(props.instance.instanceId);instance.current=null;current.current.reset(true);
   }}>重置全部</Button></DialogFooter></DialogContent>});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked&&instance.current){dialogs?.close(instance.current);instance.current=null;}},[blocked,dialogs]);
 return {resetCurrent:()=>{if(!current.current.blocked&&!dialogs?.isModalActive())current.current.reset(false);},available:!!dialogs,confirmAll:()=>{
  if(!dialogs||current.current.blocked||dialogs.isModalActive())return;
  opening.current=true;owner.current=ownerKey();try{const result=dialogs.open({dialogId:ID});if(result.ok)instance.current=result.instance.instanceId;else current.current.error(result.error);}finally{opening.current=false;}
 }};
}
export function ToolResetMenu({tool,label,disabled,onReset,onAll}:{tool:PhotoEditorTool;label:string;disabled:boolean;onReset:()=>void;onAll?:()=>void}) {
 const [position,setPosition]=useState<{x:number;y:number}|null>(null);const Icon=PHOTO_TOOLS.find(item=>item.id===tool)?.Icon;
 useEffect(()=>{if(disabled)setPosition(null);},[disabled]);
 return <><Button className="photo-editor__tool-label" size="sm" tone="ghost" disabled={disabled} title="右键重置工具选项" onContextMenu={event=>{event.preventDefault();event.stopPropagation();if(!disabled)setPosition({x:event.clientX,y:event.clientY});}}>{Icon?<Icon size={16}/>:null}{label}</Button>
 <CursorMenu open={!!position} x={position?.x??0} y={position?.y??0} onOpenChange={open=>{if(!open)setPosition(null);}} label="重置工具选项" items={[{id:"tool.reset",label:"重置当前工具",disabled,onSelect:()=>{setPosition(null);if(!disabled)onReset();}},{id:"tool.resetAll",label:"重置全部工具…",disabled:disabled||!onAll,onSelect:()=>{setPosition(null);if(!disabled)onAll?.();}}]}/></>;
}
