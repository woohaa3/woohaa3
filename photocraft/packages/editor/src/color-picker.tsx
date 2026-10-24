import {useEffect,useRef,useState} from "react";
import {ArithmeticInput} from "./arithmetic-input.js";
import {hexRgb,rgbHex,rgbHsv,hsvRgb,nearestWebColor,SPACE_FIELDS,colorNumbers,numbersRgb,validColorNumbers,normalizeHex,clampColor,type ColorSpace,type HSV} from "./color-values.js";
import {DialogBody,DialogContent,DialogFooter,DialogHeader,DialogTitle} from "./ui/Dialog.js";
import {Button} from "./ui/Button.js";
import type {EditorDialogPort,EditorDialogRendererProps} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
const SWATCHES="photocraft.color-swatches.v1",DIALOG="image-editor.color-picker";
/** 本机色板上限：与主机 localStorage 存储策略一致，超出不再接受新色。 */
export const MAX_COLOR_SWATCHES=256;
/** 读取本机色板：只接受 `#rrggbb`、去重、小写；损坏数据回退为空，不影响选择器。 */
export function readColorSwatches():string[]{try{const value:unknown=JSON.parse(localStorage.getItem(SWATCHES)??"[]");return Array.isArray(value)?[...new Set(value.filter((item):item is string=>typeof item==="string"&&/^#[0-9a-f]{6}$/i.test(item)).map(value=>value.toLowerCase()))].slice(0,MAX_COLOR_SWATCHES):[];}catch{return [];}}
/** 写入本机色板；规范化、去重并截断到上限，返回是否真的落盘（隐私模式/配额失败时为 false）。 */
export function writeColorSwatches(swatches:readonly string[]):boolean{
 const normalized=[...new Set(swatches.filter(item=>/^#[0-9a-f]{6}$/i.test(item)).map(item=>item.toLowerCase()))].slice(0,MAX_COLOR_SWATCHES);
 try{localStorage.setItem(SWATCHES,JSON.stringify(normalized));return true;}catch{return false;}
}
export function ColorPickerDialog({instance,requestClose,initial,apply}:EditorDialogRendererProps & {initial:string;apply:(color:string)=>void}) {
 const [color,setColor]=useState(initial),[hsv,setHsv]=useState<HSV>(()=>rgbHsv(hexRgb(initial))),[space,setSpace]=useState<ColorSpace>("HSB"),[fields,setFields]=useState(()=>colorNumbers("HSB",initial).map(number=>String(Math.round(number*100)/100))),[hex,setHex]=useState(initial),[onlyWeb,setOnlyWeb]=useState(false),[clipped,setClipped]=useState(false),[swatches,setSwatches]=useState(readColorSwatches),[error,setError]=useState<string|null>(null);
 const drag=useRef<{pointer:number;from:HSV}|null>(null);
 const valid=!!normalizeHex(hex)&&validColorNumbers(space,fields);
 const choose=(raw:string,keepHue=hsv[0],nextSpace=space,web=onlyWeb)=>{const next=web?nearestWebColor(raw):raw;setColor(next);setHex(next);const nextHsv=rgbHsv(hexRgb(next),keepHue);setHsv(nextHsv);setFields(colorNumbers(nextSpace,next,nextHsv[0]).map(value=>String(Math.round(value*100)/100)));setClipped(false);};
 useEffect(()=>{const cancel=()=>{if(drag.current){const from=drag.current.from;drag.current=null;choose(rgbHex(hsvRgb(from)),from[0]);}};window.addEventListener("blur",cancel);return()=>window.removeEventListener("blur",cancel);},[space,onlyWeb]);
 const point=(event:{clientX:number;clientY:number;currentTarget:HTMLElement})=>{const rect=event.currentTarget.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return;choose(rgbHex(hsvRgb([hsv[0],clampColor((event.clientX-rect.left)/rect.width),1-clampColor((event.clientY-rect.top)/rect.height)])));};
 const nearest=nearestWebColor(color);
 return <DialogContent size="sm" instanceId={instance.instanceId} ariaLabel="颜色选择器"><form onSubmit={event=>{event.preventDefault();if(valid)apply(color);}}><DialogHeader onClose={requestClose}><DialogTitle>颜色选择器</DialogTitle></DialogHeader><DialogBody>
 <div className="photo-editor__color-field" style={{backgroundColor:rgbHex(hsvRgb([hsv[0],1,1]))}} onPointerDown={event=>{if(event.button!==0||drag.current)return;event.preventDefault();drag.current={pointer:event.pointerId,from:hsv};event.currentTarget.setPointerCapture(event.pointerId);point(event);}} onPointerMove={event=>{if(drag.current?.pointer===event.pointerId)point(event);}} onPointerUp={event=>{if(drag.current?.pointer!==event.pointerId)return;point(event);drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={event=>{if(drag.current?.pointer!==event.pointerId)return;choose(rgbHex(hsvRgb(drag.current.from)),drag.current.from[0]);drag.current=null;}} onLostPointerCapture={()=>{if(drag.current){choose(rgbHex(hsvRgb(drag.current.from)),drag.current.from[0]);drag.current=null;}}}><span className="photo-editor__color-marker" style={{left:`${hsv[1]*100}%`,top:`${(1-hsv[2])*100}%`}}/></div>
 <label>色相<input type="range" min={0} max={360} step="any" value={hsv[0]} onChange={event=>{const hue=Number(event.currentTarget.value);choose(rgbHex(hsvRgb([hue,hsv[1],hsv[2]])),hue);}}/></label>
 <div className="photo-editor__color-comparison"><Button type="button" title="恢复打开时的颜色" onClick={()=>{setOnlyWeb(false);choose(initial,hsv[0],space,false);}}><span style={{backgroundColor:initial}}/>原色</Button><span><i style={{backgroundColor:color}}/>新色 {color}</span></div>
 <label>HEX<input type="text" value={hex} maxLength={7} onChange={event=>{const value=event.currentTarget.value;const normalized=normalizeHex(value);if(normalized)choose(normalized);setHex(value);}} onBlur={()=>{const normalized=normalizeHex(hex);if(normalized)choose(normalized);}}/></label>
 <label>数值模式<select value={space} onChange={event=>{const next=event.currentTarget.value as ColorSpace;setSpace(next);choose(color,hsv[0],next);}}>{["HSB","RGB","Lab","CMYK"].map(value=><option key={value}>{value}</option>)}</select></label>
 <div className="photo-editor__color-values">{SPACE_FIELDS[space].map((field,index)=><label key={`${space}:${field.label}`}>{field.label}<ArithmeticInput invalidate min={field.min} max={field.max} step="any" value={fields[index]} onChange={event=>{const value=event.currentTarget.value,next=fields.map((old,i)=>i===index?value:old);setFields(next);if(validColorNumbers(space,next)){const rgb=numbersRgb(space,next.map(Number)),raw=rgbHex(rgb),hex=onlyWeb?nearestWebColor(raw):raw;setColor(hex);setHex(hex);setHsv(rgbHsv(hexRgb(hex),space==="HSB"?Number(next[0]):hsv[0]));setClipped(rgb.some(channel=>channel<-.00001||channel>1.00001));if(onlyWeb)setFields(colorNumbers(space,hex,hsv[0]).map(value=>String(Math.round(value*100)/100)));}}}/></label>)}</div>
 {space==="Lab"?<p>Lab 使用 D65 白点，预览转换为 sRGB。</p>:space==="CMYK"?<p>CMYK 为通用数值换算，未使用印刷 ICC 配置。</p>:null}{clipped?<p>输入超出 sRGB，预览已调整到可显示范围。</p>:null}
 <label><input type="checkbox" checked={onlyWeb} onChange={event=>{const checked=event.currentTarget.checked;setOnlyWeb(checked);if(checked)choose(nearestWebColor(color));}}/>仅 Web 颜色（216 色）</label>
 {!onlyWeb&&nearest!==color?<Button type="button" size="sm" onClick={()=>choose(nearest)}>使用最近的 Web 颜色 {nearest}</Button>:null}
 <div className="photo-editor__color-swatches">{swatches.map(swatch=><button key={swatch} type="button" title={swatch} style={{backgroundColor:swatch}} onClick={()=>choose(swatch)}/>)}</div>
 <Button type="button" size="sm" disabled={!valid||swatches.includes(color)||swatches.length>=MAX_COLOR_SWATCHES} onClick={()=>{const next=[...swatches,color];setSwatches(next);setError(writeColorSwatches(next)?null:"色板已在本次会话加入，浏览器未能保存。");}}>加入色板</Button>{error?<p>{error}</p>:null}
 </DialogBody><DialogFooter><Button type="button" onClick={requestClose}>取消</Button><Button type="submit" tone="primary" disabled={!valid}>确认</Button></DialogFooter></form></DialogContent>;
}
export function useColorPicker(dialogs:EditorDialogPort|undefined,controller:EditorWorkspaceController,key:string,blocked:boolean,error:(message:string|null)=>void) {
 const current=useRef({key,blocked,error});current.current={key,blocked,error};const opening=useRef(false),instance=useRef<string|null>(null),request=useRef<{key:string;initial:string;apply:(color:string)=>void}|null>(null);
 useEffect(()=>{
  if(!dialogs)return;
  const unregister=dialogs.registerDialog(DIALOG,{definition:{singleton:true,size:"sm",editingOwner:()=>opening.current&&!current.current.blocked?controller.dialogOwner():null,validatePayload:payload=>payload==null?{ok:true,payload:null}:{ok:false,error:"无效的颜色请求"}},renderer:props=><ColorPickerDialog {...props} initial={request.current?.initial??"#000000"} apply={color=>{
   if(!request.current||request.current.key!==current.current.key||current.current.blocked||dialogs.top()?.instanceId!==props.instance.instanceId||instance.current!==props.instance.instanceId)return;
   request.current.apply(color);dialogs.close(props.instance.instanceId);instance.current=null;
  }}/>});return()=>{if(instance.current)dialogs.close(instance.current);instance.current=null;request.current=null;unregister();};
 },[dialogs,controller]);
 useEffect(()=>{if(instance.current){dialogs?.close(instance.current);instance.current=null;}request.current=null;},[controller,key]);
 useEffect(()=>{if(blocked&&instance.current){dialogs?.close(instance.current);instance.current=null;request.current=null;}},[blocked,dialogs]);
 return {available:!!dialogs,open:(initial:string,apply:(color:string)=>void)=>{if(!dialogs||current.current.blocked||dialogs.isModalActive())return false;request.current={key:current.current.key,initial:normalizeHex(initial)??"#000000",apply};opening.current=true;try{const result=dialogs.open({dialogId:DIALOG});if(!result.ok){current.current.error(result.error);return false;}instance.current=result.instance.instanceId;return true;}finally{opening.current=false;}}};
}
