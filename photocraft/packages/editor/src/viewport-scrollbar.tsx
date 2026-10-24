import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from "react";
import type {EditorViewport} from "./viewport.js";
export type ScrollbarSpan={start:number;length:number;travel:number;perPoint:number;center:number;page:number;lo:number;hi:number};
/** Upstream scrollbars::Span geometry, in document pixels. */
export function scrollbarSpan(length:number,offset:number,size:number,zoom:number,track:number,overscroll:boolean):ScrollbarSpan|null {
 if(![length,size,zoom,track].every(value=>Number.isFinite(value)&&value>0)||!Number.isFinite(offset))return null;
 const center=length/2-offset/zoom,page=size/zoom,v0=center-page/2,v1=center+page/2;
 const lo=overscroll?Math.min(v0,0,length-page):Math.min(v0,0),hi=overscroll?Math.max(v1,length,page):Math.max(v1,length);
 const total=hi-lo,visible=Math.min(page,total),thumb=Math.max(Math.min(24,track),Math.min(track,visible/total*track)),travel=track-thumb,room=total-visible;
 return {start:room>1e-6?(v0-lo)/room*travel:0,length:thumb,travel,perPoint:travel>1e-3&&room>0?room/travel:0,center,page,lo,hi};
}
export type ViewportScrollbarHandle={cancel:()=>void;active:()=>boolean};
export const ViewportScrollbars=forwardRef<ViewportScrollbarHandle,{view:EditorViewport;width:number;height:number;documentWidth:number;documentHeight:number;overscroll:boolean;disabled:boolean;onChange:(next:EditorViewport)=>void;onGestureChange:(active:boolean)=>void}>(function ViewportScrollbars(props,ref){
 const latest=useRef(props);latest.current=props;
 const drag=useRef<{axis:"x"|"y";pointer:number;origin:number;offset:number;span:ScrollbarSpan;zoom:number;target:HTMLDivElement}|null>(null);
 const [active,setActive]=useState(false);
 const cancel=()=>{const current=drag.current;drag.current=null;setActive(false);latest.current.onGestureChange(false);if(current?.target.hasPointerCapture(current.pointer))current.target.releasePointerCapture(current.pointer);};
 useImperativeHandle(ref,()=>({cancel,active:()=>!!drag.current}));
 useEffect(()=>{const stop=()=>cancel();window.addEventListener("blur",stop);document.addEventListener("visibilitychange",stop);return()=>{window.removeEventListener("blur",stop);document.removeEventListener("visibilitychange",stop);cancel();};},[]);
 useEffect(()=>{cancel();},[props.disabled,props.width,props.height,props.documentWidth,props.documentHeight,props.overscroll]);
 const update=(value:number)=>{const current=drag.current;if(!current)return;const delta=Math.max(-current.span.start,Math.min(current.span.travel-current.span.start,value-current.origin));latest.current.onChange({...latest.current.view,[current.axis]:current.offset-delta*current.span.perPoint*current.zoom});};
 return <div className="photo-editor-canvas__scrollbars" data-canvas-viewport-control="true" data-scrollbar-active={active||undefined}>
  {(["x","y"] as const).map(axis=>{
   const horizontal=axis==="x",track=Math.max(0,(horizontal?props.width:props.height)-12),span=scrollbarSpan(horizontal?props.documentWidth:props.documentHeight,props.view[axis],horizontal?props.width:props.height,props.view.zoom,track,props.overscroll);
   if(!span)return null;
   return <div key={axis} className="photo-editor-canvas__scrollbar" data-scrollbar-axis={axis} data-disabled={props.disabled||undefined} onPointerDown={event=>{
    event.preventDefault();event.stopPropagation();if(props.disabled||event.button!==0||drag.current)return;
    const rect=event.currentTarget.getBoundingClientRect(),at=horizontal?event.clientX-rect.left:event.clientY-rect.top;
    if(at>=span.start&&at<=span.start+span.length){drag.current={axis,pointer:event.pointerId,origin:horizontal?event.clientX:event.clientY,offset:props.view[axis],span,zoom:props.view.zoom,target:event.currentTarget};setActive(true);props.onGestureChange(true);event.currentTarget.setPointerCapture(event.pointerId);}
    else {const center=at<span.start?Math.max(span.lo+span.page/2,span.center-span.page):Math.min(span.hi-span.page/2,span.center+span.page);props.onChange({...props.view,[axis]:props.view[axis]-(center-span.center)*props.view.zoom});}
   }} onPointerMove={event=>{event.stopPropagation();if(drag.current?.pointer===event.pointerId)update(horizontal?event.clientX:event.clientY);}}
   onPointerUp={event=>{event.stopPropagation();if(drag.current?.pointer===event.pointerId){update(horizontal?event.clientX:event.clientY);cancel();}}}
   onPointerCancel={event=>{event.stopPropagation();if(drag.current?.pointer===event.pointerId)cancel();}}
   onLostPointerCapture={event=>{event.stopPropagation();if(drag.current?.pointer===event.pointerId)cancel();}}
   ><div className="photo-editor-canvas__scrollbar-thumb" style={horizontal?{left:span.start,width:span.length}:{top:span.start,height:span.length}}/></div>;
  })}
 </div>;
});
