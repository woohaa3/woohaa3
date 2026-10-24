import {useEffect,useRef} from "react";
import {BLEND_LABELS} from "./layer-blends.js";
import {PAINT_MODES} from "./paint-modes.js";
export function PaintModeField({value,disabled,onChange}:{value:string;disabled:boolean;onChange:(mode:string)=>void}) {
 const select=useRef<HTMLSelectElement>(null),remainder=useRef(0),latest=useRef({value,disabled,onChange});latest.current={value,disabled,onChange};
 useEffect(()=>{if(disabled)remainder.current=0;},[disabled]);
 useEffect(()=>{
  const element=select.current;if(!element)return;
  const wheel=(event:WheelEvent)=>{
   const state=latest.current;
   if(state.disabled || !Number.isFinite(event.deltaY) || !event.deltaY || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)return;
   event.preventDefault();event.stopPropagation();
   const delta=event.deltaY*(event.deltaMode===1?40:event.deltaMode===2?120:1);
   if(Math.sign(delta)!==Math.sign(remainder.current))remainder.current=0;
   remainder.current+=delta;const steps=Math.trunc(remainder.current/40);if(!steps)return;remainder.current-=steps*40;
   const index=PAINT_MODES.findIndex(mode=>mode.toLowerCase()===state.value.toLowerCase());
   const next=PAINT_MODES[Math.max(0,Math.min(PAINT_MODES.length-1,Math.max(0,index)+steps))]!;
   if(next!==state.value)state.onChange(next);
  };
  element.addEventListener("wheel",wheel,{passive:false});return()=>element.removeEventListener("wheel",wheel);
 },[]);
 return <label>模式<select ref={select} value={value} disabled={disabled} onPointerLeave={()=>{remainder.current=0;}} onChange={event=>{remainder.current=0;onChange(event.currentTarget.value);}}>{PAINT_MODES.map(mode=><option key={mode} value={mode}>{mode==="Clear"?"清除":BLEND_LABELS[mode]??mode}</option>)}</select></label>;
}
