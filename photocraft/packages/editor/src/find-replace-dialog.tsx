import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorResult} from "./editor-wasm.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.find-replace";
type Search={find:string;replace:string;caseSensitive:boolean;wholeWord:boolean;forward:boolean;allLayers:boolean};
type Action="find"|"change"|"changeFind"|"changeAll";
function FindReplaceDialog({instance,requestClose,apply}:EditorDialogRendererProps & {apply:(params:Search & {action:Action})=>EditorResult<Record<string,unknown>>}) {
 const [search,setSearch]=useState<Search>({find:"",replace:"",caseSensitive:false,wholeWord:false,forward:true,allLayers:true});
 const [message,setMessage]=useState<string|null>(null),[failure,setFailure]=useState(false),[hasMatch,setHasMatch]=useState(false);
 const change=(patch:Partial<Search>)=>{setSearch(value=>({...value,...patch}));setHasMatch(false);setMessage(null);};
 const run=(action:Action)=>{
  const result=apply({...search,action});setFailure(!result.ok);
  if(!result.ok){setMessage(result.message);return;}
  const value=result.value;setHasMatch(!!value.found);
  if(action==="changeAll")setMessage(`已在${Number(value.layers)||0}个图层中替换${Number(value.count)||0}处文字`);
  else if(value.found && typeof value.found==="object") {const hit=value.found as Record<string,unknown>;setMessage(`${value.changed?"已替换；":""}找到“${String(hit.text??"")}”（图层${String(hit.layer)}）`);}
  else setMessage(value.changed?"已替换当前匹配":"没有找到匹配文字");
 };
 const valid=search.find.length>0 && search.find.length<=10000 && search.replace.length<=10000;
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="查找和替换文字"><form onSubmit={event=>{event.preventDefault();if(valid)run("find");}}>
  <DialogHeader onClose={requestClose}><DialogTitle>查找和替换文字</DialogTitle></DialogHeader><DialogBody>
   <label>查找<input autoFocus maxLength={10000} value={search.find} onChange={event=>change({find:event.currentTarget.value})}/></label>
   <label>替换为<input maxLength={10000} value={search.replace} onChange={event=>change({replace:event.currentTarget.value})}/></label>
   <label><input type="checkbox" checked={search.allLayers} onChange={event=>change({allLayers:event.currentTarget.checked})}/>搜索所有文字图层</label>
   <label><input type="checkbox" checked={search.caseSensitive} onChange={event=>change({caseSensitive:event.currentTarget.checked})}/>区分大小写</label>
   <label><input type="checkbox" checked={search.wholeWord} onChange={event=>change({wholeWord:event.currentTarget.checked})}/>全字匹配</label>
   <label><input type="checkbox" checked={!search.forward} onChange={event=>change({forward:!event.currentTarget.checked})}/>向后搜索</label>
   {message?<p className={failure?"dlg__error":undefined}>{message}</p>:null}
  </DialogBody><DialogFooter className="photo-editor-find-replace__actions">
   <Button type="button" onClick={requestClose}>完成</Button><Button type="submit" disabled={!valid}>查找下一个</Button>
   <Button type="button" disabled={!valid || !hasMatch} onClick={()=>run("change")}>替换</Button>
   <Button type="button" disabled={!valid || !hasMatch} onClick={()=>run("changeFind")}>替换并查找</Button>
   <Button type="button" tone="primary" disabled={!valid} onClick={()=>run("changeAll")}>全部替换</Button>
  </DialogFooter>
 </form></DialogContent>;
}
export function useFindReplaceDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,refresh,report});latest.current={blocked,refresh,report};
 const instance=useRef<string|null>(null),request=useRef<string|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的查找替换请求"}},renderer:props=><FindReplaceDialog {...props} apply={params=>{
   if(latest.current.blocked || !request.current || request.current!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return {ok:false,code:"stale",message:"文档已更换，请关闭后重试"};
   const command=controller.snapshot().commands.get("edit.findAndReplaceText");
   if(!command?.allowed || !command.enabled)return {ok:false,code:"capability-disabled",message:command?.disabledReason??"当前无法查找文字"};
   const result=controller.findReplaceText(params);if(result.ok)latest.current.refresh();return result;
  }}/>});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const command=controller.snapshot().commands.get("edit.findAndReplaceText");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  request.current=owner();opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
