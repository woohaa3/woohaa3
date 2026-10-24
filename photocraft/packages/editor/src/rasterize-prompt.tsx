import {useEffect,useRef} from "react";
import type {EditorDialogPort} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";

const ID="image-editor.rasterize-before-paint";
/** Park only the original click, never a live pointer or a partially collected stroke. */
export function useRasterizePrompt(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,context:string,refresh:()=>void,message:(value:string|null)=>void) {
  const current=useRef({blocked,context,refresh,message});current.current={blocked,context,refresh,message};
  const opening=useRef(false),instance=useRef<string|null>(null);
  const pending=useRef<{key:string;layer:number;paint:()=>void}|null>(null);
  const key=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.sessionActiveIndex,controller.snapshot().view.document,current.current.context]);
  useEffect(()=>{
    if(!dialogs)return;
    const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!current.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的栅格化请求"}},renderer:props=><DialogContent size="sm" ariaLabel="栅格化文字" instanceId={props.instance.instanceId}>
      <DialogHeader onClose={props.requestClose}><DialogTitle>栅格化文字？</DialogTitle></DialogHeader>
      <DialogBody><p>继续绘制需要先栅格化此文字图层。栅格化后，文字将无法继续编辑。是否栅格化并在原点击位置绘制？</p></DialogBody>
      <DialogFooter><Button onClick={props.requestClose}>取消</Button><Button tone="primary" onClick={()=>{
        const expected=pending.current;
        if(instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==instance.current)return;
        if(!expected || current.current.blocked || expected.key!==key()) {current.current.message("文档、工具或绘制目标已更换，请取消后重试");return;}
        const command=controller.snapshot().commands.get("layer.rasterize.type");
        if(!command?.allowed || !command.enabled){current.current.message(command?.disabledReason??"当前无法栅格化此文字图层");return;}
        // Closing first releases the host modal gate. The two native transactions remain separate.
        pending.current=null;instance.current=null;dialogs.close(props.instance.instanceId);
        const result=controller.dispatch("layer.rasterize.type",{layer:expected.layer});
        current.current.refresh();
        if(!result.ok){current.current.message(result.message);return;}
        expected.paint();
      }}>栅格化并绘制</Button></DialogFooter>
    </DialogContent>});
    return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;pending.current=null;unregister();};
  },[dialogs,controller]);
  useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;pending.current=null;}},[blocked,dialogs]);
  return (paint:()=>void)=>{
    const document=controller.snapshot().view.document,layer=document?.layers.find(row=>row.active);
    if(document?.editTarget!=="pixels" || layer?.kind!=="text" || layer.effectiveLocks.all || layer.effectiveLocks.pixels)return false;
    if(!dialogs || current.current.blocked || dialogs.isModalActive() || !controller.dialogOwner()) {current.current.message("当前无法打开栅格化确认，请先结束其他操作");return true;}
    pending.current={key:key(),layer:layer.id,paint};opening.current=true;
    try {const result=dialogs.open({dialogId:ID});if(result.ok){instance.current=result.instance.instanceId;current.current.message(null);}else{pending.current=null;current.current.message(result.error);}}finally{opening.current=false;}
    return true;
  };
}
