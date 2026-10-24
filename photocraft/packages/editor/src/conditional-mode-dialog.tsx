/**
 * 条件模式转换对话框（I291）。
 *
 * 只把表单编译成 `file.automate.conditionalModeChange` 的参数；是否真的转换由引擎按来源
 * 模式判断，界面据此回报「已转换 / 当前模式不满足条件」。
 */
import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {CONDITIONAL_SOURCE_MODES,CONDITIONAL_TARGET_MODES,DEFAULT_CONDITIONAL_MODE,buildConditionalMode,decodeConditionalModeResult,willConvert,type ConditionalModeSettings} from "./conditional-mode.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.conditional-mode";
const SOURCE_LABELS:Record<typeof CONDITIONAL_SOURCE_MODES[number],string>={rgb:"RGB",grayscale:"灰度",cmyk:"CMYK",lab:"Lab",bitmap:"位图",indexed:"索引色",duotone:"双色调",multichannel:"多通道"};
const TARGET_LABELS:Record<typeof CONDITIONAL_TARGET_MODES[number],string>={rgb:"RGB",grayscale:"灰度",cmyk:"CMYK",lab:"Lab"};

function ConditionalModeDialog({instance,requestClose,initial,currentMode,apply}:EditorDialogRendererProps & {
  initial:ConditionalModeSettings;currentMode:string;apply:(settings:ConditionalModeSettings)=>string|null;
}) {
  const [value,setValue]=useState<ConditionalModeSettings>(initial);
  const [error,setError]=useState<string|null>(null);
  const [note,setNote]=useState<string|null>(null);
  const toggle=(mode:typeof CONDITIONAL_SOURCE_MODES[number])=>setValue(current=>({
    ...current,anySource:false,
    from:current.from.includes(mode)?current.from.filter(item=>item!==mode):[...current.from,mode]
  }));
  const converts=willConvert(value,currentMode);
  return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="条件模式转换"><form onSubmit={event=>{event.preventDefault();const failure=apply(value);if(failure){setError(failure);return;}setError(null);setNote("命令已执行");requestClose();}}>
    <DialogHeader onClose={requestClose}><DialogTitle>条件模式转换</DialogTitle></DialogHeader><DialogBody>
      <p>当前模式：{SOURCE_LABELS[currentMode.toLowerCase() as typeof CONDITIONAL_SOURCE_MODES[number]] ?? currentMode}。只有来源模式在下列集合内且与目标不同才会转换。</p>
      <label><input type="checkbox" checked={value.anySource} onChange={event=>setValue(current=>({...current,anySource:event.currentTarget.checked}))}/>任意来源模式</label>
      {!value.anySource?<fieldset className="photo-editor__checkbox-grid"><legend>来源模式</legend>
        {CONDITIONAL_SOURCE_MODES.map(mode=><label key={mode}><input type="checkbox" checked={value.from.includes(mode)} onChange={()=>toggle(mode)}/>{SOURCE_LABELS[mode]}</label>)}
      </fieldset>:null}
      <label>目标模式<select value={value.to} onChange={event=>setValue(current=>({...current,to:event.currentTarget.value as ConditionalModeSettings["to"]}))}>
        {CONDITIONAL_TARGET_MODES.map(mode=><option key={mode} value={mode}>{TARGET_LABELS[mode]}</option>)}</select></label>
      <p>{converts?"确认后将转换当前文档模式并记一步历史。":"当前模式不满足条件；确认不会改变文档。"}</p>
      {note?<p>{note}</p>:null}
      {error?<p className="dlg__error">{error}</p>:null}
    </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!buildConditionalMode(value)}>{converts?"转换":"确定"}</Button></DialogFooter>
  </form></DialogContent>;
}

export function useConditionalModeDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void) {
  const latest=useRef({blocked,refresh,report});latest.current={blocked,refresh,report};
  const instance=useRef<string|null>(null),request=useRef<{owner:string;currentMode:string}|null>(null),opening=useRef(false);
  const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey,controller.snapshot().view.document?.revision]);
  useEffect(()=>{
    if(!dialogs)return;
    const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的条件模式请求"}},renderer:props=>{
      const captured=request.current;if(!captured)return null;
      return <ConditionalModeDialog {...props} initial={DEFAULT_CONDITIONAL_MODE} currentMode={captured.currentMode} apply={settings=>{
        if(latest.current.blocked || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档已更换，请关闭后重试";
        const params=buildConditionalMode(settings);
        if(!params)return "请选择至少一个来源模式";
        const command=controller.snapshot().commands.get("file.automate.conditionalModeChange");
        if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法执行条件模式转换";
        const result=controller.dispatch("file.automate.conditionalModeChange",params);
        if(!result.ok)return result.message;
        const decoded=decodeConditionalModeResult(result.value);
        if(decoded)latest.current.report(decoded.changed?`已转换为 ${TARGET_LABELS[decoded.mode as ConditionalModeSettings["to"]] ?? decoded.mode}`:"当前模式不满足条件，文档未改变");
        latest.current.refresh();
        return null;
      }}/>;
    }});
    return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
  },[dialogs,controller]);
  useEffect(()=>{if(blocked&&instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
  return {open:()=>{
    const document=controller.snapshot().view.document;
    const command=controller.snapshot().commands.get("file.automate.conditionalModeChange");
    if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !document || !command?.allowed || !command.enabled || dialogs.isModalActive()){
      latest.current.report(command?.disabledReason??"请先结束当前操作");
      return false;
    }
    request.current={owner:owner(),currentMode:document.mode};opening.current=true;
    try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
  }};
}
