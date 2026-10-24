import {useEffect,useRef,useState} from "react";
import type {EditorResult} from "./editor-wasm.js";
import {visiblePixelGridRegion,type PixelGridRegion,type PixelGridSegment} from "./pixel-grid-data.js";
export type PixelGridPort={contextKey:string;read:(region:PixelGridRegion)=>EditorResult<PixelGridSegment[]>};
export function PixelGridOverlay({port,origin,size,zoom,document,transitioning=false}:{port:PixelGridPort;origin:{x:number;y:number};size:{width:number;height:number};zoom:number;document:{width:number;height:number};transitioning?:boolean}) {
  const generation=useRef(0),[data,setData]=useState<{key:string;lines:PixelGridSegment[];error?:string}|null>(null);
  const ratio=globalThis.devicePixelRatio||1;
  const region=zoom*ratio>5&&!transitioning?visiblePixelGridRegion(origin,size,zoom,document):null;
  const key=region?`${port.contextKey}:${region.x}:${region.y}:${region.width}:${region.height}`:"";
  useEffect(()=>{
    const token=++generation.current;if(!region)return;
    const frame=requestAnimationFrame(()=>{if(token!==generation.current)return;try{const result=port.read(region);if(token===generation.current)setData({key,lines:result.ok?result.value:[],error:result.ok?undefined:result.message});}catch{if(token===generation.current)setData({key,lines:[],error:"像素网格暂不可用"});}});
    return()=>{generation.current++;cancelAnimationFrame(frame);};
  },[key,port.read]);
  const lines=data?.key===key&&region?data.lines:[];
  const error=data?.key===key&&region?data.error:null;
  if(error)return <span className="photo-editor-canvas__coords" data-pixel-grid-error="true">{error}</span>;
  if(!lines.length)return null;
  // Merge colors into paths; the 60k segment limit never creates 60k DOM nodes.
  const paths=new Map<string,string[]>();
  for(const [x0,y0,x1,y1,r,g,b,a] of lines){const color=`rgba(${r},${g},${b},${a/255})`,parts=paths.get(color)??[];parts.push(`M${origin.x+x0*zoom} ${origin.y+y0*zoom}L${origin.x+x1*zoom} ${origin.y+y1*zoom}`);paths.set(color,parts);}
  return <svg data-pixel-grid="true" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none",overflow:"hidden"}}>
    {[...paths].map(([color,parts])=><path key={color} d={parts.join("")} fill="none" stroke={color} strokeWidth={1/ratio}/>)}
  </svg>;
}
