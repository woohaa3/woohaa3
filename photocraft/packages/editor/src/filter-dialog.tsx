/**
 * 滤镜参数对话框（I035）。
 *
 * 只把 `filter-catalog.ts` 声明的字段编译成已开放滤镜命令的参数；无参滤镜直接分派，
 * 不弹窗。表单在提交前按原生范围校验，越界值先禁用确认。
 */
import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {buildFilter,filterDefaults,filterSpec,type FilterSpec} from "./filter-catalog.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.filter";

function FilterDialog({instance,requestClose,spec,apply}:EditorDialogRendererProps & {
  spec:FilterSpec;
  apply:(values:Record<string,unknown>)=>string|null;
}) {
  const [values,setValues]=useState<Record<string,unknown>>(()=>filterDefaults(spec));
  const [error,setError]=useState<string|null>(null);
  const built=buildFilter(spec,values);
  return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel={spec.label}><form onSubmit={event=>{
    event.preventDefault();
    if(!built.ok){setError(built.reason);return;}
    const failure=apply(built.params);if(failure){setError(failure);return;}
    requestClose();
  }}>
    <DialogHeader onClose={requestClose}><DialogTitle>{spec.label}</DialogTitle></DialogHeader><DialogBody>
      {spec.fields.map(field=>field.choices
        ? <label key={field.key}>{field.label}<select value={String(values[field.key]??field.choices![0]![0])}
            onChange={event=>setValues(current=>({...current,[field.key]:event.currentTarget.value}))}>
            {field.choices.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
        : <label key={field.key}>{field.label}<input type="number" step={field.step??1}
            min={field.min} max={field.max} value={String(values[field.key]??field.min??0)}
            onChange={event=>setValues(current=>({...current,[field.key]:event.currentTarget.value}))}/></label>)}
      {!built.ok?<p className="dlg__error">{built.reason}</p>:null}
      {error?<p className="dlg__error">{error}</p>:null}
      <p>滤镜作用于当前图层或选区，确认后记一步历史。</p>
    </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button>
      <Button type="submit" tone="primary" disabled={!built.ok}>应用</Button></DialogFooter>
  </form></DialogContent>;
}

export function useFilterDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:()=>boolean,refresh:()=>void) {
  const latest=useRef({blocked,refresh});latest.current={blocked,refresh};
  const instance=useRef<string|null>(null),request=useRef<{owner:string;spec:FilterSpec}|null>(null),opening=useRef(false);
  const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey,controller.snapshot().view.document?.revision]);
  useEffect(()=>{
    if(!dialogs)return;
    const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!latest.current.blocked()?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的滤镜请求"}},renderer:props=>{
      const captured=request.current;if(!captured)return null;
      return <FilterDialog {...props} spec={captured.spec} apply={values=>{
        if(latest.current.blocked() || request.current!==captured || captured.owner!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return "文档已更换，请关闭后重试";
        const command=controller.snapshot().commands.get(captured.spec.id);
        if(!command?.allowed || !command.enabled)return command?.disabledReason??"当前无法应用该滤镜";
        const result=controller.dispatch(captured.spec.id,values);
        if(!result.ok)return result.message;
        latest.current.refresh();return null;
      }}/>;
    }});
    return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
  },[dialogs,controller]);
  useEffect(()=>{if(blocked()&&instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[dialogs]);
  /** 打开指定滤镜；无参数滤镜不弹窗，直接返回 `"direct"` 由调用方分派。 */
  const open=(id:string):"dialog"|"direct"|false=>{
    const spec=filterSpec(id);
    if(!spec)return false;
    const command=controller.snapshot().commands.get(id);
    if(!command?.allowed || !command.enabled)return false;
    if(!spec.fields.length)return "direct";
    if(!dialogs || latest.current.blocked() || !controller.dialogOwner() || dialogs.isModalActive())return false;
    request.current={owner:owner(),spec};opening.current=true;
    try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;return false;}instance.current=result.instance.instanceId;return "dialog";}finally{opening.current=false;}
  };
  return {open};
}
