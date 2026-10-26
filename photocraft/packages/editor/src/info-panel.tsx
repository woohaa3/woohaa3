import {formatMeasurement,type MeasurementUnit,type PointPicaSize} from "./measurement-unit.js";
import {useEffect,useRef,useState} from "react";
import type {EditorResult} from "./editor-wasm.js";
import type {DocumentPoint} from "./photo-editor-tools.js";
import type {InfoRequest,InfoReadout} from "./info-readout.js";
/** Each frame reads one bounded native sample; no DOM colors or text-layout approximation. */
export function InfoPanel({active=true,contextKey,point,size,read,unit="pixels",resolutionDpi=72,pointPicaSize=72}:{active?:boolean;contextKey:string;point:DocumentPoint|null;size:number;read:(params:InfoRequest)=>EditorResult<InfoReadout>;unit?:MeasurementUnit;resolutionDpi?:number;pointPicaSize?:PointPicaSize}) {
  const generation=useRef(0),[state,setState]=useState<{key:string;value:InfoReadout|null;error:string|null}|null>(null);
  const key=`${contextKey}:${point?.x??"none"}:${point?.y??"none"}:${size}`;
  useEffect(()=>{
    if(!active)return;
    const token=++generation.current,frame=requestAnimationFrame(()=>{
      if(token!==generation.current)return;
      try{const result=read({x:point?.x??null,y:point?.y??null,size});if(token===generation.current)setState({key,value:result.ok?result.value:null,error:result.ok?null:result.message});}
      catch{if(token===generation.current)setState({key,value:null,error:"信息暂不可用"});}
    });
    return()=>{generation.current++;cancelAnimationFrame(frame);};
  },[active,key,read]);
  const data=state?.key===key?state:null,value=data?.value;
  const length=(n:number|undefined,axis:number)=>n===undefined?"—":formatMeasurement(n,unit,resolutionDpi,value?.documentSize[axis]??1,pointPicaSize);
  const number=(value:number|undefined)=>value===undefined?"—":String(Number(value.toFixed(3)));
  return <section className="photo-editor__info" data-info-panel="true">
    <h3>信息</h3><div className="photo-editor__info-grid">
      <dl>{["R","G","B"].map((label,i)=><div key={label}><dt>{label}</dt><dd>{number(value?.rgb?.[i])}</dd></div>)}</dl>
      <dl>{["C","M","Y","K"].map((label,i)=><div key={label}><dt>{label}</dt><dd>{value?.cmyk?`${value.cmyk[i]}%`:"—"}</dd></div>)}</dl>
      <dl>{["X","Y"].map((label,i)=><div key={label}><dt>{label}</dt><dd>{length(value?.position?.[i],i)}</dd></div>)}</dl>
      <dl>{["W","H"].map((label,i)=><div key={label}><dt>{label}</dt><dd>{length(value?.selectionSize?.[i],i)}</dd></div>)}</dl>
    </div><p>{value?`文档：${value.documentSize[0]} × ${value.documentSize[1]} px`:"文档：—"}</p>
    {data?.error?<p className="photo-editor__message">{data.error}</p>:null}
  </section>;
}
