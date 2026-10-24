import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.fade";
function FadeDialog({instance,requestClose,label,apply}:EditorDialogRendererProps & {label:string;apply:(opacity:number,mode:string)=>string|null}) {
 const [opacity,setOpacity]=useState("100"),[mode,setMode]=useState("Normal"),[error,setError]=useState<string|null>(null);
 const value=Number(opacity);
 const valid=opacity.trim()!=="" && Number.isFinite(value) && value>=0 && value<=100;
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="淡化"><form onSubmit={event=>{event.preventDefault();if(!valid){setError("不透明度须为 0–100");return;}const failure=apply(value,mode);if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>淡化 {label}</DialogTitle></DialogHeader><DialogBody>
   <p>把最近一步像素操作与上一步状态混合，并作为新的单独一步记录。</p>
   <label>不透明度（%）<input type="text" inputMode="decimal" value={opacity} onChange={event=>setOpacity(event.currentTarget.value)}/></label>
   <label>模式<select value={mode} onChange={event=>setMode(event.currentTarget.value)}>{PHOTOSHOP_BLENDS.map(blend=><option key={blend} value={blend}>{blend}</option>)}</select></label>
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>淡化</Button></DialogFooter>
 </form></DialogContent>;
}
export function useFadeDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,refresh,report});latest.current={blocked,refresh,report};
 const instance=useRef<string|null>(null),request=useRef<{owner:string;label:string}|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey,controller.snapshot().view.document?.revision]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的淡化请求"}},renderer:props=>{
   const captured=request.current;if(!captured)return null;
   return <FadeDialog {...props} label={captured.label} apply={(opacity,mode)=>{
    const command=controller.snapshot().commands.get("edit.fade");
    if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档已更换，请关闭后重试";
    if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前没有可淡化的操作";
    const result=controller.dispatch("edit.fade",{opacity,mode});if(!result.ok)return result.message;
    latest.current.refresh();return null;
   }}/>;
  }});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:(label:string)=>{
  const command=controller.snapshot().commands.get("edit.fade");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  request.current={owner:owner(),label};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
