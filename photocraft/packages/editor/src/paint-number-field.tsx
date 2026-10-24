import {useEffect,useRef,type PointerEvent,type ReactNode} from "react";
import {ArithmeticInput} from "./arithmetic-input.js";
import type {NumericUnits} from "./numeric-expression.js";
type Props={label:string;value:number;min:number;max:number;disabled:boolean;onChange:(value:number)=>void;units?:NumericUnits;inputScrub?:boolean;children?:ReactNode};
/** Paint options are next-stroke state. Drag cancellation restores that option's starting value. */
export function PaintNumberField(props:Props){
 const {label,value,min,max,disabled,units,inputScrub=false,children}=props;
 const root=useRef<HTMLLabelElement>(null),input=useRef<HTMLInputElement>(null),current=useRef(props);current.current=props;
 const drag=useRef<{id:number;x:number;start:number;value:number;moved:boolean}|null>(null);
 const publish=(value:number)=>{const p=current.current;p.onChange(Math.max(p.min,Math.min(p.max,value)));};
 const cancel=()=>{const d=drag.current;drag.current=null;if(d?.moved)publish(d.start);};
 useEffect(()=>{
  const wheel=(event:WheelEvent)=>{
   const p=current.current,target=event.target instanceof Element?event.target:null;
   if(p.disabled||!event.deltaY||event.ctrlKey||event.metaKey||event.altKey||!target)return;
   const own=!!root.current?.contains(target),focused=document.activeElement===input.current;
   const canvas=target.closest(".photo-editor-canvas"),sameEditor=canvas&&root.current?.closest(".photo-editor")===canvas.closest(".photo-editor");
   if(!own&&!(focused&&sameEditor))return;
   event.preventDefault();event.stopPropagation();publish(p.value+(event.deltaY<0?1:-1)*(event.shiftKey?10:1));
  };
  document.addEventListener("wheel",wheel,{capture:true,passive:false});window.addEventListener("blur",cancel);
  return()=>{document.removeEventListener("wheel",wheel,true);window.removeEventListener("blur",cancel);drag.current=null;};
 },[]);
 useEffect(()=>{if(disabled)cancel();},[disabled]);
 const start=(event:PointerEvent,prevent:boolean)=>{if(current.current.disabled||event.button!==0)return;if(prevent)event.preventDefault();drag.current={id:event.pointerId,x:event.clientX,start:current.current.value,value:current.current.value,moved:false};event.currentTarget.setPointerCapture?.(event.pointerId);};
 const move=(event:PointerEvent)=>{const d=drag.current;if(!d||d.id!==event.pointerId)return;const delta=event.clientX-d.x;if(!d.moved&&Math.abs(delta)<3)return;d.moved=true;event.preventDefault();d.x=event.clientX;d.value=Math.max(current.current.min,Math.min(current.current.max,d.value+delta*(event.altKey ? 0.1 : event.shiftKey ? 10 : 1)));publish(d.value);};
 const release=(event:PointerEvent)=>{const d=drag.current;if(!d||d.id!==event.pointerId)return;if(d.moved)move(event);drag.current=null;if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
 return <label ref={root} data-paint-option={label}>
  <span className="photo-editor__paint-scrub" title="拖动调值；Shift 加速，Alt/Option 精调" onPointerDown={event=>start(event,true)} onPointerMove={move} onPointerUp={release} onPointerCancel={cancel} onLostPointerCapture={cancel}>{label}</span>
  <ArithmeticInput ref={input} value={Number(value.toFixed(3))} min={min} max={max} disabled={disabled} units={units} onChange={event=>{const n=Number(event.currentTarget.value);if(Number.isFinite(n))publish(n);}}
   onPointerDown={inputScrub?event=>start(event,false):undefined} onPointerMove={inputScrub?move:undefined} onPointerUp={inputScrub?release:undefined} onPointerCancel={inputScrub?cancel:undefined} onLostPointerCapture={inputScrub?cancel:undefined}/>
  {children}
 </label>;
}
