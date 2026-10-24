import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.file-info";
type Info={title:string;author:string;authorTitle:string;description:string;keywords:string;copyright:string;copyrightStatus:string;copyrightUrl:string};
type Camera=Record<string,string|number|null>;
const STATUS=[["unknown","未知"],["copyrighted","受版权保护"],["publicDomain","公共领域"]] as const;
function decode(value:unknown):Info {
 const raw=value!==null&&typeof value==="object"?value as Record<string,unknown>:{};
 const text=(key:keyof Info)=>typeof raw[key]==="string"?raw[key] as string:"";
 const keywords=Array.isArray(raw["keywords"])?raw["keywords"].filter((k):k is string=>typeof k==="string").join("; "):text("keywords");
 return {title:text("title"),author:text("author"),authorTitle:text("authorTitle"),description:text("description"),keywords,copyright:text("copyright"),copyrightStatus:STATUS.some(([id])=>id===raw["copyrightStatus"])?raw["copyrightStatus"] as string:"unknown",copyrightUrl:text("copyrightUrl")};
}
function camera(value:unknown):Camera {
 const raw=value!==null&&typeof value==="object"?value as Record<string,unknown>:{};
 const out:Camera={};for(const [key,item] of Object.entries(raw)){if(typeof item==="string"||typeof item==="number"||item===null)out[key]=item;}
 return out;
}
function FileInfoDialog({instance,requestClose,initial,initialCamera,apply}:EditorDialogRendererProps & {initial:Info;initialCamera:Camera;apply:(info:Info)=>string|null}) {
 const [value,setValue]=useState(initial),[error,setError]=useState<string|null>(null);
 const tooLong=Object.values(value).some(text=>text.length>10000);
 return <DialogContent size="md" instanceId={instance.instanceId} ariaLabel="文件信息"><form onSubmit={event=>{event.preventDefault();if(tooLong){setError("每个字段不能超过10000字符");return;}const failure=apply(value);if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>文件信息</DialogTitle></DialogHeader><DialogBody>
   {(["title","author","authorTitle","description","keywords","copyright","copyrightUrl"] as const).map(key=><label key={key}>{({title:"标题",author:"作者",authorTitle:"作者职位",description:"描述",keywords:"关键词（分号分隔）",copyright:"版权声明",copyrightUrl:"版权链接"})[key]}
    <input value={value[key]} maxLength={10000} onChange={event=>setValue(current=>({...current,[key]:event.currentTarget.value}))}/></label>)}
   <label>版权状态<select value={value.copyrightStatus} onChange={event=>setValue(current=>({...current,copyrightStatus:event.currentTarget.value}))}>{STATUS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   <section aria-label="相机数据"><h3>相机数据（只读）</h3>
    {Object.keys(initialCamera).length?<dl>{Object.entries(initialCamera).map(([key,item])=><div key={key}><dt>{key}</dt><dd>{item===null?"—":String(item)}</dd></div>)}</dl>:<p>当前文档没有相机元数据。</p>}
   </section>
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={tooLong}>确认</Button></DialogFooter>
 </form></DialogContent>;
}
export function useFileInfoDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,refresh,report});latest.current={blocked,refresh,report};
 const instance=useRef<string|null>(null),request=useRef<{owner:string;initial:Info;camera:Camera}|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey,controller.snapshot().view.document?.revision]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"md",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的文件信息请求"}},renderer:props=>{
   const captured=request.current;if(!captured)return null;
   return <FileInfoDialog {...props} initial={captured.initial} initialCamera={captured.camera} apply={info=>{
    const command=controller.snapshot().commands.get("file.fileInfo");
    if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档已更换，请关闭后重试";
    if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法编辑文件信息";
    const saved=controller.dispatch("file.fileInfo",{...info,keywords:info.keywords.split(";").map(word=>word.trim()).filter(Boolean)});if(!saved.ok)return saved.message;
    latest.current.refresh();return null;
   }}/>;
  }});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const command=controller.snapshot().commands.get("file.fileInfo");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  const read=controller.fileInfo();
  if(!read.ok){latest.current.report(read.message);return false;}
  const value=read.value as unknown;
  const raw=value!==null&&typeof value==="object"?value as Record<string,unknown>:null;
  request.current={owner:owner(),initial:decode(value),camera:camera(raw?.["camera"])};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
