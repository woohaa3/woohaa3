import {useCallback,useEffect,useRef} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
const ID="file.scripts.browse";
export const MAX_SCRIPT_BYTES=256*1024;
type ScriptController=Pick<EditorWorkspaceController,"snapshot"|"subscribe"|"dialogOwner"|"dispatch">;
/** The input owns file bytes only; native parsing and all writes stay behind dispatch. */
export function useScriptImport(controller:ScriptController,blocked:boolean,hasGesture:()=>boolean,refresh:()=>void,report:(message:string|null)=>void){
 const input=useRef<HTMLInputElement>(null),generation=useRef(0),pending=useRef<{generation:number;owner:string}|null>(null);
 const latest=useRef({blocked,hasGesture,refresh,report});latest.current={blocked,hasGesture,refresh,report};
 const owner=useCallback(()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view]),[controller]);
 useEffect(()=>{
  generation.current++;pending.current=null;
  const unsubscribe=controller.subscribe(()=>{generation.current++;});
  return()=>{generation.current++;pending.current=null;unsubscribe();};
 },[controller]);
 useEffect(()=>{if(blocked){generation.current++;pending.current=null;}},[blocked]);
 useEffect(()=>{const element=input.current;if(!element)return;const cancel=()=>{generation.current++;pending.current=null;};element.addEventListener("cancel",cancel);return()=>element.removeEventListener("cancel",cancel);},[]);
 const available=()=>{const snapshot=controller.snapshot(),command=snapshot.commands.get(ID);return !latest.current.blocked && !latest.current.hasGesture() && snapshot.view.document && command?.allowed && command.enabled && !["saving","freezing","opening"].includes(snapshot.state.phase);};
 const open=()=>{
  if(!available() || !input.current){latest.current.report("请先结束当前操作，再运行脚本。");return false;}
  generation.current++;pending.current={generation:generation.current,owner:owner()};input.current.value="";
  try{input.current.click();latest.current.report(null);return true;}catch{pending.current=null;latest.current.report("无法打开脚本文件选择器。");return false;}
 };
 const read=async(file:File,request:{generation:number;owner:string})=>{
  const current=()=>request.generation===generation.current && request.owner===owner() && !!available();
  try{
   if(!/\.(json|txt|pcdroplet)$/i.test(file.name))throw new Error("请选择PhotoCraft JSON、命令文本或pcdroplet脚本；不支持Photoshop JavaScript。");
   if(file.size>MAX_SCRIPT_BYTES)throw new Error("脚本不能超过256 KiB。");
   if(!current())return;
   const bytes=await file.arrayBuffer();
   if(!current())return;
   if(bytes.byteLength>MAX_SCRIPT_BYTES)throw new Error("脚本不能超过256 KiB。");
   let source:string;try{source=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("脚本必须是有效的UTF-8文本。");}
   const result=controller.dispatch(ID,{name:file.name,source});
   latest.current.report(result.ok?"脚本已执行。":result.message);
   if(result.ok)latest.current.refresh();
  }catch(error){if(current())latest.current.report(error instanceof Error?error.message:"脚本读取失败。");}
 };
 return {open,input:<input ref={input} type="file" hidden accept=".json,.txt,.pcdroplet" data-script-import="" onChange={event=>{
  const request=pending.current,file=event.currentTarget.files?.[0];pending.current=null;event.currentTarget.value="";
  if(file && request)void read(file,request);
 }}/>};
}
