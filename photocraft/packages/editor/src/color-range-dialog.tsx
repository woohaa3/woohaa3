import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {COLOR_RANGE_SELECTIONS,buildColorRange,type ColorRangeSettings} from "./photo-editor-tools.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.color-range";
export function decodeColorRangeValue(settings:ColorRangeSettings):Record<string,unknown>{return buildColorRange(settings);}
function ColorRangeDialog({instance,requestClose,initial,apply}:EditorDialogRendererProps & {initial:ColorRangeSettings;apply:(settings:ColorRangeSettings)=>string|null}) {
 const [value,setValue]=useState(initial),[fuzziness,setFuzziness]=useState(String(initial.fuzziness)),[range,setRange]=useState(String(initial.range)),[error,setError]=useState<string|null>(null);
 const sampled=value.select==="sampledColors";
 const max=sampled?200:100;
 const valid=Number.isFinite(Number(fuzziness)) && Number(fuzziness)>=0 && Number(fuzziness)<=max && (!sampled || !value.localized || (Number.isFinite(Number(range)) && Number(range)>=0 && Number(range)<=100));
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="颜色范围"><form onSubmit={event=>{event.preventDefault();if(!valid){setError(`容差须为0–${max}`);return;}const failure=apply({...value,fuzziness:Number(fuzziness),range:Number(range)});if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>颜色范围</DialogTitle></DialogHeader><DialogBody>
   <label>选择<select value={value.select} onChange={event=>{const select=event.currentTarget.value as ColorRangeSettings["select"];setValue(current=>({...current,select}));setError(null);}}>{COLOR_RANGE_SELECTIONS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   {sampled?<label>取样颜色<input type="color" value={value.color} onChange={event=>{const color=event.currentTarget.value;setValue(current=>({...current,color}));}}/></label>:null}
   {sampled?<div className="photo-editor__color-range-samples">
     <p>画布取样点：{value.points?.length??0} 个加入，{value.subtractPoints?.length??0} 个减去</p>
     <Button type="button" size="sm" disabled={!value.points?.length} onClick={()=>setValue(current=>({...current,points:[]}))}>清除取样点</Button>
   </div>:null}
   {value.select!=="outOfGamut"?<label>容差<input type="text" inputMode="decimal" value={fuzziness} onChange={event=>setFuzziness(event.currentTarget.value)}/></label>:null}
   {sampled?<><label><input type="checkbox" checked={value.localized} onChange={event=>{const localized=event.currentTarget.checked;setValue(current=>({...current,localized}));}}/>局部颜色群集</label>
    {value.localized?<label>范围（%）<input type="text" inputMode="decimal" value={range} onChange={event=>setRange(event.currentTarget.value)}/></label>:null}</>:null}
   <label><input type="checkbox" checked={value.invert} onChange={event=>{const invert=event.currentTarget.checked;setValue(current=>({...current,invert}));}}/>反相</label>
   <label><input type="checkbox" checked={value.sampleAllLayers} onChange={event=>{const sampleAllLayers=event.currentTarget.checked;setValue(current=>({...current,sampleAllLayers}));}}/>所有图层取样</label>
   <label>选区运算<select value={value.mode} onChange={event=>{const mode=event.currentTarget.value as ColorRangeSettings["mode"];setValue(current=>({...current,mode}));}}><option value="replace">替换</option><option value="add">增加</option><option value="subtract">减去</option><option value="intersect">相交</option></select></label>
   <p>按颜色或色调在当前文档生成选区。确认后一步写入；取消保留原选区。</p>
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>确认</Button></DialogFooter>
 </form></DialogContent>;
}
export function useColorRangeDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void,onApplied?:(settings:ColorRangeSettings)=>void) {
 const latest=useRef({blocked,refresh,report,onApplied});latest.current={blocked,refresh,report,onApplied};
 const instance=useRef<string|null>(null),request=useRef<{owner:string;initial:ColorRangeSettings}|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey,controller.snapshot().view.document?.revision]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的颜色范围请求"}},renderer:props=>{
   const captured=request.current;if(!captured)return null;
   return <ColorRangeDialog {...props} initial={captured.initial} apply={settings=>{
    const command=controller.snapshot().commands.get("select.colorRange");
    if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档已更换，请关闭后重试";
    if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法创建颜色范围选区";
    const result=controller.dispatch("select.colorRange",buildColorRange(settings));if(!result.ok)return result.message;
    latest.current.refresh();latest.current.onApplied?.(settings);return null;
   }}/>;
  }});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:(initial:ColorRangeSettings)=>{
  const command=controller.snapshot().commands.get("select.colorRange");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive()){latest.current.report(command?.disabledReason??"请先结束当前操作");return false;}
  request.current={owner:owner(),initial};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
