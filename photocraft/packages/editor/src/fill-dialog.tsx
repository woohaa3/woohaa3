import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {StylePatternPreset} from "./editor-wasm.js";
import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.fill",KEY="photocraft.fill.v1";
export const FILL_CONTENTS=[['foreground','前景色'],['background','背景色'],['color','自定义颜色'],['contentAware','内容感知'],['pattern','图案'],['history','历史记录'],['black','黑色'],['gray','50%灰'],['white','白色']] as const;
export type FillSettings={contents:string;color:string;pattern:string;colorAdaptation:boolean;mode:string;opacity:number;preserveTransparency:boolean};
export function defaultFill(color:string,patterns:readonly StylePatternPreset[]):FillSettings {return {contents:"foreground",color,pattern:patterns[0]?.id??"",colorAdaptation:true,mode:"Normal",opacity:100,preserveTransparency:false};}
export function readFill(color:string,patterns:readonly StylePatternPreset[]):FillSettings {
 const defaults=defaultFill(color,patterns);try{const value=JSON.parse(localStorage.getItem(KEY)??"null");if(!value || typeof value!=="object")return defaults;
  return {contents:FILL_CONTENTS.some(([id])=>id===value.contents)?value.contents:defaults.contents,color:typeof value.color==="string" && /^#[0-9a-f]{6}$/i.test(value.color)?value.color:defaults.color,pattern:patterns.some(p=>p.id===value.pattern)?value.pattern:defaults.pattern,colorAdaptation:typeof value.colorAdaptation==="boolean"?value.colorAdaptation:true,mode:PHOTOSHOP_BLENDS.includes(value.mode)?value.mode:"Normal",opacity:typeof value.opacity==="number" && Number.isFinite(value.opacity) && value.opacity>=0 && value.opacity<=100?value.opacity:100,preserveTransparency:typeof value.preserveTransparency==="boolean"?value.preserveTransparency:false};
 }catch{return defaults;}
}
function FillDialog({instance,requestClose,initial,defaults,patterns,apply}:EditorDialogRendererProps & {initial:FillSettings;defaults:FillSettings;patterns:readonly StylePatternPreset[];apply:(settings:FillSettings)=>string|null}) {
 const [value,setValue]=useState(initial),[opacity,setOpacity]=useState(String(initial.opacity)),[error,setError]=useState<string|null>(null);
 const valid=opacity.trim()!=="" && Number.isFinite(Number(opacity)) && Number(opacity)>=0 && Number(opacity)<=100 && (value.contents!=="pattern" || patterns.some(p=>p.id===value.pattern));
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="填充"><form onSubmit={event=>{event.preventDefault();if(!valid)return;const failure=apply({...value,opacity:Number(opacity)});if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>填充</DialogTitle></DialogHeader><DialogBody>
   <label>内容<select value={value.contents} onChange={event=>{const contents=event.currentTarget.value;setValue(v=>({...v,contents}));setError(null);}}>{FILL_CONTENTS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   {value.contents==="color"?<label>颜色<input type="color" value={value.color} onChange={event=>{const color=event.currentTarget.value;setValue(v=>({...v,color}));}}/></label>:null}
   {value.contents==="pattern"?<label>图案<select value={value.pattern} onChange={event=>{const pattern=event.currentTarget.value;setValue(v=>({...v,pattern}));}}>{patterns.length?patterns.map(pattern=><option key={pattern.id} value={pattern.id}>{pattern.name}</option>):<option value="">请先导入或定义图案</option>}</select></label>:null}
   {value.contents==="contentAware"?<><label><input type="checkbox" checked={value.colorAdaptation} onChange={event=>{const colorAdaptation=event.currentTarget.checked;setValue(v=>({...v,colorAdaptation}));}}/>颜色适应</label><p>需要像素层选区，当前限262144画布像素。</p></>:null}
   {value.contents==="history"?<p>使用当前目标在最早保留历史状态中的内容；该状态须存在同一目标。</p>:null}
   <label>混合模式<select value={value.mode} onChange={event=>{const mode=event.currentTarget.value;setValue(v=>({...v,mode}));}}>{PHOTOSHOP_BLENDS.map(mode=><option key={mode} value={mode}>{mode}</option>)}</select></label>
   <label>不透明度（%）<input type="text" inputMode="decimal" value={opacity} onChange={event=>setOpacity(event.currentTarget.value)}/></label>
   <label><input type="checkbox" checked={value.preserveTransparency} onChange={event=>{const preserveTransparency=event.currentTarget.checked;setValue(v=>({...v,preserveTransparency}));}}/>保留透明度</label>
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" title="Alt+单击恢复默认值" onClick={event=>{if(event.altKey){setValue(defaults);setOpacity(String(defaults.opacity));setError(null);}else requestClose();}}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>确认</Button></DialogFooter>
 </form></DialogContent>;
}
export function useFillDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,colors:{foreground:string;background:string},refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,colors,refresh,report});latest.current={blocked,colors,refresh,report};
 const instance=useRef<string|null>(null),opening=useRef(false),request=useRef<{owner:string;initial:FillSettings;defaults:FillSettings;patterns:StylePatternPreset[]}|null>(null);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的填充请求"}},renderer:props=>{
   const captured=request.current;if(!captured)return null;
   return <FillDialog {...props} {...captured} apply={settings=>{
    if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档或填充目标已更换，请关闭后重试";
    const command=controller.snapshot().commands.get("edit.fill");if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法填充";
    const params:Record<string,unknown>={contents:settings.contents,mode:settings.mode,opacity:settings.opacity,preserveTransparency:settings.preserveTransparency};
    if(["foreground","background","color"].includes(settings.contents))params.color=settings.contents==="color"?settings.color:latest.current.colors[settings.contents as "foreground"|"background"];
    if(settings.contents==="pattern")params.pattern=settings.pattern;
    if(settings.contents==="contentAware")params.colorAdaptation=settings.colorAdaptation;
    const result=controller.dispatch("edit.fill",params);if(!result.ok)return result.message;
    latest.current.refresh();try{localStorage.setItem(KEY,JSON.stringify(settings));latest.current.report(null);}catch{latest.current.report("填充已完成；浏览器未能保存填充偏好");}return null;
   }}/>;
  }});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const command=controller.snapshot().commands.get("edit.fill");if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  const library=controller.patternLibrary();if(!library.ok){latest.current.report(library.message);return false;}const patterns=library.value.patternPresets??library.value.presets;
  const defaults=defaultFill(latest.current.colors.foreground,patterns);request.current={owner:owner(),initial:readFill(latest.current.colors.foreground,patterns),defaults,patterns};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
