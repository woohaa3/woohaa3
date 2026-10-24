import {useEffect,useRef,useState} from "react";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorResult} from "./editor-wasm.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
const ID="image-editor.spelling",KEY="photocraft.spelling-dictionary.v1";
type Hit={layer:number;start:number;end:number;word:string};
type Reply=EditorResult<Record<string,unknown>>;
export function readSpellingDictionary():string[] {
 try {const value:unknown=JSON.parse(localStorage.getItem(KEY)??"[]");return Array.isArray(value) && value.length<=2000 && value.every(w=>typeof w==="string" && w.length>0 && [...w].length<=128 && !/\s/u.test(w))?value:[];}catch{return [];}
}
function SpellingDialog({instance,requestClose,apply}:EditorDialogRendererProps & {apply:(params:Record<string,unknown>)=>Reply}) {
 const [allLayers,setAllLayers]=useState(true),[hits,setHits]=useState<Hit[]>([]),[checked,setChecked]=useState(false),[replacement,setReplacement]=useState(""),[suggestions,setSuggestions]=useState<string[]>([]),[message,setMessage]=useState<string|null>(null);
 const ignored=useRef<string[]>([]),dictionary=useRef(readSpellingDictionary());
 const hit=hits[0];
 const show=(next:Hit[])=>{
  setHits(next);setChecked(true);setReplacement(next[0]?.word??"");setSuggestions([]);
  if(next[0]){const result=apply({action:"suggest",word:next[0].word,dictionary:dictionary.current});if(result.ok && Array.isArray(result.value.suggestions))setSuggestions(result.value.suggestions.filter((s):s is string=>typeof s==="string"));else if(!result.ok)setMessage(result.message);}
 };
 const check=(scope=allLayers)=>{
  const result=apply({action:"list",allLayers:scope,ignore:ignored.current,dictionary:dictionary.current});
  if(!result.ok){setMessage(result.message);return;}setMessage(null);
  show(Array.isArray(result.value.misspellings)?result.value.misspellings as Hit[]:[]);
 };
 const change=(all:boolean)=>{
  if(!hit)return;const result=apply({action:all?"changeAll":"change",allLayers,...(all?{}:{layer:hit.layer,start:hit.start,end:hit.end}),word:hit.word,replace:replacement,dictionary:dictionary.current});
  if(!result.ok){setMessage(result.message);return;}check();
 };
 const add=()=>{
  if(!hit)return;const result=apply({action:"add",word:hit.word,dictionary:dictionary.current});if(!result.ok){setMessage(result.message);return;}
  dictionary.current=result.value.userDictionary as string[];check();
  try{localStorage.setItem(KEY,JSON.stringify(dictionary.current));}catch{setMessage("单词已在本次检查中接受；浏览器未能保存用户词典");}
 };
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="检查拼写"><form onSubmit={event=>{event.preventDefault();check();}}>
  <DialogHeader onClose={requestClose}><DialogTitle>检查拼写</DialogTitle></DialogHeader><DialogBody>
   <p>使用英语（美国）词典检查文字图层。用户词典保存在本机。</p>
   <label><input type="checkbox" checked={allLayers} onChange={event=>{const scope=event.currentTarget.checked;setAllLayers(scope);setChecked(false);setHits([]);setSuggestions([]);setMessage(null);ignored.current=[];}}/>检查所有文字图层</label>
   {hit?<><p>疑似拼写：<strong>{hit.word}</strong>（图层 {hit.layer}）</p>
    <label>替换为<input maxLength={10000} value={replacement} onChange={event=>setReplacement(event.currentTarget.value)}/></label>
    <label>建议<select size={5} value="" onChange={event=>setReplacement(event.currentTarget.value)}>{suggestions.map(word=><option key={word} value={word}>{word}</option>)}</select></label>
    {suggestions.length===0?<p>没有可用建议，可以直接输入替换文字。</p>:null}
   </>:checked?<p>拼写检查完成，没有待检查的单词。</p>:<p>选择检查范围后，点击“开始检查”。</p>}
   {message?<p className="dlg__error">{message}</p>:null}
  </DialogBody><DialogFooter className="photo-editor-find-replace__actions">
   <Button type="button" onClick={requestClose}>完成</Button><Button type="submit">{checked?"重新检查":"开始检查"}</Button>
   <Button type="button" disabled={!hit} onClick={()=>{setMessage(null);show(hits.slice(1));}}>忽略</Button>
   <Button type="button" disabled={!hit || ignored.current.length>=2000} onClick={()=>{if(hit){ignored.current.push(hit.word);check();}}}>全部忽略</Button>
   <Button type="button" disabled={!hit} onClick={add}>添加到词典</Button>
   <Button type="button" disabled={!hit || replacement.length>10000} onClick={()=>change(false)}>更改</Button>
   <Button type="button" tone="primary" disabled={!hit || replacement.length>10000} onClick={()=>change(true)}>全部更改</Button>
  </DialogFooter>
 </form></DialogContent>;
}
export function useSpellingDialog(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,blocked:boolean,refresh:()=>void,report:(message:string|null)=>void) {
 const latest=useRef({blocked,refresh,report});latest.current={blocked,refresh,report};
 const instance=useRef<string|null>(null),request=useRef<string|null>(null),opening=useRef(false);
 const owner=()=>JSON.stringify([controller.dialogOwner(),controller.snapshot().view.document?.documentKey]);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(ID,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current && !latest.current.blocked?controller.dialogOwner():null,validatePayload:p=>p==null?{ok:true,payload:null}:{ok:false,error:"无效的拼写检查请求"}},renderer:props=><SpellingDialog {...props} apply={params=>{
   if(latest.current.blocked || !request.current || request.current!==owner() || instance.current!==props.instance.instanceId || dialogs.top()?.instanceId!==props.instance.instanceId)return {ok:false,code:"stale",message:"文档已更换，请关闭后重试"};
   const command=controller.snapshot().commands.get("edit.checkSpelling");
   if(!command?.allowed || !command.enabled)return {ok:false,code:"capability-disabled",message:command?.disabledReason??"当前无法检查拼写"};
   const result=controller.checkSpelling(params);if(result.ok)latest.current.refresh();return result;
  }}/>});
  return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(blocked && instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {open:()=>{
  const command=controller.snapshot().commands.get("edit.checkSpelling");
  if(!dialogs || latest.current.blocked || !controller.dialogOwner() || !command?.allowed || !command.enabled || dialogs.isModalActive())return false;
  request.current=owner();opening.current=true;
  try{const result=dialogs.open({dialogId:ID});if(!result.ok){request.current=null;latest.current.report(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}
 }};
}
