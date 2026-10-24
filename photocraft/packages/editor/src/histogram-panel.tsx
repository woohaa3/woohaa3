import {useEffect,useRef,useState} from "react";
import type {EditorResult} from "./editor-wasm.js";
import type {HistogramReadout} from "./histogram-data.js";
export function HistogramPanel({documentKey,contextKey,read}:{documentKey:string;contextKey:string;read:()=>EditorResult<HistogramReadout>}) {
  const [channel,setChannel]=useState(0),[state,setState]=useState<{documentKey:string;contextKey:string;value:HistogramReadout|null;error?:string}|null>(null);
  const generation=useRef(0),lastRead=useRef(-Infinity);
  useEffect(()=>{
    const token=++generation.current;
    const delay=state?.documentKey===documentKey?Math.max(0,250-(performance.now()-lastRead.current)):0;
    const timer=setTimeout(()=>{
      if(token!==generation.current)return;lastRead.current=performance.now();
      try{const result=read();if(token===generation.current)setState({documentKey,contextKey,value:result.ok?result.value:null,error:result.ok?undefined:result.message});}
      catch{if(token===generation.current)setState({documentKey,contextKey,value:null,error:"直方图暂不可用"});}
    },delay);
    return()=>{generation.current++;clearTimeout(timer);};
  },[documentKey,contextKey,read]);
  const current=state?.documentKey===documentKey?state:null,value=current?.value,hist=value?.channels[channel];
  const cached=current?.contextKey!==contextKey;
  const bins=hist?.bins??[],top=Math.max(1,...bins),path=bins.map((v,i)=>`${i===0?"M":"L"}${i+0.5} ${100-v/top*100}`).join("");
  const number=(n:number|null|undefined)=>n===null||n===undefined?"—":n.toFixed(2);
  return <section className="photo-editor__info photo-editor__histogram" data-histogram-panel="true">
    <h3>直方图</h3><select value={channel} onChange={event=>setChannel(Number(event.currentTarget.value))}>{["RGB","R","G","B"].map((label,i)=><option key={label} value={i}>{label}</option>)}</select>
    <svg viewBox="0 0 256 100" preserveAspectRatio="none" data-histogram-channel={channel}><path d={path} fill="none" stroke="currentColor"/></svg>
    {cached?<p data-histogram-cached="true">缓存数据，正在更新…</p>:null}
    <dl>{[["平均值",number(hist?.mean)],["标准差",number(hist?.stdDev)],["中位数",hist?.median??"—"],["像素",value?.pixels??"—"],["缓存级别",value?.cacheLevel??"—"]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p>统计来自最长边 384 px 的合成缓存，透明像素不计入分布。</p>
    {current?.error?<p className="photo-editor__message">{current.error}</p>:null}
  </section>;
}
