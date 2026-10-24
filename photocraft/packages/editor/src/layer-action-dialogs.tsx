import {ArithmeticInput} from "./arithmetic-input.js";
import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const SKIP_KEY="photocraft.layer-delete.skip-confirm.v1";
const LOCKS=[["transparency","透明像素"],["pixels","像素"],["position","位置"],["artboard","防止自动嵌套"],["all","全部"]] as const;
type Action="delete"|"locks"|"mask"|"find"|"defringe"|"decontaminate";
function skipConfirmation() {try{return localStorage.getItem(SKIP_KEY)==="true";}catch{return false;}}
function LayerActionDialog({instance,requestClose,action,count,apply}:EditorDialogRendererProps & {action:Action;count:number;apply:(params:Record<string,boolean>,skip:boolean,applyMask?:boolean,name?:string,radius?:string)=>string|null}) {
  const [name,setName]=useState(action==="defringe"?"1":action==="decontaminate"?"100":""),[radius,setRadius]=useState("4");
  const [skip,setSkip]=useState(false),[error,setError]=useState<string|null>(null);
  const [flags,setFlags]=useState<Record<string,boolean>>({transparency:false,pixels:false,position:false,artboard:false,all:true});
  const title=action==="decontaminate"?"颜色净化":action==="defringe"?"去边":action==="find"?"查找图层":action==="delete"?"删除图层":action==="mask"?"移除图层蒙版":"锁定图层";
  return <DialogContent size="sm" ariaLabel={title} instanceId={instance.instanceId}><form onSubmit={event=>{
    event.preventDefault();const failure=apply(flags,skip,false,name,radius);if(failure) setError(failure);else requestClose();
  }}><DialogHeader onClose={requestClose}><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>
    {action==="decontaminate" ? <><label>数量（%）<ArithmeticInput autoFocus invalidate  min={0} max={100} value={name} onChange={event=>setName(event.currentTarget.value)}/></label><label>半径（px）<ArithmeticInput invalidate  min={1} max={100} value={radius} onChange={event=>setRadius(event.currentTarget.value)}/></label></> : action==="defringe" ? <label>宽度（px）<ArithmeticInput autoFocus invalidate  min={1} max={200} step={1} value={name} onChange={event=>setName(event.currentTarget.value)}/></label> : action==="find" ? <label>图层名称<input autoFocus maxLength={200} value={name} onChange={event=>setName(event.currentTarget.value)} placeholder="输入名称中的一部分"/></label> : action==="mask" ? <p>应用蒙版以保留当前遮罩结果，或删除蒙版以恢复图层原始内容。</p> : action==="delete" ? <><p>删除所选的 {count} 个图层？删除后可以撤销。</p><label><input type="checkbox" checked={skip} onChange={event=>setSkip(event.currentTarget.checked)}/>不再显示此确认</label></> : <>
      <p>将以下锁定设置应用到所选的 {count} 个图层。</p>
      {LOCKS.map(([key,label])=><label className="photo-editor__lock-option" key={key}><input type="checkbox" checked={flags[key]} disabled={key!=="all" && flags.all} onChange={event=>{const checked=event.currentTarget.checked;setFlags(previous=>({...previous,[key]:checked}));}}/>{label}</label>)}
    </>}
    {error ? <p className="dlg__error">{error}</p>:null}
  </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button>{action==="mask" ? <Button type="button" onClick={()=>{const failure=apply(flags,false,true);if(failure) setError(failure);else requestClose();}}>应用蒙版</Button>:null}<Button type="submit" tone="primary">{action==="delete"?"删除":action==="mask"?"删除蒙版":"确认"}</Button></DialogFooter></form></DialogContent>;
}
/** 页脚删除与菜单锁定复用唯一宿主弹窗栈；确认前再次检查 owner、选择和命令。 */
export function useLayerActionDialogs(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,error:(message:string|null)=>void) {
  const latest=useRef({blocked,refresh,error});latest.current={blocked,refresh,error};
  const request=useRef<{action:Action;selection:string;count:number;target?:number;owner:NonNullable<ReturnType<EditorWorkspaceController["dialogOwner"]>>}|null>(null);
  const instanceId=useRef<string|null>(null),opening=useRef(false);
  const selection=()=>controller.snapshot().view.document?.layers.filter(layer=>layer.selected || layer.active).map(layer=>layer.id).sort((a,b)=>a-b).join(",")??"";
  useEffect(()=>{
    if(!dialogs) return;
    const cleanups=(["delete","locks","mask","find","defringe","decontaminate"] as const).map(action=>dialogs.registerDialog(`image-editor.layer-${action}`,{
      definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && request.current?.action===action && !latest.current.blocked ? controller.dialogOwner():null,
        validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的图层请求"}},
      renderer:props=><LayerActionDialog {...props} action={action} count={request.current?.count??0} apply={(flags,skip,applyMask,name,radius)=>{
        const expected=request.current,owner=controller.dialogOwner();
        if(latest.current.blocked || !expected || expected.action!==action || dialogs.top()?.instanceId!==props.instance.instanceId || instanceId.current!==props.instance.instanceId) return "当前操作已失效，请关闭后重试";
        if(!owner || Object.keys(expected.owner).some(key=>owner[key as keyof typeof owner]!==expected.owner[key as keyof typeof owner]) || selection()!==expected.selection) return "文档或所选图层已更换，请关闭后重试";
        const id=action==="decontaminate"?"layer.matting.colorDecontaminate":action==="defringe"?"layer.matting.defringe":action==="find"?"select.findLayers":action==="delete"?"layer.delete":action==="mask" ? applyMask?"layer.layerMask.apply":"layer.layerMask.delete":"layer.lockLayers",command=controller.snapshot().commands.get(id);
        if(!command?.allowed || !command.enabled) return command?.disabledReason??"当前无法操作所选图层";
        if(action==="mask" && !controller.snapshot().view.document?.layers.some(layer=>layer.id===expected.target && layer.hasMask && layer.active)) return "蒙版目标已更换，请关闭后重试";
        const result=controller.dispatch(id,action==="decontaminate"?{amount:name?.trim()?Number(name):null,radius:radius?.trim()?Number(radius):null}:action==="defringe"?{width:name?.trim()?Number(name):null}:action==="find"?{name}:action==="delete"?null:action==="mask"?{layer:expected.target}:flags);latest.current.refresh();
        if(!result.ok) return result.message;
        if(action==="delete" && skip) {try{localStorage.setItem(SKIP_KEY,"true");}catch{latest.current.error("已删除图层；浏览器未能保存确认偏好，下次仍会询问");}}
        return null;
      }}/>
    }));
    return ()=>{if(instanceId.current) dialogs.close(instanceId.current);instanceId.current=null;request.current=null;cleanups.forEach(cleanup=>cleanup());};
  },[dialogs,controller]);
  useEffect(()=>{if(blocked && instanceId.current) {dialogs?.close(instanceId.current);instanceId.current=null;request.current=null;}},[blocked,dialogs]);
  const open=(action:Action,bypass=false,target?:number)=>{
    const id=action==="decontaminate"?"layer.matting.colorDecontaminate":action==="defringe"?"layer.matting.defringe":action==="find"?"select.findLayers":action==="delete"?"layer.delete":action==="mask"?"layer.layerMask.delete":"layer.lockLayers",command=controller.snapshot().commands.get(id);
    if(latest.current.blocked || !command?.allowed || !command.enabled || dialogs?.isModalActive()) {latest.current.error("请先结束当前操作");return false;}
    if(action==="delete" && (bypass || skipConfirmation())) {const result=controller.dispatch(id,null);latest.current.refresh();latest.current.error(result.ok?null:result.message);return result.ok;}
    const owner=controller.dialogOwner(),selected=selection();
    if(!dialogs || !owner || (!selected && action!=="find")) {latest.current.error("图层窗口不可用，请重新进入图片编辑");return false;}
    request.current={action,selection:selected,count:selected.split(",").length,owner,target};opening.current=true;
    let result;try{result=dialogs.open({dialogId:`image-editor.layer-${action}`});}finally{opening.current=false;}
    if(!result.ok) {request.current=null;latest.current.error(result.error);return false;}
    instanceId.current=result.instance.instanceId;latest.current.error(null);return true;
  };
  return {decontaminate:()=>open("decontaminate"),defringe:()=>open("defringe"),find:()=>open("find"),delete:(bypass=false)=>open("delete",bypass),locks:()=>open("locks"),mask:(layer:number)=>open("mask",false,layer)};
}
