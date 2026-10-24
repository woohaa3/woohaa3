import {parseNumericExpression} from "./numeric-expression.js";
import {useEffect,useRef,useState} from "react";
import {clampEditorZoom} from "./zoom-levels.js";
import type {EditorDocumentView} from "./editor-view-model.js";
export function parseZoomPercent(text:string):number|null {
 const value=parseNumericExpression(text,{unit:"%"});return value!==null&&value>0?value/100:null;
}
const percent=(zoom:number)=>`${Number((zoom*100).toFixed(3))}%`;
export function ZoomField({zoom,width,height,onChange,disabled=false}:{zoom:number;width:number;height:number;onChange:(zoom:number)=>void;disabled?:boolean}) {
 const [text,setText]=useState(()=>percent(zoom));const input=useRef<HTMLInputElement>(null),focused=useRef(false),drag=useRef<{id:number;x:number;base:number;moved:boolean}|null>(null);
 const skipBlur=useRef(false);
 const current=useRef({zoom,width,height,onChange,disabled});current.current={zoom,width,height,onChange,disabled};
 const publish=(value:number)=>{const c=current.current;if(c.disabled)return;const next=clampEditorZoom(value,c.width,c.height);setText(percent(next));c.onChange(next);};
 const action=useRef(publish);action.current=publish;
 useEffect(()=>{if(!focused.current&&!drag.current)setText(percent(zoom));},[zoom]);
 useEffect(()=>{if(disabled){drag.current=null;focused.current=false;setText(percent(current.current.zoom));}},[disabled]);
 useEffect(()=>{
  const element=input.current;if(!element)return;
  const wheel=(event:WheelEvent)=>{if(current.current.disabled || !event.deltaY)return;event.preventDefault();event.stopPropagation();action.current(current.current.zoom+(event.deltaY<0?1:-1)*(event.shiftKey?10:1)/100);};
  element.addEventListener("wheel",wheel,{passive:false});return()=>element.removeEventListener("wheel",wheel);
 },[]);
 const finish=()=>{const next=parseZoomPercent(text);if(next!==null)publish(next);else setText(percent(current.current.zoom));};
 return <input ref={input} className="photo-editor__zoom-field" type="text" inputMode="decimal" title="缩放百分比；拖动、方向键或滚轮调整" value={text} disabled={disabled} onFocus={()=>{focused.current=true;}} onBlur={()=>{focused.current=false;drag.current=null;if(skipBlur.current){skipBlur.current=false;return;}finish();}} onChange={event=>setText(event.currentTarget.value)} onKeyDown={event=>{
  if(event.nativeEvent.isComposing||event.keyCode===229)return;
  if(event.key==="Enter"){event.preventDefault();event.stopPropagation();finish();skipBlur.current=true;event.currentTarget.blur();}
  else if(event.key==="Escape"){event.preventDefault();event.stopPropagation();drag.current=null;setText(percent(current.current.zoom));skipBlur.current=true;event.currentTarget.blur();}
  else if(event.key==="ArrowUp"||event.key==="ArrowDown"){event.preventDefault();event.stopPropagation();publish((parseZoomPercent(text)??zoom)+(event.key==="ArrowUp"?1:-1)*(event.shiftKey?10:1)/100);}
 }} onPointerDown={event=>{if(event.button!==0||disabled)return;drag.current={id:event.pointerId,x:event.clientX,base:zoom,moved:false};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{
  const d=drag.current;if(!d||d.id!==event.pointerId)return;const delta=event.clientX-d.x;if(Math.abs(delta)>3)d.moved=true;if(d.moved){event.preventDefault();publish(d.base+delta/100);}
 }} onPointerUp={event=>{const d=drag.current;if(!d||d.id!==event.pointerId)return;if(d.moved){event.preventDefault();publish(d.base+(event.clientX-d.x)/100);}drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={()=>{const d=drag.current;drag.current=null;if(d?.moved)publish(d.base);}} onLostPointerCapture={()=>{drag.current=null;}}/>;
}
export const STATUS_CHOICES=[{id:"dimensions",label:"文档尺寸与分辨率"},{id:"sizes",label:"文档大小"},{id:"profile",label:"文档配置文件"},{id:"measurementScale",label:"测量比例"},{id:"scratch",label:"暂存大小（文档数据）"},{id:"efficiency",label:"效率（未采集）"},{id:"tool",label:"当前工具"},{id:"layers",label:"图层数"}] as const;
const STATUS_KEY="photocraft.status-info.v1";
function readStatus():string {try{const saved=localStorage.getItem(STATUS_KEY);return STATUS_CHOICES.some(item=>item.id===saved)?saved!:"dimensions";}catch{return "dimensions";}}
export function formatStatusBytes(bytes:number):string {const unit=bytes>=1024**3?1024**3:bytes>=1024**2?1024**2:1024;return `${(bytes/unit).toFixed(1)}${unit===1024**3?"G":unit===1024**2?"M":"K"}`;}
export function statusText(doc:EditorDocumentView,mode:string,tool:string):string {
 const metadata=doc.statusMetadata;
 switch(mode){
  case "sizes":return metadata?`文档：${formatStatusBytes(metadata.flatBytes)}/${formatStatusBytes(metadata.layeredBytes)}`:"文档大小未读取";
  case "profile":return `${metadata?.profile??"未读取配置文件"}（${doc.depthBits} bpc）`;
  case "measurementScale":return "1 像素 = 1.0000 像素";
  case "scratch":return metadata?`文档数据：${formatStatusBytes(metadata.layeredBytes)}`:"文档数据大小未读取";
  case "efficiency":return "效率：未采集";
  case "tool":return tool;
  case "layers":return `${doc.layers.length} 层`;
  default:return `${doc.width}×${doc.height} px · ${doc.resolutionDpi??72} ppi · ${doc.mode} · ${doc.layers.length} 层`;
 }
}
export function DocumentStatus({document,tool}:{document:EditorDocumentView;tool:string}) {
 const [mode,setMode]=useState(readStatus);
 return <><select className="photo-editor__status-choice" title="状态栏显示信息" value={mode} onChange={event=>{setMode(event.currentTarget.value);try{localStorage.setItem(STATUS_KEY,event.currentTarget.value);}catch{/* Session choice remains useful. */}}}>{STATUS_CHOICES.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select><span data-document-status={mode}>{statusText(document,mode,tool)}</span></>;
}
