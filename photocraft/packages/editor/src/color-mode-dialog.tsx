import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.color-mode";
type Mode="rgb"|"grayscale"|"cmyk"|"lab"|"bitmap"|"duotone"|"multichannel";
type Depth=8|16|32;
const MODES:[Mode,string][]=[["rgb","RGB 颜色"],["grayscale","灰度"],["cmyk","CMYK 颜色"],["lab","Lab 颜色"],["bitmap","位图"],["duotone","双色调"],["multichannel","多通道"]];
const DEPTHS:[Depth,string][]=[[8,"8 位/通道"],[16,"16 位/通道"],[32,"32 位/通道"]];
export type ColorModeRequest={mode:string;depth:number};
function ColorModeDialog({instance,requestClose,initial,apply}:EditorDialogRendererProps & {initial:ColorModeRequest;apply:(mode:Mode,depth:Depth)=>string|null}) {
 const currentMode=(MODES.some(([id])=>id===initial.mode)?initial.mode:"rgb") as Mode;
 const currentDepth=(DEPTHS.some(([id])=>id===initial.depth)?initial.depth:8) as Depth;
 const [mode,setMode]=useState<Mode>(currentMode),[depth,setDepth]=useState<Depth>(currentDepth),[error,setError]=useState<string|null>(null);
 const changed=mode!==currentMode || depth!==currentDepth;
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="图像模式"><form onSubmit={event=>{event.preventDefault();const failure=apply(mode,depth);if(failure)setError(failure);else requestClose();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>图像模式与位深</DialogTitle></DialogHeader><DialogBody>
   <p>转换会重采样像素并作为一步历史。CMYK/Lab/位图/双色调/多通道在共享编辑器中按固定引擎能力执行；ICC 配置文件分配与软打样仍不在本入口。</p>
   <label>模式<select value={mode} onChange={event=>setMode(event.currentTarget.value as Mode)}>{MODES.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   <label>位深<select value={depth} onChange={event=>setDepth(Number(event.currentTarget.value) as Depth)}>{DEPTHS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   {!changed?<p>当前已是指定模式与位深，确认不产生内容变化。</p>:null}
   {error?<p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!changed}>转换</Button></DialogFooter>
 </form></DialogContent>;
}
export function useColorModeDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,refresh,report});latest.current={blocked,refresh,report};
 const instance=useRef<string|null>(null),request=useRef<{owner:string;initial:ColorModeRequest}|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey,controller.snapshot().view.document?.revision]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的图像模式请求"}},renderer:props=>{
   const captured=request.current;if(!captured)return null;
   return <ColorModeDialog {...props} initial={captured.initial} apply={(mode,depth)=>{
    if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档已更换，请关闭后重试";
    // 先转换模式再转换位深：同名命令由固定引擎保证各自一步历史。
    const modeId=`image.mode.${mode}`,depthId=`image.mode.bits${depth}`;
    const modeCommand=controller.snapshot().commands.get(modeId),depthCommand=controller.snapshot().commands.get(depthId);
    if(mode!==captured.initial.mode){if(!modeCommand?.allowed || !modeCommand.enabled)return modeCommand?.disabledReason??"当前无法转换该模式";const result=controller.dispatch(modeId,{});if(!result.ok)return result.message;}
    if(depth!==captured.initial.depth){const latestCommand=controller.snapshot().commands.get(depthId)??depthCommand;if(!latestCommand?.allowed || !latestCommand.enabled)return latestCommand?.disabledReason??"当前无法转换位深";const result=controller.dispatch(depthId,{});if(!result.ok)return result.message;}
    latest.current.refresh();return null;
   }}/>;
  }});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const document=controller.snapshot().view.document;
  const command=controller.snapshot().commands.get("image.mode.rgb");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !document || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  request.current={owner:owner(),initial:{mode:document.mode.toLowerCase(),depth:document.depthBits}};opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
