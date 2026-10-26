import {useRef,useState} from "react";
import {PanelTabs} from "./editor-sidebar.js";
import {hexRgb,rgbHex,rgbHsv,hsvRgb} from "./color-values.js";
import {MAX_COLOR_SWATCHES,readColorSwatches,writeColorSwatches} from "./color-picker.js";
import {Button} from "./ui/Button.js";

/** Shares the colour picker's local swatches and sRGB conversion; never edits document pixels. */
export function ColorPanel({foreground,background,onForeground,onBackground,onPick,onAction,disabled,active,onActive,report}:{foreground:string;background:string;onForeground:(value:string)=>void;onBackground:(value:string)=>void;onPick:(background:boolean)=>void;onAction:(action:"swap"|"reset")=>void;disabled:boolean;active?:string;onActive:(tab:string)=>void;report:(message:string|null)=>void}) {
  const [target,setTarget]=useState<"foreground"|"background">("foreground");
  const [hue,setHue]=useState(0),[swatches,setSwatches]=useState(readColorSwatches);
  const color=target==="foreground"?foreground:background,change=target==="foreground"?onForeground:onBackground;
  const hsv=rgbHsv(hexRgb(color),hue),drag=useRef<{id:number;original:string}|null>(null);
  const choose=(value:string)=>{if(!disabled)change(value);};
  const at=(event:{clientX:number;clientY:number;currentTarget:HTMLElement})=>{const rect=event.currentTarget.getBoundingClientRect();if(rect.width<=0 || rect.height<=0)return;choose(rgbHex(hsvRgb([hsv[0],Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,1-(event.clientY-rect.top)/rect.height))])));};
  const colors=<div className="photo-editor__color-controls">
    <div className="photo-editor__color-targets">{(["foreground","background"] as const).map(key=><button key={key} type="button" disabled={disabled} aria-pressed={key===target} title="单击选择颜色目标，双击打开拾色器" onClick={()=>setTarget(key)} onDoubleClick={()=>onPick(key==="background")}><i style={{backgroundColor:key==="foreground"?foreground:background}}/>{key==="foreground"?"前景色":"背景色"}</button>)}<Button size="sm" tone="ghost" disabled={disabled} onClick={()=>onAction("swap")}>交换</Button><Button size="sm" tone="ghost" disabled={disabled} onClick={()=>onAction("reset")}>默认</Button></div>
    <div className="photo-editor__color-field photo-editor__color-square" aria-label="饱和度与明度" style={{backgroundColor:`hsl(${hsv[0]},100%,50%)`}} onPointerDown={event=>{if(disabled || event.button!==0)return;event.preventDefault();drag.current={id:event.pointerId,original:color};event.currentTarget.setPointerCapture?.(event.pointerId);at(event);}} onPointerMove={event=>{if(drag.current?.id===event.pointerId)at(event);}} onPointerUp={event=>{if(drag.current?.id!==event.pointerId)return;at(event);drag.current=null;event.currentTarget.releasePointerCapture?.(event.pointerId);}} onPointerCancel={()=>{if(drag.current)choose(drag.current.original);drag.current=null;}} onLostPointerCapture={()=>{if(drag.current)choose(drag.current.original);drag.current=null;}}><span className="photo-editor__color-marker" style={{left:`${hsv[1]*100}%`,top:`${(1-hsv[2])*100}%`}}/></div>
    <label>色相<input type="range" min={0} max={360} step="any" disabled={disabled} value={hsv[0]} onChange={event=>{const next=Number(event.currentTarget.value);setHue(next);choose(rgbHex(hsvRgb([next,hsv[1],hsv[2]])));}}/><button type="button" disabled={disabled} onClick={()=>onPick(target==="background")}>{color}</button></label>
  </div>;
  const library=<div className="photo-editor__swatches-panel"><div className="photo-editor__color-swatches">{swatches.map(swatch=><button type="button" key={swatch} title={`${swatch} · Alt/Ctrl/Cmd 设置背景色`} disabled={disabled} style={{backgroundColor:swatch}} onClick={event=>event.altKey||event.ctrlKey||event.metaKey?onBackground(swatch):onForeground(swatch)}/>)}</div>
    {!swatches.length?<p className="photo-editor__panel-note">将当前颜色加入色板。</p>:null}
    <Button size="sm" disabled={disabled || swatches.includes(color) || swatches.length>=MAX_COLOR_SWATCHES} onClick={()=>{const next=[...swatches,color];setSwatches(next);report(writeColorSwatches(next)?null:"色板已在本次会话加入，浏览器未能保存。");}}>加入色板</Button>
  </div>;
  return <PanelTabs active={active} onActive={id=>{setSwatches(readColorSwatches());onActive(id);}} tabs={[{id:"color",label:"颜色",content:colors},{id:"swatches",label:"色板",content:library}]}/>;
}
