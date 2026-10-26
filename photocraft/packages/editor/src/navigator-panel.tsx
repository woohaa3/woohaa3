import {DEFAULT_TRANSPARENCY_GRID,transparencyGridStyle,type TransparencyGrid} from "./transparency-grid.js";
import {useEffect,useRef,useState} from "react";
import {ZoomField} from "./editor-status-bar.js";
import {navigatorVisibleRect,type NavigatorFrame,type NavigatorAction} from "./navigator-geometry.js";
import {stepEditorZoom,minimumZoom} from "./zoom-levels.js";
import {WheelNavigation} from "./wheel-navigation.js";
import type {EditorPreview,EditorResult} from "./editor-wasm.js";
export function NavigatorPanel({active=true,contextKey,frame,read,navigate,zoomTo,blocked=false,pinch=true,transparency=DEFAULT_TRANSPARENCY_GRID}:{active?:boolean;contextKey:string;frame:NavigatorFrame|null;read:()=>EditorResult<EditorPreview>;navigate:(action:NavigatorAction)=>void;zoomTo:(zoom:number)=>void;blocked?:boolean;pinch?:boolean;transparency?:TransparencyGrid}) {
  const canvas=useRef<HTMLCanvasElement>(null),area=useRef<HTMLDivElement>(null),generation=useRef(0);
  const [preview,setPreview]=useState<{key:string;value:EditorPreview|null;error?:string}|null>(null);
  const [box,setBox]=useState<{x:number;y:number;width:number;height:number}|null>(null);
  const drag=useRef<{id:number;key:string;start:{x:number;y:number};rectangle:boolean}|null>(null),wheel=useRef(new WheelNavigation());
  const current=useRef({frame,navigate,zoomTo,blocked,pinch,contextKey});current.current={frame,navigate,zoomTo,blocked,pinch,contextKey};
  useEffect(()=>{if(!active)return;const token=++generation.current,id=requestAnimationFrame(()=>{if(token!==generation.current)return;try{const result=read();if(token===generation.current)setPreview({key:contextKey,value:result.ok?result.value:null,error:result.ok?undefined:result.message});}catch{if(token===generation.current)setPreview({key:contextKey,value:null,error:"导航预览暂不可用"});}});return()=>{generation.current++;cancelAnimationFrame(id);};},[active,contextKey,read]);
  const value=preview?.key===contextKey?preview.value:null;
  useEffect(()=>{const context=canvas.current?.getContext("2d");if(context&&value)context.putImageData(new ImageData(new Uint8ClampedArray(value.pixels),value.width,value.height),0,0);},[value]);
  useEffect(()=>{drag.current=null;setBox(null);wheel.current.reset();},[blocked,contextKey]);
  useEffect(()=>{const clear=()=>{drag.current=null;setBox(null);wheel.current.reset();};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")clear();};window.addEventListener("blur",clear);window.addEventListener("keydown",escape);return()=>{window.removeEventListener("blur",clear);window.removeEventListener("keydown",escape);};},[]);
  useEffect(()=>{
    const element=area.current;if(!element)return;
    const scroll=(event:WheelEvent)=>{const c=current.current;if(c.blocked||!c.frame)return;event.preventDefault();event.stopPropagation();const f=c.frame,next=wheel.current.apply(event,{view:f.viewport,width:f.size.width,height:f.size.height,documentWidth:f.document.width,documentHeight:f.document.height,anchor:{x:0,y:0},zoomWithScrollWheel:true,zoomWithTrackpadPinch:c.pinch});if(next&&next.zoom!==f.viewport.zoom)c.zoomTo(next.zoom);};
    element.addEventListener("wheel",scroll,{passive:false});return()=>element.removeEventListener("wheel",scroll);
  },[]);
  const d=frame?.document,viewport=frame?.viewport;
  const point=(event:{clientX:number;clientY:number})=>{const rect=area.current?.getBoundingClientRect();return rect&&rect.width>0&&rect.height>0&&d?{x:Math.max(0,Math.min(d.width,(event.clientX-rect.left)/rect.width*d.width)),y:Math.max(0,Math.min(d.height,(event.clientY-rect.top)/rect.height*d.height))}:null;};
  const rectangle=(a:{x:number;y:number},b:{x:number;y:number})=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(b.x-a.x),height:Math.abs(b.y-a.y)});
  const visible=frame?navigatorVisibleRect(frame):null;
  const cancel=()=>{drag.current=null;setBox(null);};
  const live=()=>!!frame&&!blocked;
  return <section className="photo-editor__info photo-editor__navigator" data-navigator-panel="true"><h3>导航器</h3>
    <div ref={area} className="photo-editor__navigator-image" style={{...transparencyGridStyle(transparency),aspectRatio:d?`${d.width}/${d.height}`:"4/3",width:d?`min(100%, ${Math.max(1,220*d.width/d.height)}px)`:"100%"}} onPointerDown={event=>{if(event.button!==0||drag.current||!live())return;const p=point(event);if(!p)return;event.preventDefault();event.stopPropagation();drag.current={id:event.pointerId,key:contextKey,start:p,rectangle:event.ctrlKey||event.metaKey};event.currentTarget.setPointerCapture(event.pointerId);if(drag.current.rectangle)setBox(rectangle(p,p));else navigate({type:"center",...p});}}
      onPointerMove={event=>{const gesture=drag.current,p=point(event);if(!gesture||gesture.id!==event.pointerId||gesture.key!==contextKey||!live()||!p)return;if(gesture.rectangle)setBox(rectangle(gesture.start,p));else navigate({type:"center",...p});}}
      onPointerUp={event=>{const gesture=drag.current;if(!gesture||gesture.id!==event.pointerId)return;const p=point(event);cancel();if(gesture.id===event.pointerId&&gesture.key===contextKey&&live()&&p){if(gesture.rectangle){const rect=rectangle(gesture.start,p);if(rect.width>0&&rect.height>0)navigate({type:"rectangle",...rect});}else navigate({type:"center",...p});}if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={event=>{if(drag.current?.id===event.pointerId)cancel();}} onLostPointerCapture={event=>{if(drag.current?.id===event.pointerId)cancel();}}>
      {value?<canvas ref={canvas} width={value.width} height={value.height}/>:null}
      {d&&visible?<svg viewBox={`0 0 ${d.width} ${d.height}`} preserveAspectRatio="none"><rect x={visible.x} y={visible.y} width={visible.width} height={visible.height} vectorEffect="non-scaling-stroke"/>{box?<rect data-navigator-box="true" x={box.x} y={box.y} width={box.width} height={box.height} vectorEffect="non-scaling-stroke"/>:null}</svg>:null}
    </div>
    {preview?.key===contextKey&&preview.error?<p className="photo-editor__message">{preview.error}</p>:null}
    {d&&viewport?<div className="photo-editor__navigator-zoom"><button type="button" disabled={blocked} onClick={()=>zoomTo(stepEditorZoom(viewport.zoom,-1,d.width,d.height))}>−</button><ZoomField zoom={viewport.zoom} width={d.width} height={d.height} disabled={blocked} onChange={zoomTo}/><button type="button" disabled={blocked} onClick={()=>zoomTo(stepEditorZoom(viewport.zoom,1,d.width,d.height))}>+</button><input title="导航器连续缩放" type="range" min={Math.log(minimumZoom(d.width,d.height))} max={Math.log(128)} step="any" value={Math.log(viewport.zoom)} disabled={blocked} onChange={event=>zoomTo(Math.exp(Number(event.currentTarget.value)))}/></div>:null}
  </section>;
}
