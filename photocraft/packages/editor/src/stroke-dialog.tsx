import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.edge-stroke",KEY="photocraft.edge-stroke.v1";
export type StrokeSettings={width:number;color:string;location:string;mode:string;opacity:number;preserveTransparency:boolean};
export function readStroke(color:string):StrokeSettings {
 const defaults:StrokeSettings={width:1,color,location:"center",mode:"Normal",opacity:100,preserveTransparency:false};
 try{const value=JSON.parse(localStorage.getItem(KEY)??"null");if(!value || typeof value!=="object")return defaults;
  return {width:typeof value.width==="number" && Number.isFinite(value.width) && value.width>=1 && value.width<=250?value.width:1,color:typeof value.color==="string" && /^#[0-9a-f]{6}$/i.test(value.color)?value.color:color,location:["inside","center","outside"].includes(value.location)?value.location:"center",mode:PHOTOSHOP_BLENDS.includes(value.mode)?value.mode:"Normal",opacity:typeof value.opacity==="number" && Number.isFinite(value.opacity) && value.opacity>=0 && value.opacity<=100?value.opacity:100,preserveTransparency:typeof value.preserveTransparency==="boolean"?value.preserveTransparency:false};
 }catch{return defaults;}
}
function StrokeDialog({instance,requestClose,initial,apply}:EditorDialogRendererProps & {initial:StrokeSettings;apply:(settings:StrokeSettings)=>string|null}) {
 const [value,setValue]=useState(initial),[width,setWidth]=useState(String(initial.width)),[opacity,setOpacity]=useState(String(initial.opacity)),[error,setError]=useState<string|null>(null);
 const valid=width.trim()!=="" && Number.isFinite(Number(width)) && Number(width)>=1 && Number(width)<=250 && opacity.trim()!=="" && Number.isFinite(Number(opacity)) && Number(opacity)>=0 && Number(opacity)<=100;
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="描边"><form onSubmit={event=>{event.preventDefault();if(!valid)return;const failure=apply({...value,width:Number(width),opacity:Number(opacity)});if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>描边</DialogTitle></DialogHeader><DialogBody>
   <label>宽度（1–250 px）<input type="text" inputMode="decimal" value={width} onChange={event=>setWidth(event.currentTarget.value)}/></label>
   <label>颜色<input type="color" value={value.color} onChange={event=>{const color=event.currentTarget.value;setValue(v=>({...v,color}));}}/></label>
   <label>位置<select value={value.location} onChange={event=>{const location=event.currentTarget.value;setValue(v=>({...v,location}));}}><option value="inside">内部</option><option value="center">居中</option><option value="outside">外部</option></select></label>
   <label>混合模式<select value={value.mode} onChange={event=>{const mode=event.currentTarget.value;setValue(v=>({...v,mode}));}}>{PHOTOSHOP_BLENDS.map(mode=><option key={mode} value={mode}>{mode}</option>)}</select></label>
   <label>不透明度（%）<input type="text" inputMode="decimal" value={opacity} onChange={event=>setOpacity(event.currentTarget.value)}/></label>
   <label><input type="checkbox" checked={value.preserveTransparency} onChange={event=>{const preserveTransparency=event.currentTarget.checked;setValue(v=>({...v,preserveTransparency}));}}/>保留透明度</label>
   <p>有选区时描边选区边缘，否则描边当前像素层的不透明边缘。</p>
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>确认</Button></DialogFooter>
 </form></DialogContent>;
}
export function useStrokeDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,color:string,refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,color,refresh,report});latest.current={blocked,color,refresh,report};
 const instance=useRef<string|null>(null),opening=useRef(false),request=useRef<{owner:string;initial:StrokeSettings}|null>(null);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的描边请求"}},renderer:props=>{
   const captured=request.current;if(!captured)return null;
   return <StrokeDialog {...props} {...captured} apply={settings=>{
    if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档或描边目标已更换，请关闭后重试";
    const command=controller.snapshot().commands.get("edit.stroke");if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法描边";
    const result=controller.dispatch("edit.stroke",settings);if(!result.ok)return result.message;
    latest.current.refresh();try{localStorage.setItem(KEY,JSON.stringify(settings));latest.current.report(null);}catch{latest.current.report("描边已完成；浏览器未能保存描边偏好");}return null;
   }}/>;
  }});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const command=controller.snapshot().commands.get("edit.stroke");if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  request.current={owner:owner(),initial:readStroke(latest.current.color)};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
