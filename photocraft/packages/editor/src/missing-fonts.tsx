import {useEffect,useRef,useState} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const DIALOG="image-editor.missing-fonts";
export function MissingFontsDialog({instance,requestClose,fonts,apply}:EditorDialogRendererProps & {fonts:readonly string[];apply:(map:Record<string,string>)=>void}) {
 const [map,setMap]=useState<Record<string,string>>(()=>Object.fromEntries(fonts.map(font=>[font,"Inter"])));
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="替换缺失字体"><form onSubmit={event=>{event.preventDefault();apply(Object.fromEntries(Object.entries(map).filter(([,font])=>font)));}}>
 <DialogHeader onClose={requestClose}><DialogTitle>替换缺失字体</DialogTitle></DialogHeader><DialogBody><p>缺失字体暂用替代字体显示。确认后更新文字层，可撤销。</p>{fonts.map(font=><label key={font}>{font}<select value={map[font]} onChange={event=>{const value=event.currentTarget.value;setMap(map=>({...map,[font]:value}));}}><option value="">保留此字体</option><option value="Inter">Inter</option><option value="Noto Sans SC">思源黑体</option></select></label>)}</DialogBody>
 <DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!Object.values(map).some(Boolean)}>替换</Button></DialogFooter></form></DialogContent>;
}
export function useMissingFonts(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,key:string,revision:number|undefined,enabled:boolean,blocked:boolean,error:(message:string|null)=>void,refresh:()=>void) {
 const [fonts,setFonts]=useState<string[]>([]),[pending,setPending]=useState<{key:string;map:Record<string,string>}|null>(null);
 const current=useRef({key,blocked,error,refresh,fonts});current.current={key,blocked,error,refresh,fonts};
 const owner=useRef<{key:string;controller:EditorWorkspaceController}|null>(null);
 const instance=useRef<string|null>(null),opening=useRef(false);
 useEffect(()=>{if(!enabled || !controller.missingFonts){setFonts([]);return;}const result=controller.missingFonts();if(result.ok)setFonts(result.value);else{setFonts([]);current.current.error(result.message);}},[controller,key,revision,enabled]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(DIALOG,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!current.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的缺失字体请求"}},renderer:props=><MissingFontsDialog {...props} fonts={current.current.fonts} apply={map=>{
   if(owner.current?.key!==current.current.key || owner.current.controller!==controller || current.current.blocked || dialogs.top()?.instanceId!==props.instance.instanceId || instance.current!==props.instance.instanceId)return;
   setPending({key:current.current.key,map});dialogs.close(props.instance.instanceId);instance.current=null;
  }}/>});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(instance.current){dialogs?.close(instance.current);instance.current=null;}},[key,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;}},[blocked,dialogs]);
 useEffect(()=>{
  if(!pending)return;setPending(null);
  if(pending.key!==current.current.key || current.current.blocked || dialogs?.isModalActive())return;
  const result=controller.dispatch("type.resolveMissingFonts",{map:pending.map});current.current.error(result.ok?null:result.message);if(result.ok)current.current.refresh();
 },[pending,controller,dialogs]);
 return {fonts,open:()=>{
  if(!dialogs || current.current.blocked || !current.current.fonts.length || dialogs.isModalActive())return false;
  owner.current={key:current.current.key,controller};opening.current=true;try{const result=dialogs.open({dialogId:DIALOG});if(!result.ok){current.current.error(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
