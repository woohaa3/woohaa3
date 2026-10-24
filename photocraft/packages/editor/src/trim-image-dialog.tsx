import {useState} from "react";
import type {EditorDialogRendererProps} from "./ports.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
import {memoryRecord,memoryChoice,memoryBoolean} from "./tool-memory.js";
export type TrimOptions={basedOn:"transparent"|"topLeft"|"bottomRight";top:boolean;bottom:boolean;left:boolean;right:boolean};
export const DEFAULT_TRIM:TrimOptions={basedOn:"transparent",top:true,bottom:true,left:true,right:true};
export function decodeTrimOptions(value:unknown):TrimOptions{
 const raw=memoryRecord(value);return {basedOn:memoryChoice(raw.basedOn,["transparent","topLeft","bottomRight"] as const,"transparent"),top:memoryBoolean(raw.top,true),bottom:memoryBoolean(raw.bottom,true),left:memoryBoolean(raw.left,true),right:memoryBoolean(raw.right,true)};
}
export function TrimImageDialog({instance,requestClose,initial,apply}:EditorDialogRendererProps & {initial:TrimOptions;apply:(value:TrimOptions)=>string|null}){
 const [options,setOptions]=useState(initial),[error,setError]=useState<string|null>(null);
 return <DialogContent size="sm" ariaLabel="修整" instanceId={instance.instanceId}><form onSubmit={event=>{event.preventDefault();const failure=apply(options);if(failure)setError(failure);else requestClose();}}>
 <DialogHeader onClose={requestClose}><DialogTitle>修整</DialogTitle></DialogHeader><DialogBody>
 <label>依据<select autoFocus value={options.basedOn} onChange={event=>{const basedOn=event.currentTarget.value as TrimOptions["basedOn"];setOptions(value=>({...value,basedOn}));}}><option value="transparent">透明像素</option><option value="topLeft">左上角像素颜色</option><option value="bottomRight">右下角像素颜色</option></select></label>
 <fieldset><legend>裁切边缘</legend>{([["top","上"],["bottom","下"],["left","左"],["right","右"]] as const).map(([side,label])=><label key={side}><input type="checkbox" checked={options[side]} onChange={event=>{const checked=event.currentTarget.checked;setOptions(value=>({...value,[side]:checked}));}}/>{label}</label>)}</fieldset>
 <p>依据可见图像修整画布，并删除边界外的图层像素。</p>{error?<p className="dlg__error">{error}</p>:null}
 </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary">修整</Button></DialogFooter></form></DialogContent>;
}
