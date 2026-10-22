import {useRef,useState,type PointerEvent} from "react";
import {Button} from "./ui/Button.js";
import type {ContourLibraryActions} from "./contour-preset-store.js";
import type {ContourPreset} from "./editor-wasm.js";
import {NumberField} from "./layer-style-number-field.js";

type Point={input:number;output:number};
type Custom={name:string;points:Point[];corners?:boolean[]};
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==="object" && !Array.isArray(value);
const linear=():Custom=>({name:"自定",points:[{input:0,output:0},{input:1,output:1}],corners:[false,false]});
const valid=(points:Point[])=>points.length>=2 && points.length<=256 && points.every((point,i)=>
  Number.isFinite(point.input) && Number.isFinite(point.output) && point.input>=0 && point.input<=1
  && point.output>=0 && point.output<=1 && (i===0 || point.input>points[i-1]!.input));

/** 控制点由界面编辑；曲线形状使用内核的等高线采样，不另建插值算法。 */
export function LayerStyleContourEditor({value,label,samples=[],presets=[],library,onSave,onChange}:{value:unknown;label:string;samples?:number[];presets?:(ContourPreset & {id?:string})[];library?:ContourLibraryActions;onSave?:(value:unknown)=>void;onChange:(value:unknown)=>void}) {
  const custom=object(value) && object(value.Custom)?value.Custom as Custom:undefined;
  const [selected,setSelected]=useState(0),cached=useRef<Custom|null>(null);
  const [managedId,setManagedId]=useState(""),[presetName,setPresetName]=useState("");
  const userPresets=presets.filter(preset=>preset.id);
  const managed=userPresets.find(preset=>preset.id===managedId);
  const current=useRef({value,custom,onChange});current.current={value,custom,onChange};
  const drag=useRef<{id:number;index:number;original:unknown;start:[number,number];moved:boolean}|null>(null);
  const points=custom?.points??linear().points,index=Math.min(selected,points.length-1),isValid=valid(points);
  const catalog=presets.length?presets:[{name:"Linear",contour:"Linear"}];
  const signature=(contour:unknown)=>{
    if(!object(contour) || !object(contour.Custom)) return String(contour);
    const c=contour.Custom as Custom;
    return JSON.stringify([c.name,c.points.map((point,i)=>[point.input,point.output,c.corners?.[i]??false])]);
  };
  const presetIndex=catalog.findIndex(preset=>signature(preset.contour)===signature(value));
  const names:Record<string,string>={Linear:"线性",Cone:"锥形","Cone - Inverted":"反相锥形","Cove - Deep":"深凹","Cove - Shallow":"浅凹",Gaussian:"高斯","Half Round":"半圆",Ring:"环形","Ring - Double":"双环","Rolling Slope - Descending":"下降斜坡","Rounded Steps":"圆滑阶梯","Sawtooth 1":"锯齿 1"};
  const change=(next:Custom)=>onChange({Custom:next});
  const update=(next:Point[],corners=custom?.corners)=>change({...custom??linear(),points:next,corners});
  const add=()=>{
    if(!isValid || points.length>=256) return;
    let gap=0;for(let i=1;i<points.length-1;i++) if(points[i+1]!.input-points[i]!.input>points[gap+1]!.input-points[gap]!.input) gap=i;
    const a=points[gap]!,b=points[gap+1]!;
    const flags=points.map((_,i)=>custom?.corners?.[i]??false);flags.splice(gap+1,0,false);
    update([...points.slice(0,gap+1),{input:(a.input+b.input)/2,output:(a.output+b.output)/2},...points.slice(gap+1)],flags);setSelected(gap+1);
  };
  const remove=()=>{
    if(index<=0 || index>=points.length-1) return;
    update(points.filter((_,i)=>i!==index),points.map((_,i)=>custom?.corners?.[i]??false).filter((_,i)=>i!==index));setSelected(index-1);
  };
  const position=(event:PointerEvent<SVGSVGElement>):[number,number]|null=>{
    const rect=event.currentTarget.getBoundingClientRect();if(!rect.width || !rect.height) return null;
    return [Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),Math.max(0,Math.min(1,1-(event.clientY-rect.top)/rect.height))];
  };
  const move=(at:[number,number])=>{
    const active=drag.current,latest=current.current.custom;if(!active || !latest) return;
    const all=latest.points,i=active.index;
    if(!active.moved && Math.hypot(at[0]-active.start[0],at[1]-active.start[1])<.005) return;
    active.moved=true;
    const lower=i===0?0:all[i-1]!.input+.0001,upper=i===all.length-1?1:all[i+1]!.input-.0001;
    if(lower>upper) return;
    const input=Math.max(lower,Math.min(upper,at[0]));
    current.current.onChange({Custom:{...latest,points:all.map((point,j)=>j===i?{input,output:at[1]}:point)}});
  };
  const cancel=()=>{const active=drag.current;drag.current=null;if(active) current.current.onChange(active.original);};
  return <fieldset data-style-contour><legend>{label}</legend>
    <label>预设<select value={presetIndex>=0?`preset:${presetIndex}`:"Custom"} onChange={event=>{
      if(custom) cached.current=structuredClone(custom);
      setSelected(0);
      if(event.currentTarget.value==="Custom") {change(cached.current??linear());return;}
      const preset=catalog[Number(event.currentTarget.value.slice(7))];if(preset) onChange(structuredClone(preset.contour));
    }}>{catalog.map((preset,i)=><option value={`preset:${i}`} key={i}>{names[preset.name]??preset.name}</option>)}<option value="Custom">自定</option></select></label>
    {custom?<label>名称<input value={custom.name} maxLength={200} onChange={event=>change({...custom,name:event.currentTarget.value})}/></label>:null}
    <svg viewBox="0 0 255 255" width="160" height="160" className="photo-editor__contour-graph" data-contour-graph
      onPointerDown={event=>{
        if(event.button!==0 || !isValid) return;const at=position(event);if(!at) return;
        event.preventDefault();event.currentTarget.focus();
        let found=-1,distance=.055;points.forEach((point,i)=>{const next=Math.hypot(point.input-at[0],point.output-at[1]);if(next<distance) {distance=next;found=i;}});
        if(found<0 && (points.length>=256 || points.some(point=>Math.abs(point.input-at[0])<.0001))) return;
        const original=structuredClone(value),next=structuredClone(custom??linear());
        if(found<0) {
          found=next.points.findIndex(point=>point.input>at[0]);if(found<0) found=next.points.length;
          const flags=next.points.map((_,i)=>next.corners?.[i]??false);flags.splice(found,0,false);
          next.points.splice(found,0,{input:at[0],output:at[1]});next.corners=flags;
        }
        if(!custom || next.points.length!==points.length) change(next);
        setSelected(found);drag.current={id:event.pointerId,index:found,original,start:at,moved:false};event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={event=>{if(drag.current?.id===event.pointerId) {const at=position(event);if(at) move(at);}}}
      onPointerUp={event=>{if(drag.current?.id!==event.pointerId) return;const at=position(event);if(at) move(at);drag.current=null;
        if(event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={cancel} onLostPointerCapture={cancel} tabIndex={0}
      onKeyDown={event=>{if((event.key==="Delete" || event.key==="Backspace") && !event.nativeEvent.isComposing) {event.preventDefault();event.stopPropagation();remove();}}}>
      <path d="M0 255L255 0 M0 128H255 M128 0V255" className="photo-editor-curve__grid"/>
      {isValid && samples.length===256?<polyline points={samples.map((value,i)=>`${i},${255-value*255}`).join(" ")}/>:null}
      {points.map((point,i)=>Number.isFinite(point.input) && Number.isFinite(point.output)?<circle key={i} cx={point.input*255} cy={255-point.output*255} r={i===index?5:3} data-selected={i===index}/>:null)}
    </svg>
    <span className="photo-editor__option-hint">点击添加或选择点，拖动调整。</span>
    <label>控制点<select value={index} onChange={event=>setSelected(Number(event.currentTarget.value))}>{points.map((_,i)=><option value={i} key={i}>{i+1}</option>)}</select></label>
    {points[index]?<>
      <NumberField value={points[index]!.input} label="输入" min={0} max={1} factor={100} onChange={input=>update(points.map((point,i)=>i===index?{...point,input}:point))}/>
      <NumberField value={points[index]!.output} label="输出" min={0} max={1} factor={100} onChange={output=>update(points.map((point,i)=>i===index?{...point,output}:point))}/>
      <label><input type="checkbox" checked={custom?.corners?.[index]??false} onChange={event=>update(points,points.map((_,i)=>i===index?event.currentTarget.checked:custom?.corners?.[i]??false))}/>拐角</label>
    </>:null}
    <div className="photo-editor__style-actions"><Button size="sm" disabled={!isValid || points.length>=256} onClick={add}>添加控制点</Button>
      <Button size="sm" tone="ghost" disabled={index<=0 || index>=points.length-1} onClick={remove}>删除控制点</Button></div>
    {library?<details data-contour-library><summary>管理本机预设</summary>
      <p className="photo-editor__option-hint">默认预设保留。库管理不修改图层；从上方预设列表选择后才应用。</p>
      <label>库中预设<select value={managed?.id??""} onChange={event=>{
        const id=event.currentTarget.value;setManagedId(id);setPresetName(userPresets.find(preset=>preset.id===id)?.name??"");
      }}><option value="">新预设</option>{userPresets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
      <label>预设名称<input value={presetName} maxLength={200} onChange={event=>setPresetName(event.currentTarget.value)}/></label>
      <div className="photo-editor__style-actions">
        <Button size="sm" disabled={!isValid || !presetName.trim()} onClick={()=>library.create(presetName,value)}>将当前曲线新建为预设</Button>
        <Button size="sm" tone="ghost" disabled={!managed || !presetName.trim() || presetName===managed.name} onClick={()=>{if(managed) library.rename(managed.id!,presetName);}}>重命名预设</Button>
        <Button size="sm" tone="ghost" disabled={!managed} onClick={()=>{if(managed && library.remove(managed.id!)) {setManagedId("");setPresetName("");}}}>删除预设</Button>
      </div>
    </details>:null}
    {onSave?<Button size="sm" tone="ghost" disabled={!isValid} onClick={()=>onSave(value)}>保存等高线…</Button>:null}
    {!isValid?<p className="photo-editor__message">输入和输出须为 0–100%，输入须递增且不重复。</p>:null}
  </fieldset>;
}
