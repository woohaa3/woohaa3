import {useEffect,useRef,useState,type ReactNode} from "react";
import {canPositionStyle,type StylePositionTarget} from "./style-positioning.js";
import {LayerStyleContourEditor} from "./layer-style-contour-editor.js";
import {LayerStylePatternLibrary} from "./layer-style-pattern-library.js";
import {NumberField} from "./layer-style-number-field.js";
import {Button} from "./ui/Button.js";
import {BLEND_LABELS} from "./photo-editor-panels.js";
import {PHOTOSHOP_BLENDS} from "./editor-view-model.js";
import type {LayerStyleEditing,StylePatternPreset} from "./use-layer-properties-editing.js";

const NAMES:Record<string,string>={BevelEmboss:"斜面和浮雕",Stroke:"描边",InnerShadow:"内阴影",InnerGlow:"内发光",Satin:"光泽",ColorOverlay:"颜色叠加",GradientOverlay:"渐变叠加",PatternOverlay:"图案叠加",OuterGlow:"外发光",DropShadow:"投影"};
const NUMBERS:Record<string,[string,number,number,number?]>={opacity:["不透明度",0,1,100],angle:["角度",-360,360],altitude:["高度",0,90],distance:["距离",0,2048],spread:["扩展 / 阻塞",0,1,100],size:["大小",0,2048],soften:["柔化",0,2048],range:["范围",0,1,100],jitter:["抖动",0,1,100],noise:["杂色",0,1,100],depth:["深度",0,10,100],scale:["缩放",.01,10,100]};
const BOOLEANS:Record<string,string>={enabled:"启用效果",use_global_light:"使用全局光",anti_alias:"消除锯齿",knocks_out:"图层挖空投影",invert:"反相",up:"方向向上",reverse:"反向",dither:"仿色"};
const ENUMS:Record<string,[string,Record<string,string>]>={
  position:["位置",{Outside:"外部",Inside:"内部",Center:"居中"}],
  source:["源",{Center:"居中",Edge:"边缘"}],
  technique:["方法",{Softer:"柔和",Precise:"精确",Smooth:"平滑",ChiselHard:"雕刻清晰",ChiselSoft:"雕刻柔和"}],
  style:["样式",{Linear:"线性",Radial:"径向",Angle:"角度",Reflected:"对称",Diamond:"菱形",OuterBevel:"外斜面",InnerBevel:"内斜面",Emboss:"浮雕",PillowEmboss:"枕状浮雕",StrokeEmboss:"描边浮雕"}]
};
type Path=(string|number)[];
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==="object" && !Array.isArray(value);


function ColorField({value,label,onChange}:{value:unknown;label:string;onChange:(value:unknown)=>void}) {
  if(!object(value) || !Array.isArray(value.c) || value.c.length!==4) return null;
  const channels=value.c;
  const hex="#"+channels.slice(0,3).map(v=>Math.round(Math.max(0,Math.min(1,Number(v)))*255).toString(16).padStart(2,"0")).join("");
  return <label>{label}<input type="color" value={hex} onChange={event=>{
    const h=event.currentTarget.value;
    onChange({...value,c:[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).concat(channels[3] as number)});
  }}/></label>;
}

type Stop=[number,unknown];
type StopKey="stops"|"opacity_stops";
/** 色标跨过其它色标时保留控件身份，完整快照仍按位置提交给内核。 */
function GradientFields({gradient,onChange,spatial=true}:{gradient:Record<string,unknown>;spatial?:boolean;onChange:(value:Record<string,unknown>)=>void}) {
  const serial=useRef(0),ids=useRef<Record<StopKey,number[]>>({stops:[],opacity_stops:[]});
  const list=(key:StopKey):Stop[]=>Array.isArray(gradient[key])?gradient[key] as Stop[]:[];
  const publish=(key:StopKey,stops:Stop[],keys=ids.current[key])=>{
    const rows=stops.map((stop,i)=>({stop,id:keys[i]!}));
    // 非法输入保留原位，由草稿门禁阻止确认。
    if(stops.every(stop=>Number.isFinite(stop[0]))) rows.sort((a,b)=>a.stop[0]-b.stop[0]);
    ids.current[key]=rows.map(row=>row.id);
    onChange({...gradient,[key]:rows.map(row=>row.stop)});
  };
  const add=(key:StopKey)=>{
    const stops=list(key);if(stops.length>=256) return;
    const positions=[0,...stops.map(stop=>stop[0]).filter(Number.isFinite),1].sort((a,b)=>a-b);
    let left=0,right=1,gap=-1;
    for(let i=1;i<positions.length;i++) if(positions[i]!-positions[i-1]!>gap) {left=positions[i-1]!;right=positions[i]!;gap=right-left;}
    const position=(left+right)/2;
    const before=[...stops].reverse().find(stop=>stop[0]<=position)??stops[0];
    const after=stops.find(stop=>stop[0]>=position)??stops.at(-1);
    const t=before && after && after[0]>before[0]?(position-before[0])/(after[0]-before[0]):0;
    let value:unknown=key==="opacity_stops"?1:{mode:"Rgb",c:[0,0,0,0],alpha:1};
    if(before && after) {
      if(key==="opacity_stops") value=Number(before[1])+(Number(after[1])-Number(before[1]))*t;
      else if(object(before[1]) && object(after[1]) && Array.isArray(before[1].c) && Array.isArray(after[1].c)) {
        const end=after[1].c;value={...before[1],c:before[1].c.map((v,i)=>Number(v)+(Number(end[i])-Number(v))*t)};
      }
    }
    publish(key,[...stops,[position,value]],[...ids.current[key],++serial.current]);
  };
  return <>{spatial?<div className="photo-editor__style-stop">{["水平偏移","垂直偏移"].map((label,i)=><NumberField key={label} label={label} value={Number((gradient.offset as number[]|undefined)?.[i]??0)} min={-1_000_000} max={1_000_000} factor={100} onChange={value=>{
    const offset=Array.isArray(gradient.offset)?[...gradient.offset]:[0,0];offset[i]=value;onChange({...gradient,offset});
  }}/>)}</div>:null}{(["stops","opacity_stops"] as const).map(key=>{
    const stops=list(key),opacity=key==="opacity_stops";
    if(ids.current[key].length!==stops.length) ids.current[key]=stops.map(()=>++serial.current);
    return <fieldset key={key}><legend>{opacity?"透明度色标":"颜色色标"}</legend>
      {stops.map((stop,i)=><div className="photo-editor__style-stop" key={ids.current[key][i]}>
        <NumberField value={stop[0]} label={`${opacity?"透明度":"颜色"}色标 ${i+1} 位置`} min={0} max={1} factor={100} onChange={value=>publish(key,stops.map((stop,j)=>j===i?[value,stop[1]]:stop))}/>
        {opacity?<NumberField value={Number(stop[1])} label={`色标 ${i+1} 不透明度`} min={0} max={1} factor={100} onChange={value=>publish(key,stops.map((stop,j)=>j===i?[stop[0],value]:stop))}/>
          :<ColorField value={stop[1]} label={`色标 ${i+1} 颜色`} onChange={value=>publish(key,stops.map((stop,j)=>j===i?[stop[0],value]:stop))}/>}
        <Button size="sm" tone="ghost" disabled={!opacity && stops.length<=2} onClick={()=>publish(key,stops.filter((_,j)=>j!==i),ids.current[key].filter((_,j)=>j!==i))}>{opacity?"删除透明度色标":"删除颜色色标"}</Button>
      </div>)}
      {opacity && !stops.length?<p>未设置透明度色标，渐变完全不透明。</p>:null}
      <Button size="sm" disabled={stops.length>=256} onClick={()=>add(key)}>{opacity?"添加透明度色标":"添加颜色色标"}</Button>
    </fieldset>;
  })}</>;
}

function PatternFields({value,patterns,onChange,overlay=false,texture=false}:{value:Record<string,unknown>;patterns:StylePatternPreset[];onChange:(value:Record<string,unknown>)=>void;overlay?:boolean;texture?:boolean}) {
  const update=(key:string,next:unknown)=>onChange({...value,[key]:next});
  return <fieldset data-style-pattern><legend>{texture?"斜面纹理":"图案"}</legend>
    <label>图案<select value={String(value.id??"")} disabled={!patterns.length} onChange={event=>{
      const preset=patterns.find(p=>p.id===event.currentTarget.value);if(preset) onChange({...value,id:preset.id,name:preset.name});
    }}>{!patterns.some(p=>p.id===value.id)?<option value={String(value.id??"")}>图案资源缺失</option>:null}{patterns.map(p=><option key={p.id} value={p.id}>{p.name}（{p.width} × {p.height}）</option>)}</select></label>
    <NumberField label="缩放" value={Number(value.scale)} min={.01} max={10} factor={100} onChange={n=>update("scale",n)}/>
    {overlay?<NumberField label="角度" value={Number(value.angle)} min={-360} max={360} onChange={n=>update("angle",n)}/>:null}
    {texture?<><NumberField label="纹理深度" value={Number(value.depth)} min={-10} max={10} factor={100} onChange={n=>update("depth",n)}/>
      <label><input type="checkbox" checked={value.invert===true} onChange={event=>update("invert",event.currentTarget.checked)}/>反相纹理</label></>:null}
    {overlay || texture?<><label><input type="checkbox" checked={value.link===true} onChange={event=>update("link",event.currentTarget.checked)}/>与图层链接</label>
      {["水平偏移","垂直偏移"].map((label,i)=><NumberField key={i} label={label} value={Number((value.phase as number[]|undefined)?.[i]??0)} min={-1_000_000} max={1_000_000} onChange={n=>{
        const phase=Array.isArray(value.phase)?[...value.phase]:[0,0];phase[i]=n;update("phase",phase);
      }}/>)}</>:null}
  </fieldset>;
}
type PaintMemory={Color?:unknown;Gradient?:Record<string,unknown>;Pattern?:Record<string,unknown>;bevelContour?:Record<string,unknown>;bevelTexture?:Record<string,unknown>};
function PaintFields({paint,memory,defaultGradient,patterns,onChange,renderGradient}:{paint:Record<string,unknown>;memory:PaintMemory;defaultGradient:Record<string,unknown>|null;patterns:StylePatternPreset[];onChange:(value:Record<string,unknown>)=>void;renderGradient:(value:Record<string,unknown>,change:(value:Record<string,unknown>)=>void)=>ReactNode}) {
  const kind=object(paint.Pattern)?"Pattern":object(paint.Gradient)?"Gradient":"Color";
  return <fieldset><legend>填充</legend><label>填充类型<select value={kind} onChange={event=>{
    memory[kind]=structuredClone(paint[kind]) as Record<string,unknown>;
    const next=event.currentTarget.value as "Color"|"Gradient"|"Pattern";
    const first=patterns[0];
    const value=memory[next]??(next==="Gradient"?defaultGradient:next==="Pattern"?(first?{id:first.id,name:first.name,scale:1}:null):{mode:"Rgb",c:[0,0,0,0],alpha:1});
    if(value) onChange({[next]:structuredClone(value)});
  }}><option value="Color">颜色</option><option value="Gradient" disabled={!defaultGradient && !memory.Gradient}>渐变</option><option value="Pattern" disabled={!patterns.length && !memory.Pattern}>图案</option></select></label>
    {kind==="Color"?<ColorField value={paint.Color} label="颜色" onChange={value=>onChange({Color:value})}/>
      :kind==="Pattern"?<PatternFields value={paint.Pattern as Record<string,unknown>} patterns={patterns} onChange={value=>onChange({Pattern:value})}/>
      :renderGradient(paint.Gradient as Record<string,unknown>,value=>onChange({Gradient:value}))}
  </fieldset>;
}

/** 使用原生完整快照，修改已展示的参数时保留其它样式细节。 */
export function LayerStyleEditor({editing,disabled}:{editing:LayerStyleEditing;disabled:boolean}) {
  const [selected,setSelected]=useState(0),[addKind,setAddKind]=useState("DropShadow");
  const effectIds=useRef<number[]>([]),serial=useRef(0),paintMemory=useRef(new Map<number,PaintMemory>());
  const fileInput=useRef<HTMLInputElement>(null),latest=useRef(editing),generation=useRef(0);
  latest.current=editing;
  const [fileMessage,setFileMessage]=useState<string|null>(null),[loadingFile,setLoadingFile]=useState(false);
  useEffect(()=>{
    if(!editing.active) {setLoadingFile(false);setFileMessage(null);}
    const clear=()=>latest.current.setPresetPickerActive?.(false);
    const input=fileInput.current;input?.addEventListener("cancel",clear);window.addEventListener("focus",clear);
    return ()=>{generation.current++;clear();input?.removeEventListener("cancel",clear);window.removeEventListener("focus",clear);};
  },[editing.active]);
  const positionItems=editing.active?editing.data?.style.items??[]:[];
  const positionIndex=Math.min(selected,Math.max(0,positionItems.length-1));
  if(effectIds.current.length!==positionItems.length) effectIds.current=positionItems.map(()=>++serial.current);
  const positionKind=Object.keys(positionItems[positionIndex]??{})[0];
  const candidate:StylePositionTarget|null=positionKind==="PatternOverlay" || positionKind==="BevelEmboss" || positionKind==="GradientOverlay" || positionKind==="Stroke" || positionKind==="DropShadow" || positionKind==="InnerShadow"
    ?{key:String(effectIds.current[positionIndex]),index:positionIndex,kind:positionKind}:null;
  const positionable=!!candidate && !disabled && !!editing.data && canPositionStyle(editing.data,candidate);
  const positionKey=positionable?candidate!.key:null;
  useEffect(()=>{
    latest.current.setPositionTarget?.(positionKey!==null?{key:positionKey,index:positionIndex,kind:positionKind as StylePositionTarget["kind"]}:null);
  },[positionKey,positionIndex,positionKind]);
  useEffect(()=>()=>latest.current.setPositionTarget?.(null),[]);
  const saveContour=(value:unknown)=>{
    const bytes=editing.exportContour?.(value);if(!bytes) return;
    const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:"application/octet-stream"}));
    const name=object(value) && object(value.Custom) && typeof value.Custom.name==="string"?value.Custom.name:"等高线";
    const link=document.createElement("a");link.href=url;link.download=(name.replace(/[\\/:*?"<>|]/g,"_").slice(0,80)||"等高线")+".shc";
    editing.setPresetPickerActive?.(true);link.click();
    const revoke=URL.revokeObjectURL.bind(URL);
    setTimeout(()=>{revoke(url);if(document.hasFocus()) latest.current.setPresetPickerActive?.(false);},0);
  };
  if(!editing.active) return <Button size="sm" disabled={disabled} onClick={()=>{setSelected(0);effectIds.current=[];paintMemory.current.clear();editing.start();}}>图层样式…</Button>;
  const data=editing.data;
  if(!data) return <p>无法读取图层样式</p>;
  const modify=(path:Path,value:unknown)=>{
    const next=structuredClone(data);let target:unknown=next;
    for(const key of path.slice(0,-1)) target=(target as Record<string|number,unknown>)[key];
    (target as Record<string|number,unknown>)[path.at(-1)!]=value;editing.change(next);
  };
  const changeItems=(items:Record<string,unknown>[],ids=effectIds.current)=>{
    effectIds.current=ids;
    const remaining=new Set(ids);for(const id of paintMemory.current.keys()) if(!remaining.has(id)) paintMemory.current.delete(id);
    editing.change({...data,style:{...data.style,items}});
  };
  const items=data.style.items, index=Math.min(selected,Math.max(0,items.length-1));
  if(effectIds.current.length!==items.length) effectIds.current=items.map(()=>++serial.current);
  const effectId=effectIds.current[index];
  if(effectId!==undefined && !paintMemory.current.has(effectId)) paintMemory.current.set(effectId,{});
  const item=items[index],kind=item?Object.keys(item)[0]!:"";
  const body=item?.[kind];
  const color=(value:unknown,path:Path,label:string)=><ColorField key={path.join(".")} value={value} label={label} onChange={value=>modify(path,value)}/>;
  const fields=(value:Record<string,unknown>,path:Path)=>Object.entries(value).map(([key,v])=>{
    const p=[...path,key],id=p.join(".");
    if(kind==="PatternOverlay" && path.at(-1)==="PatternOverlay") return null;
    if(key==="gloss_contour" || (key==="contour" && !(kind==="BevelEmboss" && path.at(-1)==="BevelEmboss"))) {
      const sampleKey=path.at(-1)==="contour"?"bevelContour":key;
      return <LayerStyleContourEditor key={id} value={v} label={key==="gloss_contour"?"光泽等高线":"等高线"} samples={data.contourSamples?.[index]?.[sampleKey]} presets={data.contourPresets} library={editing.contourLibrary} onSave={editing.exportContour?saveContour:undefined} onChange={value=>modify(p,value)}/>;
    }
    if(typeof v==="number" && NUMBERS[key]) {
      const [label,min,max,factor]=NUMBERS[key]!;return <NumberField key={id} value={v} label={label} min={min} max={max} factor={factor} onChange={next=>modify(p,next)}/>;
    }
    if(typeof v==="boolean" && BOOLEANS[key]) return <label key={id}><input type="checkbox" checked={v} onChange={event=>modify(p,event.currentTarget.checked)}/>{BOOLEANS[key]}</label>;
    if(key==="blend" && typeof v==="string") return <label key={id}>混合模式<select value={v} onChange={event=>modify(p,event.currentTarget.value)}>{PHOTOSHOP_BLENDS.map(label=>{
      const raw=label.replace(/\(Add\)|\s/g,"");return <option key={raw} value={raw}>{BLEND_LABELS[label]}</option>;
    })}</select></label>;
    if(typeof v==="string" && ENUMS[key]) {
      const [label,allOptions]=ENUMS[key]!;
      const allowed=key==="technique" ? (["Softer","Precise"].includes(v)?["Softer","Precise"]:["Smooth","ChiselHard","ChiselSoft"])
        : key==="style" ? (["Linear","Radial","Angle","Reflected","Diamond"].includes(v)?["Linear","Radial","Angle","Reflected","Diamond"]:["OuterBevel","InnerBevel","Emboss","PillowEmboss","StrokeEmboss"]) : Object.keys(allOptions);
      const options=Object.entries(allOptions).filter(([raw])=>allowed.includes(raw));return <label key={id}>{label}<select value={v} onChange={event=>modify(p,event.currentTarget.value)}>{options.map(([raw,text])=><option key={raw} value={raw}>{text}</option>)}</select></label>;
    }
    if(["color","highlight_color","shadow_color"].includes(key)) return color(v,p,key==="color"?"颜色":key==="highlight_color"?"高光颜色":"阴影颜色");
    return null;
  });
  const common=(value:unknown,path:Path,label:string)=>object(value)?<fieldset key={path.join(".")}><legend>{label}</legend>{fields(value,path)}</fieldset>:null;
  const gradient=object(body) && object(body.gradient)?body.gradient:null;
  const defaultEffect=data.defaults.find(fx=>"GradientOverlay" in fx)?.GradientOverlay;
  const defaultGradient=object(defaultEffect) && object(defaultEffect.gradient)?defaultEffect.gradient:null;
  const glowGradient=kind==="InnerGlow" || kind==="OuterGlow";
  const renderGradient=(value:Record<string,unknown>,change:(value:Record<string,unknown>)=>void,path:Path)=> <fieldset><legend>渐变</legend>
    {glowGradient?null:fields(value,path)}<GradientFields gradient={value} spatial={!glowGradient} onChange={change}/>{glowGradient?<p className="photo-editor__option-hint">渐变沿发光强度分布。</p>:null}
  </fieldset>;
  return <section className="photo-editor__layer-style" data-layer-style>
    <header><strong>图层样式</strong><label><input type="checkbox" checked={data.style.enabled} onChange={event=>modify(["style","enabled"],event.currentTarget.checked)}/>显示效果</label></header>
    {positionable?<p className="photo-editor__option-hint">在图像内拖动调整{positionKind==="DropShadow"?"投影":positionKind==="InnerShadow"?"内阴影":positionKind==="BevelEmboss"?"纹理":positionKind==="GradientOverlay" || positionKind==="Stroke"?"渐变":"图案"}位置；Esc 撤回本次拖动。</p>:null}
    {editing.patternLibrary?<LayerStylePatternLibrary library={editing.patternLibrary} disabled={disabled} onPickerActive={editing.setPresetPickerActive}/>:null}
    {editing.importContours?<div className="photo-editor__style-actions"><Button size="sm" tone="ghost" disabled={loadingFile} onClick={()=>{setFileMessage(null);editing.setPresetPickerActive?.(true);fileInput.current?.click();}}>载入等高线…</Button>
      <input ref={fileInput} type="file" accept=".shc" hidden data-contour-file onChange={async event=>{
        const file=event.currentTarget.files?.[0];event.currentTarget.value="";editing.setPresetPickerActive?.(false);if(!file) return;
        if(file.size>1_048_576) {setFileMessage("等高线预设文件不能超过 1 MiB");return;}
        const token=generation.current;setLoadingFile(true);
        try {
          const bytes=new Uint8Array(await file.arrayBuffer());
          if(token!==generation.current) return;
          if(latest.current.importContours?.(bytes)) setFileMessage("等高线预设已载入，请从预设列表选择。");
        } catch {if(token===generation.current) setFileMessage("无法读取预设文件，请重新选择。");}
        finally {if(token===generation.current) setLoadingFile(false);}
      }}/>{fileMessage?<span className="photo-editor__option-hint">{fileMessage}</span>:null}</div>:null}
    <div className="photo-editor__style-actions"><select title="添加效果" value={addKind} onChange={event=>setAddKind(event.currentTarget.value)}>{Object.entries(NAMES).filter(([key])=>data.defaults.some(fx=>key in fx)).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select>
      <Button size="sm" disabled={items.length>=64 || !data.defaults.some(fx=>addKind in fx)} onClick={()=>{
        const fx=data.defaults.find(fx=>addKind in fx);if(!fx) return;
        setSelected(items.length);changeItems([...items,structuredClone(fx)],[...effectIds.current,++serial.current]);
      }}>添加效果</Button></div>
    <select title="当前效果" size={Math.min(5,Math.max(2,items.length))} value={String(index)} onChange={event=>setSelected(Number(event.currentTarget.value))}>{items.map((fx,i)=><option key={i} value={i}>{i+1}. {NAMES[Object.keys(fx)[0]!]??"效果"}</option>)}</select>
    {item?<><div className="photo-editor__style-actions">
      <Button size="sm" disabled={items.length>=64} onClick={()=>{changeItems([...items,structuredClone(item)],[...effectIds.current,++serial.current]);setSelected(items.length);}}>复制效果</Button>
      <Button size="sm" disabled={index===0} onClick={()=>{const next=[...items];[next[index-1],next[index]]=[next[index]!,next[index-1]!];const ids=[...effectIds.current];[ids[index-1],ids[index]]=[ids[index]!,ids[index-1]!];setSelected(index-1);changeItems(next,ids);}}>上移</Button>
      <Button size="sm" disabled={index===items.length-1} onClick={()=>{const next=[...items];[next[index+1],next[index]]=[next[index]!,next[index+1]!];const ids=[...effectIds.current];[ids[index+1],ids[index]]=[ids[index]!,ids[index+1]!];setSelected(index+1);changeItems(next,ids);}}>下移</Button>
      <Button size="sm" onClick={()=>changeItems(items.filter((_,i)=>i!==index),effectIds.current.filter((_,i)=>i!==index))}>删除效果</Button>
    </div>{object(body)?<div className="photo-editor__style-fields" key={effectId}>
      {common(body.common,["style","items",index,kind,"common"],"效果混合")}
      {fields(body,["style","items",index,kind])}
      {object(body.paint)?<PaintFields paint={body.paint} memory={paintMemory.current.get(effectId!)!} defaultGradient={defaultGradient} patterns={data.patternPresets??[]}
        onChange={value=>modify(["style","items",index,kind,"paint"],value)}
        renderGradient={(value,change)=>renderGradient(value,change,["style","items",index,kind,"paint","Gradient"])}/>:null}
      {kind==="PatternOverlay"?<PatternFields value={body as Record<string,unknown>} patterns={data.patternPresets??[]} overlay onChange={value=>modify(["style","items",index,kind],value)}/>:null}
      {kind==="BevelEmboss"?<><label><input type="checkbox" checked={body.contour!=null} onChange={event=>{
        const memory=paintMemory.current.get(effectId!)!;
        if(object(body.contour)) memory.bevelContour=structuredClone(body.contour);
        modify(["style","items",index,kind,"contour"],event.currentTarget.checked?memory.bevelContour??{contour:"Linear",range:.5,anti_alias:false}:null);
      }}/>启用斜面等高线</label>
        {body.contour!=null?common(body.contour,["style","items",index,kind,"contour"],"斜面等高线"):null}
        <label><input type="checkbox" checked={body.texture!=null} disabled={!body.texture && !data.patternPresets?.length} onChange={event=>{
          const memory=paintMemory.current.get(effectId!)!;
          if(object(body.texture)) memory.bevelTexture=structuredClone(body.texture);
          const first=data.patternPresets?.[0];
          modify(["style","items",index,kind,"texture"],event.currentTarget.checked?memory.bevelTexture??{id:first?.id,name:first?.name,scale:1,depth:1,invert:false,link:true,phase:[0,0]}:null);
        }}/>启用斜面纹理</label>
        {object(body.texture)?<PatternFields value={body.texture} patterns={data.patternPresets??[]} texture onChange={value=>modify(["style","items",index,kind,"texture"],value)}/>:null}</>:null}
      {common(body.highlight,["style","items",index,kind,"highlight"],"高光")}
      {common(body.shadow,["style","items",index,kind,"shadow"],"阴影")}
      {gradient?renderGradient(gradient,value=>modify(["style","items",index,kind,"gradient"],value),["style","items",index,kind,"gradient"]):null}
    </div>:null}</>:<p>尚未添加效果</p>}
    <fieldset><legend>全局光源</legend><NumberField value={data.globalLight.angle} label="角度" min={-360} max={360} onChange={value=>modify(["globalLight","angle"],value)}/><NumberField value={data.globalLight.altitude} label="高度" min={0} max={90} onChange={value=>modify(["globalLight","altitude"],value)}/></fieldset>
    <div className="photo-editor__style-actions"><Button size="sm" onClick={()=>editing.finish(true)}>确认样式</Button><Button size="sm" tone="ghost" onClick={()=>editing.finish(false)}>取消样式</Button></div>
  </section>;
}
