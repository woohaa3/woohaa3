import {EDITOR_THEMES} from "./editor-theme-palettes.js";
import {useEffect,useRef,useState} from "react";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import {EDITOR_MENUS,type EditorMenuItem,type WorkspacePurgePort} from "./photo-editor-menu.js";
import {commandShortcutLabel,TOOL_KEYS,type PhotoEditorTool} from "./photo-editor-shortcuts.js";
import {toolbarMembers} from "./toolbar-slots.js";
import {DialogBody,DialogContent,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const DIALOG="image-editor.command-search",RECENTS="photocraft.command-search.recent.v1";
export type SearchEntry={id:string;label:string;path:string;shortcut?:string;enabled:boolean;reason?:string|null;tool?:PhotoEditorTool};
/** 工具条目直接来自槽位注册表：工具栏里有的工具，命令面板都能切到，反之亦然。 */
const tools:readonly [PhotoEditorTool,string][]=toolbarMembers().map(member=>[member.tool,member.label]);
export function commandSearchEntries(controller:EditorWorkspaceController,purge?:WorkspacePurgePort):SearchEntry[] {
 const snapshot=controller.snapshot(),out:SearchEntry[]=[];
 const visit=(items:readonly EditorMenuItem[],path:string[])=>{for(const item of items) {
  if(item.children) {visit(item.children,[...path,item.label]);continue;}
  const command=snapshot.commands.get(item.id);if(!command?.allowed) continue;
  const purgeState=purge?.commands[item.id as keyof WorkspacePurgePort["commands"]];
  const enabled=purgeState?purgeState.enabled:item.id==="edit.undo"?snapshot.view.document?.canUndo:item.id==="edit.redo"?snapshot.view.document?.canRedo:command.enabled;
  out.push({id:item.id,label:item.label,path:path.join(" › "),shortcut:commandShortcutLabel(item.id),enabled:!!enabled,reason:purgeState?purgeState.reason:command.disabledReason});
 }};
 for(const menu of EDITOR_MENUS) visit(menu.items,[menu.label]);
 if(snapshot.view.document) for(const [tool,label] of tools) out.push({id:`tool:${tool}`,tool,label,path:"工具",enabled:true,shortcut:TOOL_KEYS[tool]});
 for(const theme of EDITOR_THEMES) out.push({id:`window.theme.${theme.id}`,label:theme.label,path:"窗口 › 主题",enabled:true});
 out.push({id:"tool.reset",label:"重置当前工具",path:"工具",enabled:true},{id:"tool.resetAll",label:"重置全部工具…",path:"工具",enabled:true});
 out.push({id:"window.theme.system",label:"跟随系统外观",path:"窗口 › 主题",enabled:true},
 {id:"view.darkenInterface",label:"调暗界面",path:"窗口",shortcut:"Mod+Shift+F1",enabled:true},
 {id:"view.lightenInterface",label:"调亮界面",path:"窗口",shortcut:"Mod+Shift+F2",enabled:true});
 return out;
}
export function searchCommands(entries:readonly SearchEntry[],query:string,recent:readonly string[]):SearchEntry[] {
 const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 const matches=(text:string,word:string)=>{let from=0;for(const char of word) {const next=text.indexOf(char,from);if(next<0)return false;from=next+1;}return true;};
 const rank=(entry:SearchEntry)=>{const index=recent.indexOf(entry.id);return index<0?1000:index;};
 return entries.filter(entry=>words.every(word=>matches(`${entry.label} ${entry.path} ${entry.id}`.toLocaleLowerCase(),word)))
 .sort((a,b)=>words.length?Number(!a.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))-Number(!b.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())):rank(a)-rank(b));
}
function readRecent():string[] {try{const value:unknown=JSON.parse(localStorage.getItem(RECENTS)??"[]");return Array.isArray(value)?value.filter((id):id is string=>typeof id==="string").slice(0,20):[];}catch{return [];}}
function SearchDialog({instance,requestClose,entries,recent,execute}:EditorDialogRendererProps & {entries:SearchEntry[];recent:string[];execute:(id:string)=>void}) {
 const [query,setQuery]=useState(""),[index,setIndex]=useState(0),composing=useRef(false);
 const results=searchCommands(entries,query,recent),selected=results[Math.min(index,Math.max(0,results.length-1))];
 return <DialogContent size="md" ariaLabel="搜索命令" instanceId={instance.instanceId}>
  <DialogHeader onClose={requestClose}><DialogTitle>搜索命令</DialogTitle></DialogHeader>
  <DialogBody><input className="photo-editor-command-search__query" data-dialog-initial-focus placeholder="搜索命令、菜单路径或工具" value={query} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onChange={event=>{setQuery(event.currentTarget.value);setIndex(0);}} onKeyDown={event=>{
   if(event.nativeEvent.isComposing || event.keyCode===229 || composing.current) return;
   if(event.key==="Escape") {event.preventDefault();event.stopPropagation();requestClose();}
   else if(event.key==="ArrowDown" || event.key==="ArrowUp") {event.preventDefault();setIndex(current=>results.length?(current+(event.key==="ArrowDown"?1:-1)+results.length)%results.length:0);}
   else if(event.key==="Enter") {event.preventDefault();if(selected?.enabled) execute(selected.id);}
  }}/>
  <div className="photo-editor-command-search__results">{results.length?results.map((entry,i)=><Button key={entry.id} tone={i===index?"neutral":"ghost"} disabled={!entry.enabled} title={entry.reason??undefined} onClick={()=>execute(entry.id)}><span><strong>{entry.label}</strong><small>{entry.path}{!entry.enabled?` · ${entry.reason??"当前不可用"}`:""}</small></span>{entry.shortcut?<kbd>{entry.shortcut}</kbd>:null}</Button>):<p>没有匹配的命令，请换一个关键词。</p>}</div>
  </DialogBody>
 </DialogContent>;
}
/** 搜索结果只指向已有入口；关闭模态后复核owner和能力，再调用最新动作。 */
export function useCommandSearch({dialogs,controller,blocked,execute,error,purge}: {dialogs?:EditorDialogPort;purge?:WorkspacePurgePort;controller:EditorWorkspaceController;blocked:boolean;execute:(entry:SearchEntry)=>boolean;error:(message:string|null)=>void}) {
 const current=useRef({blocked,execute,error,purge});current.current={blocked,execute,error,purge};
 const instance=useRef<string|null>(null),opening=useRef(false),owner=useRef<string|null>(null);
 const [pending,setPending]=useState<{id:string;owner:string}|null>(null);
 const ownerKey=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.sessionActiveIndex]);
 useEffect(()=>{
  if(!dialogs) return;
  const unregister=dialogs.registerDialog(DIALOG,{definition:{singleton:true,size:"md",editingOwner:()=>opening.current && !current.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的搜索请求"}},renderer:props=><SearchDialog {...props} entries={commandSearchEntries(controller,current.current.purge)} recent={readRecent()} execute={id=>{
   if(dialogs.top()?.instanceId!==props.instance.instanceId || instance.current!==props.instance.instanceId || owner.current!==ownerKey()) return;
   const entry=commandSearchEntries(controller,current.current.purge).find(entry=>entry.id===id);if(!entry?.enabled) return;
   setPending({id,owner:owner.current!});dialogs.close(props.instance.instanceId);instance.current=null;
  }}/>});
  return()=>{if(instance.current) dialogs.close(instance.current);instance.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{
  if(!pending) return;setPending(null);
  if(current.current.blocked || pending.owner!==ownerKey() || dialogs?.isModalActive()) return;
  const entry=commandSearchEntries(controller,current.current.purge).find(entry=>entry.id===pending.id);
  if(!entry?.enabled || !current.current.execute(entry)) return;
  try {localStorage.setItem(RECENTS,JSON.stringify([entry.id,...readRecent().filter(id=>id!==entry.id)].slice(0,20)));}catch{/* 本次搜索仍有效。 */}
 },[pending,dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current) {dialogs?.close(instance.current);instance.current=null;}},[blocked,dialogs]);
 return {available:!!dialogs,open:()=>{
  if(!dialogs || current.current.blocked || dialogs.isModalActive()) return false;
  owner.current=ownerKey();opening.current=true;
  try {const result=dialogs.open({dialogId:DIALOG});if(!result.ok){current.current.error(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
