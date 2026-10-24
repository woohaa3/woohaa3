import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.define-pattern";
function DefinePatternDialog({instance,requestClose,initialName,apply}:EditorDialogRendererProps & {initialName:string;apply:(name:string)=>string|null}) {
 const [name,setName]=useState(initialName),[error,setError]=useState<string|null>(null);
 return <DialogContent size="sm" ariaLabel="定义图案" instanceId={instance.instanceId}><form onSubmit={event=>{event.preventDefault();const clean=name.trim();if(!clean || clean.length>200 || /[\u0000-\u001f\u007f]/.test(clean)){setError("请输入1–200字符的有效图案名称");return;}const failure=apply(clean);if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>定义图案</DialogTitle></DialogHeader><DialogBody>
   <label>图案名称<input autoFocus maxLength={200} value={name} onChange={event=>setName(event.currentTarget.value)}/></label>
   <p>使用选区范围内的可见图像；没有选区时使用整张画布。图案单边不超过1024像素，会加入本机图案库。</p>
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button onClick={requestClose}>取消</Button><Button type="submit" tone="primary">创建图案</Button></DialogFooter>
 </form></DialogContent>;
}
export function useDefinePatternDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,create:(name:string)=>string|null,report:(message:string|null)=>void){
 const latest=useRef({blocked,create,report});latest.current={blocked,create,report};
 const request=useRef<{owner:string;name:string}|null>(null),instance=useRef<string|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && request.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的图案请求"}},renderer:props=><DefinePatternDialog {...props} initialName={request.current?.name??"图案"} apply={name=>{
   const command=controller.snapshot().commands.get("edit.definePattern");
   if(latest.current.blocked || !request.current || request.current.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==instance.current)return "文档或选区已更换，请关闭后重试";
   if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法定义图案";
   return latest.current.create(name);
  }}/>});
  return()=>{if(instance.current)dialogs.close(instance.current);request.current=null;instance.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const snapshot=controller.snapshot(),command=snapshot.commands.get("edit.definePattern");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !snapshot.view.document || !command?.allowed || !command.enabled || dialogs.isModalActive()){latest.current.report("请先结束当前操作并等候图案库载入");return false;}
  request.current={owner:owner(),name:snapshot.view.document.name?.replace(/\.[^.]+$/,"")||"图案"};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;latest.current.report(null);return true;}finally{opening.current=false;}
 }};
}
